/**
 * 재질 사운드 프로필 (데이터).
 * 재질마다 음높이만 다른 것이 아니라 공진 주파수 분포(모드 비율), 감쇠, 대역폭,
 * 노이즈 비율, 초기 충격 세기, 저역·고역 응답, 파편 질감이 모두 다르다.
 *
 * 모드 비율 근거
 *  - 금속 막대/판(자유단): 1 : 2.756 : 5.404 : 8.933 … (비조화 → 쇳소리)
 *  - 유리·얼음: 얇은 판의 높은 비조화 모드, 긴 감쇠
 *  - 목재: 낮은 모드에 에너지가 몰리고 빠르게 감쇠 (내부 마찰이 큼)
 *  - 석재·콘크리트: 모드가 촘촘하고 거의 즉시 감쇠 → 노이즈 성분이 대부분
 */

export type MaterialName =
  | 'steel' | 'iron' | 'wood' | 'stone' | 'concrete' | 'glass' | 'ice'
  | 'leather' | 'rubber' | 'water' | 'sand' | 'dirt' | 'flesh' | 'polymer' | 'cloth';

export type DebrisType = 'none' | 'grit' | 'dust' | 'splinter' | 'shard' | 'crunch' | 'splash';

export interface MaterialProfile {
  /** 기본 공진 주파수 (Hz) */
  resonance: number;
  /** 공진 대역폭 (중심 주파수 대비 비율, 작을수록 날카롭게 울림) */
  bandwidth: number;
  /** 0..1: 높은 모드일수록 더 빨리 사라지는 정도 (내부 마찰) */
  damping: number;
  /** 기본 모드 감쇠 시간 (초) */
  decay: number;
  /** 0..1: 초기 충격(트랜지언트) 세기 */
  transient: number;
  /** 0..1: 공진 대비 노이즈 성분 비율 */
  noiseRatio: number;
  /** 0..1: 저역(무게감) 응답 */
  lowResponse: number;
  /** 고역 응답 상한 (Hz) */
  highResponse: number;
  /** 모드 주파수 비율 */
  modes: number[];
  /** 모드별 상대 세기 */
  modeGains: number[];
  debris: DebrisType;
}

const P = (p: MaterialProfile) => p;

export const MATERIALS: Record<MaterialName, MaterialProfile> = {
  steel: P({ resonance: 1650, bandwidth: 0.004, damping: 0.3, decay: 0.85, transient: 0.95, noiseRatio: 0.18, lowResponse: 0.25, highResponse: 13000,
    modes: [1, 2.756, 5.404, 8.933, 13.34], modeGains: [1, 0.7, 0.45, 0.3, 0.18], debris: 'none' }),
  iron: P({ resonance: 820, bandwidth: 0.01, damping: 0.45, decay: 0.42, transient: 0.85, noiseRatio: 0.3, lowResponse: 0.45, highResponse: 10000,
    modes: [1, 2.32, 4.25, 6.63, 9.38], modeGains: [1, 0.6, 0.4, 0.22, 0.12], debris: 'grit' }),
  wood: P({ resonance: 360, bandwidth: 0.12, damping: 0.8, decay: 0.085, transient: 0.6, noiseRatio: 0.45, lowResponse: 0.6, highResponse: 5200,
    modes: [1, 2.57, 4.2, 6.1], modeGains: [1, 0.45, 0.2, 0.1], debris: 'splinter' }),
  stone: P({ resonance: 620, bandwidth: 0.3, damping: 0.9, decay: 0.05, transient: 0.85, noiseRatio: 0.7, lowResponse: 0.7, highResponse: 7500,
    modes: [1, 1.71, 2.53, 3.4], modeGains: [1, 0.6, 0.35, 0.2], debris: 'grit' }),
  concrete: P({ resonance: 470, bandwidth: 0.4, damping: 0.92, decay: 0.04, transient: 0.9, noiseRatio: 0.78, lowResponse: 0.8, highResponse: 6800,
    modes: [1, 1.6, 2.3, 3.1], modeGains: [1, 0.55, 0.3, 0.15], debris: 'dust' }),
  glass: P({ resonance: 2700, bandwidth: 0.003, damping: 0.3, decay: 0.55, transient: 1, noiseRatio: 0.15, lowResponse: 0.1, highResponse: 15000,
    modes: [1, 2.32, 4.25, 6.63, 9.38, 12.9], modeGains: [1, 0.8, 0.6, 0.4, 0.3, 0.2], debris: 'shard' }),
  ice: P({ resonance: 3300, bandwidth: 0.008, damping: 0.5, decay: 0.22, transient: 0.9, noiseRatio: 0.35, lowResponse: 0.2, highResponse: 13500,
    modes: [1, 2.1, 3.9, 6.2], modeGains: [1, 0.7, 0.4, 0.25], debris: 'shard' }),
  leather: P({ resonance: 260, bandwidth: 0.6, damping: 0.95, decay: 0.03, transient: 0.3, noiseRatio: 0.8, lowResponse: 0.5, highResponse: 3200,
    modes: [1, 1.9], modeGains: [1, 0.4], debris: 'none' }),
  rubber: P({ resonance: 180, bandwidth: 0.5, damping: 0.9, decay: 0.06, transient: 0.4, noiseRatio: 0.5, lowResponse: 0.6, highResponse: 3200,
    modes: [1, 1.5], modeGains: [1, 0.3], debris: 'none' }),
  water: P({ resonance: 720, bandwidth: 0.25, damping: 0.7, decay: 0.12, transient: 0.3, noiseRatio: 0.85, lowResponse: 0.3, highResponse: 6000,
    modes: [1, 1.4, 2.2], modeGains: [1, 0.6, 0.3], debris: 'splash' }),
  sand: P({ resonance: 320, bandwidth: 0.8, damping: 0.98, decay: 0.02, transient: 0.25, noiseRatio: 0.95, lowResponse: 0.3, highResponse: 4800,
    modes: [1], modeGains: [1], debris: 'crunch' }),
  dirt: P({ resonance: 220, bandwidth: 0.7, damping: 0.96, decay: 0.03, transient: 0.35, noiseRatio: 0.9, lowResponse: 0.6, highResponse: 3800,
    modes: [1, 1.8], modeGains: [1, 0.3], debris: 'crunch' }),
  flesh: P({ resonance: 140, bandwidth: 0.7, damping: 0.95, decay: 0.05, transient: 0.3, noiseRatio: 0.6, lowResponse: 0.9, highResponse: 2000,
    modes: [1, 1.7], modeGains: [1, 0.35], debris: 'none' }),
  polymer: P({ resonance: 1350, bandwidth: 0.08, damping: 0.8, decay: 0.045, transient: 0.7, noiseRatio: 0.4, lowResponse: 0.2, highResponse: 9500,
    modes: [1, 2.1, 3.7], modeGains: [1, 0.4, 0.2], debris: 'none' }),
  cloth: P({ resonance: 900, bandwidth: 1.2, damping: 0.99, decay: 0.02, transient: 0.05, noiseRatio: 1, lowResponse: 0.1, highResponse: 5000,
    modes: [1], modeGains: [1], debris: 'none' }),
};

export function material(name: string | undefined, fallback: MaterialName = 'concrete'): MaterialProfile {
  return MATERIALS[(name as MaterialName) ?? fallback] ?? MATERIALS[fallback];
}
