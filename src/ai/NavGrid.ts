import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { MapDefinition } from '../maps/MapData';

/**
 * 봇 길찾기용 격자 (맵 ASCII 격자 한 칸 = 노드 하나).
 *   - 바닥/구역/스폰/실내/계단/발판 칸을 걸을 수 있다. 상자·기둥·낮은 벽 칸은 막힘.
 *   - 대각선 이동은 양옆 두 칸이 모두 열려 있을 때만 (모서리 끼임 방지)
 *   - 계단(s)은 오르는 방향으로만 연결: 바닥 ↔ 계단 ↔ 발판(h). 발판에서 바닥으로는 뛰어내릴 수 있다.
 *   - A* 결과는 시야 직선 검사로 꺾인 점을 줄여 자연스럽게 움직이도록 다듬는다.
 */

export interface Cell {
  r: number;
  c: number;
}

const WALKABLE = new Set(['.', '+', 'A', 'B', 'T', 'D', 's', 'h']);
const DIRS: [number, number, number][] = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
];

export class NavGrid {
  readonly rows: number;
  readonly cols: number;
  readonly cs: number;
  private ox: number;
  private oz: number;
  private layout: string[];
  /** 칸별 서 있는 높이 */
  private height: Float32Array;
  /** 계단 칸의 오르는 방향 (dr, dc) */
  private stairDir = new Map<number, [number, number]>();
  /** 칸 → 그 칸 옆에 엄폐물(벽/상자/기둥)이 있는지 */
  readonly coverAdj: Uint8Array;

  constructor(
    def: MapDefinition,
    private world: CollisionWorld,
  ) {
    this.layout = def.layout;
    this.rows = def.layout.length;
    this.cols = def.layout[0].length;
    this.cs = def.cellSize;
    this.ox = (-this.cols * def.cellSize) / 2;
    this.oz = (-this.rows * def.cellSize) / 2;
    this.height = new Float32Array(this.rows * this.cols);
    this.coverAdj = new Uint8Array(this.rows * this.cols);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const ch = this.at(r, c);
        const i = this.idx(r, c);
        if (ch === 'h') this.height[i] = def.platformHeight;
        if (ch === 's') {
          this.height[i] = def.platformHeight / 2;
          const d = ([[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]).find(([dr, dc]) => this.at(r + dr, c + dc) === 'h');
          if (d) this.stairDir.set(i, d);
        }
        if (WALKABLE.has(ch))
          this.coverAdj[i] = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dr, dc]) => !WALKABLE.has(this.at(r + dr, c + dc))) ? 1 : 0;
      }
  }

  // ───────────────────────── 좌표 ─────────────────────────

  at(r: number, c: number): string {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return '#';
    return this.layout[r][c];
  }

  idx(r: number, c: number): number {
    return r * this.cols + c;
  }

  walkable(r: number, c: number): boolean {
    return WALKABLE.has(this.at(r, c));
  }

  cellOf(p: { x: number; z: number }): Cell {
    return { r: Math.floor((p.z - this.oz) / this.cs), c: Math.floor((p.x - this.ox) / this.cs) };
  }

  center(cell: Cell, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.ox + (cell.c + 0.5) * this.cs, this.height[this.idx(cell.r, cell.c)], this.oz + (cell.r + 0.5) * this.cs);
  }

  /** 칸 안의 무작위 위치 (가장자리 여유 jitter m) */
  randomIn(cell: Cell, jitter = 0.8, out = new THREE.Vector3()): THREE.Vector3 {
    this.center(cell, out);
    out.x += (Math.random() * 2 - 1) * jitter;
    out.z += (Math.random() * 2 - 1) * jitter;
    return out;
  }

  /** 가장 가까운 걸을 수 있는 칸 (자기 칸이 막혀 있으면 주변 탐색) */
  nearestWalkable(p: { x: number; z: number }): Cell {
    const s = this.cellOf(p);
    if (this.walkable(s.r, s.c)) return s;
    for (let rad = 1; rad < 6; rad++)
      for (let dr = -rad; dr <= rad; dr++)
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          if (this.walkable(s.r + dr, s.c + dc)) return { r: s.r + dr, c: s.c + dc };
        }
    return s;
  }

  /** 문자로 칸 찾기 (예: 'A' = A 구역 칸들) */
  cellsOf(ch: string): Cell[] {
    const out: Cell[] = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.at(r, c) === ch) out.push({ r, c });
    return out;
  }

  // ───────────────────────── 연결 ─────────────────────────

  /** a → b 로 한 칸 이동할 수 있는지 (방향성 있음: 발판에 오르는 건 계단으로만) */
  private canStep(r: number, c: number, nr: number, nc: number, diag: boolean): boolean {
    if (!this.walkable(nr, nc)) return false;
    const a = this.at(r, c);
    const b = this.at(nr, nc);
    if (diag) {
      // 대각선: 양옆이 열린 평지끼리만
      if (!this.walkable(r, nc) || !this.walkable(nr, c)) return false;
      if (a === 's' || b === 's' || a === 'h' || b === 'h') return false;
      return true;
    }
    if (b === 's') {
      const d = this.stairDir.get(this.idx(nr, nc));
      if (!d) return false;
      // 계단은 아래(반대쪽)에서 올라오거나, 위(발판)에서 내려온다
      return (nr - r === d[0] && nc - c === d[1]) || (a === 'h' && r - nr === d[0] && c - nc === d[1]);
    }
    if (a === 's') {
      const d = this.stairDir.get(this.idx(r, c));
      if (!d) return false;
      return (nr - r === d[0] && nc - c === d[1]) || (nr - r === -d[0] && nc - c === -d[1]);
    }
    // 바닥 → 발판은 계단으로만, 발판 → 바닥(뛰어내리기)은 허용
    if (b === 'h' && a !== 'h') return false;
    return true;
  }

  /** A* 최단 경로 (칸 목록, 시작 칸 포함). 없으면 null */
  findPath(from: Cell, to: Cell): Cell[] | null {
    if (!this.walkable(to.r, to.c)) to = this.nearestWalkable(this.center(to));
    if (!this.walkable(from.r, from.c)) from = this.nearestWalkable(this.center(from));
    const N = this.rows * this.cols;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open: number[] = [];
    const fScore = new Float32Array(N).fill(Infinity);
    const h = (r: number, c: number) => {
      const dr = Math.abs(r - to.r);
      const dc = Math.abs(c - to.c);
      return Math.max(dr, dc) + (Math.SQRT2 - 1) * Math.min(dr, dc);
    };
    const s = this.idx(from.r, from.c);
    const t = this.idx(to.r, to.c);
    g[s] = 0;
    fScore[s] = h(from.r, from.c);
    open.push(s);
    while (open.length) {
      // 열린 목록이 작아서(최대 수백) 선형 탐색으로 충분
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (cur === t) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const r = Math.floor(cur / this.cols);
      const c = cur % this.cols;
      for (const [dr, dc, cost] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (!this.canStep(r, c, nr, nc, dr !== 0 && dc !== 0)) continue;
        const ni = this.idx(nr, nc);
        if (closed[ni]) continue;
        const ng = g[cur] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = cur;
          fScore[ni] = ng + h(nr, nc);
          open.push(ni);
        }
      }
    }
    if (came[t] === -1 && s !== t) return null;
    const out: Cell[] = [];
    for (let i = t; i !== -1; i = came[i]) {
      out.push({ r: Math.floor(i / this.cols), c: i % this.cols });
      if (i === s) break;
    }
    return out.reverse();
  }

  /** 두 칸 사이 경로 길이 (m), 없으면 Infinity */
  pathLength(from: Cell, to: Cell): number {
    const p = this.findPath(from, to);
    if (!p) return Infinity;
    let len = 0;
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].r - p[i - 1].r, p[i].c - p[i - 1].c) * this.cs;
    return len;
  }

  /**
   * 월드 경로: 칸 중심점들을 직선으로 이어도 되는 구간은 건너뛰어 꺾임을 줄인다.
   * 높이가 바뀌는 칸(계단/발판)은 건너뛰지 않는다.
   */
  smoothPath(cells: Cell[], start: THREE.Vector3, goal: THREE.Vector3): THREE.Vector3[] {
    const pts = cells.map((c) => this.center(c));
    if (pts.length) pts[pts.length - 1] = goal.clone();
    const out: THREE.Vector3[] = [];
    let from = start.clone();
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.clearLine(from, pts[j], cells, i, j)) j--;
      out.push(pts[j]);
      from = pts[j];
      i = j + 1;
    }
    return out;
  }

  /** 수평 직선이 걸을 수 있는 같은 높이 칸만 지나는지 (몸 너비를 고려해 양옆도 검사) */
  private clearLine(a: THREE.Vector3, b: THREE.Vector3, cells: Cell[], i: number, j: number): boolean {
    for (let k = i; k <= j; k++) {
      const ch = this.at(cells[k].r, cells[k].c);
      if ((ch === 's' || ch === 'h') && j > i) return false;
    }
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return true;
    const nx = -dz / len;
    const nz = dx / len;
    const steps = Math.ceil(len / 0.5);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      for (const off of [-0.4, 0, 0.4]) {
        const cell = this.cellOf({ x: x + nx * off, z: z + nz * off });
        const ch = this.at(cell.r, cell.c);
        if (!WALKABLE.has(ch) || ch === 's' || ch === 'h') return false;
      }
    }
    // 실제 충돌(낮은 벽·상자 모서리 등)도 확인
    const hit = this.world.raycast(a.x, a.y + 0.5, a.z, dx / len, 0, dz / len, len);
    return !hit;
  }
}
