import { DRYDOCK } from './drydock';
import { FOUNDRY } from './foundry';
import { MERIDIAN } from './meridian';
import type { MapDefinition } from './MapData';

/** 플레이할 수 있는 맵 목록 */
export const MAPS: MapDefinition[] = [FOUNDRY, DRYDOCK, MERIDIAN];

/** 맵 선택: 맵 id 또는 'random' */
export type MapChoice = string;
export const RANDOM_MAP = 'random';

export function getMap(id: string): MapDefinition {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/** 'random'이면 무작위 맵 (except와 다른 맵을 우선) */
export function resolveMap(choice: MapChoice, except?: string): MapDefinition {
  if (choice !== RANDOM_MAP) return getMap(choice);
  const pool = MAPS.length > 1 ? MAPS.filter((m) => m.id !== except) : MAPS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 맵 선택 버튼 목록 (무작위 + 각 맵) */
export function mapOptions(): { id: string; label: string; desc: string }[] {
  return [
    { id: RANDOM_MAP, label: '무작위', desc: '경기마다 맵을 무작위로' },
    ...MAPS.map((m) => ({ id: m.id, label: m.name, desc: m.blurb })),
  ];
}
