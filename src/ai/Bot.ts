import * as THREE from 'three';
import type { AbilityEffects, FacingTarget } from '../abilities/AbilityEffects';
import { AbilitySystem } from '../abilities/AbilitySystem';
import type { AbilitySlot } from '../abilities/abilityData';
import type { Sound } from '../audio/Sound';
import { randomInCone, spreadAngle, type Vitals } from '../combat/ballistics';
import type { CombatSystem, DamageEvent } from '../combat/CombatSystem';
import type { Capsule } from '../combat/Hitbox';
import { PLAYER_SHAPE } from '../core/config';
import { MuzzleFlash } from '../effects/MuzzleFlash';
import { BladeStormVisual } from '../effects/BladeStormVisual';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { CharacterModel, DEFAULT_POSE, type CharacterPose, type Team } from '../player/CharacterModel';
import { PlayerController, type MoveIntent } from '../player/PlayerController';
import type { TeamId } from '../rounds/RoundManager';
import { getWeapon, type WeaponDef } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import type { BotSkill } from './botConfig';
import type { NavGrid } from './NavGrid';

/**
 * 봇 한 명의 몸: 이동(플레이어와 같은 물리), 조준, 무기, 능력, 애니메이션.
 * 무엇을 할지는 BotBrain이 정하고, 여기서는 그 명령을 실제 동작으로 옮긴다.
 */

export interface BotEnv {
  world: CollisionWorld;
  nav: NavGrid;
  combat: CombatSystem;
  sound: Sound;
  fx: AbilityEffects;
  surfaceAt(x: number, y: number, z: number): string;
  /** 총소리·발소리 (주변 적이 듣는다) */
  noise(source: Bot, pos: THREE.Vector3, radius: number): void;
}

interface Ammo {
  mag: number;
  reserve: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const DEG = Math.PI / 180;
const HIT_REACTION = 0.43;

/** 각도 차이 (-π..π) */
export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

export class Bot implements FacingTarget {
  alive = true;
  readonly vitals: Vitals = { health: 100, armor: 0 };
  /** 지금 진영 (전투 판정·색) */
  team: Team = 'attack';
  readonly ctrl: PlayerController;
  readonly abilities: AbilitySystem;
  pose: CharacterPose = { ...DEFAULT_POSE };
  /** 경기에서 쓰지 않으면 숨김 */
  enabled = true;
  onDeath?: (b: Bot, e: DamageEvent) => void;
  onHurt?: (b: Bot, e: DamageEvent) => void;
  /** 죽은 지 경과 시간 */
  deadTime = 0;
  /** 마지막 처치 시각 (흡수 능력) */
  lastKillAt = -1e9;
  /** 투척 단검 궁극기: 남은 단검 */
  stormKnives = 0;
  /** 되살아난 뒤 처치해야 하는 남은 시간 */
  repriseTimer = 0;
  /** 무적 (되살아난 직후·질주 중) */
  invulnerable = false;
  private invulnTimer = 0;
  /** REKINDLE: 남은 시간과 표식 */
  private ribTimer = 0;
  private ribMarker: { pos: THREE.Vector3; yaw: number; armor: number } | null = null;
  /** 되살아났을 때 (경기 진행에 알림, 성공하면 true) */
  onRevive?: (b: Bot) => boolean;

  // ── 무기
  primary: WeaponDef | null = null;
  secondary: WeaponDef = getWeapon('tack');
  slot: 'primary' | 'secondary' | 'melee' = 'secondary';
  private ammo = new Map<string, Ammo>();
  private fireTimer = 0;
  private reloadTimer = -1;
  private equipTimer = 0;
  private bloom = 0;
  /** 사격 중 (Brain이 매 프레임 설정) */
  trigger = false;
  private triggerWasDown = false;
  private semiDelay = 0;

  // ── 조준 (현재 / 목표)
  aimYaw = 0;
  aimPitch = 0;
  private wantYaw = 0;
  private wantPitch = 0;
  /** 즉시 돌림 (능력 투척 등) */
  private snap = false;

  // ── 이동
  private path: THREE.Vector3[] = [];
  private pathIdx = 0;
  goal: THREE.Vector3 | null = null;
  walk = false;
  crouch = false;
  /** 이동 대신 좌우로 흔들기 (교전 중 피킹) */
  strafe = 0;
  /** 경로를 따르지 않고 멈춤 */
  hold = false;
  private stuckTimer = 0;
  private stuckFrom = new THREE.Vector3();
  private jumpNext = false;
  private stepDist = 0;
  private renderPos = new THREE.Vector3();
  private hitTime = -1;
  /** 설치/해체 진행도 (애니메이션용, 아니면 -1) */
  interact = -1;

  private flash = new MuzzleFlash(0.18);
  private stormFx = new BladeStormVisual('world');
  readonly eyeCam = new THREE.PerspectiveCamera();

  constructor(
    readonly id: string,
    readonly name: string,
    readonly teamId: TeamId,
    readonly model: CharacterModel,
    readonly env: BotEnv,
    public skill: BotSkill,
    agentId: string,
  ) {
    this.ctrl = new PlayerController(env.world);
    this.abilities = new AbilitySystem({
      effects: env.fx,
      player: this.ctrl,
      camera: this.eyeCam,
      shooter: () => ({ id: this.id, name: this.name, team: this.team }),
      team: () => this.team,
      moveDir: () => this.moveDirection(),
      self: () => this,
      alive: () => this.alive,
      autonomous: true,
      lastKillAge: () => (performance.now() - this.lastKillAt) / 1000,
      equipBladeStorm: (n) => {
        this.stormKnives = n;
        void this.applyWeaponModel();
      },
      revive: (hp, dur) => this.revive(hp, dur),
      runItBack: (dur) => {
        if (!this.alive) return false;
        this.ribMarker = { pos: this.ctrl.position.clone(), yaw: this.aimYaw, armor: this.vitals.armor };
        this.ribTimer = dur;
        env.fx.adv.vfx.zoneBurst(this.ctrl.position, 1.2, 0xffb43c);
        return true;
      },
      onCast: (_d, kind) => {
        if (kind === 'dash') env.sound.play('dash', { at: this.ctrl.position });
        this.pose.fire = 0.6;
      },
    });
    this.abilities.setAgent(agentId);
    model.root.add(this.stormFx.group);
  }

  // ───────────────────────── Damageable ─────────────────────────

  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.ctrl.position).setY(this.ctrl.position.y + (this.ctrl.crouching ? 0.7 : 1.0));
  }

  eyePos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.ctrl.position).setY(this.ctrl.position.y + this.ctrl.eyeHeight);
  }

  /** 머리 (조준점) */
  headPos(out: THREE.Vector3): THREE.Vector3 {
    return this.alive ? this.model.headPosition(out) : this.eyePos(out);
  }

  facing(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyEuler(new THREE.Euler(this.aimPitch, this.aimYaw, 0, 'YXZ'));
  }

  hitboxes(): Capsule[] {
    return this.model.hitboxes();
  }

  onDamaged(e: DamageEvent): void {
    this.hitTime = 0;
    this.onHurt?.(this, e);
  }

  /** REKINDLE: 쓰러질 피해를 받으면 표식으로 돌아간다 */
  cheatDeath(): boolean {
    if (this.ribTimer <= 0) return false;
    this.returnToMarker();
    return true;
  }

  private returnToMarker(): void {
    const m = this.ribMarker;
    this.ribTimer = 0;
    this.ribMarker = null;
    if (!m) return;
    this.ctrl.spawn(m.pos.x, m.pos.y, m.pos.z, m.yaw);
    this.vitals.health = 100;
    this.vitals.armor = m.armor;
    this.path = [];
    this.env.fx.adv.vfx.zoneBurst(m.pos, 1.6, 0xffb43c);
  }

  /** 지진 등으로 공중에 띄워짐 */
  knock(vy: number): void {
    this.ctrl.velocity.y = Math.max(this.ctrl.velocity.y, vy);
    this.ctrl.grounded = false;
  }

  /** 내가 적을 처치함 */
  onKill(): void {
    this.lastKillAt = performance.now();
    this.repriseTimer = 0;
    this.abilities.onKill();
    if (this.stormKnives > 0) this.stormKnives = getWeapon('storm').magazine;
  }

  /** 궁극기 REPRISE: 쓰러진 자리에서 되살아남 */
  revive(hp: number, duration: number): boolean {
    if (this.alive || !this.enabled) return false;
    if (this.onRevive && !this.onRevive(this)) return false;
    this.alive = true;
    this.vitals.health = hp;
    this.vitals.armor = 0;
    this.deadTime = 0;
    this.repriseTimer = duration;
    this.invulnTimer = 2;
    this.pose.dead = -1;
    this.env.fx.adv.vfx.witherBurst(this.ctrl.position, 2.5, 0xff7ad1);
    this.env.sound.play('magic_charge', { at: this.ctrl.position, duration: 1, intensity: 1 });
    return true;
  }

  onKilled(e: DamageEvent): void {
    this.alive = false;
    this.stormKnives = 0;
    this.repriseTimer = 0;
    this.ribTimer = 0;
    this.ribMarker = null;
    this.deadTime = 0;
    this.trigger = false;
    this.reloadTimer = -1;
    this.interact = -1;
    this.path = [];
    this.goal = null;
    this.onDeath?.(this, e);
  }

  // ───────────────────────── 라운드 ─────────────────────────

  spawnAt(x: number, y: number, z: number, yaw: number, armor: number): void {
    this.ctrl.spawn(x, y, z, yaw);
    this.renderPos.set(x, y, z);
    this.aimYaw = this.wantYaw = yaw;
    this.aimPitch = this.wantPitch = 0;
    this.alive = this.enabled;
    this.vitals.health = 100;
    this.vitals.armor = armor;
    this.deadTime = 0;
    this.hitTime = -1;
    this.bloom = 0;
    this.trigger = false;
    this.reloadTimer = -1;
    this.interact = -1;
    this.path = [];
    this.goal = null;
    this.hold = false;
    this.strafe = 0;
    this.crouch = false;
    this.walk = false;
    this.pose = { ...DEFAULT_POSE };
    this.model.root.position.set(x, y, z);
    this.model.root.rotation.y = yaw;
    this.model.root.visible = this.enabled;
  }

  setTeamSide(side: Team, colorAsAlly: boolean): void {
    this.team = side;
    // 색은 진영이 아니라 플레이어 기준 아군(파랑)/적(빨강)으로 — 진영이 바뀌어도 피아 식별이 쉽다
    this.model.setTeam(colorAsAlly ? 'defense' : 'attack');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.model.root.visible = on;
    if (!on) this.alive = false;
  }

  /** 무기 구성 (사망 시 기본 장비로 돌아갈 때도 사용) */
  async setLoadout(primary: string | null, secondary = 'tack'): Promise<void> {
    this.primary = primary ? getWeapon(primary) : null;
    this.secondary = getWeapon(secondary);
    for (const d of [this.primary, this.secondary]) if (d) this.ammo.set(d.id, { mag: d.magazine, reserve: d.reserve });
    this.slot = this.primary ? 'primary' : 'secondary';
    await this.applyWeaponModel();
  }

  /** 라운드 시작: 살아남았으면 무기 유지, 탄약은 채움 */
  refillAmmo(): void {
    for (const d of [this.primary, this.secondary]) if (d) this.ammo.set(d.id, { mag: d.magazine, reserve: d.reserve });
    this.slot = this.primary ? 'primary' : 'secondary';
    void this.applyWeaponModel();
  }

  private async applyWeaponModel(): Promise<void> {
    const def = this.weapon;
    const t = await loadWeaponTemplate(def);
    if (this.weapon !== def) return;
    this.flash.object.removeFromParent();
    this.model.setWeapon(t);
    if (this.model.weapon) this.model.weapon.muzzle.add(this.flash.object);
    this.equipTimer = 0;
  }

  get weapon(): WeaponDef {
    if (this.stormKnives > 0) return getWeapon('storm');
    if (this.slot === 'melee') return getWeapon('blade');
    return this.slot === 'primary' && this.primary ? this.primary : this.secondary;
  }

  /** 남은 탄 전체 (주무기 + 권총) */
  get totalAmmo(): number {
    let n = 0;
    for (const d of [this.primary, this.secondary]) {
      const a = d ? this.ammo.get(d.id) : null;
      if (a) n += a.mag + a.reserve;
    }
    return n;
  }

  get ammoState(): Ammo {
    if (this.stormKnives > 0) return { mag: this.stormKnives, reserve: 0 };
    return this.ammo.get(this.weapon.id) ?? { mag: 0, reserve: 0 };
  }

  get reloading(): boolean {
    return this.reloadTimer >= 0;
  }

  /** 탄이 떨어졌을 때 주무기 ↔ 권총 교체, 둘 다 없으면 칼 */
  private switchIfEmpty(): void {
    if (this.slot === 'melee' || this.stormKnives > 0) return;
    const a = this.ammoState;
    if (a.mag > 0 || this.reloading) return;
    if (a.reserve > 0) {
      this.startReload();
      return;
    }
    const other = this.slot === 'primary' ? 'secondary' : 'primary';
    const od = other === 'primary' ? this.primary : this.secondary;
    const oa = od ? this.ammo.get(od.id) : null;
    if (od && oa && oa.mag + oa.reserve > 0) {
      this.slot = other;
      void this.applyWeaponModel();
    } else if (this.totalAmmo === 0) {
      this.slot = 'melee';
      void this.applyWeaponModel();
    }
  }

  startReload(): void {
    const a = this.ammoState;
    if (this.reloading || a.reserve <= 0 || a.mag >= this.weapon.magazine) return;
    this.reloadTimer = 0;
    this.env.sound.weapon(this.weapon.id, 'magOut', this.ctrl.position);
  }

  // ───────────────────────── 명령 (Brain이 호출) ─────────────────────────

  /** 목표 지점으로 이동 (경로 계산). 같은 목표면 다시 계산하지 않음 */
  goTo(target: THREE.Vector3, force = false): boolean {
    if (!force && this.goal && this.goal.distanceToSquared(target) < 0.25 && this.path.length) return true;
    const nav = this.env.nav;
    const cells = nav.findPath(nav.nearestWalkable(this.ctrl.position), nav.nearestWalkable(target));
    if (!cells) {
      this.path = [];
      this.goal = null;
      return false;
    }
    this.goal = target.clone();
    this.path = nav.smoothPath(cells, this.ctrl.position, target);
    this.pathIdx = 0;
    this.stuckTimer = 0;
    this.stuckFrom.copy(this.ctrl.position);
    return true;
  }

  stop(): void {
    this.path = [];
    this.goal = null;
  }

  get moving(): boolean {
    return this.path.length > 0 && this.pathIdx < this.path.length;
  }

  get arrived(): boolean {
    return !this.moving;
  }

  /** 남은 경로 거리 */
  get remaining(): number {
    if (!this.moving) return 0;
    let d = this.ctrl.position.distanceTo(this.path[this.pathIdx]);
    for (let i = this.pathIdx + 1; i < this.path.length; i++) d += this.path[i - 1].distanceTo(this.path[i]);
    return d;
  }

  /** 다음 경유점 (시선 처리용) */
  get nextWaypoint(): THREE.Vector3 | null {
    return this.moving ? this.path[this.pathIdx] : null;
  }

  lookAt(p: THREE.Vector3): void {
    const eye = this.eyePos(_v);
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    this.wantYaw = Math.atan2(-dx, -dz);
    this.wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  lookYaw(yaw: number, pitch = 0): void {
    this.wantYaw = yaw;
    this.wantPitch = pitch;
  }

  /** 목표 방향과의 조준 오차 (라디안) */
  get aimOffset(): number {
    return Math.hypot(angleDiff(this.wantYaw, this.aimYaw), this.wantPitch - this.aimPitch);
  }

  /** 능력 사용: 목표 지점을 향해(투척이면 포물선 각도로) 즉시 돌아서 사용 */
  useAbility(slot: AbilitySlot, target?: THREE.Vector3): boolean {
    if (!this.alive && !this.abilities.usableWhileDead(slot)) return false;
    if (!this.abilities.canUse(slot)) return false;
    const d = this.abilities.def(slot);
    if (target) {
      this.lookAt(target);
      // 보통 포물선으로 던지는 능력만 각도 계산 (휘는 섬광·연막탄은 그대로 조준)
      if (d.throwSpeed > 0 && d.effect !== 'curveball' && d.effect !== 'cloudburst') this.wantPitch = this.throwPitch(target, d.throwSpeed, 0);
      this.aimYaw = this.wantYaw;
      this.aimPitch = this.wantPitch;
      this.snap = true;
    }
    this.syncEyeCam();
    return this.abilities.use(slot, undefined, target);
  }

  /** 투척물이 target 근처에 떨어지는(섬광은 fuse초 뒤 그 근처에서 터지는) 발사 각도 */
  private throwPitch(target: THREE.Vector3, speed: number, fuse: number): number {
    const eye = this.eyePos(_v);
    const dist = Math.hypot(target.x - eye.x, target.z - eye.z);
    const dy = target.y - eye.y;
    let best = 0;
    let bestErr = Infinity;
    for (let p = -0.6; p <= 1.2; p += 0.02) {
      // AbilitySystem과 같은 투척 방향: 조준 + 위로 0.12
      const ax = Math.cos(p);
      const ay = Math.sin(p) + 0.12;
      const n = Math.hypot(ax, ay);
      const vx = (ax / n) * speed;
      const vy = (ay / n) * speed;
      let err: number;
      if (fuse > 0) {
        err = Math.abs(vx * fuse - dist) + Math.abs(vy * fuse - 8 * fuse * fuse - dy) * 0.5;
      } else {
        // y(t) = vy t - 8 t² = dy 의 해 (내려오는 쪽)
        const disc = vy * vy - 32 * -dy;
        if (disc < 0) continue;
        const t = (vy + Math.sqrt(disc)) / 16;
        err = Math.abs(vx * t - dist);
      }
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
    return best;
  }

  /** 지금 이동하려는 수평 방향 (돌진 방향) */
  private moveDirection(): THREE.Vector3 {
    const wp = this.nextWaypoint;
    if (wp) return new THREE.Vector3(wp.x - this.ctrl.position.x, 0, wp.z - this.ctrl.position.z).normalize();
    return new THREE.Vector3(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw));
  }

  private syncEyeCam(): void {
    this.eyePos(this.eyeCam.position);
    this.eyeCam.rotation.set(this.aimPitch, this.aimYaw, 0, 'YXZ');
    this.eyeCam.updateMatrixWorld(true);
  }

  // ───────────────────────── 시야 ─────────────────────────

  /** 눈에서 점까지 벽·연막에 가리지 않는지 */
  canSee(p: THREE.Vector3): boolean {
    const eye = this.eyePos(_v);
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const hit = this.env.world.raycast(eye.x, eye.y, eye.z, dx / d, dy / d, dz / d, d);
    if (hit && hit.distance < d - 0.25) return false;
    return !this.env.fx.blocksLine(eye, p);
  }

  /** 점이 시야각 안에 있는지 */
  inFov(p: THREE.Vector3, fovDeg = this.skill.fov): boolean {
    const eye = this.eyePos(_v);
    const to = _w.set(p.x - eye.x, 0, p.z - eye.z);
    const len = to.length();
    if (len < 0.01) return true;
    const fx = -Math.sin(this.aimYaw);
    const fz = -Math.cos(this.aimYaw);
    return (to.x * fx + to.z * fz) / len >= Math.cos((fovDeg / 2) * DEG);
  }

  get blinded(): boolean {
    return this.env.fx.isBlinded(this.id);
  }

  // ───────────────────────── 고정 틱 (물리) ─────────────────────────

  tick(dt: number, locked: boolean): void {
    if (!this.enabled) return;
    const c = this.ctrl;
    if (!this.alive) {
      c.tick({ forward: 0, strafe: 0, jump: false, walk: false, crouch: false }, dt);
      return;
    }
    c.yaw = this.aimYaw;
    const intent: MoveIntent = { forward: 0, strafe: 0, jump: false, walk: this.walk, crouch: this.crouch };
    if (!locked) {
      let mx = 0;
      let mz = 0;
      if (this.moving && !this.hold) {
        const wp = this.path[this.pathIdx];
        const dx = wp.x - c.position.x;
        const dz = wp.z - c.position.z;
        const d = Math.hypot(dx, dz);
        const last = this.pathIdx === this.path.length - 1;
        if (d < (last ? 0.35 : 0.6) && Math.abs(wp.y - c.position.y) < 1.2) {
          this.pathIdx++;
          if (this.pathIdx >= this.path.length) {
            this.path = [];
          }
        } else {
          mx = dx / d;
          mz = dz / d;
        }
        // 막힘 감지: 1.2초 동안 0.4m도 못 가면 점프해 보고, 다시 경로 계산
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.2) {
          if (c.position.distanceTo(this.stuckFrom) < 0.4) {
            this.jumpNext = true;
            if (this.goal) this.goTo(this.goal.clone(), true);
          }
          this.stuckTimer = 0;
          this.stuckFrom.copy(c.position);
        }
      }
      if (this.strafe !== 0) {
        // 조준 방향 기준 좌우
        mx += Math.cos(this.aimYaw) * this.strafe;
        mz += -Math.sin(this.aimYaw) * this.strafe;
      }
      if (mx !== 0 || mz !== 0) {
        // 월드 방향 → 바라보는 방향 기준 전후/좌우
        const sin = Math.sin(c.yaw);
        const cos = Math.cos(c.yaw);
        intent.forward = -sin * mx - cos * mz;
        intent.strafe = cos * mx - sin * mz;
      }
      intent.jump = this.jumpNext;
      this.jumpNext = false;
    }
    c.tick(intent, dt);
  }

  // ───────────────────────── 프레임 ─────────────────────────

  update(dt: number, alpha: number, weaponsLocked: boolean): void {
    if (!this.enabled) return;
    const p = this.pose;
    const c = this.ctrl;
    this.renderPos.lerpVectors(c.prevPosition, c.position, alpha);
    this.model.root.position.copy(this.renderPos);
    p.fire = Math.max(0, p.fire - dt * 8);
    this.flash.update(dt);

    if (!this.alive) {
      this.deadTime += dt;
      p.dead = this.deadTime;
      p.moveX = p.moveZ = 0;
      p.plant = -1;
      this.model.update(dt, p);
      return;
    }

    // ── 조준 회전 (최대 회전 속도 제한, 가까울수록 감속)
    const turn = this.skill.turnSpeed * DEG * dt;
    if (this.snap) {
      this.snap = false;
    } else {
      const dyaw = angleDiff(this.wantYaw, this.aimYaw);
      const dpitch = this.wantPitch - this.aimPitch;
      const k = Math.min(1, dt * 12);
      this.aimYaw += THREE.MathUtils.clamp(dyaw * Math.max(k, 0.25), -turn, turn);
      this.aimPitch += THREE.MathUtils.clamp(dpitch * Math.max(k, 0.25), -turn, turn);
    }
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch, -1.3, 1.3);

    // ── 투척 단검 궁극기: 몸 주위를 도는 단검
    this.stormFx.group.visible = this.stormKnives > 0;
    if (this.stormKnives > 0) {
      this.stormFx.setCount(this.stormKnives);
      this.stormFx.update(dt);
    }

    // ── 상태 이상: 감속/충격/무력화
    const st = this.env.fx.status;
    c.speedMul = st.speedMul(this.id);
    if (st.has(this.id, 'concuss')) {
      // 충격: 조준이 흔들리고 탄이 퍼진다
      this.aimYaw += (Math.random() - 0.5) * 0.03;
      this.aimPitch += (Math.random() - 0.5) * 0.02;
      this.bloom = Math.max(this.bloom, 3);
    }
    if (st.has(this.id, 'jam') && this.slot === 'primary' && this.stormKnives <= 0) {
      this.slot = 'secondary';
      void this.applyWeaponModel();
    } else if (!st.has(this.id, 'jam') && this.slot === 'secondary' && this.primary && (this.ammo.get(this.primary.id)?.mag ?? 0) + (this.ammo.get(this.primary.id)?.reserve ?? 0) > 0 && !this.reloading) {
      this.slot = 'primary';
      void this.applyWeaponModel();
    }
    // 무적 (되살아난 직후 2초, 질주 중), REKINDLE 시간 만료
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    this.invulnerable = this.invulnTimer > 0 || (this.abilities.agent.id === 'gale' && c.dashAmount > 0);
    if (this.ribTimer > 0) {
      this.ribTimer -= dt;
      if (this.ribTimer <= 0) this.returnToMarker();
    }
    // 되살아난 뒤 시간 안에 처치하지 못하면 다시 쓰러짐
    if (this.repriseTimer > 0) {
      this.repriseTimer -= dt;
      if (this.repriseTimer <= 0) {
        this.repriseTimer = 0;
        this.env.combat.applyDirectDamage({ id: this.id, name: this.name, team: this.team }, { ...getWeapon('blade'), name: 'REPRISE' }, this, 9999, this.ctrl.position.clone());
      }
    }

    // ── 무기
    this.abilities.update(dt);
    const od = false;
    const rateMul = st.fireRateMul(this.id);
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.semiDelay = Math.max(0, this.semiDelay - dt);
    this.equipTimer = Math.min(1, this.equipTimer + dt / Math.max(0.2, this.weapon.equipTime));
    if (!this.trigger) this.bloom = Math.max(0, this.bloom - dt * 7);
    if (this.reloading) {
      this.reloadTimer += dt;
      const t = this.reloadTimer / this.weapon.reloadTime;
      if (t >= 0.7 && t - dt / this.weapon.reloadTime < 0.7) this.env.sound.weapon(this.weapon.id, 'magIn', c.position);
      if (t >= 1) {
        const a = this.ammoState;
        const need = this.weapon.magazine - a.mag;
        const take = Math.min(need, a.reserve);
        a.mag += take;
        a.reserve -= take;
        this.reloadTimer = -1;
      }
    } else {
      this.switchIfEmpty();
    }
    const ready = this.equipTimer >= 1 && !this.reloading && this.interact < 0;
    if (this.trigger && ready && !weaponsLocked && this.fireTimer <= 0) {
      const semiOk = this.weapon.automatic || !this.triggerWasDown || this.semiDelay <= 0;
      const melee = this.weapon.category === 'melee';
      if (semiOk && (melee || this.ammoState.mag > 0)) {
        this.fire(od);
        this.fireTimer = 1 / (this.weapon.fireRate * rateMul);
        // 단발 무기: 사람처럼 클릭 사이에 약간의 간격
        if (!this.weapon.automatic) this.semiDelay = this.fireTimer + 0.05 + Math.random() * 0.12;
      }
    }
    this.triggerWasDown = this.trigger;

    // ── 발소리 (달릴 때 2m마다)
    const speed = c.horizontalSpeed;
    if (c.grounded && speed > 3.6) {
      this.stepDist += speed * dt;
      if (this.stepDist > 2) {
        this.stepDist = 0;
        this.env.sound.footstep(this.env.surfaceAt(c.position.x, c.position.y, c.position.z), speed, c.position);
        this.env.noise(this, c.position, 14);
      }
    }

    // ── 애니메이션 포즈
    const sin = Math.sin(this.aimYaw);
    const cos = Math.cos(this.aimYaw);
    const vx = c.velocity.x;
    const vz = c.velocity.z;
    p.moveZ = -sin * vx - cos * vz;
    p.moveX = cos * vx - sin * vz;
    p.grounded = c.grounded;
    p.crouch += ((c.crouching ? 1 : 0) - p.crouch) * Math.min(1, dt * 10);
    p.aimPitch = this.aimPitch;
    p.reload = this.reloading ? this.reloadTimer / this.weapon.reloadTime : -1;
    p.equip = this.equipTimer;
    p.dead = -1;
    p.plant = this.interact;
    if (this.hitTime >= 0) {
      this.hitTime += dt;
      if (this.hitTime >= HIT_REACTION) this.hitTime = -1;
    }
    p.hit = this.hitTime >= 0 ? this.hitTime / HIT_REACTION : -1;
    this.model.root.rotation.y = this.aimYaw;
    this.model.update(dt, p);
  }

  private fire(overdrive: boolean): void {
    const def = this.weapon;
    const c = this.ctrl;
    const a = this.ammoState;
    if (this.stormKnives > 0) {
      this.stormFx.throwOne();
      this.stormKnives--;
      if (this.stormKnives <= 0) void this.applyWeaponModel();
    } else if (def.category !== 'melee') a.mag--;
    const eye = this.eyePos(new THREE.Vector3());
    const stationary = c.horizontalSpeed < 0.8;
    const spread = spreadAngle(def, {
      speed: overdrive ? 0 : c.horizontalSpeed,
      grounded: c.grounded,
      crouching: c.crouching,
      // 저격총은 멈춰 서 있으면 정조준한 것으로 본다
      aim: def.category === 'sniper' && stationary ? 1 : 0,
      bloom: this.bloom,
    });
    this.bloom = Math.min(8, this.bloom + (def.automatic ? 0.5 : 0.3) * this.skill.sprayFactor);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.aimPitch, this.aimYaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const pellets = def.pellets ?? 1;
    const cone = pellets > 1 ? def.spread * DEG + Math.max(0, spread - def.spread * DEG) * 0.5 : spread;
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < pellets; i++) {
      const [x, y] = randomInCone(cone);
      dirs.push(fwd.clone().addScaledVector(right, Math.tan(x)).addScaledVector(up, Math.tan(y)).normalize());
    }
    const muzzle = this.model.muzzlePosition(new THREE.Vector3());
    const shooter = { id: this.id, name: this.name, team: this.team };
    if (def.category === 'melee') {
      this.env.combat.melee(shooter, def, eye, fwd);
      this.env.sound.play('knife', { at: eye });
      this.pose.fire = 1;
      return;
    }
    this.env.combat.fire(shooter, def, eye, dirs, muzzle);
    this.env.sound.weapon(def.id, 'shot', muzzle);
    this.env.noise(this, muzzle, 40);
    this.flash.trigger();
    this.pose.fire = 1;
    if (a.mag <= 0) this.startReload();
  }
}

export async function createBotModel(team: Team): Promise<CharacterModel> {
  const m = await CharacterModel.create({ team });
  m.setWeapon(await loadWeaponTemplate(getWeapon('tack')));
  return m;
}

export { PLAYER_SHAPE };
