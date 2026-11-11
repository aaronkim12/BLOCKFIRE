import * as THREE from 'three';
import type { Sound } from '../audio/Sound';
import type { Vitals } from '../combat/ballistics';
import type { CombatSystem, Damageable, DamageEvent } from '../combat/CombatSystem';
import type { Capsule } from '../combat/Hitbox';
import { MuzzleFlash } from '../effects/MuzzleFlash';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { getWeapon, type WeaponDef } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import { CharacterModel, DEFAULT_POSE, type CharacterPose, type Team } from './CharacterModel';

/**
 * 연습 모드의 더미 캐릭터들.
 *   - 맵 곳곳에 서 있는 표적: 체력/방어구가 있고, 맞으면 피격 반응, 죽으면 3초 뒤 부활
 *   - '더미 반격'을 켜면 시야에 들어온 플레이어를 향해 돌아서서 사격한다
 *   - 공격 스폰 앞의 "애니메이션 쇼케이스": 모든 캐릭터 동작을 순서대로 반복 (피격되지 않음)
 */

interface DummySpec {
  x: number;
  z: number;
  y?: number;
  yaw: number;
  team: Team;
  weapon: string;
  crouch?: number;
  armor: number;
}

/** FOUNDRY 맵 기준 배치 */
const DUMMIES: DummySpec[] = [
  { x: -31.5, z: -27, yaw: Math.PI, team: 'defense', weapon: 'falcon', armor: 50 },
  { x: -22.5, z: -24, y: 1.6, yaw: Math.PI, team: 'defense', weapon: 'longbow', armor: 25 },
  { x: 31.5, z: -18, yaw: Math.PI * 0.8, team: 'defense', weapon: 'warhound', crouch: 1, armor: 50 },
  { x: 0, z: 15, yaw: Math.PI, team: 'defense', weapon: 'hornet', armor: 0 },
  { x: 28.5, z: 12, yaw: Math.PI, team: 'defense', weapon: 'slugger', armor: 25 },
  { x: -1.5, z: -39, yaw: Math.PI, team: 'defense', weapon: 'tack', armor: 0 },
];

const RESPAWN_TIME = 3;
const HIT_REACTION = 0.43;

/** 더미가 반격할 때 필요한 정보 */
export interface DummyContext {
  shootBack: boolean;
  /** 연막에 시야가 가려지는지 / 섬광에 눈이 멀었는지 */
  visionBlocked?: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  isBlinded?: (id: string) => boolean;
  player: Damageable;
  combat: CombatSystem;
  world: CollisionWorld;
  sound: Sound;
}

export class Dummy implements Damageable {
  pose: CharacterPose = { ...DEFAULT_POSE };
  alive = true;
  vitals: Vitals;
  team: Team;
  /** 경기에서 쓰지 않는 더미는 숨기고 피격되지 않게 한다 */
  enabled = true;
  /** 연습 모드: 죽으면 3초 뒤 자동 부활 (경기에서는 라운드가 관리) */
  autoRespawn = true;
  /** 평소 바라보는 방향 */
  homeYaw: number;
  private homeArmor: number;
  /** 죽었을 때 호출 (경기 진행에 알림) */
  onDeath?: (d: Dummy, e: DamageEvent) => void;
  private deadTime = 0;
  private hitTime = -1;
  private fireCooldown = 1 + Math.random();
  private flash = new MuzzleFlash(0.18);
  weapon: WeaponDef;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly model: CharacterModel,
    readonly spec: DummySpec,
  ) {
    this.team = spec.team;
    this.homeYaw = spec.yaw;
    this.homeArmor = spec.armor;
    this.weapon = getWeapon(spec.weapon);
    this.vitals = { health: 100, armor: spec.armor };
    if (model.weapon && this.weapon.category !== 'melee') model.weapon.muzzle.add(this.flash.object);
  }

  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.model.root.position).setY(this.model.root.position.y + 1.0);
  }

  facing(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.model.root.rotation.y), Math.sin(this.pose.aimPitch), -Math.cos(this.model.root.rotation.y)).normalize();
  }

  eyePos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.model.root.position).setY(this.model.root.position.y + 1.5 - this.pose.crouch * 0.4);
  }

  hitboxes(): Capsule[] {
    return this.model.hitboxes();
  }

  onDamaged(): void {
    this.hitTime = 0;
  }

  onKilled(e: DamageEvent): void {
    this.deadTime = 0;
    this.hitTime = -1;
    this.onDeath?.(this, e);
  }

  /** 지정 위치/팀으로 재배치하고 체력을 채운다 (라운드 시작) */
  placeAt(x: number, y: number, z: number, yaw: number, team: Team, armor: number): void {
    this.model.root.position.set(x, y, z);
    this.homeYaw = yaw;
    this.homeArmor = armor;
    if (team !== this.team) {
      this.team = team;
      this.model.setTeam(team);
    }
    this.deadTime = 0;
    this.respawn();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.model.root.visible = on;
    this.alive = on;
  }

  /** 원래 연습장 배치로 복귀 */
  resetHome(): void {
    this.placeAt(this.spec.x, this.spec.y ?? 0, this.spec.z, this.spec.yaw, this.spec.team, this.spec.armor);
    this.autoRespawn = true;
    this.setEnabled(true);
  }

  private respawn(): void {
    this.alive = true;
    this.vitals.health = 100;
    this.vitals.armor = this.homeArmor;
    this.model.root.rotation.y = this.homeYaw;
    this.fireCooldown = 1.5;
  }

  update(dt: number, ctx?: DummyContext): void {
    if (!this.enabled) return;
    const p = this.pose;
    p.fire = Math.max(0, p.fire - dt * 8);
    if (!this.alive) {
      this.deadTime += dt;
      p.dead = this.deadTime;
      if (this.autoRespawn && this.deadTime >= RESPAWN_TIME) this.respawn();
    } else {
      p.dead = -1;
      if (this.hitTime >= 0) {
        this.hitTime += dt;
        if (this.hitTime >= HIT_REACTION) this.hitTime = -1;
      }
      p.hit = this.hitTime >= 0 ? this.hitTime / HIT_REACTION : -1;
      if (ctx) this.think(dt, ctx);
    }
    this.flash.update(dt);
    this.model.update(dt, p);
  }

  /** 반격: 플레이어가 보이면 돌아서서 조준하고 일정 간격으로 사격 */
  private think(dt: number, ctx: DummyContext): void {
    const root = this.model.root;
    let targetYaw = this.homeYaw;
    let pitch = 0;
    let canSee = false;
    const eye = root.position.clone().setY(root.position.y + 1.5 - this.pose.crouch * 0.4);
    if (ctx.shootBack && ctx.player.alive) {
      const target = ctx.player.center(new THREE.Vector3());
      const to = target.clone().sub(eye);
      const dist = to.length();
      if (dist < 45) {
        to.normalize();
        const wall = ctx.world.raycast(eye.x, eye.y, eye.z, to.x, to.y, to.z, dist);
        canSee = (!wall || wall.distance > dist - 0.3) && !ctx.visionBlocked?.(eye, target);
        if (canSee) {
          targetYaw = Math.atan2(-to.x, -to.z);
          pitch = Math.asin(THREE.MathUtils.clamp(to.y, -1, 1));
        }
      }
    }
    // 부드럽게 회전
    let dy = targetYaw - root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    root.rotation.y += THREE.MathUtils.clamp(dy, -4 * dt, 4 * dt);
    this.pose.aimPitch += (pitch - this.pose.aimPitch) * Math.min(1, dt * 6);

    this.fireCooldown -= dt;
    const blind = ctx.isBlinded?.(this.id) ?? false;
    if (canSee && !blind && Math.abs(dy) < 0.15 && this.fireCooldown <= 0 && this.weapon.category !== 'melee') {
      this.fireCooldown = 1.1 + Math.random() * 0.8;
      this.shoot(ctx, eye);
    }
  }

  private shoot(ctx: DummyContext, eye: THREE.Vector3): void {
    const target = ctx.player.center(new THREE.Vector3());
    const base = target.sub(eye).normalize();
    const pellets = this.weapon.pellets ?? 1;
    const cone = (pellets > 1 ? this.weapon.spread : 2.5) * (Math.PI / 180);
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < pellets; i++) {
      const r = cone * Math.sqrt(Math.random());
      const t = Math.random() * Math.PI * 2;
      const right = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, base).normalize();
      dirs.push(base.clone().addScaledVector(right, Math.cos(t) * r).addScaledVector(up, Math.sin(t) * r).normalize());
    }
    const muzzle = this.model.muzzlePosition();
    ctx.combat.fire({ id: this.id, name: this.name, team: this.team }, this.weapon, eye, dirs, muzzle);
    ctx.sound.weapon(this.weapon.id, 'shot', muzzle);
    this.flash.trigger();
    this.pose.fire = 1;
  }
}

interface ShowcaseStep {
  label: string;
  duration: number;
  pose: (t: number) => Partial<CharacterPose> & { speed?: number; jumpY?: number };
  weapon?: string;
}

const SHOWCASE: ShowcaseStep[] = [
  { label: 'IDLE', duration: 2.5, pose: () => ({}) },
  { label: 'WALK', duration: 3, pose: () => ({ speed: 3 }) },
  { label: 'RUN', duration: 3, pose: () => ({ speed: 5.4 }) },
  { label: 'CROUCH', duration: 2.5, pose: () => ({ crouch: 1 }) },
  { label: 'CROUCH WALK', duration: 3, pose: () => ({ crouch: 1, speed: 2.2 }) },
  {
    label: 'JUMP / FALL',
    duration: 2.4,
    pose: (t) => {
      const c = t % 1.2;
      const y = Math.max(0, 6.8 * c - 10 * c * c);
      return { grounded: y <= 0, jumpY: y };
    },
  },
  { label: 'SHOOT', duration: 2.5, pose: () => ({}) },
  { label: 'RELOAD', duration: 2.5, pose: (t) => ({ reload: Math.min(1, t / 2.5) }) },
  { label: 'EQUIP (PISTOL)', duration: 2, weapon: 'tack', pose: (t) => ({ equip: Math.min(1, t / 0.75) }) },
  { label: 'EQUIP (KNIFE)', duration: 2, weapon: 'blade', pose: (t) => ({ equip: Math.min(1, t / 0.5) }) },
  { label: 'EQUIP (RIFLE)', duration: 2, pose: (t) => ({ equip: Math.min(1, t / 1) }) },
  { label: 'DEATH', duration: 3, pose: (t) => ({ dead: t }) },
];

export class PracticeDummies {
  readonly group = new THREE.Group();
  readonly dummies: Dummy[] = [];
  private showcase!: CharacterModel;
  private showcaseFlash = new MuzzleFlash(0.18);
  private showcaseCenter = new THREE.Vector3(4.5, 0, 31.5);
  private showcaseWeapon = 'falcon';
  private stepIndex = 0;
  private stepTime = 0;
  private angle = 0;
  private shotTimer = 0;
  showcaseLabel = '';
  /** 쇼케이스 표시 여부 (경기 중에는 숨김) */
  showcaseVisible = true;

  static async create(): Promise<PracticeDummies> {
    const p = new PracticeDummies();
    await p.init();
    return p;
  }

  private async init(): Promise<void> {
    let n = 1;
    for (const spec of DUMMIES) {
      const m = await CharacterModel.create({ team: spec.team });
      m.setWeapon(await loadWeaponTemplate(getWeapon(spec.weapon)));
      m.root.position.set(spec.x, spec.y ?? 0, spec.z);
      m.root.rotation.y = spec.yaw;
      const d = new Dummy(`dummy-${n}`, `DUMMY ${n}`, m, spec);
      n++;
      d.pose.crouch = spec.crouch ?? 0;
      this.dummies.push(d);
      this.group.add(m.root);
    }
    this.showcase = await CharacterModel.create({ team: 'attack' });
    await this.setShowcaseWeapon(this.showcaseWeapon);
    this.group.add(this.showcase.root);
  }

  private async setShowcaseWeapon(id: string): Promise<void> {
    const m = this.showcase;
    m.setWeapon(await loadWeaponTemplate(getWeapon(id)));
    this.showcaseFlash.object.removeFromParent();
    if (m.weapon && id !== 'blade') m.weapon.muzzle.add(this.showcaseFlash.object);
  }


  /** @param ctx 반격에 필요한 정보 (메뉴 배경 등에서는 생략) */
  update(dt: number, ctx?: DummyContext): void {
    for (const d of this.dummies) d.update(dt, ctx);
    this.showcase.root.visible = this.showcaseVisible;
    if (this.showcaseVisible) this.updateShowcase(dt);
  }

  private updateShowcase(dt: number): void {
    const step = SHOWCASE[this.stepIndex];
    this.stepTime += dt;
    if (this.stepTime >= step.duration) {
      this.stepIndex = (this.stepIndex + 1) % SHOWCASE.length;
      this.stepTime = 0;
      const next = SHOWCASE[this.stepIndex];
      const wid = next.weapon ?? 'falcon';
      if (wid !== this.showcaseWeapon) {
        this.showcaseWeapon = wid;
        void this.setShowcaseWeapon(wid);
      }
    }
    const cur = SHOWCASE[this.stepIndex];
    this.showcaseLabel = cur.label;
    const p = cur.pose(this.stepTime);
    const speed = p.speed ?? 0;
    const m = this.showcase;

    // 이동 동작은 반지름 1.6m 원을 따라 돈다 (몸은 진행 방향을 바라봄)
    const r = 1.6;
    this.angle += (speed / r) * dt;
    m.root.position.set(
      this.showcaseCenter.x + Math.cos(this.angle) * r,
      p.jumpY ?? 0,
      this.showcaseCenter.z + Math.sin(this.angle) * r,
    );
    // 원의 접선 방향을 바라봄: 진행 방향 (-sin, cos) → yaw
    const tx = -Math.sin(this.angle);
    const tz = Math.cos(this.angle);
    m.root.rotation.y = Math.atan2(-tx, -tz);

    // 사격 동작
    let fire = 0;
    if (cur.label === 'SHOOT') {
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) {
        this.shotTimer = 0.11;
        this.showcaseFlash.trigger();
      }
      fire = Math.max(0, this.shotTimer / 0.11);
    }
    this.showcaseFlash.update(dt);

    const pose: CharacterPose = {
      ...DEFAULT_POSE,
      moveZ: speed,
      grounded: p.grounded ?? true,
      crouch: p.crouch ?? 0,
      reload: p.reload ?? -1,
      equip: p.equip ?? 1,
      dead: p.dead ?? -1,
      fire,
      aimPitch: 0,
    };
    m.update(dt, pose);
  }
}
