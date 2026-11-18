import { DRYDOCK } from './drydock';
import { FOUNDRY } from './foundry';
import { MERIDIAN } from './meridian';
import type { MapDefinition } from './MapData';
import { analyzeMap, type FairnessReport } from './fairness';

/**
 * 사용자 맵: 맵 에디터에서 만든 격자 + 이름 + 분위기(테마).
 *   - 공유 코드 "BFM1:…" 하나로 맵 전체를 주고받는다 (서버 없이도 친구에게 전달 가능)
 *   - 내 맵은 이 브라우저(localStorage)에 저장
 *   - 게임에서 쓰기 전에는 항상 공정성 검사(analyzeMap)를 다시 한다 — 검사를 통과하지 못한 맵은 고를 수 없다
 */

export interface CustomMapData {
  /** 'u:' + 고유값 */
  id: string;
  name: string;
  author: string;
  theme: ThemeId;
  layout: string[];
}

export type ThemeId = 'sunset' | 'dusk' | 'violet';
export const THEMES: Record<ThemeId, { label: string; env: MapDefinition['environment'] }> = {
  sunset: { label: '노을 (주황)', env: FOUNDRY.environment },
  dusk: { label: '해 질 녘 (푸른빛)', env: DRYDOCK.environment },
  violet: { label: '보랏빛 저녁', env: MERIDIAN.environment },
};

export const CUSTOM_PREFIX = 'u:';
const STORE_KEY = 'blockfire.myMaps';

export function newMapId(): string {
  return CUSTOM_PREFIX + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** 사용자 맵 → 게임 맵 정의 (크기·높이는 기본 맵과 같게, 연습 더미 자리는 자동) */
export function toDefinition(m: CustomMapData): MapDefinition {
  const def: MapDefinition = {
    id: m.id,
    name: m.name.toUpperCase().slice(0, 20) || 'CUSTOM',
    blurb: `${m.author || '익명'}님의 맵`,
    cellSize: 3.75,
    wallHeight: 6,
    roofHeight: 4,
    platformHeight: 1.6,
    layout: m.layout.slice(),
    environment: (THEMES[m.theme] ?? THEMES.sunset).env,
    practice: { dummies: [], showcase: [1, 1] },
  };
  def.practice = autoPractice(def);
  return def;
}

/** 연습 더미 6개: A 2 · B 2 · 맵 가운데 1 · 수비 스폰 1, 쇼케이스는 공격 스폰 바로 앞 */
function autoPractice(def: MapDefinition): MapDefinition['practice'] {
  const L = def.layout;
  const free = (ch: string) => {
    const out: [number, number][] = [];
    L.forEach((row, r) => [...row].forEach((x, c) => {
      if (x === ch || (ch === '.' && (x === '.' || x === '+'))) out.push([c, r]);
    }));
    return out;
  };
  const center = (cs: [number, number][]) => {
    const cx = cs.reduce((a, p) => a + p[0], 0) / Math.max(1, cs.length);
    const cy = cs.reduce((a, p) => a + p[1], 0) / Math.max(1, cs.length);
    return cs.slice().sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  };
  const pickTwo = (cs: [number, number][]) => {
    const s = center(cs);
    return [s[0], s[Math.min(s.length - 1, Math.floor(s.length * 0.7))]].filter(Boolean);
  };
  const dummies: MapDefinition['practice']['dummies'] = [];
  for (const p of [...pickTwo(free('A')), ...pickTwo(free('B'))]) dummies.push([p[0], p[1], Math.PI]);
  const mid = free('.');
  const mx = L[0].length / 2;
  const my = L.length / 2;
  const m = mid.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))[0];
  if (m) dummies.push([m[0], m[1], Math.PI]);
  const d = center(free('D'))[0];
  if (d) dummies.push([d[0], d[1], Math.PI]);
  while (dummies.length < 6) dummies.push(dummies[dummies.length - 1] ?? [1, 1, 0]);
  // 쇼케이스: 공격 스폰 가운데 칸
  const t = center(free('T'))[0] ?? [1, 1];
  return { dummies: dummies.slice(0, 6), showcase: [t[0], t[1]] };
}

// ───────────────────────── 공유 코드 ─────────────────────────

export function encodeShare(m: CustomMapData): string {
  const json = JSON.stringify({ n: m.name, a: m.author, t: m.theme, l: m.layout });
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'BFM1:' + b64;
}

export function decodeShare(code: string, id = newMapId()): CustomMapData | null {
  try {
    const s = code.trim();
    if (!s.startsWith('BFM1:')) return null;
    const b64 = s.slice(5).replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const o = JSON.parse(json) as { n: string; a?: string; t: ThemeId; l: string[] };
    if (!Array.isArray(o.l) || !o.l.every((r) => typeof r === 'string')) return null;
    return { id, name: String(o.n ?? 'CUSTOM').slice(0, 20), author: String(o.a ?? '').slice(0, 16), theme: o.t in THEMES ? o.t : 'sunset', layout: o.l };
  } catch {
    return null;
  }
}

// ───────────────────────── 내 맵 (이 브라우저) ─────────────────────────

export function loadMyMaps(): CustomMapData[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as CustomMapData[]) : [];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string' && Array.isArray(m.layout)) : [];
  } catch {
    return [];
  }
}

export function saveMyMap(m: CustomMapData): void {
  const list = loadMyMaps().filter((x) => x.id !== m.id);
  list.unshift(m);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 40)));
  } catch {
    /* 저장 공간 없음 */
  }
}

export function deleteMyMap(id: string): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(loadMyMaps().filter((x) => x.id !== id)));
  } catch {
    /* 무시 */
  }
}

/** 검사 결과 캐시 (같은 격자는 한 번만) */
const reportCache = new Map<string, FairnessReport>();
export function checkCustom(def: MapDefinition): FairnessReport {
  const key = def.layout.join('\n');
  let r = reportCache.get(key);
  if (!r) {
    r = analyzeMap(def);
    reportCache.set(key, r);
  }
  return r;
}
