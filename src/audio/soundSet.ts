import type { SoundParams } from './engine';

/**
 * 이 게임이 쓰는 효과음 조합 (로딩 화면에서 미리 렌더링, 오디오 랩에서 검수).
 * [표시 이름, 소리 이름, 매개변수]
 */
export const GAME_SET: [string, string, SoundParams][] = [
  ...(['pistol9', 'smg', 'rifle556', 'rifle762', 'sniper', 'shotgun', 'revolver'] as const).map(
    (c) => [`gunshot · ${c}`, 'gunshot', { caliber: c }] as [string, string, SoundParams],
  ),
  ...['mag_out', 'mag_in', 'charge', 'bolt', 'pump', 'slide', 'revolver_open', 'revolver_close', 'revolver_cock', 'shell_load', 'dry_fire', 'equip', 'core_tap'].map(
    (k) => [`mechanism · ${k}`, 'mechanism', { kind: k }] as [string, string, SoundParams],
  ),
  ...['concrete', 'stone', 'wood', 'steel', 'dirt', 'glass'].map((m) => [`impact · ${m}`, 'impact', { material: m, intensity: 1 }] as [string, string, SoundParams]),
  ...['concrete', 'dirt', 'wood', 'steel'].flatMap((m) =>
    [0.65, 1].map((i) => [`footstep · ${m} · ${i === 1 ? 'run' : 'walk'}`, 'footstep', { material: m, weight: 'normal', intensity: i }] as [string, string, SoundParams]),
  ),
  ['hit_body', 'hit_body', {}],
  ['hit_head', 'hit_head', {}],
  ['knife', 'knife', {}],
  ['explosion · large', 'explosion', { size: 'large' }],
  ['ability throw', 'ability', {}],
  ['smoke', 'smoke', {}],
  ['wall_up', 'wall_up', {}],
  ['beacon', 'beacon', {}],
  ['zone', 'zone', {}],
  ['flare', 'flare', {}],
  ['dash', 'dash', {}],
  ['magic_charge (overdrive)', 'magic_charge', { duration: 0.9, intensity: 1 }],
  ['beep', 'beep', {}],
  ['plant_start', 'plant_start', {}],
  ['planted', 'planted', {}],
  ['defused', 'defused', {}],
  ['hurt', 'hurt', {}],
  ['kill', 'kill', {}],
  ['ui', 'ui', {}],
  ['round_start', 'round_start', {}],
  ['round_win', 'round_win', {}],
  ['round_lose', 'round_lose', {}],
];

/** 오디오 랩: 게임 조합 + 매뉴얼 예시 API (재질·크기 비교용) */
export const LAB_SET: [string, string, SoundParams][] = [
  ...GAME_SET,
  ...['steel', 'iron', 'wood', 'stone', 'glass', 'ice', 'rubber', 'water'].map(
    (m) => [`metal_impact · ${m}`, 'metal_impact', { material: m, intensity: 0.9 }] as [string, string, SoundParams],
  ),
  ['explosion · small', 'explosion', { size: 'small' }],
  ['footstep · stone · heavy', 'footstep', { material: 'stone', weight: 'heavy', intensity: 1 }],
  ['footstep · sand · light', 'footstep', { material: 'sand', weight: 'light', intensity: 0.65 }],
  ['magic_charge · 2.5s', 'magic_charge', { duration: 2.5, intensity: 0.8 }],
];
