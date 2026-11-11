/**
 * 무기별 효과음 (public/assets/sounds 샘플 이름).
 * 탄종에 맞는 총소리를 고르고, pitch로 같은 탄종 무기끼리도 구분되게 한다.
 */
export interface WeaponSfx {
  shot: string;
  pitch?: number;
  /** 재장전 25% 지점 (탄창 빼기) */
  magOut?: string;
  /** 재장전 70% 지점 (탄창 끼우기) */
  magIn?: string;
  /** 꺼낼 때 */
  equip?: string;
  /** 사격 직후 (노리쇠/펌프 조작) */
  cycle?: string;
}

const AR = { magOut: 'ar_mag_out', magIn: 'ar_mag_in', equip: 'ar_charge' };
const AK = { magOut: 'ak_mag_out', magIn: 'ak_mag_in', equip: 'ak_rack' };
const PISTOL = { magOut: 'pistol_mag_out', magIn: 'pistol_mag_in', equip: 'pistol_slide' };
const BOLT = { magOut: 'bolt_mag_out', magIn: 'bolt_mag_in', equip: 'bolt_cycle', cycle: 'bolt_cycle' };
const SHELL = { magOut: 'shell_load', magIn: 'shell_load', equip: 'pump_rack' };

export const WEAPON_SFX: Record<string, WeaponSfx> = {
  tack: { shot: 'shot_9mm', pitch: 1.1, ...PISTOL },
  magnum: { shot: 'shot_308', pitch: 1.15, magOut: 'revolver_open', magIn: 'revolver_close', equip: 'revolver_cock' },
  ripper: { shot: 'shot_20g', pitch: 1.05, ...SHELL, equip: 'revolver_close' },
  hornet: { shot: 'shot_9mm', pitch: 1.05, ...AR },
  viper: { shot: 'shot_9mm', pitch: 0.95, ...AR },
  breach: { shot: 'shot_20g', ...SHELL, cycle: 'pump_rack' },
  slugger: { shot: 'shot_20g', pitch: 1.08, ...SHELL },
  mule: { shot: 'shot_556', pitch: 1.05, ...AR },
  sentry: { shot: 'shot_762', pitch: 0.95, ...AK },
  falcon: { shot: 'shot_556', ...AR },
  warhound: { shot: 'shot_762', ...AK },
  needle: { shot: 'shot_762r', ...BOLT },
  longbow: { shot: 'shot_308', pitch: 0.9, ...BOLT },
  blade: { shot: 'knife' },
  storm: { shot: 'knife', equip: 'equip' },
  core: { shot: 'ui', equip: 'equip' },
};

/** 미리 불러올 샘플 파일 */
export const SAMPLE_FILES = [
  'shot_556', 'shot_762', 'shot_762r', 'shot_308', 'shot_9mm', 'shot_20g',
  'ar_mag_out', 'ar_mag_in', 'ar_charge', 'ak_mag_out', 'ak_mag_in', 'ak_rack',
  'bolt_mag_out', 'bolt_mag_in', 'bolt_cycle', 'shell_load', 'pump_rack',
  'pistol_mag_out', 'pistol_mag_in', 'pistol_slide', 'dry_fire',
  'revolver_open', 'revolver_close', 'revolver_cock',
];
