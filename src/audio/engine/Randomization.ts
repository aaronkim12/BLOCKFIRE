/**
 * 시드 기반 난수와 변조 헬퍼.
 * 같은 시드 → 같은 소리 (변형본 캐시가 재현 가능), 다른 시드 → 미세하게 다른 소리.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** v ± v·pct */
  jitter(v: number, pct: number): number {
    return v * (1 + (this.next() * 2 - 1) * pct);
  }

  /** 로그 스케일 변조 (주파수용): v × 2^(±cents/1200) */
  cents(v: number, cents: number): number {
    return v * Math.pow(2, ((this.next() * 2 - 1) * cents) / 1200);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
}

/** 재생 시 변조 범위 (렌더링된 변형본 위에 추가로 적용) */
export interface PlaybackVariation {
  /** 음높이 변화 (cents) */
  pitchCents: number;
  /** 음량 변화 (dB) */
  gainDb: number;
  /** 저역 통과 필터 변화 (비율) */
  filterPct: number;
  /** 시작 지연 (초) */
  timing: number;
}

export const DEFAULT_VARIATION: PlaybackVariation = { pitchCents: 35, gainDb: 1.5, filterPct: 0.12, timing: 0.004 };

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-9, g));
