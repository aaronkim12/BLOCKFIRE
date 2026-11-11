import * as THREE from 'three';
import type { Sound } from '../audio/Sound';
import { boxNormal, type CombatSystem, type Damageable, type Shooter } from '../combat/CombatSystem';
import type { Vfx } from '../effects/vfx/Vfx';
import { createBarrierMaterial, createBeamMaterial, createZoneMaterial, vfxTime } from '../effects/vfx/VfxMaterials';
import { createPSXMaterial } from '../graphics/PSXMaterial';
import { AdvancedEffects } from './AdvancedEffects';
import { StatusEffects } from './StatusEffects';
import type { AABB, CollisionWorld } from '../physics/CollisionWorld';
import type { Team } from '../player/CharacterModel';
import { getWeapon } from '../weapons/weaponData';

/**
 * 능력이 만들어 내는 월드 효과.
 *   투척물(포물선, 벽에 튕김) → 착지하면 효과 발동
 *   연막(시야 차단) / 방벽(이동·총알 차단, 파괴 가능) / 비콘(적 위치 표시) / 지역(지속 피해) / 섬광(시야 차단)
 * 효과는 팀을 가지므로 Phase 7 봇·Phase 8 원격 플레이어도 같은 코드로 능력을 쓸 수 있다.
 * 겉모습은 Vfx(입자·충격파)와 전용 셰이더(방벽·지역 바닥·빛 기둥)로 그린다.
 */

export interface FacingTarget extends Damageable {
  /** 바라보는 방향 (섬광 판정) */
  facing?(out: THREE.Vector3): THREE.Vector3;
  /** 눈 위치 */
  eyePos?(out: THREE.Vector3): THREE.Vector3;
}

/** 투척물 옵션 */
export interface ThrowOptions {
  /** 중력 (기본 16) */
  gravity?: number;
  /** 최대 비행 시간 (지나면 그 자리에서 터짐) */
  life?: number;
  /** 매 프레임 조종 방향 (null이면 그대로 날아감) */
  steer?: () => THREE.Vector3 | null;
  /** 바닥(stick이면 아무 면)에서 이만큼 튕긴 뒤 멈춤 (기본 0) */
  bounces?: number;
  /** 처음 닿는 면에 붙는다 (bounces만큼 튕긴 뒤) */
  stick?: boolean;
  /** 날아가며 수평으로 휘는 정도 (rad/s, +면 왼쪽) */
  curve?: number;
}

interface Projectile {
  mesh: THREE.Mesh;
  color: number;
  gravity: number;
  steer?: () => THREE.Vector3 | null;
  bounces: number;
  stick: boolean;
  curve: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  onLand: (p: THREE.Vector3) => void;
  /** 공중에서 터지는 시간 (섬광). 0이면 착지할 때 */
  fuse: number;
}

/** 연막 (모양은 Vfx 입자, 여기서는 시야 판정용 구) */
interface Smoke { pos: THREE.Vector3; radius: number; life: number; max: number }
interface Wall {
  mesh: THREE.Mesh; mat: THREE.ShaderMaterial; box: AABB; hp: number; maxHp: number; life: number;
  rise: number; size: THREE.Vector3; hit: number;
}
interface Beacon { mesh: THREE.Group; pos: THREE.Vector3; radius: number; life: number; team: Team; pulse: number; kind: 'reveal' | 'stim'; color: number }
interface Zone {
  mesh: THREE.Group; mat: THREE.ShaderMaterial; edge: THREE.ShaderMaterial; kind: 0 | 1; color: number;
  pos: THREE.Vector3; radius: number; life: number; max: number; dps: number; owner: Shooter; name: string; tick: number;
  /** 주인 회복 (초당, 0이면 없음) / 지금까지 회복한 양 */
  heal: number; healed: number;
}

const GRAVITY = 16;
const WALL_COLOR = 0x4fe0c0;
const BEACON_COLOR = 0x40c8ff;
const UP = new THREE.Vector3(0, 1, 0);

/** 메시와 그 아래의 지오메트리·머티리얼 해제 (공유 지오메트리는 keep으로 제외) */
function disposeTree(o: THREE.Object3D, keep?: THREE.BufferGeometry): void {
  o.removeFromParent();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry !== keep) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat.dispose();
  });
}

export class AbilityEffects {
  readonly group = new THREE.Group();
  private projectiles: Projectile[] = [];
  private smokes: Smoke[] = [];
  private walls: Wall[] = [];
  /** 시간이 다 되어 사라지는 중인 방벽 (충돌은 이미 없음) */
  private fadingWalls: { wall: Wall; t: number }[] = [];
  private beacons: Beacon[] = [];
  private zones: Zone[] = [];
  private blinded = new Map<string, number>();
  /** 비콘에 드러난 적 (HUD 표시) */
  revealed: Damageable[] = [];
  /** 진영별: 그 진영의 비콘에 드러난 적 (봇이 정보로 사용) */
  revealedBy = new Map<Team, Damageable[]>();
  /** 내 화면 섬광 세기 0..1 */
  playerFlash = 0;
  /** 상태 이상 (충격·억제·무력화·감속·가속·쇠약) */
  readonly status = new StatusEffects();
  /** 2세대 능력 월드 효과 */
  readonly adv: AdvancedEffects;
  /** 내(로컬 플레이어) 시점: 누가 던진 섬광이든 이 카메라로 눈부심을 판정 */
  localViewer: { camera: THREE.Camera; id: string; team: () => Team } | null = null;

  private projectileGeo = new THREE.IcosahedronGeometry(0.09, 0);

  constructor(
    private world: CollisionWorld,
    private combat: CombatSystem,
    private sound: Sound,
    private vfx: Vfx,
  ) {
    this.adv = new AdvancedEffects(world, combat, sound, vfx, this.status);
  }

  /** 그룹 (2세대 효과 포함) — 장면에 추가할 때 사용 */
  attachTo(scene: THREE.Object3D): void {
    scene.add(this.group, this.adv.group);
  }

  // ───────────────────────── 생성 ─────────────────────────

  throwProjectile(from: THREE.Vector3, dir: THREE.Vector3, speed: number, color: number, onLand: (p: THREE.Vector3) => void, fuse = 0, opts: ThrowOptions = {}): void {
    const mesh = new THREE.Mesh(this.projectileGeo, createPSXMaterial({ color: 0x303438, emissive: color }));
    mesh.position.copy(from);
    this.group.add(mesh);
    this.projectiles.push({
      mesh, color, pos: from.clone(), vel: dir.clone().normalize().multiplyScalar(speed), life: opts.life ?? 4, onLand, fuse,
      gravity: opts.gravity ?? GRAVITY, steer: opts.steer, bounces: opts.bounces ?? 0, stick: !!opts.stick, curve: opts.curve ?? 0,
    });
    this.sound.play('ability', { at: from, gain: 0.6 });
  }

  spawnSmoke(pos: THREE.Vector3, radius: number, duration: number): void {
    this.vfx.smokeCloud(pos, radius, duration);
    this.smokes.push({ pos: pos.clone().setY(pos.y + radius * 0.45), radius, life: duration, max: duration });
    this.sound.play('smoke', { at: pos, gain: 0.9 });
  }

  /** 보이지 않는 시야 차단 (불길 벽·레이저 기둥: 모양은 따로 그린다) */
  addBlocker(pos: THREE.Vector3, radius: number, duration: number): void {
    this.smokes.push({ pos: pos.clone(), radius, life: duration, max: duration + 1 });
  }

  /** 방벽: AABB 충돌을 쓰므로 바라보는 방향에 수직인 축으로 맞춘다 */
  spawnWall(center: THREE.Vector3, facing: THREE.Vector3, width: number, hp: number, duration: number): void {
    const alongX = Math.abs(facing.z) >= Math.abs(facing.x); // 앞이 Z축이면 벽은 X축으로 길다
    const h = 2.6;
    const d = 0.35;
    const sx = alongX ? width : d;
    const sz = alongX ? d : width;
    const box: AABB = {
      minX: center.x - sx / 2, maxX: center.x + sx / 2,
      minY: center.y, maxY: center.y + h,
      minZ: center.z - sz / 2, maxZ: center.z + sz / 2,
    };
    const size = new THREE.Vector3(sx, h, sz);
    const mat = createBarrierMaterial(WALL_COLOR, size);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat);
    mesh.position.set(center.x, center.y + h / 2, center.z);
    mesh.castShadow = true;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.world.add(box);
    this.walls.push({ mesh, mat, box, hp, maxHp: hp, life: duration, rise: 0, size, hit: 0 });
    this.vfx.ring(new THREE.Vector3(center.x, center.y + 0.05, center.z), width * 0.65, 0.45, WALL_COLOR, UP, 0.08, 0.9);
    this.sound.play('wall_up', { at: center, gain: 1 });
  }

  spawnBeacon(pos: THREE.Vector3, radius: number, duration: number, team: Team, kind: 'reveal' | 'stim' = 'reveal'): void {
    const color = kind === 'stim' ? 0xffa040 : BEACON_COLOR;
    // 기기 + 위로 뻗는 빛 기둥
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), createPSXMaterial({ color: 0x103040, emissive: color }));
    core.position.y = 0.2;
    core.name = 'core';
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, 3, 12, 1, true), createBeamMaterial(color, 0.9));
    beam.geometry.translate(0, 1.5, 0);
    beam.renderOrder = 3;
    mesh.add(core, beam);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.beacons.push({ mesh, pos: pos.clone(), radius, life: duration, team, pulse: 0, kind, color });
  }

  spawnZone(pos: THREE.Vector3, radius: number, duration: number, dps: number, owner: Shooter, name: string, color: number, heal = 0): void {
    // 빨강이 강하면 화염, 아니면 봉쇄장
    const kind: 0 | 1 = color >> 16 > (color & 0xff) ? 0 : 1;
    const mesh = new THREE.Group();
    const mat = createZoneMaterial(color, kind);
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 2;
    // 경계를 보여 주는 낮은 빛의 벽
    const edgeH = kind === 0 ? 0.6 : 2.4;
    const edge = createBeamMaterial(color, kind === 0 ? 0.25 : 0.6);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, edgeH, 48, 1, true), edge);
    wall.geometry.translate(0, edgeH / 2, 0);
    wall.renderOrder = 3;
    mesh.add(disc, wall);
    mesh.position.copy(pos).setY(pos.y + 0.03);
    this.group.add(mesh);
    this.zones.push({ mesh, mat, edge, kind, color, pos: pos.clone(), radius, life: duration, max: duration, dps, owner, name, tick: 0, heal, healed: 0 });
    this.vfx.zoneBurst(pos, radius, color);
    this.sound.play('zone', { at: pos, gain: 1 });
  }

  /**
   * 섬광: 터지는 지점을 바라보고 있고 가려지지 않은 적을 duration초 동안 눈멀게 한다.
   * 던진 사람 자신도 그 방향을 보고 있으면 눈이 부시다.
   */
  flare(pos: THREE.Vector3, owner: Shooter, duration: number, radius: number, viewer: { camera: THREE.Camera; id: string }): void {
    this.sound.play('flare', { at: pos, gain: 1.2 });
    this.vfx.flare(pos);
    const seen = (eye: THREE.Vector3, facing: THREE.Vector3) => {
      const to = pos.clone().sub(eye);
      const dist = to.length();
      if (dist > radius) return 0;
      to.normalize();
      const facingDot = facing.dot(to);
      if (facingDot < 0.25) return 0; // 대략 시야각 150° 밖
      const hit = this.world.raycast(eye.x, eye.y, eye.z, to.x, to.y, to.z, dist);
      if (hit && hit.distance < dist - 0.2) return 0;
      if (this.blocksLine(eye, pos)) return 0;
      return Math.min(1, (facingDot - 0.25) / 0.5 + 0.3);
    };
    for (const t of this.combat.targets as FacingTarget[]) {
      if (!t.alive || t.team === owner.team || !t.facing || !t.eyePos) continue;
      const k = seen(t.eyePos(new THREE.Vector3()), t.facing(new THREE.Vector3()));
      if (k > 0) this.blinded.set(t.id, Math.max(this.blinded.get(t.id) ?? 0, duration * k));
    }
    // 내 화면: 내가 던졌거나(자기 섬광도 눈부심) 적이 던진 섬광만. 아군 봇의 섬광은 영향 없음
    const lv = this.localViewer ?? { camera: viewer.camera, id: viewer.id, team: () => owner.team };
    if (lv.id === owner.id || lv.team() !== owner.team) {
      const cam = lv.camera;
      const eye = cam.getWorldPosition(new THREE.Vector3());
      const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      const k = seen(eye, facing);
      if (k > 0) this.playerFlash = Math.max(this.playerFlash, k);
    }
  }

  // ───────────────────────── 질의 ─────────────────────────

  /** 연막이 퍼진 정도에 따른 현재 반경 (터진 뒤 1초에 걸쳐 커지고, 끝날 때 줄어듦) */
  private smokeRadius(s: Smoke): number {
    const grow = Math.min(1, (s.max - s.life) / 1.0);
    const fade = Math.min(1, s.life / 1.2);
    return s.radius * grow * (0.5 + 0.5 * fade);
  }

  /** 두 점 사이 시야가 연막에 가려지는지 */
  blocksLine(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const ab = b.clone().sub(a);
    const len = ab.length();
    if (len < 1e-4) return false;
    ab.divideScalar(len);
    for (const s of this.smokes) {
      const r = this.smokeRadius(s);
      const t = THREE.MathUtils.clamp(s.pos.clone().sub(a).dot(ab), 0, len);
      if (a.clone().addScaledVector(ab, t).distanceTo(s.pos) < r * 0.9) return true;
    }
    return false;
  }

  /** 점이 연막 안에 얼마나 깊이 있는지 0..1 (화면을 연기로 덮는 데 사용) */
  smokeDensityAt(p: THREE.Vector3): number {
    let k = 0;
    for (const s of this.smokes) {
      const r = this.smokeRadius(s);
      if (r <= 0.01) continue;
      const d = p.distanceTo(s.pos) / r;
      k = Math.max(k, THREE.MathUtils.smoothstep(1.05 - d, 0, 0.35) * Math.min(1, s.life / 1.2));
    }
    return k;
  }

  isBlinded(id: string): boolean {
    return (this.blinded.get(id) ?? 0) > 0;
  }

  /** 총알이 벽에 맞음 → 능력 방벽이면 피해 + 맞은 자리에 파문 */
  onImpact(point: THREE.Vector3, damage: number): void {
    for (const w of this.walls) {
      const b = w.box;
      const e = 0.05;
      if (point.x >= b.minX - e && point.x <= b.maxX + e && point.y >= b.minY - e && point.y <= b.maxY + e && point.z >= b.minZ - e && point.z <= b.maxZ + e) {
        w.hp -= damage;
        if (w.hp <= 0) w.life = 0;
        const hits = w.mat.uniforms.uHits.value as THREE.Vector4[];
        hits[w.hit++ % hits.length].set(point.x, point.y, point.z, vfxTime.value);
        return;
      }
    }
  }

  get activeCounts() {
    return { smokes: this.smokes.length, walls: this.walls.length, beacons: this.beacons.length, zones: this.zones.length, projectiles: this.projectiles.length };
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(dt: number, localTeam: Team): void {
    this.updateProjectiles(dt);
    this.status.update(dt);
    this.adv.localTeam = localTeam;
    this.adv.update(dt);

    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= dt;
      if (s.life <= 0) this.smokes.splice(i, 1);
    }

    for (let i = this.walls.length - 1; i >= 0; i--) {
      const w = this.walls[i];
      w.life -= dt;
      // 솟아오름: 0.45초, 윗선을 따라 불꽃
      if (w.rise < 1) {
        w.rise = Math.min(1, w.rise + dt / 0.45);
        const y = w.box.minY + w.size.y * w.rise;
        this.vfx.wallRiseSparks(w.mesh.position, w.size, y, WALL_COLOR);
      }
      w.mat.uniforms.uRise.value = w.rise;
      w.mat.uniforms.uHp.value = Math.max(0, w.hp / w.maxHp);
      if (w.life <= 0) {
        this.world.remove(w.box);
        this.walls.splice(i, 1);
        if (w.hp <= 0) {
          // 부서짐: 산산조각
          this.vfx.shatter(w.mesh.position, w.size, WALL_COLOR);
          disposeTree(w.mesh);
          this.sound.play('impact', { at: w.mesh.position, gain: 0.8, pitch: 0.5 });
        } else {
          // 시간 만료: 아래로 가라앉으며 흐려짐
          this.fadingWalls.push({ wall: w, t: 0 });
        }
      }
    }
    for (let i = this.fadingWalls.length - 1; i >= 0; i--) {
      const f = this.fadingWalls[i];
      f.t += dt / 0.5;
      f.wall.mat.uniforms.uFade.value = 1 - f.t;
      f.wall.mat.uniforms.uRise.value = 1 - f.t * 0.6;
      if (f.t >= 1) {
        disposeTree(f.wall.mesh);
        this.fadingWalls.splice(i, 1);
      }
    }

    // 비콘: 1초마다 신호, 반경 안의 적을 드러냄
    this.revealed = [];
    this.revealedBy.clear();
    for (let i = this.beacons.length - 1; i >= 0; i--) {
      const b = this.beacons[i];
      b.life -= dt;
      b.pulse -= dt;
      const core = b.mesh.getObjectByName('core');
      if (core) {
        core.rotation.y += dt * 3;
        core.position.y = 0.22 + Math.sin(b.life * 4) * 0.03;
      }
      if (b.kind === 'stim') {
        // 자극 신호기: 범위 안 아군에게 연사·이동 +10% (벗어나도 4초)
        if (b.pulse <= 0) {
          b.pulse = 1;
          this.vfx.ring(new THREE.Vector3(b.pos.x, b.pos.y + 0.05, b.pos.z), b.radius, 0.9, b.color, UP, 0.05, 0.6);
        }
        for (const t of this.combat.targets)
          if (t.alive && t.team === b.team && t.center(new THREE.Vector3()).distanceTo(b.pos) <= b.radius + 0.8) this.status.apply(t.id, 'stim', 4);
        if (b.life <= 0) {
          disposeTree(b.mesh);
          this.beacons.splice(i, 1);
        }
        continue;
      }
      if (b.pulse <= 0) {
        b.pulse = 1;
        this.sound.play('beacon', { at: b.pos, gain: 0.6 });
        this.vfx.beaconPulse(new THREE.Vector3(b.pos.x, b.pos.y + 0.22, b.pos.z), b.radius);
      }
      const list = this.revealedBy.get(b.team) ?? [];
      this.revealedBy.set(b.team, list);
      for (const t of this.combat.targets) {
        if (!t.alive || t.team === b.team) continue;
        if (t.center(new THREE.Vector3()).distanceTo(b.pos) <= b.radius && !list.includes(t)) list.push(t);
      }
      if (b.team === localTeam) for (const t of list) if (!this.revealed.includes(t)) this.revealed.push(t);
      if (b.life <= 0) {
        disposeTree(b.mesh);
        this.beacons.splice(i, 1);
      }
    }
    // 드론에 드러난 적
    for (const r of this.adv.reveals.values()) {
      const list = this.revealedBy.get(r.team) ?? [];
      this.revealedBy.set(r.team, list);
      if (!list.includes(r.target)) list.push(r.target);
      if (r.team === localTeam && !this.revealed.includes(r.target)) this.revealed.push(r.target);
    }

    // 지역: 0.25초마다 범위 안의 적에게 피해
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life -= dt;
      z.tick -= dt;
      // 펼쳐짐(0.35초) → 유지 → 끝날 때 오므라듦(0.4초)
      const open = Math.min(1, (z.max - z.life) / 0.35);
      const close = Math.min(1, Math.max(0, z.life) / 0.4);
      const spread = 1 - Math.pow(1 - open, 3);
      z.mat.uniforms.uLife.value = spread * close;
      z.edge.uniforms.uIntensity.value = (z.kind === 0 ? 0.25 : 0.6) * close * open;
      this.vfx.zoneTick(dt, z.pos, z.radius * spread, z.color, z.kind, close);
      if (z.tick <= 0) {
        z.tick = 0.25;
        const weapon = { ...getWeapon('blade'), name: z.name };
        for (const t of this.combat.targets) {
          if (!t.alive || t.team === z.owner.team) continue;
          const c = t.center(new THREE.Vector3());
          if (Math.hypot(c.x - z.pos.x, c.z - z.pos.z) <= z.radius && Math.abs(c.y - z.pos.y) < 2.2)
            this.combat.applyDirectDamage(z.owner, weapon, t, Math.round(z.dps * 0.25), c);
        }
        // 자기 불 위에서 회복 (불 하나당 최대 50)
        if (z.heal > 0 && z.healed < 50) {
          const me = this.combat.targets.find((t) => t.id === z.owner.id);
          if (me?.alive && me.vitals.health < 100) {
            const c = me.center(new THREE.Vector3());
            if (Math.hypot(c.x - z.pos.x, c.z - z.pos.z) <= z.radius && Math.abs(c.y - z.pos.y) < 2.2) {
              const h = Math.min(z.heal * 0.25, 50 - z.healed, 100 - me.vitals.health);
              me.vitals.health += h;
              z.healed += h;
            }
          }
        }
      }
      if (z.life <= 0) {
        disposeTree(z.mesh);
        this.zones.splice(i, 1);
      }
    }

    for (const [id, t] of this.blinded) {
      if (t - dt <= 0) this.blinded.delete(id);
      else this.blinded.set(id, t - dt);
    }
    this.playerFlash = Math.max(0, this.playerFlash - dt * 0.45);
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      if (p.fuse > 0) {
        p.fuse -= dt;
        if (p.fuse <= 0) {
          this.land(i);
          continue;
        }
      }
      // 조종: 속도는 유지하고 방향만 조준 쪽으로 돌린다
      if (p.curve) p.vel.applyAxisAngle(UP, p.curve * dt);
      const want = p.steer?.();
      if (want) {
        const sp = p.vel.length();
        p.vel.normalize().lerp(want, Math.min(1, dt * 5)).normalize().multiplyScalar(sp);
      } else p.vel.y -= p.gravity * dt;
      const step = p.vel.clone().multiplyScalar(dt);
      const len = step.length();
      const dir = step.clone().divideScalar(len || 1);
      const hit = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, len + 0.09);
      if (hit) {
        const at = p.pos.clone().addScaledVector(dir, Math.max(0, hit.distance - 0.09));
        const n = boxNormal(hit.box, p.pos.clone().addScaledVector(dir, hit.distance));
        p.pos.copy(at);
        const floor = n.y > 0.5;
        if (p.steer || p.vel.length() < 2 || ((floor || p.stick) && p.bounces <= 0)) {
          this.land(i);
          continue;
        }
        // 튕긴다 (바닥에서는 횟수를 센다)
        p.vel.reflect(n);
        // 바닥: 수평 속도를 크게 잃고 낮게 튐 / 벽: 고르게 감속
        if (floor) p.vel.set(p.vel.x * 0.3, p.vel.y * 0.45, p.vel.z * 0.3);
        else p.vel.multiplyScalar(0.45);
        if (floor || p.stick) p.bounces--;
      } else {
        p.pos.add(step);
      }
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += dt * 8;
      this.vfx.trail(p.pos, p.color);
      if (p.life <= 0) this.land(i);
    }
  }

  private land(i: number): void {
    const p = this.projectiles[i];
    this.projectiles.splice(i, 1);
    disposeTree(p.mesh, this.projectileGeo);
    p.onLand(p.pos.clone());
  }

  /** 라운드가 끝나면 모든 효과 제거 */
  clear(): void {
    for (const w of this.walls) this.world.remove(w.box);
    for (const o of [...this.group.children]) disposeTree(o, this.projectileGeo);
    this.projectiles = [];
    this.smokes = [];
    this.walls = [];
    this.fadingWalls = [];
    this.beacons = [];
    this.zones = [];
    this.blinded.clear();
    this.revealed = [];
    this.playerFlash = 0;
    this.group.clear();
    this.vfx.clear();
    this.status.clear();
    this.adv.clear();
  }
}
