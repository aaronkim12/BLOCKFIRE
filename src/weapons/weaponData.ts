/**
 * 무기 데이터. 모든 무기는 이 표로 정의된다 (데이터 기반).
 * 모델은 Ultimate Gun Pack by Quaternius (CC0).
 * 이름과 수치는 BLOCKFIRE 고유의 것이다.
 *
 * Phase 3에서는 모델/애니메이션/탄약/재장전에 쓰이는 값만 사용하고,
 * 피해량·반동·탄 퍼짐 등은 Phase 4(전투 시스템)에서 사용한다.
 */

export type WeaponCategory = 'sidearm' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'melee' | 'core';
export type WeaponSlot = 1 | 2 | 3 | 4; // 1 주무기, 2 보조무기, 3 근접, 4 Core

export interface WeaponDef {
  id: string;
  name: string;
  category: WeaponCategory;
  slot: WeaponSlot;
  /** public/ 기준 모델 경로 */
  model: string;
  /** 모델의 총 길이를 이 값(m)에 맞춰 크기를 정규화한다 */
  length: number;
  /**
   * 손 위치 [앞뒤, 높이] — 바운딩 박스 기준 비율.
   * 앞뒤: 총 뒤끝 0 → 총구 1, 높이: 바닥 0 → 윗면 1.
   * grip = 오른손(손잡이), support = 왼손(핸드가드). support가 없으면 두 손으로 감싸 쥔다.
   */
  hold: { grip: [number, number]; support?: [number, number] };
  price: number;

  // ── 조작/애니메이션
  /** 초당 발사 수 */
  fireRate: number;
  automatic: boolean;
  magazine: number;
  reserve: number;
  reloadTime: number;
  equipTime: number;
  /** 조준 시 시야 배율 (1 = 변화 없음) */
  adsZoom: number;
  /** 1인칭에서 무기를 들고 있는 위치 미세 조정 (카메라 공간, m) */
  viewOffset?: [number, number, number];
  /** 반동 애니메이션 크기 배율 */
  kick: number;

  // ── 전투 (Phase 4)
  damage: { head: number; body: number; leg: number };
  /** [거리(m), 피해 배율] — 거리별 피해 감소 */
  falloff: [number, number][];
  pellets?: number;
  /** 정지 상태 기본 탄 퍼짐 (도) */
  spread: number;
  /** 이동 시 퍼짐 증가 (도) */
  moveSpread: number;
  /** 벽 관통력 (Phase 4) */
  penetration: 'low' | 'medium' | 'high';
}

const W = (d: WeaponDef) => d;

export const WEAPONS: WeaponDef[] = [
  // ───────── 보조무기
  W({
    id: 'tack', name: 'TACK', category: 'sidearm', slot: 2, model: 'assets/weapons/Pistol_1.fbx',
    length: 0.22, hold: { grip: [0.11, 0.54] }, price: 0, fireRate: 6.75, automatic: false, magazine: 12, reserve: 36,
    reloadTime: 1.75, equipTime: 0.75, adsZoom: 1.1, kick: 0.8,
    damage: { head: 78, body: 26, leg: 22 }, falloff: [[30, 1], [50, 0.85]],
    spread: 0.4, moveSpread: 2.5, penetration: 'low',
  }),
  W({
    id: 'magnum', name: 'MAGNUM', category: 'sidearm', slot: 2, model: 'assets/weapons/Revolver_1.fbx',
    length: 0.26, hold: { grip: [0.1, 0.43] }, price: 800, fireRate: 4, automatic: false, magazine: 6, reserve: 24,
    reloadTime: 2.25, equipTime: 0.75, adsZoom: 1.15, kick: 1.8,
    damage: { head: 159, body: 55, leg: 46 }, falloff: [[30, 1], [50, 0.85]],
    spread: 0.25, moveSpread: 3, penetration: 'high',
  }),
  W({
    id: 'ripper', name: 'RIPPER', category: 'sidearm', slot: 2, model: 'assets/weapons/Shotgun_SawedOff.fbx',
    length: 0.42, hold: { grip: [0.15, 0.38], support: [0.62, 0.62] }, price: 300, fireRate: 3.3, automatic: false, magazine: 2, reserve: 10,
    reloadTime: 1.75, equipTime: 0.75, adsZoom: 1, kick: 2,
    damage: { head: 22, body: 11, leg: 9 }, falloff: [[7, 1], [15, 0.5]], pellets: 15,
    spread: 4, moveSpread: 0.5, penetration: 'low',
  }),
  // ───────── 기관단총
  W({
    id: 'hornet', name: 'HORNET', category: 'smg', slot: 1, model: 'assets/weapons/SubmachineGun_1.fbx',
    length: 0.42, hold: { grip: [0.19, 0.66], support: [0.5, 0.48] }, price: 1100, fireRate: 16, automatic: true, magazine: 20, reserve: 60,
    reloadTime: 2.25, equipTime: 0.75, adsZoom: 1.15, kick: 0.5,
    damage: { head: 67, body: 27, leg: 23 }, falloff: [[15, 1], [50, 0.9]],
    spread: 0.6, moveSpread: 1.2, penetration: 'low',
  }),
  W({
    id: 'viper', name: 'VIPER', category: 'smg', slot: 1, model: 'assets/weapons/SubmachineGun_3.fbx',
    length: 0.55, hold: { grip: [0.47, 0.53], support: [0.84, 0.47] }, price: 1600, fireRate: 13.33, automatic: true, magazine: 30, reserve: 90,
    reloadTime: 2.25, equipTime: 0.75, adsZoom: 1.15, kick: 0.55,
    damage: { head: 78, body: 26, leg: 22 }, falloff: [[20, 1], [50, 0.85]],
    spread: 0.4, moveSpread: 1, penetration: 'medium',
  }),
  // ───────── 산탄총
  W({
    id: 'breach', name: 'BREACH', category: 'shotgun', slot: 1, model: 'assets/weapons/Shotgun_1.fbx',
    length: 0.95, hold: { grip: [0.28, 0.52], support: [0.67, 0.6] }, price: 850, fireRate: 1.1, automatic: false, magazine: 5, reserve: 10,
    reloadTime: 2.5, equipTime: 1, adsZoom: 1, kick: 2.2,
    damage: { head: 40, body: 20, leg: 17 }, falloff: [[8, 1], [12, 0.6]], pellets: 15,
    spread: 2.6, moveSpread: 0.5, penetration: 'low',
  }),
  W({
    id: 'slugger', name: 'SLUGGER', category: 'shotgun', slot: 1, model: 'assets/weapons/Shotgun_ShortStock.fbx',
    length: 0.8, hold: { grip: [0.2, 0.54], support: [0.79, 0.65] }, price: 1850, fireRate: 3.5, automatic: true, magazine: 7, reserve: 14,
    reloadTime: 2.2, equipTime: 1, adsZoom: 1, kick: 1.6,
    damage: { head: 34, body: 17, leg: 14 }, falloff: [[10, 1], [15, 0.7]], pellets: 12,
    spread: 2.25, moveSpread: 0.5, penetration: 'medium',
  }),
  // ───────── 소총
  W({
    id: 'mule', name: 'MULE', category: 'rifle', slot: 1, model: 'assets/weapons/AssaultRifle2_4.fbx',
    length: 0.72, hold: { grip: [0.36, 0.44], support: [0.69, 0.62] }, price: 2050, fireRate: 9.15, automatic: true, magazine: 24, reserve: 72,
    reloadTime: 2.5, equipTime: 1, adsZoom: 1.25, kick: 0.8,
    damage: { head: 115, body: 35, leg: 29 }, falloff: [[50, 1]],
    spread: 0.3, moveSpread: 5, penetration: 'medium',
  }),
  W({
    id: 'sentry', name: 'SENTRY', category: 'rifle', slot: 1, model: 'assets/weapons/AssaultRifle_3.fbx',
    length: 0.85, hold: { grip: [0.08, 0.56], support: [0.66, 0.78] }, price: 2250, fireRate: 5.25, automatic: false, magazine: 12, reserve: 36,
    reloadTime: 2.5, equipTime: 1, adsZoom: 1.5, kick: 1.2,
    damage: { head: 195, body: 65, leg: 49 }, falloff: [[50, 1]],
    spread: 0.1, moveSpread: 5, penetration: 'high',
  }),
  W({
    id: 'falcon', name: 'FALCON', category: 'rifle', slot: 1, model: 'assets/weapons/AssaultRifle2_1.fbx',
    length: 0.9, hold: { grip: [0.3, 0.5], support: [0.61, 0.67] }, price: 2900, fireRate: 11, automatic: true, magazine: 30, reserve: 90,
    reloadTime: 2.5, equipTime: 1, adsZoom: 1.25, kick: 0.9,
    damage: { head: 156, body: 39, leg: 33 }, falloff: [[15, 1], [30, 0.88], [50, 0.79]],
    spread: 0.2, moveSpread: 5, penetration: 'medium',
  }),
  W({
    id: 'warhound', name: 'WARHOUND', category: 'rifle', slot: 1, model: 'assets/weapons/AssaultRifle_2.fbx',
    length: 0.92, hold: { grip: [0.3, 0.53], support: [0.68, 0.75] }, price: 2900, fireRate: 9.75, automatic: true, magazine: 25, reserve: 75,
    reloadTime: 2.5, equipTime: 1, adsZoom: 1.25, kick: 1.1,
    damage: { head: 160, body: 40, leg: 34 }, falloff: [[50, 1]],
    spread: 0.25, moveSpread: 5, penetration: 'medium',
  }),
  // ───────── 저격총
  W({
    id: 'needle', name: 'NEEDLE', category: 'sniper', slot: 1, model: 'assets/weapons/SniperRifle_4.fbx',
    length: 1.05, hold: { grip: [0.29, 0.51], support: [0.53, 0.53] }, price: 950, fireRate: 1.5, automatic: false, magazine: 5, reserve: 10,
    reloadTime: 2.5, equipTime: 1.25, adsZoom: 2.5, kick: 2,
    damage: { head: 202, body: 101, leg: 85 }, falloff: [[50, 1]],
    spread: 0, moveSpread: 5, penetration: 'medium',
  }),
  W({
    id: 'longbow', name: 'LONGBOW', category: 'sniper', slot: 1, model: 'assets/weapons/SniperRifle_2.fbx',
    length: 1.2, hold: { grip: [0.3, 0.55], support: [0.56, 0.63] }, price: 4700, fireRate: 0.6, automatic: false, magazine: 5, reserve: 10,
    reloadTime: 3.7, equipTime: 1.5, adsZoom: 4, kick: 3,
    damage: { head: 255, body: 150, leg: 127 }, falloff: [[50, 1]],
    spread: 0, moveSpread: 5, penetration: 'high',
  }),
  // ───────── 근접
  W({
    id: 'blade', name: 'BLADE', category: 'melee', slot: 3, model: 'assets/weapons/Accessories/Bayonet.fbx',
    length: 0.3, hold: { grip: [0.1, 0.5] }, price: 0, fireRate: 2, automatic: true, magazine: 0, reserve: 0,
    reloadTime: 0, equipTime: 0.5, adsZoom: 1, kick: 0,
    damage: { head: 50, body: 50, leg: 50 }, falloff: [[2.5, 1]],
    spread: 0, moveSpread: 0, penetration: 'low',
  }),
  // ───────── 목표물: Core (사격하지 않고, 들고 있는 상태에서 길게 눌러 설치)
  W({
    id: 'core', name: 'CORE', category: 'core', slot: 4, model: '',
    length: 0.42, hold: { grip: [0, 0.5] }, price: 0, fireRate: 0, automatic: false, magazine: 0, reserve: 0,
    reloadTime: 0, equipTime: 0.6, adsZoom: 1, kick: 0,
    damage: { head: 0, body: 0, leg: 0 }, falloff: [[1, 1]],
    spread: 0, moveSpread: 0, penetration: 'low',
  }),
];

/** 궁극기 STORM EDGE의 투척 단검 (상점·무기 목록에는 없음) */
export const STORM_KNIVES: WeaponDef = W({
  id: 'storm', name: 'STORM EDGE', category: 'sidearm', slot: 3, model: 'assets/weapons/Accessories/Bayonet.fbx',
  length: 0.3, hold: { grip: [0.1, 0.5] }, price: 0, fireRate: 3.2, automatic: false, magazine: 5, reserve: 0,
  reloadTime: 0, equipTime: 0.45, adsZoom: 1, kick: 0.2,
  damage: { head: 150, body: 50, leg: 50 }, falloff: [[60, 1]],
  spread: 0.12, moveSpread: 0.2, penetration: 'low',
});

export const WEAPON_BY_ID = new Map([...WEAPONS, STORM_KNIVES].map((w) => [w.id, w]));

export function getWeapon(id: string): WeaponDef {
  const w = WEAPON_BY_ID.get(id);
  if (!w) throw new Error(`알 수 없는 무기: ${id}`);
  return w;
}
