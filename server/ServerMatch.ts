import * as THREE from 'three';
import { AbilityEffects } from '../src/abilities/AbilityEffects';
import { SLOTS, type AbilitySlot } from '../src/abilities/abilityData';
import type { StatusKind } from '../src/abilities/StatusEffects';
import { applyDamage } from '../src/combat/ballistics';
import { CombatSystem, type DamageEvent } from '../src/combat/CombatSystem';
import { Economy } from '../src/economy/Economy';
import { FOUNDRY } from '../src/maps/foundry';
import { MapBuilder } from '../src/maps/MapBuilder';
import type { AABB } from '../src/physics/CollisionWorld';
import { DEFAULT_MATCH, type MatchConfig } from '../src/rounds/matchConfig';
import { RoundManager, type Side, type SiteId } from '../src/rounds/RoundManager';
import { getWeapon, WEAPON_BY_ID } from '../src/weapons/weaponData';
import type { ClientMsg, LobbyPlayer, NetPlayer, PlayerState, ServerMsg, V3 } from '../src/net/protocol';
import { Avatar } from './Avatar';
import { noop } from './stubs';

const SHIELDS: Record<string, { value: number; price: number }> = {
  'shield-light': { value: 25, price: 400 },
  'shield-heavy': { value: 50, price: 1000 },
};
const STATUS_KINDS: StatusKind[] = ['concuss', 'suppress', 'jam', 'slow', 'haste', 'stim'];
/** 지연 보정 최대 (초) */
const MAX_REWIND = 0.25;
/** 이동 검사: 한 상태 사이 최대 이동 속도 (질주 44m/s 포함) */
const MAX_SPEED = 50;

const v3 = (v: THREE.Vector3): V3 => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

/**
 * 서버 권한 경기: RoundManager(라운드) + Economy(크레딧) + Core + 명중 판정 + 능력 효과.
 * 클라이언트는 자기 이동 상태와 입력만 보내고, 결과는 스냅샷과 이벤트로 받는다.
 */
export class ServerMatch {
  readonly rm: RoundManager;
  readonly economy = new Economy();
  readonly avatars = new Map<string, Avatar>();
  private map = new MapBuilder(FOUNDRY).buildCollision();
  private combat: CombatSystem;
  private fx: AbilityEffects;
  private time = 0;
  private sideSwapped = false;
  /** 사격 한 번 동안 모은 예광탄 끝점 */
  private tracerEnds: V3[] = [];
  /** 누가 누구에게 언제 피해를 줬는지 (처치 관여) */
  private damagedBy = new Map<string, Map<string, number>>();
  private snapTimer = 0;

  constructor(
    players: LobbyPlayer[],
    private send: (id: string | null, msg: ServerMsg) => void,
    readonly config: MatchConfig = { ...DEFAULT_MATCH },
  ) {
    this.combat = new CombatSystem(this.map.collision, {
      onTracer: (_from, to) => this.tracerEnds.push(v3(to)),
      onHit: (e) => {
        this.markDamage(e.shooter.id, e.target.id);
        this.send(null, { t: 'hit', shooter: e.shooter.id, target: e.target.id, part: e.part, damage: e.dealt, point: v3(e.point), from: v3(e.from) });
      },
      onKill: (e) => this.onKill(e),
    });
    this.fx = new AbilityEffects(this.map.collision, this.combat, noop(), noop());
    this.rm = new RoundManager(this.config, {
      onRoundSetup: (r) => this.setupRound(r),
      onRoundEnd: (r) => {
        const survivors = new Set<string>();
        for (const p of this.rm.participants.values()) if (p.alive && p.team !== r.winner) survivors.add(p.id);
        this.economy.onRoundEnd(r.winner, survivors);
        this.fx.clear();
        this.send(null, { t: 'round', kind: 'end', reason: r.reason, winner: r.winner });
      },
      onSideSwap: () => {
        this.economy.resetHalf();
        this.sideSwapped = true;
        this.send(null, { t: 'round', kind: 'swap' });
      },
      onMatchEnd: (w) => this.send(null, { t: 'round', kind: 'matchEnd', winner: w }),
      onPlantStart: () => this.send(null, { t: 'round', kind: 'plantStart' }),
      onPlanted: (id, site) => {
        this.economy.onPlant(this.rm.teamOn('attack'));
        this.avatars.get(id)?.abilities.addUlt(1);
        this.send(null, { t: 'round', kind: 'planted', site });
      },
      onDefused: (id) => {
        this.avatars.get(id)?.abilities.addUlt(1);
        this.send(null, { t: 'round', kind: 'defused' });
      },
      onDetonated: () => this.detonate(),
    });

    for (const p of players) {
      const a = new Avatar(p.id, p.name, p.team, p.agent, this.map.collision, this.fx, {
        revive: (av, hp, dur) => this.reviveLater(av, hp, dur),
        runItBack: (av, dur) => {
          if (!av.alive) return false;
          av.rib = { p: [...av.s.p], yaw: av.s.yaw, armor: av.vitals.armor, t: dur };
          return true;
        },
        onKilled: (av, e) => this.onDeath(av, e),
        onDeathAvoided: (av) => this.returnToMarker(av),
      });
      this.avatars.set(p.id, a);
      this.combat.addTarget(a);
      this.rm.addParticipant({ id: p.id, name: p.name, team: p.team });
      this.economy.add(p.id, p.team);
    }
  }

  start(): void {
    this.rm.start();
  }

  // ───────────────────────── 입력 ─────────────────────────

  handle(id: string, m: ClientMsg): void {
    const a = this.avatars.get(id);
    if (!a) return;
    switch (m.t) {
      case 'state':
        this.applyState(a, m.s);
        break;
      case 'fire':
        this.fire(a, m.weapon, m.eye, m.dirs, m.at);
        break;
      case 'buy':
        this.buy(a, m.item);
        break;
      case 'sell':
        this.sell(a, m.item);
        break;
      case 'drop':
        if (a.alive && this.rm.core.carrierId === id) {
          const f = new THREE.Vector3(-Math.sin(a.s.yaw), 0, -Math.cos(a.s.yaw));
          this.rm.dropCore(id, { x: a.s.p[0] + f.x * 1.2, y: a.s.p[1], z: a.s.p[2] + f.z * 1.2 });
        }
        break;
      case 'cast':
        this.cast(a, m);
        break;
      case 'dev':
        // 테스트 서버(FAST=1)에서만: 이동 검사 없이 순간이동
        if (process.env.FAST && a.alive) this.teleport(a, m.p, m.yaw);
        break;
    }
  }

  private applyState(a: Avatar, s: PlayerState): void {
    // 순간이동 전에 보낸 상태 (옛 위치)는 무시
    if ((s.tp ?? 0) < (this.tpSeq.get(a.id) ?? 0)) return;
    if (!a.alive) {
      a.s = { ...a.s, yaw: s.yaw, pitch: s.pitch };
      return;
    }
    // 이동 검사: 너무 빠르면 되돌림. 라운드 시작 전에는 스폰 구역 안
    const prev = a.s.p;
    const dist = Math.hypot(s.p[0] - prev[0], s.p[2] - prev[2]);
    const dt = 1 / 30;
    if (dist > MAX_SPEED * dt * 3 + 1.5 && (this.lastTeleport.get(a.id) ?? -1e9) < this.time - 0.5) {
      const seq = (this.tpSeq.get(a.id) ?? 0) + 1;
      this.tpSeq.set(a.id, seq);
      this.send(a.id, { t: 'teleport', p: prev, yaw: a.s.yaw, seq });
      return;
    }
    if (this.rm.state === 'BuyPhase' || this.rm.state === 'Waiting') {
      const z = this.spawnZone(a.team);
      s = { ...s, p: [THREE.MathUtils.clamp(s.p[0], z.minX, z.maxX), s.p[1], THREE.MathUtils.clamp(s.p[2], z.minZ, z.maxZ)] };
    }
    a.setState(s, this.time);
    a.invulnerable = a.invulnFor > 0 || (a.agent === 'gale' && !!s.dash);
  }

  private lastTeleport = new Map<string, number>();
  private tpSeq = new Map<string, number>();

  private teleport(a: Avatar, p: V3, yaw: number): void {
    a.place(p, yaw);
    this.lastTeleport.set(a.id, this.time);
    const seq = (this.tpSeq.get(a.id) ?? 0) + 1;
    this.tpSeq.set(a.id, seq);
    this.send(a.id, { t: 'teleport', p, yaw, seq });
  }

  /** 사격: 그 시각으로 되감아 판정 */
  private fire(a: Avatar, weaponId: string, eye: V3, dirs: V3[], at: number): void {
    if (!a.alive || this.weaponsLocked) return;
    const owned = weaponId === a.primary || weaponId === a.secondary || weaponId === 'blade' || (weaponId === 'storm' && a.storm > 0);
    if (!owned || !WEAPON_BY_ID.has(weaponId)) return;
    // 무력화: 주무기 사용 불가
    if (weaponId === a.primary && this.fx.status.has(a.id, 'jam')) return;
    const def = getWeapon(weaponId);
    const last = a.lastFire.get(weaponId) ?? -1;
    if (this.time - last < (0.8 / def.fireRate) - 0.02) return;
    a.lastFire.set(weaponId, this.time);
    if (weaponId === 'storm') a.storm--;
    // 눈 위치가 몸과 너무 멀면 무시
    const e = new THREE.Vector3(...eye);
    if (e.distanceTo(a.eyePos(new THREE.Vector3())) > 2.5) e.copy(a.eyePos(new THREE.Vector3()));
    const t = THREE.MathUtils.clamp(at, this.time - MAX_REWIND, this.time);
    for (const o of this.avatars.values()) if (o !== a) o.rewind(t);
    this.tracerEnds = [];
    const ds = dirs.slice(0, 16).map((d) => new THREE.Vector3(...d).normalize());
    if (def.category === 'melee') this.combat.melee(a.shooter, def, e, ds[0]);
    else this.combat.fire(a.shooter, def, e, ds, e);
    for (const o of this.avatars.values()) o.rewind(null);
    if (def.category !== 'melee') this.send(null, { t: 'shot', shooter: a.id, weapon: weaponId, from: v3(e), to: this.tracerEnds });
  }

  private cast(a: Avatar, m: Extract<ClientMsg, { t: 'cast' }>): void {
    const ab = a.abilities;
    const slot = m.slot;
    if (!SLOTS.includes(slot)) return;
    if (this.rm.state === 'Waiting' || this.rm.state === 'RoundEnd' || this.rm.state === 'MatchEnd') return;
    a.aim(m.eye, m.aim);
    let ok: boolean;
    const d = ab.def(slot);
    if (m.points?.length && ab.isMapTargeted(slot)) ok = ab.useAt(slot, m.points.map((p) => new THREE.Vector3(...p)));
    else if (d.effect === 'faultline' && m.held !== undefined && !ab.pendingActivation(slot)) {
      const len = ab.faultLength(d, m.held);
      const flat = new THREE.Vector3(m.aim[0], 0, m.aim[2]).normalize();
      const target = a.pos.addScaledVector(flat, Math.max(1, len - 2));
      ok = ab.use(slot, undefined, target);
    } else ok = ab.use(slot, m.variant);
    // 다른 사람들 화면에서 같은 능력을 재현
    if (ok) for (const o of this.avatars.values()) if (o !== a) this.send(o.id, { t: 'cast', id: a.id, slot, eye: m.eye, aim: m.aim, variant: m.variant, points: m.points, held: m.held });
  }

  // ───────────────────────── 구매 ─────────────────────────

  private canShop(a: Avatar): boolean {
    return this.rm.state === 'BuyPhase' && a.alive;
  }

  private buy(a: Avatar, item: string): void {
    if (!this.canShop(a)) return;
    const w = WEAPON_BY_ID.get(item);
    if (w && w.price > 0 && (w.slot === 1 || w.slot === 2)) {
      const cur = w.slot === 1 ? a.primary : a.secondary;
      if (cur === item || !this.economy.spend(a.id, w.price)) return;
      a.purchases.push({ item, paid: w.price, prevWeapon: cur });
      if (w.slot === 1) a.primary = item;
      else a.secondary = item;
      return;
    }
    const sh = SHIELDS[item];
    if (sh) {
      if (a.vitals.armor >= sh.value || !this.economy.spend(a.id, sh.price)) return;
      a.purchases.push({ item, paid: sh.price, prevArmor: a.vitals.armor });
      a.vitals.armor = sh.value;
      return;
    }
    if (item.startsWith('ability-')) {
      const slot = item.slice(8) as AbilitySlot;
      const ab = a.abilities;
      if (!SLOTS.includes(slot) || !ab.canBuy(slot) || !this.economy.spend(a.id, ab.def(slot).cost)) return;
      a.purchases.push({ item, paid: ab.def(slot).cost });
      ab.buyCharge(slot);
    }
  }

  private sell(a: Avatar, item: string): void {
    if (!this.canShop(a)) return;
    const i = a.purchases.map((p) => p.item).lastIndexOf(item);
    if (i < 0) return;
    const p = a.purchases.splice(i, 1)[0];
    const w = WEAPON_BY_ID.get(item);
    if (w) {
      if (w.slot === 1) a.primary = p.prevWeapon ?? null;
      else a.secondary = p.prevWeapon ?? 'tack';
    } else if (SHIELDS[item]) a.vitals.armor = p.prevArmor ?? 0;
    else if (item.startsWith('ability-')) a.abilities.sellCharge(item.slice(8) as AbilitySlot);
    this.economy.refund(a.id, p.paid);
  }

  // ───────────────────────── 라운드 ─────────────────────────

  get weaponsLocked(): boolean {
    const s = this.rm.state;
    return s === 'BuyPhase' || s === 'RoundStart' || s === 'Waiting';
  }

  private setupRound(round: number): void {
    const swap = this.sideSwapped || round === 1;
    this.fx.clear();
    this.fx.status.clear();
    const bySide: Record<Side, Avatar[]> = { attack: [], defense: [] };
    for (const a of this.avatars.values()) {
      const side = this.rm.sideOf(a.teamId);
      a.team = side;
      bySide[side].push(a);
      const keep = !a.died && !swap;
      a.alive = true;
      a.invulnerable = false;
      a.reprise = 0;
      a.reviveIn = 0;
      a.rib = null;
      a.storm = 0;
      a.vitals.health = 100;
      if (!keep) {
        a.vitals.armor = 0;
        a.primary = null;
        a.secondary = 'tack';
      }
      a.purchases = [];
      a.died = false;
      if (swap) a.abilities.resetAll();
      else a.abilities.roundStart();
    }
    this.sideSwapped = false;
    this.economy.clearRewards();
    this.damagedBy.clear();
    // 스폰 자리 배정
    for (const side of ['attack', 'defense'] as Side[]) {
      const pts = side === 'attack' ? this.map.spawns.attackers : this.map.spawns.defenders;
      bySide[side].forEach((a, i) => {
        const sp = pts[(i * 2 + 1) % pts.length];
        this.teleport(a, [sp.position.x, 0, sp.position.z], sp.yaw);
      });
    }
    // Core: 공격 스폰 앞 바닥
    const atk = this.map.spawns.attackers;
    const sp = atk[Math.floor(atk.length / 2)];
    this.rm.placeCoreOnGround({ x: sp.position.x, y: 0, z: sp.position.z - 4.5 });
    this.send(null, { t: 'round', kind: 'setup' });
  }

  private markDamage(shooter: string, target: string): void {
    let m = this.damagedBy.get(target);
    if (!m) this.damagedBy.set(target, (m = new Map()));
    m.set(shooter, this.time);
  }

  /** 처치 이벤트 (총·능력·폭발 모두) */
  private onKill(e: DamageEvent): void {
    const killer = this.avatars.get(e.shooter.id);
    const victim = this.avatars.get(e.target.id);
    if (!victim) return;
    const kp = this.rm.participants.get(e.shooter.id);
    const vp = this.rm.participants.get(victim.id);
    const enemyKill = !!killer && !!kp && !!vp && kp.team !== vp.team;
    if (enemyKill) {
      killer!.abilities.addUlt(1);
      killer!.abilities.onKill();
      if (killer!.storm > 0) killer!.storm = 5;
    }
    // 처치 관여: 마지막 처치 시각 (흡수 능력·되살아나기 생존)
    const now = this.time;
    for (const [sid, t] of this.damagedBy.get(victim.id) ?? []) {
      const s = this.avatars.get(sid);
      if (s && (now - t < 10 || sid === e.shooter.id)) {
        s.lastKillAt = performance.now();
        s.reprise = 0;
      }
    }
    if (killer && enemyKill) {
      killer.lastKillAt = performance.now();
      killer.reprise = 0;
    }
    this.send(null, { t: 'kill', shooter: e.shooter.id, shooterName: e.shooter.name, target: victim.id, targetName: victim.name, weapon: e.weapon.name, head: e.part === 'head' });
  }

  private onDeath(a: Avatar, e: DamageEvent): void {
    a.alive = false;
    a.died = true;
    a.storm = 0;
    a.abilities.addUlt(1);
    const vp = this.rm.participants.get(a.id);
    if (vp) this.economy.onKill(e.shooter.id, vp.team);
    this.rm.notifyDeath(a.id, e.shooter.id, { x: a.s.p[0], y: Math.max(0, a.s.p[1]), z: a.s.p[2] });
  }

  /** REKINDLE: 표식으로 돌아옴 */
  private returnToMarker(a: Avatar): void {
    const r = a.rib;
    if (!r) return;
    a.rib = null;
    a.vitals.health = 100;
    a.vitals.armor = r.armor;
    this.teleport(a, r.p, r.yaw);
  }

  /** REPRISE: 1.5초 뒤 되살아남 */
  private reviveLater(a: Avatar, hp: number, dur: number): boolean {
    if (a.alive || a.reviveIn > 0 || this.rm.state === 'RoundEnd') return false;
    a.reviveIn = 1.5;
    this.pendingRevive.set(a.id, [hp, dur]);
    return true;
  }

  private pendingRevive = new Map<string, [number, number]>();

  private detonate(): void {
    const c = this.rm.core;
    if (!c.position) return;
    this.send(null, { t: 'round', kind: 'detonated' });
    const center = new THREE.Vector3(c.position.x, c.position.y + 0.5, c.position.z);
    const { explosionRadius: R, explosionDamage: D } = this.config;
    const weapon = { ...getWeapon('blade'), name: 'EXPLOSION' };
    const shooter = { id: 'core', name: 'CORE', team: 'attack' as const };
    for (const a of this.avatars.values()) {
      if (!a.alive) continue;
      const pos = a.center(new THREE.Vector3());
      const dist = pos.distanceTo(center);
      if (dist > R) continue;
      const damage = Math.round(D * (1 - dist / R));
      const dealt = applyDamage(a.vitals, damage);
      if (a.vitals.health > 0) continue;
      const e: DamageEvent = { shooter, target: a, weapon, part: 'body', damage, dealt: dealt.health + dealt.armor, point: pos, from: center, killed: true, distance: dist };
      a.alive = false;
      a.onKilled(e);
      this.onKill(e);
    }
  }

  siteAt(p: V3): SiteId | null {
    for (const id of ['A', 'B'] as SiteId[]) {
      const s = this.map.sites[id];
      if (p[0] >= s.minX && p[0] <= s.maxX && p[2] >= s.minZ && p[2] <= s.maxZ) return id;
    }
    return null;
  }

  private spawnZone(side: Side): AABB {
    const pts = side === 'attack' ? this.map.spawns.attackers : this.map.spawns.defenders;
    const half = this.map.def.cellSize / 2 - 0.35;
    const b: AABB = { minX: Infinity, minY: 0, minZ: Infinity, maxX: -Infinity, maxY: 6, maxZ: -Infinity };
    for (const s of pts) {
      b.minX = Math.min(b.minX, s.position.x - half);
      b.maxX = Math.max(b.maxX, s.position.x + half);
      b.minZ = Math.min(b.minZ, s.position.z - half);
      b.maxZ = Math.max(b.maxZ, s.position.z + half);
    }
    return b;
  }

  // ───────────────────────── 매 틱 ─────────────────────────

  update(dt: number): void {
    this.time += dt;
    const rm = this.rm;
    rm.update(dt);
    this.fx.update(dt, 'attack');
    const c = rm.core;
    for (const a of this.avatars.values()) {
      a.abilities.update(dt);
      if (a.invulnFor > 0) a.invulnFor -= dt;
      // 되살아나기 (1.5초 뒤)
      if (a.reviveIn > 0) {
        a.reviveIn -= dt;
        if (a.reviveIn <= 0) {
          const [hp, dur] = this.pendingRevive.get(a.id) ?? [100, 10];
          if (rm.revive(a.id)) {
            a.alive = true;
            a.vitals.health = hp;
            a.vitals.armor = 0;
            a.reprise = dur;
            a.invulnFor = 2;
          }
        }
      }
      if (a.alive && a.reprise > 0) {
        a.reprise -= dt;
        if (a.reprise <= 0) this.combat.applyDirectDamage(a.shooter, { ...getWeapon('blade'), name: 'REPRISE' }, a, 9999, a.center(new THREE.Vector3()));
      }
      if (a.rib) {
        a.rib.t -= dt;
        if (a.rib.t <= 0) this.returnToMarker(a);
      }
      if (!a.alive) continue;
      const at = { x: a.s.p[0], y: a.s.p[1], z: a.s.p[2] };
      const side = a.team;
      // Core 줍기: 공격팀이 밟거나 E
      if (side === 'attack' && c.status === 'dropped' && c.position) {
        const d = Math.hypot(c.position.x - at.x, c.position.z - at.z);
        if (d < 0.9 || (a.s.act === 1 && d < this.config.interactRange)) rm.tryPickup(a.id, at);
      }
      // 설치 / 해체: 키를 누르고 있고 움직이지 않을 때
      if (a.s.act === 1 && !a.s.moving && side === 'attack' && c.status === 'carried' && c.carrierId === a.id && a.s.grounded) rm.holdPlant(a.id, this.siteAt(a.s.p), at, dt);
      else rm.cancelPlant(a.id);
      if (a.s.act === 2 && !a.s.moving && side === 'defense' && c.status === 'planted') rm.holdDefuse(a.id, at, dt);
      else rm.cancelDefuse(a.id);
    }
    this.snapTimer -= dt;
    if (this.snapTimer <= 0) {
      this.snapTimer = 1 / 20;
      this.broadcastSnapshot();
    }
  }

  private broadcastSnapshot(): void {
    const rm = this.rm;
    const players: NetPlayer[] = [...this.avatars.values()].map((a) => {
      const st: NetPlayer['st'] = {};
      for (const k of STATUS_KINDS) {
        const t = this.fx.status.remaining(a.id, k);
        if (t > 0) st[k] = +t.toFixed(2);
      }
      return { id: a.id, s: a.s, alive: a.alive, hp: Math.round(a.vitals.health), armor: a.vitals.armor, st };
    });
    const round = {
      sides: { ...rm.sides }, state: rm.state, round: rm.round, timeLeft: +rm.timeLeft.toFixed(2), score: rm.score, core: rm.core,
      participants: [...rm.participants.values()], winner: rm.winner, lastResult: rm.lastResult, history: rm.history,
    };
    for (const a of this.avatars.values()) {
      const ab = a.abilities;
      this.send(a.id, {
        t: 'snap', time: this.time, players, round,
        you: {
          credits: this.economy.get(a.id), rewards: this.economy.lastRewards.get(a.id) ?? [],
          primary: a.primary, secondary: a.secondary, armor: a.vitals.armor,
          charges: { ...ab.charges }, ult: ab.ultPoints, refundable: a.purchases.map((p) => p.item),
        },
      });
    }
  }

  /** 접속이 끊긴 사람: 쓰러진 것으로 */
  removePlayer(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    if (a.alive) this.combat.applyDirectDamage({ id: 'disconnect', name: '연결 끊김', team: a.team === 'attack' ? 'defense' : 'attack' }, { ...getWeapon('blade'), name: 'DISCONNECT' }, a, 9999, a.center(new THREE.Vector3()));
  }
}
