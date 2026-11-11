import * as THREE from 'three';
import type { Sound } from '../audio/Sound';
import type { CombatSystem, Damageable, Shooter } from '../combat/CombatSystem';
import type { Capsule } from '../combat/Hitbox';
import type { Vfx } from '../effects/vfx/Vfx';
import { createBeamMaterial } from '../effects/vfx/VfxMaterials';
import { createPSXMaterial } from '../graphics/PSXMaterial';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { Team } from '../player/CharacterModel';
import { getWeapon } from '../weapons/weaponData';
import type { FacingTarget } from './AbilityEffects';
import type { StatusEffects } from './StatusEffects';

/**
 * 두 번째 세대 능력의 월드 효과.
 *   벽 너머 폭약/섬광, 지면 충격파·지진, 조종 드론, 충격탄, 미사일, 연쇄 폭격,
 *   가시덤불, 벽 함정, 섬광 꽃, 금속 가시(무력화), 불길 벽, 궤도 레이저.
 * 피해는 CombatSystem.applyDirectDamage로 주므로 처치·킬 피드·라운드 집계가 일반 사격과 같다.
 */

/** 위치를 바꿀 수 있는 대상 (지진에 띄워짐) */
export interface Knockable extends FacingTarget {
  knock?(vy: number): void;
}

/** 드론 조종 입력 (플레이어). 없으면 드론은 앞으로 곧게 날며 적을 보면 스스로 파동 */
export interface DronePilot {
  yaw(): number;
  pitch(): number;
  /** 앞(+)/옆(+오른쪽) 입력, 점프 */
  move(): { f: number; s: number; jump: boolean };
  /** 드론이 끝나면 (파동·시간 만료·파괴) */
  onEnd(): void;
  /** 원격 조종: 조종하는 사람이 알려 준 드론 위치 (있으면 그대로 따라감) */
  pos?(): THREE.Vector3 | null;
}

interface Scheduled {
  t: number;
  fn: () => void;
}
export interface Drone {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  vy: number;
  life: number;
  owner: Shooter;
  pilot: DronePilot | null;
  range: number;
  suppress: number;
  /** 총에 맞는 몸 (체력 50) */
  body: Damageable;
  pulseNow: boolean;
  dead: boolean;
}
interface Missile {
  mesh: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** 포물선 꼭대기 높이 (출발·도착 직선 위로) */
  peak: number;
  t: number;
  dur: number;
  onHit: () => void;
}
interface Vine {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  radius: number;
  owner: Shooter;
  /** 발동까지 남은 시간 (발동 누름 후 0.3초) */
  arming: number;
  active: number;
  dmg: number;
  life: number;
  auto: boolean;
  /** 덤불 안에서 움직인 거리 (대상별) */
  moved: Map<string, { last: THREE.Vector3; acc: number }>;
}
interface Shear {
  mesh: THREE.Object3D;
  /** 벽면 위 붙인 점 (바닥 높이) */
  base: THREE.Vector3;
  /** 벽에서 뻗어 나가는 방향 (줄 방향) */
  along: THREE.Vector3;
  length: number;
  owner: Shooter;
  arm: number;
  life: number;
  side: Map<string, number>;
  onTrigger: () => void;
}
interface Rose {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  owner: Shooter;
  auto: boolean;
  life: number;
  fire: () => void;
}
interface FireWall {
  owner: Shooter;
  head: THREE.Vector3;
  dir: THREE.Vector3;
  left: number;
  segments: { pos: THREE.Vector3; mesh: THREE.Mesh }[];
  life: number;
  dps: number;
  heal: boolean;
  healed: number;
  tick: number;
  steer: (() => THREE.Vector3 | null) | null;
  blocker: (p: THREE.Vector3, r: number, d: number) => void;
  duration: number;
}
interface Orbital {
  pos: THREE.Vector3;
  radius: number;
  windup: number;
  life: number;
  perTick: number;
  tick: number;
  owner: Shooter;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  blocked: boolean;
  blocker: (p: THREE.Vector3, r: number, d: number) => void;
}

/** 드론이 떠 있는 높이 (바닥 위 m) */
export const DRONE_HOVER = 1.2;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class AdvancedEffects {
  readonly group = new THREE.Group();
  private scheduled: Scheduled[] = [];
  private drones: Drone[] = [];
  private missiles: Missile[] = [];
  private vines: Vine[] = [];
  private shears: Shear[] = [];
  private roses: Rose[] = [];
  private fireWalls: FireWall[] = [];
  private orbitals: Orbital[] = [];
  /** 드론에 드러난 적: id → { 드러낸 진영, 남은 시간 } */
  readonly reveals = new Map<string, { team: Team; t: number; target: Damageable }>();
  /** 나(로컬) 진영: 우리 편 함정만 보이게 */
  localTeam: Team = 'attack';
  /** 내(로컬) 위치: 적 함정이 가까우면 희미하게 보인다 */
  readonly localPos = new THREE.Vector3(0, -999, 0);

  constructor(
    private world: CollisionWorld,
    private combat: CombatSystem,
    readonly sound: Sound,
    readonly vfx: Vfx,
    readonly status: StatusEffects,
  ) {}

  // ───────────────────────── 공용 ─────────────────────────

  schedule(delay: number, fn: () => void): void {
    this.scheduled.push({ t: delay, fn });
  }

  /** 시선 방향으로 처음 닿는 표면 (없으면 max 거리 지점) */
  aimPoint(eye: THREE.Vector3, dir: THREE.Vector3, max: number): { point: THREE.Vector3; hit: boolean; normal: THREE.Vector3 } {
    const hit = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, max);
    if (!hit) return { point: eye.clone().addScaledVector(dir, max), hit: false, normal: new THREE.Vector3(0, 1, 0) };
    const point = eye.clone().addScaledVector(dir, hit.distance);
    const b = hit.box;
    const d = [
      [Math.abs(point.x - b.minX), -1, 0, 0], [Math.abs(point.x - b.maxX), 1, 0, 0],
      [Math.abs(point.y - b.minY), 0, -1, 0], [Math.abs(point.y - b.maxY), 0, 1, 0],
      [Math.abs(point.z - b.minZ), 0, 0, -1], [Math.abs(point.z - b.maxZ), 0, 0, 1],
    ].sort((a, c) => a[0] - c[0])[0];
    return { point, hit: true, normal: new THREE.Vector3(d[1], d[2], d[3]) };
  }

  /** 지점 아래 바닥 */
  ground(p: THREE.Vector3): THREE.Vector3 {
    const hit = this.world.raycast(p.x, p.y + 0.3, p.z, 0, -1, 0, 30);
    return hit ? new THREE.Vector3(p.x, p.y + 0.3 - hit.distance, p.z) : p.clone().setY(0);
  }

  /** 반경 안의 적 (los: 벽에 가리면 제외) */
  enemiesNear(pos: THREE.Vector3, radius: number, team: Team, los = false): Damageable[] {
    return this.targetsNear(pos, radius, los, (t) => t.team !== team);
  }

  /** 반경 안의 대상 (filter로 고름) */
  targetsNear(pos: THREE.Vector3, radius: number, los: boolean, filter: (t: Damageable) => boolean): Damageable[] {
    const out: Damageable[] = [];
    for (const t of this.combat.targets) {
      if (!t.alive || !filter(t) || this.isDroneBody(t)) continue;
      const c = t.center(_v);
      const d = c.distanceTo(pos);
      if (d > radius) continue;
      if (los) {
        const dir = _w.copy(c).sub(pos).normalize();
        const hit = this.world.raycast(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, d);
        if (hit && hit.distance < d - 0.3) continue;
      }
      out.push(t);
    }
    return out;
  }

  private isDroneBody(t: Damageable): boolean {
    return t.id.endsWith(':drone');
  }

  /**
   * 범위 피해. 가운데 damage, 가장자리 damage×edge. los면 벽 뒤는 안전
   */
  explode(pos: THREE.Vector3, radius: number, damage: number, owner: Shooter, name: string, los = true, color = 0xffb060, edge = 0.5): void {
    this.vfx.blast(pos, radius, color);
    this.sound.play('explosion', { at: pos, size: radius > 4 ? 'medium' : 'small', intensity: 0.7 });
    const weapon = { ...getWeapon('blade'), name };
    for (const t of this.enemiesNear(pos, radius, owner.team, los)) {
      const d = t.center(new THREE.Vector3()).distanceTo(pos);
      this.combat.applyDirectDamage(owner, weapon, t, Math.round(damage * (1 - (1 - edge) * (d / radius))), t.center(new THREE.Vector3()));
    }
  }

  /** 능력 피해 하나 (처치·킬 피드는 일반 사격과 같은 경로) */
  damage(owner: Shooter, t: Damageable, amount: number, name: string): void {
    this.combat.applyDirectDamage(owner, { ...getWeapon('blade'), name }, t, amount, t.center(new THREE.Vector3()));
  }

  /** 충격: 이동 감소 + 조준 흔들림. knock이면 공중으로 띄움 */
  concuss(pos: THREE.Vector3, radius: number, duration: number, owner: Shooter, los: boolean, knock = 0): void {
    for (const t of this.enemiesNear(pos, radius, owner.team, los)) {
      this.status.apply(t.id, 'concuss', duration);
      if (knock > 0) (t as Knockable).knock?.(knock);
    }
  }

  // ───────────────────────── TREMOR ─────────────────────────

  /** 벽에 붙인 폭약: windup초 뒤 벽 너머 2.2m 지점에서 2연속 폭발 */
  rivetCharge(eye: THREE.Vector3, dir: THREE.Vector3, owner: Shooter, radius: number, damage: number, windup: number): void {
    const a = this.aimPoint(eye, dir, 9);
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const center = a.point.clone().addScaledVector(flat, a.hit ? 2.2 : 0);
    const gp = this.ground(center).setY(this.ground(center).y + 0.8);
    // 벽에 붙은 장치 (깜빡이며 터질 때를 알림)
    const dev = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.12), createPSXMaterial({ color: 0x3a3028, emissive: 0xff6a20 }));
    dev.position.copy(a.point).addScaledVector(a.normal, 0.06);
    dev.lookAt(_v.copy(a.point).add(a.normal));
    this.group.add(dev);
    this.sound.play('beep', { at: a.point, gain: 0.8 });
    // 터질 자리를 바닥에 미리 표시
    this.vfx.ring(this.ground(center).setY(this.ground(center).y + 0.05), radius, windup, 0xff8a3c, UP, 0.05, 0.5);
    for (let i = 0; i < 2; i++)
      this.schedule(windup + i * 0.5, () => {
        this.explode(gp.clone().addScaledVector(flat, i * 0.8), radius, damage, owner, 'RIVET CHARGE', false, 0xff8a3c, 0.6);
        if (i === 1) dev.removeFromParent();
      });
  }

  /** 벽을 뚫고 넘어가 터지는 섬광 */
  glareCharge(eye: THREE.Vector3, dir: THREE.Vector3, onPop: (p: THREE.Vector3) => void): void {
    const a = this.aimPoint(eye, dir, 14);
    const p = a.hit ? a.point.clone().addScaledVector(dir, 2.2) : a.point.clone();
    p.y = Math.max(this.ground(p).y + 1.2, Math.min(p.y, this.ground(p).y + 2.5));
    this.vfx.ring(a.point.clone().addScaledVector(a.normal, 0.05), 0.6, 0.5, 0xffd090, a.normal, 0.15, 0.9);
    this.sound.play('ability', { at: a.point, gain: 0.7 });
    this.schedule(0.5, () => onPop(p));
  }

  /**
   * 일직선 충격파 (벽 통과): 발밑에서 length m 앞까지, 폭 halfWidth×2.
   * 1.1초 뒤 띠 안의 적을 충격 상태로.
   */
  seismicLine(feet: THREE.Vector3, dir: THREE.Vector3, length: number, halfWidth: number, duration: number, owner: Shooter): void {
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    const windup = 1.1;
    this.sound.play('impact', { at: feet, pitch: 0.4, gain: 1 });
    const n = Math.ceil(length / 2.5);
    for (let i = 1; i <= n; i++) {
      const g = this.ground(feet.clone().addScaledVector(flat, Math.min(length, i * 2.5)));
      // 땅이 갈라지는 예고 → 충격파
      this.vfx.ring(g.clone().setY(g.y + 0.05), halfWidth * 0.6, windup, 0xff8a3c, UP, 0.04, 0.35);
      this.schedule(windup + i * 0.02, () => this.vfx.shockwave(g, halfWidth, 0xff8a3c));
    }
    this.schedule(windup, () => {
      for (const t of this.combat.targets as Knockable[]) {
        if (!t.alive || t.team === owner.team || this.isDroneBody(t)) continue;
        const c = t.center(_v).sub(feet);
        const along = c.x * flat.x + c.z * flat.z;
        if (along < 0.5 || along > length + 1) continue;
        if (Math.abs(c.x * side.x + c.z * side.z) > halfWidth) continue;
        this.status.apply(t.id, 'concuss', duration);
      }
    });
  }

  /**
   * 궁극기 지진: 앞쪽 폭 width m 띠를 따라 5m씩 steps번 연쇄 진동 (지형 무시).
   * 맞은 적은 띄워지고 오래 충격.
   */
  groundSurge(feet: THREE.Vector3, dir: THREE.Vector3, steps: number, width: number, duration: number, owner: Shooter): void {
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    const half = width / 2;
    this.sound.play('explosion', { at: feet, size: 'large', intensity: 0.6 });
    const hit = new Set<string>();
    for (let step = 1; step <= steps; step++) {
      const d = step * 5;
      this.schedule(0.5 + step * 0.255, () => {
        for (let k = -2; k <= 2; k++) {
          const p = this.ground(feet.clone().addScaledVector(flat, d).addScaledVector(side, (k / 2) * (half - 1.5)));
          this.vfx.shockwave(p, 3.6, 0xff6a20);
        }
        this.sound.play('impact', { at: feet.clone().addScaledVector(flat, d), pitch: 0.3, gain: 0.9 });
        for (const t of this.combat.targets as Knockable[]) {
          if (!t.alive || t.team === owner.team || hit.has(t.id) || this.isDroneBody(t)) continue;
          const c = t.center(_v).sub(feet);
          const along = c.x * flat.x + c.z * flat.z;
          if (along < d - 5 || along > d + 0.5) continue;
          if (Math.abs(c.x * side.x + c.z * side.z) > half) continue;
          hit.add(t.id);
          this.status.apply(t.id, 'concuss', duration);
          t.knock?.(6.5);
        }
      });
    }
  }

  // ───────────────────────── MARSHAL ─────────────────────────

  /**
   * 정찰 드론 (체력 50, 총에 맞음).
   *   pilot 있음: 플레이어가 6초 동안 조종, pulse()로 파동
   *   pilot 없음(봇): 앞으로 곧게 날다가 앞에 적이 보이면 스스로 파동
   * 파동: 드론에서 보이는 range m 안 적을 억제 + 위치 드러냄
   */
  drone(from: THREE.Vector3, dir: THREE.Vector3, owner: Shooter, life: number, range: number, suppress: number, pilot: DronePilot | null): Drone {
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), createPSXMaterial({ color: 0x2a2c30, emissive: 0xd9c25a }));
    core.scale.set(1.4, 0.6, 1.4);
    const rotor = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 4, 12), createPSXMaterial({ color: 0x404448, emissive: 0x403010 }));
    rotor.rotation.x = Math.PI / 2;
    mesh.add(core, rotor);
    mesh.position.copy(from);
    // 조종 중에는 내 화면에 드론 몸이 보이지 않게
    this.group.add(mesh);
    const pos = from.clone();
    const d = {} as Drone;
    const body: Damageable = {
      id: `${owner.id}:drone`,
      name: 'SEEKER DRONE',
      team: owner.team,
      alive: true,
      vitals: { health: 50, armor: 0 },
      center: (out) => out.copy(pos),
      hitboxes: (): Capsule[] => [{ part: 'body', a: pos.clone(), b: pos.clone(), radius: 0.3 }],
      // 부서져도 처치로 치지 않는다
      cheatDeath: () => {
        d.dead = true;
        return true;
      },
    };
    Object.assign(d, { mesh, pos, dir: dir.clone().normalize(), vy: 0, life, owner, pilot, range, suppress, body, pulseNow: false, dead: false });
    this.combat.addTarget(body);
    this.drones.push(d);
    this.sound.play('ability', { at: from, gain: 0.6, pitch: 1.4 });
    return d;
  }

  /** 이 사람의 드론 (조종 여부와 상관없이) */
  droneOf(ownerId: string): Drone | null {
    return this.drones.find((d) => d.owner.id === ownerId) ?? null;
  }

  /** 조종 중인 드론 */
  pilotedDrone(ownerId: string): Drone | null {
    return this.drones.find((d) => d.owner.id === ownerId && d.pilot) ?? null;
  }

  /** 미사일: 쏜 사람 위에서 솟아올라 포물선을 그리며 dur초 뒤 목표에 떨어진다 */
  missile(target: THREE.Vector3, from: THREE.Vector3, onHit: () => void, dur?: number, peak?: number, color = 0xff8020): void {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6, 6), createPSXMaterial({ color: 0x505458, emissive: color }));
    const start = from.clone().setY(from.y + 2.2);
    const dist = start.distanceTo(target);
    mesh.position.copy(start);
    this.group.add(mesh);
    this.missiles.push({ mesh, from: start, to: target.clone(), peak: peak ?? 6 + dist * 0.25, t: 0, dur: dur ?? THREE.MathUtils.clamp(dist / 26, 0.9, 2.4), onHit });
    this.sound.play('ability', { at: start, gain: 0.8, pitch: 0.6 });
  }

  /** 하늘에서 떨어지는 투하물 (연막 통) */
  drop(target: THREE.Vector3, dur: number, color: number, onHit: () => void): void {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 6), createPSXMaterial({ color: 0x404448, emissive: color }));
    const start = target.clone().setY(target.y + 24);
    this.group.add(mesh);
    this.missiles.push({ mesh, from: start, to: target.clone(), peak: 0, t: 0, dur, onHit });
  }

  /** 지도에서 고른 (x, z)의 바닥 (지붕 아래·발판 위 포함) */
  groundAt(x: number, z: number): THREE.Vector3 {
    const hit = this.world.raycast(x, 3.6, z, 0, -1, 0, 10);
    return new THREE.Vector3(x, hit ? 3.6 - hit.distance : 0, z);
  }

  // ───────────────────────── WARDEN ─────────────────────────

  /** 궤도 레이저: windup초 경고 → duration초 동안 범위 안 적에게 총 total 피해. 기둥은 시야도 가림 */
  orbital(pos: THREE.Vector3, radius: number, windup: number, duration: number, total: number, owner: Shooter, blocker: Orbital['blocker']): void {
    this.vfx.ring(pos.clone().setY(pos.y + 0.05), radius, windup, 0x4fe0c0, UP, 0.06, 0.8);
    this.vfx.ring(pos.clone().setY(pos.y + 0.05), radius * 0.5, windup, 0x4fe0c0, UP, 0.04, 0.5);
    const mat = createBeamMaterial(0x80fff0, 0);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 40, 32, 1, true), mat);
    mesh.position.copy(pos).setY(pos.y + 20);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.orbitals.push({ pos: pos.clone(), radius, windup, life: duration, perTick: total / (duration / 0.25), tick: 0, owner, mesh, mat, blocked: false, blocker });
    this.sound.play('magic_charge', { at: pos, duration: windup, intensity: 1 });
  }

  // ───────────────────────── VOLT ─────────────────────────

  /**
   * 불길 벽: 머리가 18m/s로 length m 나아가며 1.2m마다 불기둥을 남긴다 (벽 통과).
   * steer가 방향을 주면 그쪽으로 휜다. 닿은 적은 초당 dps, 주인은 회복(innerfire).
   */
  fireWall(start: THREE.Vector3, dir: THREE.Vector3, length: number, duration: number, dps: number, owner: Shooter, heal: boolean, steer: FireWall['steer'], blocker: FireWall['blocker']): void {
    this.fireWalls.push({
      owner, head: start.clone(), dir: new THREE.Vector3(dir.x, 0, dir.z).normalize(), left: length, segments: [], life: duration + length / 18,
      dps, heal, healed: 0, tick: 0, steer, blocker, duration,
    });
    this.sound.play('zone', { at: start, gain: 1, pitch: 1.3 });
  }

  // ───────────────────────── THORN ─────────────────────────

  /** 가시덤불 (착지 후 거의 보이지 않음, activateVine()로 0.3초 뒤 솟아오름) */
  vine(pos: THREE.Vector3, radius: number, owner: Shooter, dmg: number, auto: boolean): Vine {
    const g = new THREE.Group();
    const mat = createPSXMaterial({ color: 0x302838, emissive: 0x2a1a40 });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = radius * (0.3 + Math.random() * 0.65);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.7, 4), mat);
      spike.position.set(Math.cos(a) * r, 0.35, Math.sin(a) * r);
      spike.rotation.z = (Math.random() - 0.5) * 0.6;
      g.add(spike);
    }
    g.position.copy(pos);
    g.scale.y = 0.08;
    this.group.add(g);
    const v: Vine = { mesh: g, pos: pos.clone(), radius, owner, arming: -1, active: 0, dmg, life: 60, auto, moved: new Map() };
    this.vines.push(v);
    return v;
  }

  activateVine(v: Vine, duration: number): void {
    if (v.active > 0 || v.arming >= 0 || !this.vines.includes(v)) return;
    v.arming = 0.3;
    v.life = duration + 0.3;
    v.active = duration;
    this.sound.play('wall_up', { at: v.pos, gain: 0.7 });
    this.vfx.ring(v.pos.clone().setY(v.pos.y + 0.05), v.radius, 0.5, 0xb48cff, UP, 0.06, 0.8);
  }

  /**
   * 벽 함정: 벽면 base에서 along 방향으로 length m 줄.
   * 적이 줄을 넘어가면 0.8초 뒤 onTrigger (벽이 솟음).
   */
  shear(base: THREE.Vector3, along: THREE.Vector3, length: number, owner: Shooter, onTrigger: () => void): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), createPSXMaterial({ color: 0x302838, emissive: 0x6a40c0 }));
    mesh.position.copy(base).setY(base.y + 0.3);
    this.group.add(mesh);
    this.shears.push({ mesh, base: base.clone(), along: along.clone().setY(0).normalize(), length, owner, arm: 1, life: 90, side: new Map(), onTrigger });
  }

  /** 섬광 꽃: 벽/바닥에 붙어 있다가 fire() */
  rose(pos: THREE.Vector3, normal: THREE.Vector3, owner: Shooter, auto: boolean, fire: (p: THREE.Vector3) => void): Rose {
    const g = new THREE.Group();
    const mat = createPSXMaterial({ color: 0x8a86a0, emissive: 0x3a2a60 });
    for (let i = 0; i < 5; i++) {
      const petal = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 4), mat);
      const a = (i / 5) * Math.PI * 2;
      petal.position.set(Math.cos(a) * 0.08, 0.08, Math.sin(a) * 0.08);
      petal.rotation.set(Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8);
      g.add(petal);
    }
    g.position.copy(pos).addScaledVector(normal, 0.05);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    this.group.add(g);
    const r: Rose = { mesh: g, pos: pos.clone().addScaledVector(normal, 0.3), owner, auto, life: 90, fire: () => fire(r.pos) };
    this.roses.push(r);
    this.sound.play('ability', { at: pos, gain: 0.5, pitch: 1.6 });
    return r;
  }

  /** 꽃 발동: 0.5초 뒤 섬광 */
  fireRose(r: Rose): void {
    const i = this.roses.indexOf(r);
    if (i < 0) return;
    this.roses.splice(i, 1);
    r.mesh.visible = true;
    this.vfx.ring(r.pos.clone(), 0.5, 0.5, 0xffffff, undefined, 0.1, 0.9);
    this.sound.play('beep', { at: r.pos, gain: 0.7, pitch: 1.5 });
    this.schedule(0.5, () => {
      r.mesh.removeFromParent();
      r.fire();
    });
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(dt: number): void {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const s = this.scheduled[i];
      s.t -= dt;
      if (s.t <= 0) {
        this.scheduled.splice(i, 1);
        s.fn();
      }
    }

    for (const [id, r] of this.reveals) {
      r.t -= dt;
      if (r.t <= 0 || !r.target.alive) this.reveals.delete(id);
    }

    this.updateDrones(dt);

    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.t += dt / m.dur;
      const t = Math.min(1, m.t);
      const prev = m.mesh.position.clone();
      m.mesh.position.lerpVectors(m.from, m.to, t).y += m.peak * 4 * t * (1 - t);
      // 진행 방향을 바라봄
      const ahead = m.mesh.position.clone().add(m.mesh.position.clone().sub(prev));
      if (ahead.distanceToSquared(m.mesh.position) > 1e-8) {
        m.mesh.lookAt(ahead);
        m.mesh.rotateX(Math.PI / 2);
      }
      this.vfx.trail(m.mesh.position, 0xff8020);
      if (m.t >= 1) {
        m.mesh.removeFromParent();
        this.missiles.splice(i, 1);
        m.onHit();
      }
    }

    this.updateVines(dt);
    this.updateShears(dt);

    // 섬광 꽃: 우리 편에게 보이고, 적은 10m 안에서만 희미하게. 봇이 설치한 것은 적이 보이면 스스로 터뜨린다
    for (let i = this.roses.length - 1; i >= 0; i--) {
      const r = this.roses[i];
      r.life -= dt;
      r.mesh.rotation.y += dt;
      r.mesh.visible = r.owner.team === this.localTeam || r.pos.distanceTo(this.localPos) < 10;
      if (r.auto && this.enemiesNear(r.pos, 14, r.owner.team, true).length) {
        this.fireRose(r);
        continue;
      }
      if (r.life <= 0) {
        r.mesh.removeFromParent();
        this.roses.splice(i, 1);
      }
    }

    this.updateFireWalls(dt);
    this.updateOrbitals(dt);
  }

  private updateDrones(dt: number): void {
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      d.life -= dt;
      const speed = 7;
      const remote = d.pilot?.pos?.();
      if (remote) {
        // 원격 조종: 조종하는 사람이 보낸 위치로 부드럽게
        d.pos.lerp(remote, Math.min(1, dt * 15));
        d.dir.set(0, 0, -1).applyEuler(new THREE.Euler(d.pilot!.pitch(), d.pilot!.yaw(), 0, 'YXZ'));
        d.vy = 0;
      } else if (d.pilot) {
        // 조종: 마우스 방향, 이동 키로 앞뒤·옆 (높이는 저절로 유지)
        const yaw = d.pilot.yaw();
        const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const mv = d.pilot.move();
        const vel = fwd.multiplyScalar(mv.f).addScaledVector(right, mv.s);
        if (vel.lengthSq() > 1) vel.normalize();
        vel.multiplyScalar(speed);
        d.dir.set(0, 0, -1).applyEuler(new THREE.Euler(d.pilot.pitch(), yaw, 0, 'YXZ'));
        for (const axis of ['x', 'z'] as const) {
          const step = vel[axis] * dt;
          if (Math.abs(step) < 1e-5) continue;
          const dx = axis === 'x' ? Math.sign(step) : 0;
          const dz = axis === 'z' ? Math.sign(step) : 0;
          if (!this.world.raycast(d.pos.x, d.pos.y, d.pos.z, dx, 0, dz, Math.abs(step) + 0.3)) d.pos[axis] += step;
        }
      } else {
        // 봇 드론: 수평으로 곧게 (벽에 막히면 멈춤)
        const step = speed * dt;
        const flat = new THREE.Vector3(d.dir.x, 0, d.dir.z).normalize();
        if (!this.world.raycast(d.pos.x, d.pos.y, d.pos.z, flat.x, 0, flat.z, step + 0.3)) d.pos.addScaledVector(flat, step);
      }
      // 중력 없이 바닥 위 일정 높이를 유지한다 (계단·상자 위로는 부드럽게 따라 오르내림)
      if (!remote) {
        const want = this.ground(d.pos.clone().setY(d.pos.y + 0.5)).y + DRONE_HOVER;
        d.pos.y += (want - d.pos.y) * Math.min(1, dt * 8);
        d.vy = 0;
      }
      d.mesh.position.copy(d.pos);
      d.mesh.rotation.y += dt * 12;
      if (Math.random() < 0.5) this.vfx.trail(d.pos, 0xd9c25a);
      // 봇 드론: 앞에 적이 보이면 파동
      if (!d.pilot && !d.pulseNow) {
        for (const t of this.combat.targets) {
          if (!t.alive || t.team === d.owner.team || this.isDroneBody(t)) continue;
          const c = t.center(_v);
          const to = _w.copy(c).sub(d.pos);
          const dist = to.length();
          if (dist > d.range * 0.8 || to.normalize().dot(d.dir) < 0.3) continue;
          const wall = this.world.raycast(d.pos.x, d.pos.y, d.pos.z, to.x, to.y, to.z, dist);
          if (wall && wall.distance < dist - 0.3) continue;
          d.pulseNow = true;
          break;
        }
      }
      if (d.pulseNow) {
        // 드론에서 보이는 범위의 적: 억제 + 위치 드러냄
        this.vfx.ring(d.pos.clone(), d.range, 0.6, 0xd9c25a, undefined, 0.06, 0.9);
        this.vfx.ring(d.pos.clone(), d.range * 0.5, 0.45, 0xd9c25a, undefined, 0.05, 0.7);
        this.sound.play('beacon', { at: d.pos, gain: 0.9 });
        for (const t of this.enemiesNear(d.pos, d.range, d.owner.team, true)) {
          this.status.apply(t.id, 'suppress', d.suppress);
          this.reveals.set(t.id, { team: d.owner.team, t: 3, target: t });
        }
      }
      if (d.pulseNow || d.life <= 0 || d.dead) {
        if (d.dead) {
          this.vfx.blast(d.pos, 0.8, 0xd9c25a);
          this.sound.play('impact', { at: d.pos, gain: 0.8, pitch: 1.6 });
        }
        this.removeDrone(i);
      }
    }
  }

  private removeDrone(i: number): void {
    const d = this.drones[i];
    d.mesh.removeFromParent();
    this.drones.splice(i, 1);
    d.body.alive = false;
    const k = this.combat.targets.indexOf(d.body);
    if (k >= 0) this.combat.targets.splice(k, 1);
    d.pilot?.onEnd();
  }

  /** 가시덤불: 우리 편에게 보이고 적은 4m 안에서만. 발동하면 솟아올라 안에서 움직인 거리만큼 피해 + 감속 */
  private updateVines(dt: number): void {
    const weapon = { ...getWeapon('blade'), name: 'BRIAR NEST' };
    for (let i = this.vines.length - 1; i >= 0; i--) {
      const v = this.vines[i];
      v.life -= dt;
      const live = v.arming >= 0 && v.arming <= 0;
      v.mesh.visible = v.arming >= 0 || v.owner.team === this.localTeam || v.pos.distanceTo(this.localPos) < 4;
      if (v.arming > 0) v.arming = Math.max(0, v.arming - dt);
      if (live) {
        v.active -= dt;
        v.mesh.scale.y = Math.min(1, v.mesh.scale.y + dt * 6);
        const inside = new Set<string>();
        for (const t of this.enemiesNear(v.pos.clone().setY(v.pos.y + 1), v.radius, v.owner.team)) {
          inside.add(t.id);
          this.status.apply(t.id, 'slow', 0.3);
          const c = t.center(new THREE.Vector3());
          const m = v.moved.get(t.id);
          if (!m) {
            v.moved.set(t.id, { last: c, acc: 0 });
            continue;
          }
          // 순간이동 같은 큰 이동은 무시
          const step = Math.hypot(c.x - m.last.x, c.z - m.last.z);
          m.last.copy(c);
          if (step > 2) continue;
          m.acc += step;
          // 약 0.9m 걸음마다 피해
          while (m.acc >= 0.9) {
            m.acc -= 0.9;
            this.combat.applyDirectDamage(v.owner, weapon, t, v.dmg, c);
          }
        }
        for (const id of v.moved.keys()) if (!inside.has(id)) v.moved.delete(id);
        if (v.active <= 0) v.life = 0;
      } else if (v.arming < 0 && v.auto && this.enemiesNear(v.pos.clone().setY(v.pos.y + 1), v.radius * 0.8, v.owner.team).length) {
        this.activateVine(v, 7);
      }
      if (v.life <= 0) {
        v.mesh.removeFromParent();
        this.vines.splice(i, 1);
      }
    }
  }

  /** 벽 함정: 적이 줄을 넘어가면 (지나간 뒤) 벽이 솟는다 */
  private updateShears(dt: number): void {
    for (let i = this.shears.length - 1; i >= 0; i--) {
      const s = this.shears[i];
      s.arm -= dt;
      s.life -= dt;
      s.mesh.visible = s.owner.team === this.localTeam;
      const perp = new THREE.Vector3(-s.along.z, 0, s.along.x);
      let fired = false;
      if (s.arm <= 0) {
        for (const t of this.combat.targets) {
          if (!t.alive || t.team === s.owner.team || this.isDroneBody(t)) continue;
          const c = t.center(_v).sub(s.base);
          const along = c.x * s.along.x + c.z * s.along.z;
          // 높이 띄워진(점프 위) 대상은 무시
          if (along < -0.3 || along > s.length + 0.3 || c.y > 2.6) {
            s.side.delete(t.id);
            continue;
          }
          const side = Math.sign(c.x * perp.x + c.z * perp.z) || 1;
          const prev = s.side.get(t.id);
          s.side.set(t.id, side);
          if (prev !== undefined && prev !== side) {
            fired = true;
            break;
          }
        }
      }
      if (fired) {
        this.sound.play('beep', { at: s.base, gain: 0.8, pitch: 0.7 });
        this.schedule(0.8, s.onTrigger);
        s.life = 0;
      }
      if (s.life <= 0) {
        s.mesh.removeFromParent();
        this.shears.splice(i, 1);
      }
    }
  }

  private updateFireWalls(dt: number): void {
    const weapon = { ...getWeapon('blade'), name: 'FLAME LINE' };
    for (let i = this.fireWalls.length - 1; i >= 0; i--) {
      const f = this.fireWalls[i];
      f.life -= dt;
      // 머리가 나아가며 불기둥을 남긴다 (벽을 통과)
      if (f.left > 0) {
        const want = f.steer?.();
        if (want) {
          const w = new THREE.Vector3(want.x, 0, want.z);
          if (w.lengthSq() > 1e-4) f.dir.lerp(w.normalize(), Math.min(1, dt * 4)).normalize();
        }
        const step = Math.min(f.left, 18 * dt);
        const prevSeg = f.segments[f.segments.length - 1]?.pos;
        f.head.addScaledVector(f.dir, step);
        f.left -= step;
        if (!prevSeg || prevSeg.distanceTo(f.head) >= 1.2 || f.left <= 0) {
          const g = this.ground(f.head.clone().setY(f.head.y + 1.5));
          // 벽 속(바닥이 엉뚱한 높이)이면 시작 높이 그대로
          const p = Math.abs(g.y - f.head.y) < 1.2 ? g : f.head.clone();
          const mat = createBeamMaterial(0xff6020, 0.85);
          const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.75, 3, 10, 1, true), mat);
          mesh.geometry.translate(0, 1.5, 0);
          mesh.position.copy(p);
          mesh.renderOrder = 3;
          this.group.add(mesh);
          f.segments.push({ pos: p.clone(), mesh });
          f.blocker(p.clone().setY(p.y + 1.4), 0.9, f.life);
        }
      }
      for (const s of f.segments) this.vfx.zoneTick(dt, s.pos, 0.7, 0xff6020, 0, Math.min(1, f.life / 0.5));
      f.tick -= dt;
      if (f.tick <= 0) {
        f.tick = 0.25;
        const near = (t: Damageable) => {
          const c = t.center(_v);
          return f.segments.some((s) => Math.hypot(c.x - s.pos.x, c.z - s.pos.z) < 1.1 && c.y > s.pos.y - 0.5 && c.y < s.pos.y + 3);
        };
        for (const t of this.combat.targets) {
          if (!t.alive || this.isDroneBody(t) || !near(t)) continue;
          if (t.team !== f.owner.team) this.combat.applyDirectDamage(f.owner, weapon, t, Math.round(f.dps * 0.25), t.center(new THREE.Vector3()));
          else if (t.id === f.owner.id && f.heal && f.healed < 50 && t.vitals.health < 100) {
            const h = Math.min(6.25 * 0.25, 50 - f.healed, 100 - t.vitals.health);
            t.vitals.health += h;
            f.healed += h;
          }
        }
      }
      if (f.life <= 0) {
        for (const s of f.segments) {
          s.mesh.removeFromParent();
          s.mesh.geometry.dispose();
          (s.mesh.material as THREE.Material).dispose();
        }
        this.fireWalls.splice(i, 1);
      } else if (f.life < 0.5) for (const s of f.segments) (s.mesh.material as THREE.ShaderMaterial).uniforms.uIntensity.value = 0.85 * (f.life / 0.5);
    }
  }

  private updateOrbitals(dt: number): void {
    const weapon = { ...getWeapon('blade'), name: 'HALO STRIKE' };
    for (let i = this.orbitals.length - 1; i >= 0; i--) {
      const o = this.orbitals[i];
      if (o.windup > 0) {
        o.windup -= dt;
        o.mat.uniforms.uIntensity.value = 0.15 * (1 - Math.max(0, o.windup) / 2);
        continue;
      }
      if (!o.blocked) {
        // 레이저가 떨어지면 기둥이 시야를 가린다
        o.blocked = true;
        o.blocker(o.pos.clone().setY(o.pos.y + 1.6), o.radius * 0.9, o.life);
        this.vfx.blast(o.pos.clone().setY(o.pos.y + 0.5), o.radius, 0x80fff0);
        this.sound.play('explosion', { at: o.pos, size: 'large', intensity: 0.8 });
      }
      o.life -= dt;
      o.mat.uniforms.uIntensity.value = 1.1 + Math.sin(performance.now() / 40) * 0.15;
      this.vfx.zoneTick(dt, o.pos, o.radius, 0x80fff0, 1, 1);
      o.tick -= dt;
      if (o.tick <= 0) {
        o.tick = 0.25;
        // 하늘에서 내리치므로 벽과 상관없이 범위 안 모두
        for (const t of this.combat.targets) {
          if (!t.alive || t.team === o.owner.team || this.isDroneBody(t)) continue;
          const c = t.center(new THREE.Vector3());
          if (Math.hypot(c.x - o.pos.x, c.z - o.pos.z) <= o.radius && Math.abs(c.y - o.pos.y) < 4) this.combat.applyDirectDamage(o.owner, weapon, t, Math.round(o.perTick), c);
        }
      }
      if (o.life <= 0) {
        o.mesh.removeFromParent();
        o.mesh.geometry.dispose();
        o.mat.dispose();
        this.orbitals.splice(i, 1);
      }
    }
  }

  /** 주인이 설치해 두고 아직 발동하지 않은 덤불 (전부) */
  pendingVines(ownerId: string): Vine[] {
    return this.vines.filter((v) => v.owner.id === ownerId && v.arming < 0);
  }

  pendingVine(ownerId: string): Vine | null {
    return this.pendingVines(ownerId)[0] ?? null;
  }

  /** 주인이 설치해 둔 섬광 꽃 */
  pendingRose(ownerId: string): Rose | null {
    return this.roses.find((r) => r.owner.id === ownerId) ?? null;
  }

  clear(): void {
    for (let i = this.drones.length - 1; i >= 0; i--) this.removeDrone(i);
    this.scheduled = [];
    this.missiles = [];
    this.vines = [];
    this.shears = [];
    this.roses = [];
    this.fireWalls = [];
    this.orbitals = [];
    this.reveals.clear();
    this.group.clear();
  }
}

export type { Vine, Rose };
