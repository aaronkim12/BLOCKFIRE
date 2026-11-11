import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';

/**
 * 사망 래그돌 (Verlet 입자 + 거리 제약).
 *   - 관절마다 입자 하나 (엉덩이·가슴·머리·어깨·팔꿈치·손·허벅지·무릎·발)
 *   - 뼈 길이는 거리 제약으로 유지, 몸통은 서로 연결해 단단하게
 *   - 맵 충돌 박스(CollisionWorld)와 부딪히면 밀려나고 바닥에서는 마찰로 미끄러짐이 멈춤
 *   - 매 프레임 입자 위치로 각 뼈의 방향을 정한다 (죽는 순간의 자세를 기준으로 회전 차이만큼)
 * 물리 엔진 없이 캐릭터당 입자 16개라 가볍고, 몇 초 뒤 멈추면 계산을 끈다.
 */

/** 입자 순서 */
export const JOINTS = ['hips', 'chest', 'head', 'headTop', 'shL', 'elL', 'haL', 'shR', 'elR', 'haR', 'thL', 'knL', 'ftL', 'thR', 'knR', 'ftR'] as const;
export type Joint = (typeof JOINTS)[number];
const P = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<Joint, number>;
const COUNT = JOINTS.length;

/** 몸통처럼 단단하게 묶는 입자 묶음 (모든 쌍에 거리 제약) */
const RIGID: number[][] = [
  [P.hips, P.chest, P.shL, P.shR, P.thL, P.thR],
  [P.chest, P.head, P.headTop, P.shL, P.shR],
];
/** 팔다리 뼈 */
const BONES: [number, number][] = [
  [P.shL, P.elL], [P.elL, P.haL], [P.shR, P.elR], [P.elR, P.haR],
  [P.thL, P.knL], [P.knL, P.ftL], [P.thR, P.knR], [P.knR, P.ftR],
];
/** 관절이 완전히 접히지 않게: [a, b, 최소 거리 비율 (a-중간-b 길이 합 기준)] */
const FOLD: [number, number, number, number][] = [
  [P.shL, P.elL, P.haL, 0.45], [P.shR, P.elR, P.haR, 0.45],
  [P.thL, P.knL, P.ftL, 0.55], [P.thR, P.knR, P.ftR, 0.55],
  // 무릎이 가슴에 닿을 만큼 다리가 앞으로 꺾이지 않게
  [P.chest, P.thL, P.knL, 0.75], [P.chest, P.thR, P.knR, 0.75],
];
const RADIUS: number[] = [0.12, 0.13, 0.1, 0.1, 0.07, 0.06, 0.06, 0.07, 0.06, 0.06, 0.09, 0.07, 0.06, 0.09, 0.07, 0.06];

const GRAVITY = 13;
const ITER = 10;
const SLEEP_AFTER = 5;

interface Link {
  a: number;
  b: number;
  len: number;
  min?: boolean;
}

const _box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

export class Ragdoll {
  readonly pos: THREE.Vector3[] = Array.from({ length: COUNT }, () => new THREE.Vector3());
  private prev: THREE.Vector3[] = Array.from({ length: COUNT }, () => new THREE.Vector3());
  private links: Link[] = [];
  private time = 0;
  private still = 0;
  asleep = false;

  /**
   * @param start 죽는 순간 관절 위치 (P 순서)
   * @param vel 몸 전체 속도 (이동 중이던 속도)
   * @param impulse 맞은 방향으로 밀어내는 속도와 맞은 지점 (그 근처 입자가 더 세게 밀림)
   */
  constructor(start: THREE.Vector3[], vel: THREE.Vector3, impulse: { dir: THREE.Vector3; point: THREE.Vector3 | null }, private world: CollisionWorld | null) {
    const dt = 1 / 60;
    for (let i = 0; i < COUNT; i++) {
      this.pos[i].copy(start[i]);
      let k = 1;
      if (impulse.point) k = 0.5 + 1.2 * Math.exp(-start[i].distanceToSquared(impulse.point) / 0.15);
      const v = vel.clone().addScaledVector(impulse.dir, k);
      this.prev[i].copy(start[i]).addScaledVector(v, -dt);
    }
    const add = (a: number, b: number, min = false, scale = 1) => this.links.push({ a, b, len: start[a].distanceTo(start[b]) * scale, min });
    for (const group of RIGID) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) add(group[i], group[j]);
    for (const [a, b] of BONES) add(a, b);
    for (const [a, m, b, k] of FOLD) this.links.push({ a, b, len: (start[a].distanceTo(start[m]) + start[m].distanceTo(start[b])) * k, min: true });
  }

  update(dt: number): void {
    if (this.asleep) return;
    dt = Math.min(dt, 1 / 30);
    // 작은 단계로 나눠 안정적으로
    const steps = dt > 1 / 70 ? 2 : 1;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) this.step(h);
    this.time += dt;
    // 거의 멈췄으면 잠듦
    let motion = 0;
    for (let i = 0; i < COUNT; i++) motion = Math.max(motion, this.pos[i].distanceToSquared(this.prev[i]));
    this.still = motion < 1e-7 ? this.still + dt : 0;
    if (this.time > SLEEP_AFTER || this.still > 0.6) this.asleep = true;
  }

  private step(h: number): void {
    const g = GRAVITY * h * h;
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      const q = this.prev[i];
      const vx = (p.x - q.x) * 0.995;
      const vy = (p.y - q.y) * 0.995;
      const vz = (p.z - q.z) * 0.995;
      q.copy(p);
      p.set(p.x + vx, p.y + vy - g, p.z + vz);
    }
    for (let it = 0; it < ITER; it++) {
      for (const l of this.links) {
        const a = this.pos[l.a];
        const b = this.pos[l.b];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        if (l.min && d >= l.len) continue;
        const k = ((d - l.len) / d) * 0.5;
        a.x += dx * k; a.y += dy * k; a.z += dz * k;
        b.x -= dx * k; b.y -= dy * k; b.z -= dz * k;
      }
      this.collide();
    }
  }

  /** 맵 박스 밖으로 밀어냄. 위로 밀린(바닥) 입자는 마찰로 미끄러짐을 줄인다 */
  private collide(): void {
    const w = this.world;
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      const r = RADIUS[i];
      if (!w) {
        if (p.y < r) this.ground(i, r - p.y);
        continue;
      }
      _box.minX = p.x - r; _box.maxX = p.x + r;
      _box.minY = p.y - r; _box.maxY = p.y + r;
      _box.minZ = p.z - r; _box.maxZ = p.z + r;
      for (const b of w.query(_box)) {
        if (p.x <= b.minX - r || p.x >= b.maxX + r || p.y <= b.minY - r || p.y >= b.maxY + r || p.z <= b.minZ - r || p.z >= b.maxZ + r) continue;
        // 가장 얕은 방향으로 밀어냄
        const pen = [p.x - (b.minX - r), b.maxX + r - p.x, p.y - (b.minY - r), b.maxY + r - p.y, p.z - (b.minZ - r), b.maxZ + r - p.z];
        let m = 0;
        for (let k = 1; k < 6; k++) if (pen[k] < pen[m]) m = k;
        if (m === 0) p.x -= pen[0];
        else if (m === 1) p.x += pen[1];
        else if (m === 2) p.y -= pen[2];
        else if (m === 3) this.ground(i, pen[3]);
        else if (m === 4) p.z -= pen[4];
        else p.z += pen[5];
      }
    }
  }

  private ground(i: number, push: number): void {
    const p = this.pos[i];
    const q = this.prev[i];
    p.y += push;
    // 마찰: 이번 단계의 수평 이동을 줄임
    p.x = q.x + (p.x - q.x) * 0.85;
    p.z = q.z + (p.z - q.z) * 0.85;
  }
}
