import * as THREE from 'three';
import { AGENTS } from '../abilities/abilityData';
import type { Game } from '../core/Game';
import { SHIELDS } from '../economy/Shop';
import type { Economy } from '../economy/Economy';
import type { RoundManager, Side, SiteId, TeamId } from '../rounds/RoundManager';
import { getWeapon } from '../weapons/weaponData';
import { Bot, createBotModel } from './Bot';
import { BotBrain, TeamIntel, hashId, type BrainContext, type Combatant, type HoldKind, type TeamPlan } from './BotBrain';
import { ALLY_NAMES, BOT_SKILL, ENEMY_NAMES, type BotDifficulty } from './botConfig';
import { NavGrid } from './NavGrid';
import { Tactics } from './Tactics';

/**
 * 봇 관리자 + 팀 지휘.
 *   - 봇 생성 (아군 4 + 적 5, 모델은 한 번 만들어 경기마다 재사용)
 *   - 라운드 준비: 스폰 배치, 구매(경제), 팀 계획(공격 구역 선택·수비 배치)
 *   - 매 프레임: 팀 정보 공유, 진입 시점/로테이션 판단, Core 줍기 담당, 물리 틱, 판단
 */

/** MatchController가 넘겨 주는 경기 정보 */
export interface MatchLink {
  rm: RoundManager;
  economy: Economy;
  playerId: string;
  playerTeam: TeamId;
  siteAt(p: THREE.Vector3): SiteId | null;
  weaponsLocked: boolean;
  /** 이 봇이 가지러 갈 바닥 무기 위치 (아군이 건네준 총) */
  weaponFor?(bot: Bot): THREE.Vector3 | null;
}

const TICK = 1 / 64;
const RIFLES = ['falcon', 'warhound', 'falcon', 'mule'];

export class BotManager {
  nav: NavGrid;
  tactics: Tactics;
  private env: { nav: NavGrid } | null = null;
  readonly bots: Bot[] = [];
  private brains = new Map<string, BotBrain>();
  private intel: Record<TeamId, TeamIntel> = { A: new TeamIntel(), B: new TeamIntel() };
  private plans: Record<TeamId, TeamPlan> = { A: freshPlan(), B: freshPlan() };
  private link: MatchLink | null = null;
  private acc = 0;
  private time = 0;
  private activeTime = 0;
  private combatants: Combatant[] = [];
  difficulty: BotDifficulty = 'normal';
  /** 테스트용: 판단·이동·사격을 멈춤 (규칙만 검사할 때) */
  frozen = false;
  /** 봇 사이 상호작용을 끄고 디버그 표시 (테스트) */
  readonly group = new THREE.Group();

  constructor(private game: Game) {
    this.nav = new NavGrid(game.map.def, game.map.collision);
    this.tactics = new Tactics(this.nav, game.map.collision);
    this.group.name = 'bots';
    game.scene.add(this.group);
  }

  /** 맵이 바뀌면 이동 격자·전술 지점을 다시 만든다 */
  setMap(): void {
    this.nav = new NavGrid(this.game.map.def, this.game.map.collision);
    this.tactics = new Tactics(this.nav, this.game.map.collision);
    if (this.env) this.env.nav = this.nav;
  }

  get allies(): Bot[] {
    return this.bots.filter((b) => b.teamId === 'A');
  }

  get enemies(): Bot[] {
    return this.bots.filter((b) => b.teamId === 'B');
  }

  brain(id: string): BotBrain | undefined {
    return this.brains.get(id);
  }

  /** 처음 한 번 봇 9명 생성 */
  async ensureBots(): Promise<void> {
    if (this.bots.length) return;
    const g = this.game;
    const env = {
      world: g.map.collision,
      nav: this.nav,
      combat: g.combat,
      sound: g.sound,
      fx: g.abilityFx,
      surfaceAt: (x: number, y: number, z: number) => g.map.surfaceAt(x, y, z),
      noise: (src: Bot, pos: THREE.Vector3, radius: number) => this.noise(src.teamId, pos, radius),
    };
    this.env = env;
    const specs: { id: string; name: string; team: TeamId }[] = [
      ...ALLY_NAMES.map((n, i) => ({ id: `ally-${i + 1}`, name: n, team: 'A' as TeamId })),
      ...ENEMY_NAMES.map((n, i) => ({ id: `enemy-${i + 1}`, name: n, team: 'B' as TeamId })),
    ];
    const models = await Promise.all(specs.map((s) => createBotModel(s.team === 'A' ? 'defense' : 'attack')));
    specs.forEach((s, i) => {
      const agent = AGENTS[(hashId(s.id) >>> 0) % AGENTS.length].id;
      const b = new Bot(s.id, s.name, s.team, models[i], env, BOT_SKILL[this.difficulty], agent);
      b.setEnabled(false);
      b.onHurt = (bb, e) => this.hurt(bb, e.from);
      this.bots.push(b);
      this.brains.set(b.id, new BotBrain(b));
      this.group.add(b.model.root);
      g.combat.addTarget(b);
    });
  }

  /** 경기 시작 */
  attach(link: MatchLink, difficulty: BotDifficulty, playerAgent: string): void {
    this.link = link;
    this.difficulty = difficulty;
    // 캐릭터: 한 팀 안에서는 겹치지 않게 무작위 (아군은 플레이어 캐릭터 제외)
    const shuffled = (exclude: string[]) => AGENTS.map((a) => a.id).filter((id) => !exclude.includes(id)).sort(() => Math.random() - 0.5);
    const pools: Record<TeamId, string[]> = { A: shuffled([playerAgent]), B: shuffled([]) };
    for (const b of this.bots) {
      b.skill = BOT_SKILL[difficulty];
      b.setEnabled(true);
      const pool = pools[b.teamId];
      b.abilities.setAgent(pool.length ? pool.shift()! : AGENTS[Math.floor(Math.random() * AGENTS.length)].id);
      b.onRevive = (bb) => link.rm.revive(bb.id);
      b.vitals.armor = 0;
      void b.setLoadout(null);
    }
    const g = this.game;
    this.combatants = [
      { id: link.playerId, teamId: link.playerTeam, d: g.local, head: (o) => g.local.eyePosition(o) },
      ...this.bots.map((b) => ({ id: b.id, teamId: b.teamId, d: b, bot: b, head: (o: THREE.Vector3) => b.headPos(o) })),
    ];
    this.time = 0;
  }

  detach(): void {
    this.link = null;
    for (const b of this.bots) {
      b.setEnabled(false);
      b.trigger = false;
    }
  }

  // ───────────────────────── 라운드 ─────────────────────────

  /**
   * 새 라운드: 배치 + 구매 + 계획.
   * @param keep 지난 라운드에 살아남아 장비를 유지하는 봇 id
   * @param pistol 권총 라운드 (첫 라운드/진영 교체)
   */
  setupRound(keep: Set<string>, pistol: boolean, excludeSpawn: THREE.Vector3 | null): void {
    const link = this.link!;
    const map = this.game.map;
    this.intel.A.clear();
    this.intel.B.clear();
    this.activeTime = 0;
    for (const team of ['A', 'B'] as TeamId[]) {
      const side = link.rm.sideOf(team);
      const spawns = (side === 'attack' ? map.spawns.attackers : map.spawns.defenders).filter(
        (s) => !excludeSpawn || s.position.distanceTo(excludeSpawn) > 1.5,
      );
      const bots = this.bots.filter((b) => b.teamId === team);
      bots.forEach((b, i) => {
        const s = spawns[Math.floor(((i + 0.5) / bots.length) * spawns.length)];
        const armor = keep.has(b.id) && !pistol ? b.vitals.armor : 0;
        b.setTeamSide(side, team === link.playerTeam);
        b.spawnAt(s.position.x + (Math.random() - 0.5), 0, s.position.z + (Math.random() - 0.5), s.yaw, armor);
        if (pistol) b.abilities.resetAll();
        else b.abilities.roundStart();
        if (!keep.has(b.id) || pistol) void b.setLoadout(null);
        else b.refillAmmo();
        this.brains.get(b.id)!.reset();
      });
      this.buy(team, pistol);
      this.plans[team] = this.makePlan(team, side);
    }
  }

  /** 팀 구매: 권총 라운드 / 풀 구매 / 절약(에코) / 강제 구매 */
  private buy(team: TeamId, pistol: boolean): void {
    const eco = this.link!.economy;
    const bots = this.bots.filter((b) => b.teamId === team);
    const avg = bots.reduce((s, b) => s + eco.get(b.id), 0) / Math.max(1, bots.length);
    for (const b of bots) {
      let credits = eco.get(b.id);
      const spend = (n: number) => {
        if (n > credits) return false;
        if (!eco.spend(b.id, n)) return false;
        credits -= n;
        return true;
      };
      let primary: string | null = b.primary?.id ?? null;
      let armor = b.vitals.armor;
      // 살아남아 들고 있는 무기가 기관단총·산탄총이면, 돈이 넉넉할 때 소총으로 바꾼다
      const weak = !!b.primary && ['smg', 'shotgun'].includes(b.primary.category);
      if (pistol) {
        if (spend(SHIELDS[0].price)) armor = SHIELDS[0].value;
      } else if ((!primary || weak) && credits >= 3900) {
        // 풀 구매: 소총(가끔 저격총) + 중방어구
        const sniper = credits >= 5700 && Math.random() < 0.2;
        const w = getWeapon(sniper ? 'longbow' : RIFLES[(hashId(b.id) >>> 0) % RIFLES.length]);
        if (spend(w.price)) primary = w.id;
        if (armor < 50 && spend(SHIELDS[1].price)) armor = 50;
      } else if (!primary && avg >= 2000 && credits >= 1600) {
        // 강제 구매: 기관단총·산탄총 + 경방어구
        const w = getWeapon(credits >= 2400 ? 'mule' : Math.random() < 0.5 ? 'viper' : 'breach');
        if (spend(w.price)) primary = w.id;
        if (armor < 25 && spend(SHIELDS[0].price)) armor = 25;
      } else if (primary && armor < 50 && credits >= 1000) {
        if (spend(SHIELDS[1].price)) armor = 50;
      }
      // 남은 돈으로 능력 충전 (다음 라운드를 위해 일부 남김)
      for (const slot of ['ability1', 'ability2'] as const) {
        const d = b.abilities.def(slot);
        if (b.abilities.canBuy(slot) && credits - d.cost >= (pistol ? 0 : 300) && spend(d.cost)) b.abilities.buyCharge(slot);
      }
      b.vitals.armor = armor;
      if (primary !== (b.primary?.id ?? null)) void b.setLoadout(primary);
    }
  }

  private makePlan(team: TeamId, side: Side): TeamPlan {
    const plan = freshPlan();
    const bots = this.bots.filter((b) => b.teamId === team);
    if (side === 'attack') {
      plan.site = Math.random() < 0.5 ? 'A' : 'B';
      plan.execAt = 8 + Math.random() * 14;
      // 상대(적) 공격팀이면 봇 중 한 명이 Core를 들고 시작
    } else {
      // 수비 배치: A 2 · B 2 · 미드 1 (플레이어가 있는 팀은 플레이어 몫을 비워 둠)
      const order: HoldKind[] = team === this.link!.playerTeam ? ['A', 'B', 'mid', 'A'] : ['A', 'B', 'A', 'B', 'mid'];
      bots.forEach((b, i) => plan.assign.set(b.id, order[i % order.length]));
    }
    return plan;
  }

  /** 공격팀 봇 한 명에게 Core를 준다 (적이 공격일 때) */
  carrierFor(team: TeamId): string | null {
    const bots = this.bots.filter((b) => b.teamId === team && b.alive);
    return bots.length ? bots[Math.floor(Math.random() * bots.length)].id : null;
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(dt: number): void {
    const link = this.link;
    if (!link) return;
    const rm = link.rm;
    this.time += dt;
    if (rm.combatActive) this.activeTime += dt;
    const ctx = this.context(link);
    this.direct(ctx);

    // 판단 → 물리 → 모델
    if (this.frozen) for (const b of this.bots) b.trigger = false;
    else for (const b of this.bots) this.brains.get(b.id)!.frame(dt, ctx);
    this.acc += dt;
    let n = 0;
    while (this.acc >= TICK && n < 8) {
      for (const b of this.bots) b.tick(TICK, this.frozen || !rm.canMove || (b.interact >= 0 && b.alive));
      this.acc -= TICK;
      n++;
    }
    if (n === 8) this.acc = 0;
    const alpha = this.acc / TICK;
    for (const b of this.bots) b.update(dt, alpha, link.weaponsLocked);

    // 쓰러진 봇: 되살아나는 궁극기가 있으면 잠시 뒤 사용
    if (rm.combatActive && !this.frozen)
      for (const b of this.bots)
        if (b.enabled && !b.alive && b.deadTime > 1.8 && b.deadTime < 6 && b.abilities.usableWhileDead('ultimate') && b.abilities.def('ultimate').effect === 'notdeadyet')
          b.useAbility('ultimate');

    // Core 줍기 (공격 봇이 바닥의 Core 위를 지나가면)
    const c = rm.core;
    if (c.status === 'dropped' && c.position && !this.frozen) {
      for (const b of this.bots) {
        if (!b.alive || rm.sideOf(b.teamId) !== 'attack') continue;
        const p = b.ctrl.position;
        if (Math.hypot(p.x - c.position.x, p.z - c.position.z) < 1.0 && rm.tryPickup(b.id, { x: p.x, y: p.y, z: p.z })) break;
      }
    }
  }

  private context(link: MatchLink): BrainContext {
    const rm = link.rm;
    return {
      time: this.time,
      activeTime: this.activeTime,
      rm,
      tactics: this.tactics,
      weaponFor: (b: Bot) => link.weaponFor?.(b) ?? null,
      canMove: rm.canMove,
      weaponsLocked: link.weaponsLocked,
      combatActive: rm.combatActive,
      sideOf: (t) => rm.sideOf(t),
      enemiesOf: (t) => this.combatants.filter((c) => c.teamId !== t),
      alliesOf: (t) => this.combatants.filter((c) => c.teamId === t),
      intel: (t) => this.intel[t],
      plan: (t) => this.plans[t],
      combatant: (id) => this.combatants.find((c) => c.id === id),
      siteAt: (p) => link.siteAt(p),
      playerId: link.playerId,
    };
  }

  /** 팀 단위 판단: 진입 시점, 로테이션, Core 줍기 담당 */
  private direct(ctx: BrainContext): void {
    const rm = ctx.rm;
    for (const team of ['A', 'B'] as TeamId[]) {
      const plan = this.plans[team];
      const side = rm.sideOf(team);
      const members = this.combatants.filter((c) => c.teamId === team && c.d.alive);
      // 우리 비콘에 드러난 적은 벽 너머라도 위치를 안다
      for (const t of this.game.abilityFx.revealedBy.get(side) ?? []) this.intel[team].report(t.id, t.center(new THREE.Vector3()), this.time);
      if (side === 'attack') {
        // 집결지에 셋 이상 모였거나 시간이 되면 진입
        if (plan.phase === 'gather') {
          const st = this.tactics.sites[plan.site].staging;
          const gathered = members.filter((m) => m.d.center(new THREE.Vector3()).distanceTo(st) < 7).length;
          if (rm.combatActive && (this.activeTime > plan.execAt || gathered >= Math.min(3, members.length) || rm.timeLeft < 35)) plan.phase = 'execute';
        }
        // 아군 플레이어가 Core를 들고 다른 구역으로 가면 그쪽을 따른다
        if (team === this.link!.playerTeam && rm.core.carrierId === ctx.playerId) {
          const pl = ctx.combatant(ctx.playerId)!;
          const pp = pl.d.center(new THREE.Vector3());
          const dA = pp.distanceTo(this.tactics.sites.A.center);
          const dB = pp.distanceTo(this.tactics.sites.B.center);
          plan.site = dA < dB ? 'A' : 'B';
        }
        // 바닥의 Core: 가장 가까운 봇이 줍는다. 아군 플레이어가 근처에 살아 있으면 6초간 양보
        plan.pickerId = null;
        if (rm.core.status === 'dropped' && rm.core.position) {
          const cp = new THREE.Vector3(rm.core.position.x, rm.core.position.y, rm.core.position.z);
          const pl = team === this.link!.playerTeam ? ctx.combatant(ctx.playerId) : undefined;
          const playerNear = pl?.d.alive && pl.d.center(new THREE.Vector3()).distanceTo(cp) < 10;
          if (!playerNear || this.activeTime > 6) {
            let best: Bot | null = null;
            let bd = Infinity;
            for (const b of this.bots) {
              if (b.teamId !== team || !b.alive) continue;
              const d = b.ctrl.position.distanceTo(cp);
              if (d < bd) {
                bd = d;
                best = b;
              }
            }
            plan.pickerId = best?.id ?? null;
          }
        }
      } else {
        // 수비: 최근 4초 안에 적 둘 이상이 한 구역 근처에서 보이면 그쪽으로 지원
        const seen = this.intel[team].recent(this.time, 4);
        plan.rotate = null;
        for (const id of ['A', 'B'] as SiteId[]) {
          const s = this.tactics.sites[id];
          const n = seen.filter((x) => x.pos.distanceTo(s.center) < 16 || x.pos.distanceTo(s.entrance) < 10).length;
          if (n >= 2) plan.rotate = id;
        }
      }
    }
  }

  /** 봇이 적을 처치함 (흡수·단검 재충전·되살아남 확정) */
  onKill(killerId: string): void {
    const b = this.bots.find((x) => x.id === killerId);
    if (!b) return;
    b.onKill();
    this.brains.get(b.id)?.onKill();
  }

  /** 총소리·발소리: 반경 안의 상대 봇이 듣는다 */
  noise(sourceTeam: TeamId, pos: THREE.Vector3, radius: number): void {
    for (const b of this.bots) {
      if (b.teamId === sourceTeam || !b.alive) continue;
      if (b.ctrl.position.distanceTo(pos) <= radius) this.brains.get(b.id)!.hear(pos, this.time);
    }
  }

  /** 봇이 맞았을 때 (보이지 않는 적에게) */
  hurt(b: Bot, from: THREE.Vector3): void {
    this.brains.get(b.id)?.onHurt(from, this.time);
  }
}

function freshPlan(): TeamPlan {
  return { site: 'A', phase: 'gather', execAt: 12, assign: new Map(), rotate: null, pickerId: null };
}
