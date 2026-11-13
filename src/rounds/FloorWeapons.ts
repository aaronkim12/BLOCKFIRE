import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { getWeapon } from '../weapons/weaponData';
import { instantiateWeapon, loadWeaponTemplate } from '../weapons/WeaponModels';

/**
 * 바닥에 떨어진 무기 (G로 버린 총 — 아군에게 건네주기).
 *   - 던진 방향으로 날아가 바닥·벽에 닿으면 멈춘다
 *   - 옆으로 누운 무기가 천천히 돌며 위아래로 살짝 떠서 눈에 띈다
 *   - 봇 대전: 이 클래스가 위치·탄약까지 관리 / 온라인: 서버 목록을 sync()로 따라 그린다
 */
export interface FloorWeapon {
  id: number;
  weapon: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  settled: boolean;
  /** 남은 탄 (봇 대전) */
  mag?: number;
  reserve?: number;
  /** 버린 사람·시각 (버리자마자 다시 줍지 않게) */
  by: string;
  at: number;
  mesh: THREE.Group;
}

const GRAVITY = 14;
let nextId = 1;

export class FloorWeapons {
  readonly group = new THREE.Group();
  readonly items = new Map<number, FloorWeapon>();
  private time = 0;

  constructor(private world: CollisionWorld) {
    this.group.name = 'floor-weapons';
  }

  /** 던져서 버림: from(눈 앞)에서 vel로 */
  drop(weapon: string, from: THREE.Vector3, vel: THREE.Vector3, by: string, ammo?: { mag: number; reserve: number }, id = nextId++): FloorWeapon {
    const mesh = new THREE.Group();
    this.group.add(mesh);
    const w: FloorWeapon = { id, weapon, pos: from.clone(), vel: vel.clone(), settled: false, mag: ammo?.mag, reserve: ammo?.reserve, by, at: performance.now(), mesh };
    this.items.set(id, w);
    const def = getWeapon(weapon);
    void loadWeaponTemplate(def).then((t) => {
      if (!this.items.has(id)) return;
      const inst = instantiateWeapon(t);
      // 옆으로 눕힌다 (총구가 수평, 옆면이 위)
      inst.root.rotation.z = Math.PI / 2;
      inst.root.position.set(0, 0, 0);
      mesh.add(inst.root);
    });
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.position.copy(w.pos);
    return w;
  }

  remove(id: number): FloorWeapon | null {
    const w = this.items.get(id);
    if (!w) return null;
    this.items.delete(id);
    w.mesh.removeFromParent();
    return w;
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  /** 온라인: 서버가 알려 준 목록으로 맞춘다 */
  sync(list: { i: number; w: string; p: [number, number, number] }[]): void {
    const seen = new Set<number>();
    for (const it of list) {
      seen.add(it.i);
      let w = this.items.get(it.i);
      if (!w) w = this.drop(it.w, new THREE.Vector3(...it.p), new THREE.Vector3(), '', undefined, it.i);
      w.pos.set(...it.p);
      w.settled = true;
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.remove(id);
  }

  /** pos에서 r 안의 가장 가까운 무기 (filter로 거를 수 있음) */
  nearest(pos: THREE.Vector3, r: number, filter?: (w: FloorWeapon) => boolean): FloorWeapon | null {
    let best: FloorWeapon | null = null;
    let bd = r * r;
    for (const w of this.items.values()) {
      if (filter && !filter(w)) continue;
      const d = (w.pos.x - pos.x) ** 2 + (w.pos.z - pos.z) ** 2 + ((w.pos.y - pos.y) * 0.5) ** 2;
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  update(dt: number): void {
    this.time += dt;
    for (const w of this.items.values()) {
      if (!w.settled) {
        w.vel.y -= GRAVITY * dt;
        const step = w.vel.clone().multiplyScalar(dt);
        const len = step.length();
        if (len > 0) {
          const dir = step.clone().divideScalar(len);
          const hit = this.world.raycast(w.pos.x, w.pos.y, w.pos.z, dir.x, dir.y, dir.z, len + 0.12);
          if (hit) {
            w.pos.addScaledVector(dir, Math.max(0, hit.distance - 0.12));
            if (dir.y < -0.3) {
              w.settled = true;
            } else {
              // 벽: 앞으로는 멈추고 그대로 떨어진다
              w.vel.set(0, Math.min(0, w.vel.y), 0);
            }
          } else w.pos.add(step);
        }
        if (w.pos.y < -5) w.settled = true;
      }
      // 바닥 위 0.12m에서 살짝 떠다니며 돈다
      const bob = w.settled ? 0.12 + Math.sin(this.time * 2 + w.id) * 0.03 : 0;
      w.mesh.position.set(w.pos.x, w.pos.y + bob, w.pos.z);
      if (w.settled) w.mesh.rotation.y += dt * 0.8;
    }
  }

  /** 지도 표시용 위치 */
  positions(): THREE.Vector3[] {
    return [...this.items.values()].map((w) => w.pos);
  }
}
