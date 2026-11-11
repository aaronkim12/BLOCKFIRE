/**
 * 정적 AABB 충돌 월드.
 * 맵이 기본 도형(박스) 위주로 구성되므로 Rapier 같은 범용 물리 엔진 대신
 * 축 분리(axis-separated) AABB 충돌을 사용한다. 결정적이고 가벼워서
 * 이후 서버 권한 방식 멀티플레이에서도 동일 코드를 서버에서 돌릴 수 있다.
 */

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** 표면 재질 (효과음: 착탄·발소리) */
  material?: string;
}

export interface RayHit {
  distance: number;
  box: AABB;
}

const CELL = 4; // 브로드페이즈 격자 셀 크기 (m)
const EPS = 1e-4;

export class CollisionWorld {
  readonly boxes: AABB[] = [];
  private grid = new Map<string, AABB[]>();

  add(box: AABB): void {
    this.boxes.push(box);
    for (let x = Math.floor(box.minX / CELL); x <= Math.floor(box.maxX / CELL); x++) {
      for (let z = Math.floor(box.minZ / CELL); z <= Math.floor(box.maxZ / CELL); z++) {
        const k = `${x},${z}`;
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(box);
      }
    }
  }

  /** 모든 박스 제거 (맵 교체) */
  clear(): void {
    this.boxes.length = 0;
    this.grid.clear();
  }

  /** 박스 제거 (능력으로 세운 방벽 등 임시 장애물) */
  remove(box: AABB): void {
    const i = this.boxes.indexOf(box);
    if (i >= 0) this.boxes.splice(i, 1);
    for (const list of this.grid.values()) {
      const j = list.indexOf(box);
      if (j >= 0) list.splice(j, 1);
    }
  }

  /** 영역과 겹칠 가능성이 있는 박스 후보 */
  query(q: AABB, out: AABB[] = []): AABB[] {
    out.length = 0;
    const seen = new Set<AABB>();
    for (let x = Math.floor(q.minX / CELL); x <= Math.floor(q.maxX / CELL); x++) {
      for (let z = Math.floor(q.minZ / CELL); z <= Math.floor(q.maxZ / CELL); z++) {
        const list = this.grid.get(`${x},${z}`);
        if (!list) continue;
        for (const b of list) {
          if (!seen.has(b)) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  overlapsAny(q: AABB): boolean {
    for (const b of this.query(q)) if (overlaps(q, b)) return true;
    return false;
  }

  /**
   * AABB를 한 축으로 이동시키고 충돌하면 접촉면에서 멈춘다.
   * @returns 실제로 이동한 거리 (막히면 요청보다 작다)
   */
  moveAxis(box: AABB, axis: 0 | 1 | 2, delta: number): { moved: number; blocked: boolean } {
    if (delta === 0) return { moved: 0, blocked: false };
    const swept = { ...box };
    const [minK, maxK] = AXIS_KEYS[axis];
    if (delta > 0) swept[maxK] += delta;
    else swept[minK] += delta;

    let allowed = delta;
    let blocked = false;
    for (const b of this.query(swept)) {
      if (!overlapsExcept(box, b, axis)) continue;
      if (delta > 0) {
        const gap = b[minK] - box[maxK];
        if (gap >= -EPS && gap < allowed) {
          allowed = Math.max(0, gap - EPS);
          blocked = true;
        }
      } else {
        const gap = b[maxK] - box[minK];
        if (gap <= EPS && gap > allowed) {
          allowed = Math.min(0, gap + EPS);
          blocked = true;
        }
      }
    }
    box[minK] += allowed;
    box[maxK] += allowed;
    return { moved: allowed, blocked };
  }

  /** 레이캐스트 (슬랩 방식). 사격 판정에서도 사용할 예정 */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): RayHit | null {
    let best: RayHit | null = null;
    // 레이가 지나는 셀만 정밀하게 돌기보다, 맵 규모가 작아 전체 순회로 충분하다.
    for (const b of this.boxes) {
      const t = rayBox(ox, oy, oz, dx, dy, dz, b);
      if (t !== null && t <= maxDist && (!best || t < best.distance)) best = { distance: t, box: b };
    }
    return best;
  }
}

type NumKey = Exclude<keyof AABB, 'material'>;
const AXIS_KEYS: [NumKey, NumKey][] = [
  ['minX', 'maxX'],
  ['minY', 'maxY'],
  ['minZ', 'maxZ'],
];

export function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX - EPS && a.maxX > b.minX + EPS &&
    a.minY < b.maxY - EPS && a.maxY > b.minY + EPS &&
    a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS
  );
}

/** 지정 축을 제외한 나머지 두 축에서 겹치는지 */
function overlapsExcept(a: AABB, b: AABB, axis: number): boolean {
  if (axis !== 0 && !(a.minX < b.maxX - EPS && a.maxX > b.minX + EPS)) return false;
  if (axis !== 1 && !(a.minY < b.maxY - EPS && a.maxY > b.minY + EPS)) return false;
  if (axis !== 2 && !(a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS)) return false;
  return true;
}

function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  b: AABB,
): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [b.minX, b.minY, b.minZ];
  const mx = [b.maxX, b.maxY, b.maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
