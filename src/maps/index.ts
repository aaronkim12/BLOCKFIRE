import { DRYDOCK } from './drydock';
import { FOUNDRY } from './foundry';
import { MERIDIAN } from './meridian';
import type { MapDefinition } from './MapData';

/** 기본 맵 목록 */
export const MAPS: MapDefinition[] = [FOUNDRY, DRYDOCK, MERIDIAN];

/**
 * 사용자 맵 (맵 에디터에서 만들었거나 공유 코드·게시판에서 받은 맵).
 * 공정성 검사를 통과한 것만 등록된다 (registerCustomMap 쪽에서 확인).
 */
const custom = new Map<string, MapDefinition>();
/** 맵 선택 목록에 보일 사용자 맵 (공정성 검사 통과) */
const listed = new Set<string>();

/** listed=false: 시험 플레이용 (검사 전이거나 통과하지 못한 맵 — 선택 목록에는 안 보임) */
export function registerCustomMap(def: MapDefinition, isListed = true): void {
  custom.set(def.id, def);
  if (isListed) listed.add(def.id);
  else listed.delete(def.id);
}

export function unregisterCustomMap(id: string): void {
  custom.delete(id);
  listed.delete(id);
}

export function customMaps(): MapDefinition[] {
  return [...custom.values()].filter((d) => listed.has(d.id));
}

/** 맵 선택: 맵 id 또는 'random' */
export type MapChoice = string;
export const RANDOM_MAP = 'random';

export function getMap(id: string): MapDefinition {
  return MAPS.find((m) => m.id === id) ?? custom.get(id) ?? MAPS[0];
}

/** 'random'이면 기본 맵 중 무작위 (except와 다른 맵을 우선) */
export function resolveMap(choice: MapChoice, except?: string): MapDefinition {
  if (choice !== RANDOM_MAP) return getMap(choice);
  const pool = MAPS.length > 1 ? MAPS.filter((m) => m.id !== except) : MAPS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 맵 선택 버튼 목록 (무작위 + 기본 맵 + 내 맵) */
export function mapOptions(): { id: string; label: string; desc: string; custom?: boolean }[] {
  return [
    { id: RANDOM_MAP, label: '무작위', desc: '경기마다 기본 맵 중 무작위로' },
    ...MAPS.map((m) => ({ id: m.id, label: m.name, desc: m.blurb })),
    ...customMaps().map((m) => ({ id: m.id, label: m.name, desc: `★ ${m.blurb}`, custom: true })),
  ];
}
