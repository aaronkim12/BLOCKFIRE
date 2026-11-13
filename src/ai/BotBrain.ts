import * as THREE from 'three';
import { SLOTS, type AbilityEffect, type AbilitySlot } from '../abilities/abilityData';
import type { Damageable } from '../combat/CombatSystem';
import type { RoundManager, Side, SiteId, TeamId } from '../rounds/RoundManager';
import { Bot } from './Bot';
import type { Tactics } from './Tactics';

/**
 * 봇의 판단 (상태 기반 AI).
 *
 *   인지  : 시야각 + 벽·연막 가림 + 섬광 실명, 총소리·발소리 듣기, 팀원이 본 적 위치 공유
 *   전투  : 반응 시간 → 조준 오차가 줄어들며 추적 → 점사/연사 제어, 쏠 때 멈추고 쉴 때 좌우 피킹
 *   생존  : 체력이 낮거나 재장전이 필요하면 적에게서 안 보이는 엄폐 위치로
 *   목표  : 공격 — Core 줍기, 집결 → 진입, 설치, 설치 후 지키기 / 수비 — 구역·미드 지키기, 지원(로테이션), 재진입, 해체
 *   능력  : 캐릭터별 상황에 맞는 능력 사용
 *
 * think()는 0.12~0.18초마다 상황을 판단하고, frame()은 매 프레임 조준·사격을 처리한다.
 */

export interface Combatant {
  id: string;
  teamId: TeamId;
  d: Damageable;
  bot?: Bot;
  /** 조준할 머리 위치 */
  head(out: THREE.Vector3): THREE.Vector3;
}

export interface Sighting {
  pos: THREE.Vector3;
  time: number;
}

/** 위협: 본 것 / 들은 것 / 맞은 방향 */
interface Threat extends Sighting {
  kind: 'seen' | 'heard' | 'hurt';
}

/**
 * 능력 사용 상황. 캐릭터와 상관없이 능력의 효과 종류로 판단한다 (새 캐릭터가 늘어도 그대로 동작).
 *   execute  공격 진입      retake  설치된 Core 재진입     defend  밀고 들어오는 적 막기
 *   threat   안 보이는 적 확인    postplant  해체 방해     setup   수비 위치에 함정 설치
 *   fight    교전 중 강화   escape  빠져나가기           afterKill  처치 직후
 */
type Situation = 'execute' | 'retake' | 'defend' | 'threat' | 'postplant' | 'setup' | 'fight' | 'escape' | 'afterKill';

const UTIL: Record<AbilityEffect, Situation[]> = {
  stim: ['execute', 'retake', 'defend'],
  incendiary: ['postplant', 'defend', 'threat'],
  skysmoke: ['execute', 'defend', 'retake'],
  orbital: ['postplant', 'retake', 'defend'],
  blaze: ['execute', 'escape'],
  hothands: ['postplant', 'defend', 'threat'],
  curveball: ['threat', 'execute', 'retake'],
  runitback: ['fight'],
  cloudburst: ['execute', 'defend', 'escape'],
  tailwind: ['escape'],
  ruse: ['execute', 'defend', 'retake'],
  drone: ['execute', 'threat'],
  meddle: ['postplant', 'defend', 'threat'],
  aftershock: ['threat', 'postplant', 'defend'],
  flashpoint: ['threat', 'execute', 'retake'],
  arcrose: ['setup'],
  shear: ['setup'],
  razorvine: ['setup', 'postplant'],
  updraft: ['escape'],
  bladestorm: ['fight'],
  pickmeup: ['afterKill'],
  faultline: ['execute', 'retake', 'defend', 'threat'],
  quake: ['execute', 'retake', 'defend'],
  sticky: ['threat', 'defend', 'execute'],
  salvo: ['postplant', 'defend', 'threat'],
  armageddon: ['execute', 'defend', 'postplant'],
  steelgarden: ['retake', 'defend', 'execute'],
  notdeadyet: [],
};

/** 무기 종류별 교전 거리 (m): 이보다 멀면 쏘지 않는다 */
const RANGE: Record<string, number> = { sidearm: 32, smg: 30, shotgun: 13, rifle: 75, sniper: 110, melee: 2.4, core: 0 };

/** 팀이 공유하는 적 위치 정보 */
export class TeamIntel {
  readonly sightings = new Map<string, Sighting>();

  report(id: string, pos: THREE.Vector3, time: number): void {
    const s = this.sightings.get(id);
    if (s) {
      s.pos.copy(pos);
      s.time = time;
    } else this.sightings.set(id, { pos: pos.clone(), time });
  }

  recent(now: number, maxAge: number): Sighting[] {
    const out: Sighting[] = [];
    for (const s of this.sightings.values()) if (now - s.time <= maxAge) out.push(s);
    return out;
  }

  forget(id: string): void {
    this.sightings.delete(id);
  }

  clear(): void {
    this.sightings.clear();
  }
}

export type HoldKind = 'A' | 'B' | 'mid';

/** 팀의 이번 라운드 계획 */
export interface TeamPlan {
  /** 공격: 노리는 구역 */
  site: SiteId;
  /** 공격: 집결 중 / 진입 */
  phase: 'gather' | 'execute';
  /** 공격: 진입을 시작할 라운드 경과 시간 */
  execAt: number;
  /** 수비: 봇별 담당 위치 */
  assign: Map<string, HoldKind>;
  /** 수비: 지원하러 갈 구역 (적이 몰린 곳) */
  rotate: SiteId | null;
  /** 공격: 바닥의 Core를 주우러 갈 봇 */
  pickerId: string | null;
}

export interface BrainContext {
  /** 가지러 갈 바닥 무기 (없으면 null) */
  weaponFor?(bot: Bot): THREE.Vector3 | null;
  time: number;
  /** 교전 상태가 된 뒤 경과 시간 */
  activeTime: number;
  rm: RoundManager;
  tactics: Tactics;
  canMove: boolean;
  weaponsLocked: boolean;
  combatActive: boolean;
  sideOf(team: TeamId): Side;
  enemiesOf(team: TeamId): Combatant[];
  alliesOf(team: TeamId): Combatant[];
  intel(team: TeamId): TeamIntel;
  plan(team: TeamId): TeamPlan;
  combatant(id: string): Combatant | undefined;
  siteAt(p: THREE.Vector3): SiteId | null;
  /** 플레이어 id (아군 플레이어 호위) */
  playerId: string;
}

type Mode = 'idle' | 'travel' | 'hold' | 'engage' | 'cover' | 'search' | 'plant' | 'defuse' | 'pickup' | 'escort';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const DEG = Math.PI / 180;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class BotBrain {
  mode: Mode = 'idle';
  /** 디버그/테스트용: 마지막 판단 이유 */
  note = '';
  private thinkTimer = Math.random() * 0.15;
  // ── 표적
  target: Combatant | null = null;
  private targetVisible = false;
  /** think가 교전하기로 정함 (사거리 안) */
  private engaging = false;
  private lostTime = 0;
  private reaction = 0;
  private errYaw = 0;
  private errPitch = 0;
  private aimHead = false;
  /** 마지막으로 확인한 위협 위치 (본 것·들은 것·맞은 방향) */
  private threat: Threat | null = null;
  /** 이동 중 잠깐 돌아볼 곳 (멀리서 들린 소리) */
  private glance: Sighting | null = null;
  private now = 0;
  // ── 사격 리듬
  private burstLeft = 0;
  private pauseTimer = 0;
  private peekTimer = 0;
  private stopWhenFiring = true;
  // ── 위치
  private holdPos: THREE.Vector3 | null = null;
  private watch: THREE.Vector3 | null = null;
  private holdKey = '';
  private coverUntil = 0;
  private coverAgainAt = 0;
  private plantSpot: THREE.Vector3 | null = null;
  private lookAround = 0;
  private abilityCd = 0;
  private usedExecuteUtil = false;
  private usedSetup = false;

  constructor(readonly bot: Bot) {}

  /** 라운드 시작: 기억 초기화 */
  reset(): void {
    this.mode = 'idle';
    this.target = null;
    this.targetVisible = false;
    this.threat = null;
    this.glance = null;
    this.holdPos = null;
    this.watch = null;
    this.holdKey = '';
    this.plantSpot = null;
    this.coverUntil = 0;
    this.abilityCd = rand(2, 5);
    this.usedExecuteUtil = false;
    this.usedSetup = false;
    this.burstLeft = 0;
    this.pauseTimer = 0;
  }

  /** 소리를 들음 (총소리·발소리). 위치는 정확하지 않다 */
  hear(pos: THREE.Vector3, time: number): void {
    if (!this.bot.alive) return;
    const p = pos.clone().add(new THREE.Vector3(rand(-1.5, 1.5), 0, rand(-1.5, 1.5)));
    this.glance = { pos: p, time };
    // 본 위협이 최근에 있으면 그게 더 중요
    if (!this.threat || this.threat.kind === 'heard' || time - this.threat.time > 2) this.threat = { pos: p, time, kind: 'heard' };
  }

  /** 맞음: 보이지 않는 적이면 맞은 방향을 위협으로 기억 */
  onHurt(from: THREE.Vector3, time: number): void {
    this.threat = { pos: from.clone(), time, kind: 'hurt' };
    if (!this.targetVisible) this.bot.lookAt(from);
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  frame(dt: number, ctx: BrainContext): void {
    const bot = this.bot;
    if (!bot.alive) return;
    this.now = ctx.time;
    this.abilityCd -= dt;
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = rand(0.12, 0.18);
      this.think(ctx);
    }

    // ── 설치 / 해체 (진행 중에는 움직이지 않음)
    if (this.mode === 'plant' || this.mode === 'defuse') {
      bot.hold = true;
      bot.strafe = 0;
      bot.trigger = false;
      const p = bot.ctrl.position;
      const at = { x: p.x, y: p.y, z: p.z };
      const prog = this.mode === 'plant' ? ctx.rm.holdPlant(bot.id, ctx.siteAt(p), at, dt) : ctx.rm.holdDefuse(bot.id, at, dt);
      bot.interact = prog;
      if (prog < 0 || (this.mode === 'plant' && ctx.rm.core.status !== 'carried') || (this.mode === 'defuse' && ctx.rm.core.status !== 'planted')) {
        bot.interact = -1;
        bot.hold = false;
        this.mode = 'idle';
      }
      // 설치·해체 중에도 표적이 보이면 고개는 돌린다 (사격은 중단 후 think가 결정)
      return;
    }
    bot.interact = -1;

    // ── 조준 + 사격
    if (this.target && this.targetVisible && this.engaging && ctx.combatActive) {
      this.aim(dt, ctx);
    } else {
      bot.trigger = false;
      this.idleLook(dt);
    }
  }

  /** 표적을 조준하고 사격 리듬에 맞춰 방아쇠를 당긴다 */
  private aim(dt: number, ctx: BrainContext): void {
    const bot = this.bot;
    const t = this.target!;
    const point = this.aimHead ? t.head(_v) : t.d.center(_v);
    if (!this.aimHead) point.y += 0.15;
    bot.lookAt(point);
    // 초기 오차는 시간이 지나며 줄어든다 (표적이 움직이면 조금 다시 커짐)
    const decay = Math.exp(-bot.skill.errorDecay * dt);
    this.errYaw *= decay;
    this.errPitch *= decay;
    bot.lookYaw(Math.atan2(-(point.x - bot.ctrl.position.x), -(point.z - bot.ctrl.position.z)) + this.errYaw, this.wantPitchTo(point) + this.errPitch);

    this.reaction -= dt;
    const dist = bot.ctrl.position.distanceTo(t.d.center(_w));
    const tolerance = Math.atan2(this.aimHead ? 0.18 : 0.3, dist) + 0.004;
    const onTarget = bot.aimOffset < tolerance + Math.hypot(this.errYaw, this.errPitch);
    let fire = this.reaction <= 0 && onTarget && !bot.blinded && !ctx.weaponsLocked;
    const w = bot.weapon;
    // 멀리 있는 적은 멈춰 선 뒤에 쏜다 (이동 중 퍼짐 회피)
    if (fire && dist > 12 && w.category !== 'shotgun' && w.category !== 'melee' && bot.ctrl.horizontalSpeed > 1.2) {
      fire = false;
      bot.hold = true;
      bot.strafe = 0;
    }
    // 연사 제어: 거리가 멀면 짧게 끊어 쏜다
    if (w.automatic && fire) {
      if (this.pauseTimer > 0) {
        this.pauseTimer -= dt;
        fire = false;
      } else if (this.burstLeft <= 0) {
        this.burstLeft = dist < 10 ? 99 : dist < 22 ? Math.round(rand(3, 6)) : Math.round(rand(2, 4));
      }
    }
    const wasFiring = bot.trigger;
    bot.trigger = fire;
    if (fire && w.automatic && bot.ammoState.mag > 0) {
      // 대략 발사 간격마다 하나씩 소모
      this.burstLeft -= dt * w.fireRate;
      if (this.burstLeft <= 0) this.pauseTimer = dist < 22 ? rand(0.18, 0.32) : rand(0.3, 0.5);
    }
    // 쏠 때는 멈춰 서고(퍼짐 감소), 쉴 때는 좌우로 움직인다
    const shooting = fire || (wasFiring && this.pauseTimer <= 0);
    if (shooting && this.stopWhenFiring) {
      bot.strafe = 0;
      bot.hold = true;
    } else {
      this.peekTimer -= dt;
      if (this.peekTimer <= 0) {
        this.peekTimer = rand(0.3, 0.7);
        bot.strafe = Math.random() < 0.5 ? -1 : 1;
      }
    }
  }

  private wantPitchTo(p: THREE.Vector3): number {
    const eye = this.bot.eyePos(_w);
    return Math.atan2(p.y - eye.y, Math.hypot(p.x - eye.x, p.z - eye.z));
  }

  /** 할 일이 없을 때: 진행 방향 또는 지킬 곳을 바라보고 가끔 둘러본다 */
  private idleLook(dt: number): void {
    const bot = this.bot;
    bot.strafe = 0;
    const wp = bot.nextWaypoint;
    if (this.mode === 'search' && this.threat) {
      bot.lookAt(_v.copy(this.threat.pos).setY(this.threat.pos.y + 1.4));
      return;
    }
    // 이동 중 소리가 들린 쪽을 잠깐 돌아봄
    if (this.glance && this.now - this.glance.time < 1.2) {
      bot.lookAt(_v.copy(this.glance.pos).setY(this.glance.pos.y + 1.4));
      return;
    }
    if (wp && !bot.hold) {
      // 진행 방향 (경유점이 아주 가까우면 그다음)
      _v.copy(wp).setY(wp.y + 1.5);
      if (this.watch && bot.remaining < 6) bot.lookAt(this.watch);
      else bot.lookAt(_v);
      return;
    }
    if (this.watch) {
      this.lookAround -= dt;
      if (this.lookAround <= 0) this.lookAround = rand(2, 5);
      const sway = Math.sin(this.lookAround * 1.3) * 0.25;
      bot.lookAt(_v.copy(this.watch).setY(this.watch.y + 1.4));
      bot.lookYaw(Math.atan2(-(this.watch.x - bot.ctrl.position.x), -(this.watch.z - bot.ctrl.position.z)) + sway, 0);
    }
  }

  // ───────────────────────── 판단 ─────────────────────────

  private think(ctx: BrainContext): void {
    const bot = this.bot;
    if (!ctx.canMove) {
      bot.stop();
      return;
    }
    this.perceive(ctx);
    // 아군이 건네준(바닥에 버린) 총을 가지러 간다
    const fetch = ctx.weaponFor?.(bot) ?? null;
    if (fetch) {
      bot.hold = false;
      if (!bot.goal || bot.goal.distanceToSquared(fetch) > 0.25) bot.goTo(fetch, true);
      return;
    }
    if (!ctx.combatActive) {
      // 구매 단계: 제자리에서 둘러본다
      bot.hold = true;
      return;
    }

    // 설치·해체 중: 계속할지 판단
    if (this.mode === 'plant' || this.mode === 'defuse') {
      if (this.shouldAbortInteract(ctx)) {
        if (this.mode === 'plant') ctx.rm.cancelPlant(bot.id);
        else ctx.rm.cancelDefuse(bot.id);
        bot.interact = -1;
        this.mode = 'engage';
      } else return;
    }

    this.engaging = false;
    bot.hold = false;
    bot.crouch = false;
    bot.walk = false;
    bot.trigger = bot.trigger && this.targetVisible;

    // ── 1) 교전 (무기 사거리 안) — 사거리 밖이면 위협으로만 기억
    if (this.target && this.targetVisible) {
      const dist = this.target.d.center(_v).distanceTo(bot.ctrl.position);
      const range = RANGE[bot.weapon.category] ?? 40;
      if (dist <= range || bot.weapon.category === 'melee') {
        this.engage(ctx);
        return;
      }
      bot.trigger = false;
    }
    bot.strafe = 0;
    // 엄폐 중이면 재장전이 끝날 때까지 기다림
    if (this.mode === 'cover' && (ctx.time < this.coverUntil || bot.reloading) && bot.moving) return;
    if (this.mode === 'cover' && (ctx.time < this.coverUntil || bot.reloading)) {
      bot.hold = true;
      return;
    }
    // 탄창이 많이 비었으면 조용할 때 재장전
    const a = bot.ammoState;
    if (!bot.reloading && a.mag < bot.weapon.magazine * 0.4 && a.reserve > 0) bot.startReload();

    // ── 2) 최근 위협: 그쪽을 경계하거나 확인하러 감
    if (this.threat && ctx.time - this.threat.time < 5 && this.reactToThreat(ctx)) return;

    // ── 3) 목표
    this.objective(ctx);
  }

  /** 보이는 적 찾기 + 팀에 알림 */
  private perceive(ctx: BrainContext): void {
    const bot = this.bot;
    const intel = ctx.intel(bot.teamId);
    let best: Combatant | null = null;
    let bestD = Infinity;
    let currentVisible = false;
    const blind = bot.blinded;
    for (const e of ctx.enemiesOf(bot.teamId)) {
      if (!e.d.alive) {
        intel.forget(e.id);
        continue;
      }
      const c = e.d.center(_v);
      const d = c.distanceTo(bot.ctrl.position);
      if (d > 70) continue;
      // 아주 가까우면 시야각 밖이어도 알아챈다
      if (d > 3 && !bot.inFov(c)) continue;
      if (blind) continue;
      const seen = bot.canSee(c) || bot.canSee(e.head(_w));
      if (!seen) continue;
      intel.report(e.id, c, ctx.time);
      if (e === this.target) currentVisible = true;
      // 지금 표적을 우선 (자주 바꾸지 않음)
      const score = d - (e === this.target ? 6 : 0);
      if (score < bestD) {
        bestD = score;
        best = e;
      }
    }
    if (best) {
      if (best !== this.target) this.acquire(best);
      this.targetVisible = true;
      this.lostTime = ctx.time;
      const bp = best.d.center(new THREE.Vector3());
      const range = RANGE[bot.weapon.category] ?? 40;
      if (bp.distanceTo(bot.ctrl.position) <= range) this.threat = { pos: bp, time: ctx.time, kind: 'seen' };
      else this.glance = { pos: bp, time: ctx.time };
    } else {
      this.targetVisible = currentVisible;
      if (!currentVisible && this.target && ctx.time - this.lostTime > 3) this.target = null;
    }
  }

  private acquire(t: Combatant): void {
    const s = this.bot.skill;
    this.target = t;
    this.reaction = rand(s.reaction[0], s.reaction[1]);
    const err = s.aimError * DEG;
    const ang = Math.random() * Math.PI * 2;
    this.errYaw = Math.cos(ang) * err;
    this.errPitch = Math.sin(ang) * err * 0.6;
    this.aimHead = Math.random() < s.headChance;
    this.burstLeft = 0;
    this.pauseTimer = 0;
    this.stopWhenFiring = Math.random() < s.stopToShoot;
  }

  /** 교전 중 움직임과 능력 */
  private engage(ctx: BrainContext): void {
    const bot = this.bot;
    const t = this.target!;
    const tp = t.d.center(new THREE.Vector3());
    const dist = tp.distanceTo(bot.ctrl.position);
    this.mode = 'engage';
    this.engaging = true;
    bot.stop();
    const visible = ctx.enemiesOf(bot.teamId).filter((e) => e.d.alive && ctx.intel(bot.teamId).sightings.get(e.id)?.time === ctx.time).length;

    // 체력이 낮거나 탄이 없으면 엄폐 (마지막 생존자는 버티는 대신 싸움)
    const lowHp = bot.vitals.health < 35 && ctx.alliesOf(bot.teamId).some((a) => a.d.alive && a.id !== bot.id);
    const empty = bot.ammoState.mag === 0 && bot.weapon.category !== 'melee';
    // 설치 전 공격팀은 시간이 없으면 물러서지 않는다
    const mustPush = ctx.sideOf(bot.teamId) === 'attack' && ctx.rm.core.status !== 'planted' && ctx.rm.timeLeft < 30;
    if ((lowHp || empty) && dist > 5 && !mustPush && (ctx.time >= this.coverAgainAt || empty)) {
      const cover = ctx.tactics.findCover(bot.ctrl.position, tp);
      if (cover) {
        this.mode = 'cover';
        this.engaging = false;
        this.coverUntil = ctx.time + rand(1.5, 3);
        this.coverAgainAt = ctx.time + 6;
        bot.goTo(cover);
        bot.trigger = false;
        if (Math.random() < 0.6 * bot.skill.abilityUse) this.useUtil('escape', tp);
        this.note = 'cover';
        return;
      }
    }

    // 근거리 무기는 거리를 좁힌다, 저격총은 버틴다. 칼만 남았으면 달려든다
    const cat = bot.weapon.category;
    if ((cat === 'shotgun' || cat === 'smg' || cat === 'melee') && dist > (cat === 'shotgun' ? 6 : cat === 'melee' ? 1.5 : 12)) {
      bot.goTo(tp);
      bot.walk = cat !== 'melee';
      if (cat === 'melee') bot.hold = false;
    }
    if (cat === 'sniper') bot.strafe = 0;
    // 멀리서 연사할 때는 가끔 앉는다
    bot.crouch = dist > 18 && bot.weapon.automatic && Math.random() < 0.25;

    // 능력: 여럿이 보이면 궁극기(오버드라이브), 방벽은 먼 적 앞에
    if (this.abilityCd <= 0 && Math.random() < 0.5 * bot.skill.abilityUse) {
      if (visible >= 2 && this.useUtil('fight', tp, true)) this.abilityCd = 8;
      else if (bot.vitals.health < 60 && dist > 8 && this.useUtil('escape', tp)) this.abilityCd = 8;
      else this.abilityCd = 1.5;
    }
    this.note = `engage ${t.id}`;
  }

  /** 설치·해체를 그만두고 싸워야 하는지 */
  private shouldAbortInteract(ctx: BrainContext): boolean {
    if (!this.target || !this.targetVisible) return false;
    const c = ctx.rm.core;
    if (this.mode === 'plant') return c.plantProgress < 0.6;
    // 해체: 남은 시간이 빠듯하면 끝까지 한다
    const remaining = (1 - c.defuseProgress) * ctx.rm.config.defuseTime;
    return c.timer - remaining > 3 && c.defuseProgress < 0.75;
  }

  /** 보이지 않는 위협에 대한 반응. 처리했으면 true (false면 목표 행동을 계속) */
  private reactToThreat(ctx: BrainContext): boolean {
    const bot = this.bot;
    const th = this.threat!;
    const d = th.pos.distanceTo(bot.ctrl.position);
    const age = ctx.time - th.time;
    // 멀리서 들린 소리는 돌아보기만 하고 하던 일을 계속한다
    if (th.kind === 'heard' && d > 14) return false;
    // 목표 행동이 급하면(설치된 Core 해체/설치 직전) 위협을 무시
    const side = ctx.sideOf(bot.teamId);
    const core = ctx.rm.core;
    if (side === 'defense' && core.status === 'planted' && core.timer < 20) return false;
    if (core.carrierId === bot.id && ctx.plan(bot.teamId).phase === 'execute') return false;
    if (core.status === 'dropped' && ctx.plan(bot.teamId).pickerId === bot.id) return false;
    if (side === 'attack' && core.status !== 'planted' && ctx.rm.timeLeft < 25) return false;

    // 능력: 섬광/정찰 비콘으로 먼저 확인
    if (this.abilityCd <= 0 && d < 25 && d > 5 && Math.random() < 0.5 * bot.skill.abilityUse) {
      this.abilityCd = this.useUtil('threat', th.pos.clone().setY(th.pos.y + 1)) ? 5 : 1;
    }
    // 방금 본/맞은/가까이서 들은 위협: 잠깐 멈춰서 그쪽을 겨눈다
    if (age < 1.5) {
      this.mode = 'search';
      bot.stop();
      bot.hold = true;
      this.note = 'watch threat';
      return true;
    }
    // 그다음엔 확인하러 감 — 공격팀이나 가까운 위협만 (수비는 자리를 크게 비우지 않음)
    const chase = ctx.sideOf(bot.teamId) === 'attack' ? d < 20 : d < 10;
    if (th.kind !== 'heard' && chase && d > 2) {
      this.mode = 'search';
      bot.walk = true;
      bot.goTo(th.pos);
      this.note = 'search';
      return true;
    }
    return false;
  }

  // ───────────────────────── 목표 ─────────────────────────

  private objective(ctx: BrainContext): void {
    const bot = this.bot;
    const side = ctx.sideOf(bot.teamId);
    const core = ctx.rm.core;
    const plan = ctx.plan(bot.teamId);
    const tac = ctx.tactics;
    const pos = bot.ctrl.position;

    if (side === 'attack') {
      // Core가 바닥에 있고 내가 주울 차례
      if (core.status === 'dropped' && core.position && plan.pickerId === bot.id) {
        this.mode = 'pickup';
        bot.goTo(_v.set(core.position.x, core.position.y, core.position.z));
        this.note = 'pickup core';
        return;
      }
      if (core.status === 'planted' && core.position) {
        this.postPlant(ctx, _v.set(core.position.x, core.position.y, core.position.z).clone());
        return;
      }
      const site = tac.sites[plan.site];
      if (core.status === 'carried' && core.carrierId === bot.id) {
        if (plan.phase === 'gather') {
          this.holdAt(ctx, `stage-${plan.site}`, site.staging, site.entrance, 2);
          this.note = 'carrier gather';
          return;
        }
        // 진입: 팀원이 먼저 들어가면(또는 6초 뒤) 설치 위치로
        const teamIn = ctx.alliesOf(bot.teamId).some((a) => a.id !== bot.id && a.d.alive && ctx.siteAt(a.d.center(_w)) === plan.site);
        if (!teamIn && ctx.activeTime < plan.execAt + 6 && pos.distanceTo(site.entrance) < 10) {
          this.holdAt(ctx, `wait-${plan.site}`, pos.clone(), site.center, 0);
          this.note = 'carrier wait entry';
          return;
        }
        this.plantSpot ??= tac.plantSpot(plan.site);
        if (ctx.siteAt(pos) === plan.site && pos.distanceTo(this.plantSpot) < 1.2) {
          this.mode = 'plant';
          bot.stop();
          this.note = 'plant';
          return;
        }
        this.mode = 'travel';
        bot.goTo(this.plantSpot);
        this.note = 'carrier → plant spot';
        return;
      }
      // 아군 플레이어가 Core를 들고 있으면 호위
      if (core.status === 'carried' && core.carrierId === ctx.playerId) {
        const pl = ctx.combatant(ctx.playerId);
        if (pl?.d.alive) {
          const pp = pl.d.center(new THREE.Vector3()).setY(pl.d.center(_w).y - 1);
          const plSite = ctx.siteAt(pp);
          if (plSite) {
            this.holdAt(ctx, `in-${plSite}`, tac.nav.randomIn(tac.nav.nearestWalkable(this.siteSpot(ctx, plSite))), tac.defenseSpawn, 0);
          } else if (pos.distanceTo(pp) > 7) {
            this.mode = 'escort';
            bot.goTo(pp);
          } else {
            this.holdAt(ctx, 'escort', pos.clone(), pp.clone().add(pp.clone().sub(pos).normalize().multiplyScalar(10)), 0);
          }
          this.note = 'escort player';
          return;
        }
      }
      // 진입 전: 집결지, 진입 후: 구역 안의 자리
      if (plan.phase === 'gather') {
        this.holdAt(ctx, `stage-${plan.site}`, site.staging, site.entrance, 3);
        this.note = 'gather';
        return;
      }
      // 진입 직후 능력 (연막/비콘/섬광)
      if (!this.usedExecuteUtil && pos.distanceTo(site.entrance) < 12) {
        this.usedExecuteUtil = true;
        if (Math.random() < 0.7 * bot.skill.abilityUse) this.executeUtility(ctx, plan.site);
      }
      this.holdAt(ctx, `in-${plan.site}`, this.siteSpot(ctx, plan.site), tac.defenseSpawn, 0);
      this.note = 'execute';
      return;
    }

    // ── 수비
    if (core.status === 'planted' && core.position) {
      const cp = new THREE.Vector3(core.position.x, core.position.y, core.position.z);
      const d = pos.distanceTo(cp);
      if (core.defuserId && core.defuserId !== bot.id) {
        // 동료가 해체 중: 근처에서 공격팀이 올 만한 쪽을 지킨다
        const site = ctx.siteAt(cp) ?? 'A';
        const away = ctx.tactics.sites[site].entrance;
        this.holdAt(ctx, 'guard-defuse', cp.clone().lerp(away, 0.25), away, 1);
        this.note = 'guard defuser';
        return;
      }
      if (d < ctx.rm.config.interactRange - 0.3) {
        // 주변에 적이 보이지 않으면 해체
        this.mode = 'defuse';
        bot.stop();
        // 방벽으로 해체를 엄호
        if (this.threat && Math.random() < bot.skill.abilityUse) this.useUtil('escape', this.threat.pos);
        this.note = 'defuse';
        return;
      }
      // 재진입: 혼자면 잠깐 기다렸다가 같이 (시간이 촉박하면 바로)
      const near = ctx.alliesOf(bot.teamId).filter((a) => a.d.alive && a.d.center(_w).distanceTo(cp) < d + 4).length;
      if (near < 2 && core.timer > 25 && d < 18 && ctx.alliesOf(bot.teamId).filter((a) => a.d.alive).length > 1) {
        this.holdAt(ctx, 'retake-wait', pos.clone(), cp, 0);
        this.note = 'retake wait';
        return;
      }
      if (!this.usedExecuteUtil && d < 16) {
        this.usedExecuteUtil = true;
        if (Math.random() < 0.7 * bot.skill.abilityUse) {
          this.useUtil('retake', cp.clone().setY(cp.y + 1), true);
          this.useUtil('retake', cp.clone().setY(cp.y + 1));
        }
      }
      this.mode = 'travel';
      bot.goTo(cp);
      this.note = 'retake';
      return;
    }
    // 지원 요청이 있으면 그 구역으로
    const kind = plan.assign.get(bot.id) ?? 'mid';
    const target: HoldKind = plan.rotate && kind !== plan.rotate && (kind === 'mid' || Math.random() < 0.85) ? plan.rotate : kind;
    const holds = target === 'mid' ? tac.midHolds : tac.sites[target].holds;
    const idx = Math.abs(hashId(bot.id)) % holds.length;
    const h = holds[idx];
    this.holdAt(ctx, `def-${target}-${idx}`, h.pos, h.watch, 0.8);
    if (this.mode === 'hold' && !this.usedSetup) {
      this.usedSetup = true;
      // 들어올 길(입구) 쪽 6~9m 바닥에 함정
      const dir = h.watch.clone().sub(h.pos).setY(0);
      const len = Math.min(9, Math.max(4, dir.length() * 0.6));
      const spot = h.pos.clone().addScaledVector(dir.normalize(), len);
      this.useUtil('setup', spot);
      this.useUtil('setup', spot.clone().addScaledVector(dir, -1.5));
    }
    // 구역을 지키며 들어오는 적에게 능력
    if (target !== 'mid' && this.abilityCd <= 0) this.defendUtility(ctx, target);
    this.note = `defend ${target}`;
  }

  /** 구역 안의 내 자리 (봇마다 다른 칸) */
  private siteSpot(ctx: BrainContext, site: SiteId): THREE.Vector3 {
    const cells = ctx.tactics.sites[site].cells;
    const covered = cells.filter((c) => ctx.tactics.nav.coverAdj[ctx.tactics.nav.idx(c.r, c.c)]);
    const pool = covered.length ? covered : cells;
    return ctx.tactics.nav.center(pool[Math.abs(hashId(this.bot.id)) % pool.length]);
  }

  /** 한 위치로 가서 지키기 (같은 key면 위치를 다시 고르지 않음) */
  private holdAt(ctx: BrainContext, key: string, pos: THREE.Vector3, watch: THREE.Vector3, jitter: number): void {
    const bot = this.bot;
    if (this.holdKey !== key || !this.holdPos) {
      this.holdKey = key;
      this.holdPos = jitter > 0 ? ctx.tactics.nav.randomIn(ctx.tactics.nav.nearestWalkable(pos), jitter) : pos.clone();
    }
    this.watch = watch.clone();
    if (bot.ctrl.position.distanceTo(this.holdPos) > 1) {
      this.mode = 'travel';
      // 적 진영 쪽으로 다가갈 때는 걷는다 (발소리를 줄임)
      bot.walk = this.holdKey.startsWith('in-') && bot.remaining < 10;
      bot.goTo(this.holdPos);
    } else {
      this.mode = 'hold';
      bot.stop();
      bot.hold = true;
    }
  }

  private postPlant(ctx: BrainContext, core: THREE.Vector3): void {
    const bot = this.bot;
    if (this.holdKey !== 'postplant') {
      const spots = ctx.tactics.postPlantSpots(core);
      const pick = spots.length ? spots.sort((a, b) => a.distanceTo(bot.ctrl.position) - b.distanceTo(bot.ctrl.position))[Math.min(spots.length - 1, Math.floor(Math.random() * 3))] : core.clone();
      this.holdKey = 'postplant';
      this.holdPos = pick;
    }
    this.watch = core.clone();
    // 화염 지대/봉쇄장으로 해체를 막는다
    const defusing = ctx.rm.core.defuserId !== null;
    if (defusing && this.abilityCd <= 0) {
      this.abilityCd = this.useUtil('postplant', core, Math.random() < 0.5) || this.useUtil('postplant', core) ? 5 : 1;
    }
    if (bot.ctrl.position.distanceTo(this.holdPos!) > 1) {
      this.mode = 'travel';
      bot.goTo(this.holdPos!);
    } else {
      this.mode = 'hold';
      bot.stop();
      bot.hold = true;
    }
    this.note = 'post-plant';
  }

  private executeUtility(ctx: BrainContext, site: SiteId): void {
    const s = ctx.tactics.sites[site];
    const deep = s.holds[0]?.pos ?? s.center;
    // 궁극기 → 연막(수비 자리) → 정보/섬광/충격(구역 중심)
    if (this.bot.abilities.ultReady) this.useUtil('execute', s.center.clone().setY(s.center.y + 1), true);
    this.useUtil('execute', deep.clone().setY(deep.y + 0.5));
    this.useUtil('execute', s.center.clone().setY(s.center.y + 1.5));
    this.abilityCd = 3;
  }

  private defendUtility(ctx: BrainContext, site: SiteId): void {
    const bot = this.bot;
    const intel = ctx.intel(bot.teamId).recent(ctx.time, 3);
    const s = ctx.tactics.sites[site];
    const pushing = intel.filter((x) => x.pos.distanceTo(s.entrance) < 12);
    if (pushing.length === 0 || Math.random() > 0.6 * bot.skill.abilityUse) {
      this.abilityCd = 1;
      return;
    }
    const at = pushing[0].pos.clone().setY(pushing[0].pos.y + 0.5);
    if (pushing.length >= 2 && this.useUtil('defend', at, true)) this.abilityCd = 6;
    else this.abilityCd = this.useUtil('defend', at) ? 6 : 2;
  }

  /** 처치 직후 (흡수 능력) */
  onKill(): void {
    this.useUtil('afterKill');
  }

  /**
   * 상황에 맞는 능력 하나를 사용한다.
   * @param ult true면 궁극기만, false면 궁극기 제외
   */
  private useUtil(situation: Situation, target?: THREE.Vector3, ult = false): boolean {
    const bot = this.bot;
    const slots: AbilitySlot[] = ult ? ['ultimate'] : SLOTS.filter((x) => x !== 'ultimate').sort(() => Math.random() - 0.5);
    for (const slot of slots) {
      const d = bot.abilities.def(slot);
      if (!UTIL[d.effect].includes(situation) || !bot.abilities.canUse(slot)) continue;
      // 설치형은 이미 깔아 둔 게 있으면 건너뜀 (발동은 스스로)
      if (bot.abilities.pendingActivation(slot)) continue;
      if (bot.useAbility(slot, target)) {
        // 질주: 바람을 1초 모은 뒤 사용
        if (d.effect === 'tailwind') bot.env.fx.adv.schedule(1.05, () => bot.alive && bot.useAbility(slot));
        return true;
      }
    }
    return false;
  }
}

/** 봇 id → 고정 정수 (자리 배정에 사용) */
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h;
}
