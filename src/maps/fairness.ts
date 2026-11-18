import { SOLID_CELLS, type MapDefinition } from './MapData';
import { validateMap } from './validateMap';

/**
 * 사용자 맵 공정성 검사 (맵 에디터 · 게시 · 온라인 경기 시작 전에 모두 같은 검사).
 *   오류(errors)가 하나라도 있으면 게시·온라인 사용 불가. 경고(warnings)는 안내만.
 *
 * 오류
 *   - 크기 16~48칸, 테두리는 벽, 허용된 글자만
 *   - 공격/수비 스폰, A/B 구역이 각각 하나의 덩어리로 존재 (스폰 12칸 이상, 구역 16~140칸)
 *   - 벽·바닥 겹침 없음 + 모든 곳에 걸어서 갈 수 있음 (validateMap)
 *   - 스폰끼리 멀리 (걸어서 22칸 이상) · 서로 보이지 않음
 *   - 공격 스폰은 구역에서 8칸 이상, 수비 스폰은 4칸 이상 떨어짐
 *   - 각 구역에 수비가 먼저 도착 (수비 거리 < 공격 거리), 공격 거리는 수비의 4배 + 10칸 이하
 *   - 공격 스폰에서 A·B까지 거리 차이가 1.6배 이하 (한쪽 구역만 너무 가깝지 않게)
 *   - 각 구역의 입구가 2곳 이상 (한 길만 막으면 끝나는 구역 금지)
 *   - 구역 안에 설치할 빈 바닥 9칸 이상
 * 경고
 *   - 한 줄로 22칸 넘게 뚫린 긴 시야, 구역 사이 수비 이동 거리가 너무 짧음, 맵이 너무 큼
 */

export interface FairnessReport {
  errors: string[];
  warnings: string[];
  stats: {
    atkToA: number;
    atkToB: number;
    defToA: number;
    defToB: number;
    spawnGap: number;
    rotate: number;
    entrancesA: number;
    entrancesB: number;
  } | null;
}

const LEGAL = new Set(['#', '.', '+', 'A', 'B', 'T', 'D', 'c', 'C', 'w', 'p', 'h', 's']);
const BLOCKED = new Set(['#', 'c', 'C', 'p']);
export const MIN_SIZE = 16;
export const MAX_SIZE = 48;

type Cell = [number, number];

export function analyzeMap(def: MapDefinition): FairnessReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const L = def.layout;
  const rows = L.length;
  const cols = L[0]?.length ?? 0;

  // ── 형식
  if (rows < MIN_SIZE || cols < MIN_SIZE || rows > MAX_SIZE || cols > MAX_SIZE) errors.push(`맵 크기는 ${MIN_SIZE}~${MAX_SIZE}칸이어야 합니다 (지금 ${cols}×${rows})`);
  if (L.some((r) => r.length !== cols)) errors.push('모든 줄의 길이가 같아야 합니다');
  for (const r of L) for (const ch of r) if (!LEGAL.has(ch)) {
    errors.push(`쓸 수 없는 칸이 있습니다: '${ch}'`);
    break;
  }
  if (errors.length) return { errors, warnings, stats: null };
  for (let c = 0; c < cols; c++) if (L[0][c] !== '#' || L[rows - 1][c] !== '#') {
    errors.push('맵 가장자리는 모두 벽이어야 합니다');
    break;
  }
  if (!errors.length) for (let r = 0; r < rows; r++) if (L[r][0] !== '#' || L[r][cols - 1] !== '#') {
    errors.push('맵 가장자리는 모두 벽이어야 합니다');
    break;
  }

  // ── 지역 (스폰·구역)
  const cellsOf = (ch: string): Cell[] => {
    const out: Cell[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (L[r][c] === ch) out.push([r, c]);
    return out;
  };
  const regions: Record<'T' | 'D' | 'A' | 'B', Cell[]> = { T: cellsOf('T'), D: cellsOf('D'), A: cellsOf('A'), B: cellsOf('B') };
  const label = { T: '공격 스폰', D: '수비 스폰', A: 'A 구역', B: 'B 구역' };
  for (const k of ['T', 'D', 'A', 'B'] as const) {
    const cs = regions[k];
    if (!cs.length) {
      errors.push(`${label[k]} 칸을 칠해 주세요 (없음)`);
      continue;
    }
    if (components(cs) > 1) errors.push(`${label[k]}: 한 덩어리여야 합니다 (지금 ${components(cs)}곳으로 나뉨)`);
    if ((k === 'T' || k === 'D') && cs.length < 12) errors.push(`${label[k]}: 12칸 이상이어야 합니다 (지금 ${cs.length}칸)`);
    if ((k === 'A' || k === 'B') && (cs.length < 16 || cs.length > 140)) errors.push(`${label[k]}: 16~140칸이어야 합니다 (지금 ${cs.length}칸)`);
  }
  if (errors.length) return { errors, warnings, stats: null };

  // ── 만들 수 있는지 (겹침·계단·이동 가능성)
  for (const e of validateMap(def)) errors.push(e);
  if (errors.length) return { errors, warnings, stats: null };

  // ── 거리 (걸어서, 칸 단위)
  const walk = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols && !BLOCKED.has(L[r][c]);
  const bfs = (from: Cell[]): Int32Array => {
    const dist = new Int32Array(rows * cols).fill(-1);
    const q: number[] = [];
    for (const [r, c] of from) {
      dist[r * cols + c] = 0;
      q.push(r * cols + c);
    }
    for (let i = 0; i < q.length; i++) {
      const r = Math.floor(q[i] / cols);
      const c = q[i] % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (!walk(nr, nc) || dist[nr * cols + nc] >= 0) continue;
        dist[nr * cols + nc] = dist[q[i]] + 1;
        q.push(nr * cols + nc);
      }
    }
    return dist;
  };
  const near = (dist: Int32Array, to: Cell[]) => {
    let best = Infinity;
    for (const [r, c] of to) {
      const d = dist[r * cols + c];
      if (d >= 0 && d < best) best = d;
    }
    return best;
  };
  const fromT = bfs(regions.T);
  const fromD = bfs(regions.D);
  const fromA = bfs(regions.A);
  const atkToA = near(fromT, regions.A);
  const atkToB = near(fromT, regions.B);
  const defToA = near(fromD, regions.A);
  const defToB = near(fromD, regions.B);
  const spawnGap = near(fromT, regions.D);
  const rotate = near(fromA, regions.B);
  if (!isFinite(defToA) || !isFinite(defToB)) errors.push('수비 스폰에서 A·B 구역 모두에 갈 수 있어야 합니다');

  // ── 스폰
  if (spawnGap < 22) errors.push(`두 스폰이 너무 가깝습니다 (걸어서 ${spawnGap}칸, 22칸 이상 필요)`);
  if (spawnsSeeEachOther(L, regions.T, regions.D)) errors.push('공격 스폰과 수비 스폰이 서로 보입니다 — 사이에 벽을 두세요');
  if (Math.min(atkToA, atkToB) < 8) errors.push(`공격 스폰이 설치 구역에 너무 가깝습니다 (${Math.min(atkToA, atkToB)}칸, 8칸 이상 필요)`);
  if (Math.min(defToA, defToB) < 4) errors.push(`수비 스폰이 설치 구역에 너무 가깝습니다 (${Math.min(defToA, defToB)}칸, 4칸 이상 필요)`);

  // ── 공격·수비 균형
  for (const [site, atk, dfn] of [['A', atkToA, defToA], ['B', atkToB, defToB]] as const) {
    if (dfn >= atk) errors.push(`${site} 구역: 수비가 공격보다 먼저 도착해야 합니다 (수비 ${dfn}칸 · 공격 ${atk}칸)`);
    else if (atk > dfn * 4 + 10) errors.push(`${site} 구역: 공격이 너무 멉니다 (공격 ${atk}칸 · 수비 ${dfn}칸 — 공격은 수비의 4배 + 10칸 이하)`);
  }
  if (Math.max(atkToA, atkToB) > Math.min(atkToA, atkToB) * 1.6) errors.push(`A·B까지 공격 거리 차이가 너무 큽니다 (A ${atkToA}칸 · B ${atkToB}칸 — 1.6배 이하)`);

  // ── 구역 입구와 설치 공간
  const entrancesA = entrances(L, regions.A, walk);
  const entrancesB = entrances(L, regions.B, walk);
  if (entrancesA < 2) errors.push(`A 구역 입구가 ${entrancesA}곳뿐입니다 (2곳 이상 필요)`);
  if (entrancesB < 2) errors.push(`B 구역 입구가 ${entrancesB}곳뿐입니다 (2곳 이상 필요)`);
  for (const k of ['A', 'B'] as const) {
    const free = regions[k].filter(([r, c]) => !BLOCKED.has(L[r][c])).length;
    if (free < 9) errors.push(`${k} 구역에 설치할 빈 바닥이 부족합니다 (${free}칸, 9칸 이상)`);
  }
  if (regions.T.some(([r, c]) => adjacentTo(L, r, c, 'A') || adjacentTo(L, r, c, 'B'))) errors.push('공격 스폰이 설치 구역에 붙어 있으면 안 됩니다');

  // ── 경고
  const sight = longestSightline(L);
  if (sight > 22) warnings.push(`한 줄로 ${sight}칸 뚫린 긴 시야가 있습니다 — 상자나 벽으로 끊으면 저격총이 너무 강해지지 않습니다`);
  if (rotate < 10) warnings.push(`A↔B 이동이 ${rotate}칸으로 너무 짧습니다 (수비가 너무 쉽게 돌아감)`);
  if (rows * cols > 40 * 40) warnings.push('맵이 넓어 5대5에서도 만나기까지 오래 걸릴 수 있습니다');

  return { errors, warnings, stats: { atkToA, atkToB, defToA, defToB, spawnGap, rotate, entrancesA, entrancesB } };
}

/** 4방향으로 이어진 덩어리 수 */
function components(cells: Cell[]): number {
  const key = (r: number, c: number) => `${r},${c}`;
  const set = new Set(cells.map(([r, c]) => key(r, c)));
  const seen = new Set<string>();
  let n = 0;
  for (const [r, c] of cells) {
    if (seen.has(key(r, c))) continue;
    n++;
    const stack: Cell[] = [[r, c]];
    seen.add(key(r, c));
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(cr + dr, cc + dc);
        if (set.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push([cr + dr, cc + dc]);
        }
      }
    }
  }
  return n;
}

function adjacentTo(L: string[], r: number, c: number, ch: string): boolean {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => L[r + dr]?.[c + dc] === ch);
}

/** 구역 바깥 경계의 걸을 수 있는 칸들을 이어진 묶음으로 세면 입구 수 */
function entrances(_L: string[], site: Cell[], walk: (r: number, c: number) => boolean): number {
  const inSite = new Set(site.map(([r, c]) => `${r},${c}`));
  const border: Cell[] = [];
  const seen = new Set<string>();
  for (const [r, c] of site) {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      const k = `${nr},${nc}`;
      if (inSite.has(k) || seen.has(k) || !walk(nr, nc)) continue;
      // 구역 칸 자체가 막혀 있으면(상자) 입구로 치지 않음
      if (!walk(r, c)) continue;
      seen.add(k);
      border.push([nr, nc]);
    }
  }
  // 경계 칸끼리 대각선까지 이어지면 같은 입구
  const key = (r: number, c: number) => `${r},${c}`;
  const set = new Set(border.map(([r, c]) => key(r, c)));
  const done = new Set<string>();
  let n = 0;
  for (const [r, c] of border) {
    if (done.has(key(r, c))) continue;
    n++;
    const stack: Cell[] = [[r, c]];
    done.add(key(r, c));
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const k = key(cr + dr, cc + dc);
          if (set.has(k) && !done.has(k)) {
            done.add(k);
            stack.push([cr + dr, cc + dc]);
          }
        }
    }
  }
  return n;
}

/** 두 스폰의 칸 중심끼리 벽(#)에 막히지 않고 이어지는 직선이 있는지 */
function spawnsSeeEachOther(L: string[], T: Cell[], D: Cell[]): boolean {
  const step = (a: Cell, b: Cell) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 3);
    for (let i = 1; i < n; i++) {
      const r = Math.round(a[0] + ((b[0] - a[0]) * i) / n);
      const c = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
      // 벽과 큰 상자(눈높이보다 높음)는 시야를 막는다
      if (SOLID_CELLS.has(L[r][c]) || L[r][c] === 'C') return false;
    }
    return true;
  };
  // 칸이 많으면 일부만 (가장자리 위주로 충분)
  const pick = (cs: Cell[]) => (cs.length > 40 ? cs.filter((_, i) => i % Math.ceil(cs.length / 40) === 0) : cs);
  for (const a of pick(T)) for (const b of pick(D)) if (step(a, b)) return true;
  return false;
}

/** 가로·세로로 가장 길게 뚫린 줄 (칸) */
function longestSightline(L: string[]): number {
  const open = (ch: string) => !SOLID_CELLS.has(ch) && ch !== 'C' && ch !== 'p';
  let best = 0;
  for (const row of L) {
    let run = 0;
    for (const ch of row) {
      run = open(ch) ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  for (let c = 0; c < L[0].length; c++) {
    let run = 0;
    for (const row of L) {
      run = open(row[c]) ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  return best;
}
