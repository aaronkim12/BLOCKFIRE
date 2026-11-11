import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { SiteId } from '../rounds/RoundManager';
import type { Cell, NavGrid } from './NavGrid';

/**
 * 맵에서 자동으로 뽑아낸 전술 지점 (맵 데이터만 바꾸면 새 맵에도 그대로 동작).
 *   - 공격 집결지: 공격 스폰 → 구역 최단 경로에서 구역 입구 약 4칸 앞
 *   - 구역 입구: 공격 경로가 구역에 처음 들어서는 칸
 *   - 수비 위치: 구역 안/옆의 엄폐물 옆 칸 중 입구가 보이고 입구에서 6m 이상 떨어진 곳
 *   - 미드 위치: 두 스폰 사이 경로의 가운데쯤 엄폐물 옆
 * 그리고 실시간 질의: 엄폐 위치 찾기, 설치 후 지킬 위치.
 */

export interface SiteInfo {
  id: SiteId;
  cells: Cell[];
  center: THREE.Vector3;
  staging: THREE.Vector3;
  entrance: THREE.Vector3;
  /** 수비가 지킬 위치 + 바라볼 곳 */
  holds: { pos: THREE.Vector3; watch: THREE.Vector3 }[];
}

const EYE = 1.5;

export class Tactics {
  readonly sites: Record<SiteId, SiteInfo>;
  readonly attackSpawn: THREE.Vector3;
  readonly defenseSpawn: THREE.Vector3;
  readonly midHolds: { pos: THREE.Vector3; watch: THREE.Vector3 }[];

  constructor(
    readonly nav: NavGrid,
    private world: CollisionWorld,
  ) {
    this.attackSpawn = this.centroid(nav.cellsOf('T'));
    this.defenseSpawn = this.centroid(nav.cellsOf('D'));
    this.sites = { A: this.analyzeSite('A'), B: this.analyzeSite('B') };
    this.midHolds = this.analyzeMid();
  }

  private centroid(cells: Cell[]): THREE.Vector3 {
    const v = new THREE.Vector3();
    for (const c of cells) v.add(this.nav.center(c));
    v.divideScalar(Math.max(1, cells.length));
    // 실제로 걸을 수 있는 칸 중심으로
    return this.nav.center(this.nav.nearestWalkable(v));
  }

  /** 두 점 사이가 벽에 막히지 않는지 (눈높이) */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3, ay = EYE, by = EYE): boolean {
    const dx = b.x - a.x;
    const dy = b.y + by - (a.y + ay);
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const hit = this.world.raycast(a.x, a.y + ay, a.z, dx / d, dy / d, dz / d, d);
    return !hit || hit.distance > d - 0.3;
  }

  private analyzeSite(id: SiteId): SiteInfo {
    const nav = this.nav;
    const cells = nav.cellsOf(id);
    const center = this.centroid(cells);
    const path = nav.findPath(nav.cellOf(this.attackSpawn), nav.cellOf(center)) ?? [];
    let enter = path.findIndex((c) => nav.at(c.r, c.c) === id);
    if (enter < 0) enter = path.length - 1;
    const entrance = nav.center(path[enter] ?? nav.cellOf(center));
    const staging = nav.center(path[Math.max(0, enter - 4)] ?? nav.cellOf(this.attackSpawn));
    // 수비 위치 후보: 구역 칸 + 구역에 붙은 칸 중 엄폐물 옆
    const inSite = new Set(cells.map((c) => nav.idx(c.r, c.c)));
    const cand: Cell[] = [];
    for (let r = 0; r < nav.rows; r++)
      for (let c = 0; c < nav.cols; c++) {
        if (!nav.walkable(r, c) || !nav.coverAdj[nav.idx(r, c)]) continue;
        const near = inSite.has(nav.idx(r, c)) || [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dr, dc]) => inSite.has(nav.idx(r + dr, c + dc)));
        if (near) cand.push({ r, c });
      }
    const holds = cand
      .map((c) => nav.center(c))
      .filter((p) => p.distanceTo(entrance) >= 6 && this.lineOfSight(p, entrance))
      .sort((a, b) => b.distanceTo(entrance) - a.distanceTo(entrance))
      .slice(0, 8)
      .map((pos) => ({ pos, watch: entrance.clone() }));
    // 입구가 보이는 곳이 없으면 구역 중심이라도 지킨다
    if (holds.length === 0) holds.push({ pos: center.clone(), watch: entrance.clone() });
    return { id, cells, center, staging, entrance, holds };
  }

  private analyzeMid(): { pos: THREE.Vector3; watch: THREE.Vector3 }[] {
    const nav = this.nav;
    const path = nav.findPath(nav.cellOf(this.defenseSpawn), nav.cellOf(this.attackSpawn)) ?? [];
    const out: { pos: THREE.Vector3; watch: THREE.Vector3 }[] = [];
    for (let i = Math.floor(path.length * 0.35); i < Math.floor(path.length * 0.6); i++) {
      const c = path[i];
      const watch = nav.center(path[Math.min(path.length - 1, i + 4)]);
      // 경로 옆 엄폐물 칸을 찾는다
      for (const [dr, dc] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const r = c.r + dr;
        const cc = c.c + dc;
        if (nav.walkable(r, cc) && nav.coverAdj[nav.idx(r, cc)]) {
          out.push({ pos: nav.center({ r, c: cc }), watch });
          break;
        }
      }
    }
    if (out.length === 0 && path.length) out.push({ pos: nav.center(path[Math.floor(path.length / 2)]), watch: this.attackSpawn.clone() });
    return out;
  }

  siteOf(p: THREE.Vector3): SiteId | null {
    const ch = this.nav.at(this.nav.cellOf(p).r, this.nav.cellOf(p).c);
    return ch === 'A' || ch === 'B' ? ch : null;
  }

  /** 구역 안의 무작위 설치 위치 (가장자리 칸 선호: 엄폐물 옆) */
  plantSpot(site: SiteId): THREE.Vector3 {
    const cells = this.sites[site].cells;
    const covered = cells.filter((c) => this.nav.coverAdj[this.nav.idx(c.r, c.c)]);
    const pool = covered.length && Math.random() < 0.7 ? covered : cells;
    return this.nav.randomIn(pool[Math.floor(Math.random() * pool.length)], 0.6);
  }

  /**
   * 위협(threat)에서 보이지 않는 가까운 엄폐 위치.
   * 너비 우선으로 maxDist 안의 칸을 살펴 위협과의 시야가 벽에 막힌 곳을 고른다.
   */
  findCover(from: THREE.Vector3, threat: THREE.Vector3, maxDist = 10): THREE.Vector3 | null {
    const nav = this.nav;
    const s = nav.nearestWalkable(from);
    const seen = new Set<number>([nav.idx(s.r, s.c)]);
    const queue: { cell: Cell; d: number }[] = [{ cell: s, d: 0 }];
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    while (queue.length) {
      const { cell, d } = queue.shift()!;
      const p = nav.center(cell);
      if (d > 0 && !this.lineOfSight(p, threat, 1.2, 1.5)) {
        // 가깝고, 위협에서 너무 멀어지지 않는 곳
        const score = d - Math.min(6, p.distanceTo(threat)) * 0.2;
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const n = { r: cell.r + dr, c: cell.c + dc };
        const i = nav.idx(n.r, n.c);
        if (seen.has(i) || !nav.walkable(n.r, n.c) || nav.at(n.r, n.c) === 'h' || nav.at(n.r, n.c) === 's') continue;
        const nd = d + nav.cs;
        if (nd > maxDist) continue;
        seen.add(i);
        queue.push({ cell: n, d: nd });
      }
    }
    return best;
  }

  /** 설치된 Core를 지킬 위치: Core가 보이는 5~14m 거리의 엄폐물 옆 칸 */
  postPlantSpots(core: THREE.Vector3): THREE.Vector3[] {
    const nav = this.nav;
    const out: THREE.Vector3[] = [];
    for (let r = 0; r < nav.rows; r++)
      for (let c = 0; c < nav.cols; c++) {
        if (!nav.walkable(r, c) || !nav.coverAdj[nav.idx(r, c)]) continue;
        const p = nav.center({ r, c });
        const d = p.distanceTo(core);
        if (d < 5 || d > 14) continue;
        if (this.lineOfSight(p, core, EYE, 0.4)) out.push(p);
      }
    return out;
  }
}
