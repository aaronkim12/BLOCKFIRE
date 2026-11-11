import type { AABB } from '../physics/CollisionWorld';
import { MapBuilder, type VisualBox } from './MapBuilder';
import { SOLID_CELLS, type MapDefinition } from './MapData';

/**
 * 맵 검사: 벽·바닥이 서로 겹치지 않는지, 모든 구역에 걸어서 갈 수 있는지.
 *   1) 부피 겹침: 눈에 보이는 두 박스가 공간을 나눠 가지면 오류 (바닥 아래 받침판은 제외)
 *   2) 면 겹침: 같은 방향을 보는 두 면이 같은 평면에서 겹치면 오류 (Z-파이팅으로 깜빡임)
 *   3) 이동 가능성: 공격 스폰에서 A·B 구역, 수비 스폰까지 걸어서 갈 수 있는지
 * 오류 목록을 돌려준다 (비어 있으면 통과).
 */
export function validateMap(def: MapDefinition): string[] {
  const errors: string[] = [];
  let builder: MapBuilder;
  try {
    builder = new MapBuilder(def);
    builder.buildCollision();
  } catch (e) {
    return [String(e)];
  }
  const boxes = builder.visual.filter((v) => v.kind !== 'underlay');
  const E = 1e-4;
  const name = (v: VisualBox) =>
    `${v.kind}[${f(v.box.minX)},${f(v.box.minY)},${f(v.box.minZ)} → ${f(v.box.maxX)},${f(v.box.maxY)},${f(v.box.maxZ)}]`;

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i].box;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j].box;
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox > E && oy > E && oz > E) {
        errors.push(`부피 겹침: ${name(boxes[i])} ∩ ${name(boxes[j])}`);
        continue;
      }
      const face = coplanarFace(a, b, ox, oy, oz, E);
      if (face) errors.push(`면 겹침(${face}): ${name(boxes[i])} / ${name(boxes[j])}`);
    }
  }

  errors.push(...reachability(def));
  return errors;
}

/** 같은 방향을 보는 면이 같은 평면 위에서 넓이를 가지고 겹치는지 */
function coplanarFace(a: AABB, b: AABB, ox: number, oy: number, oz: number, E: number): string | null {
  const same = (p: number, q: number) => Math.abs(p - q) < E;
  if (oy > E && oz > E && (same(a.minX, b.minX) || same(a.maxX, b.maxX))) return same(a.minX, b.minX) ? '-X' : '+X';
  if (ox > E && oz > E && (same(a.minY, b.minY) || same(a.maxY, b.maxY))) return same(a.minY, b.minY) ? '-Y' : '+Y';
  if (ox > E && oy > E && (same(a.minZ, b.minZ) || same(a.maxZ, b.maxZ))) return same(a.minZ, b.minZ) ? '-Z' : '+Z';
  return null;
}

/** 걸어서 갈 수 있는 칸 (상자·기둥은 막힘, 낮은 벽은 넘을 수 있음) */
const BLOCKED = new Set(['c', 'C', 'p']);

function reachability(def: MapDefinition): string[] {
  const L = def.layout;
  const rows = L.length;
  const cols = L[0].length;
  const ok = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < rows && c < cols && !SOLID_CELLS.has(L[r][c]) && !BLOCKED.has(L[r][c]);
  let start: [number, number] | null = null;
  for (let r = 0; r < rows && !start; r++) for (let c = 0; c < cols; c++) if (L[r][c] === 'T') { start = [r, c]; break; }
  if (!start) return ['공격 스폰(T)이 없습니다'];
  const seen = new Set<string>([start.join(',')]);
  const stack = [start];
  while (stack.length) {
    const [r, c] = stack.pop()!;
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const k = `${r + dr},${c + dc}`;
      if (ok(r + dr, c + dc) && !seen.has(k)) {
        seen.add(k);
        stack.push([r + dr, c + dc]);
      }
    }
  }
  const out: string[] = [];
  for (const ch of ['A', 'B', 'D']) {
    let any = false;
    let reached = false;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (L[r][c] === ch) {
          any = true;
          if (seen.has(`${r},${c}`)) reached = true;
        }
    if (!any) out.push(`'${ch}' 칸이 없습니다`);
    else if (!reached) out.push(`공격 스폰에서 '${ch}'까지 갈 수 없습니다`);
  }
  // 갇힌 바닥 (어디서도 들어갈 수 없는 빈 칸)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (ok(r, c) && !seen.has(`${r},${c}`)) out.push(`(${r},${c}) '${L[r][c]}' 칸은 들어갈 수 없는 곳입니다`);
  return out;
}

function f(n: number): string {
  return String(Math.round(n * 100) / 100);
}
