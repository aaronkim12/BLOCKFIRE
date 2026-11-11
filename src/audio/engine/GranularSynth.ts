import { noiseSource, type SynthContext } from './NoiseGenerator';
import type { Rng } from './Randomization';

/**
 * 그래뉼러 합성: 아주 짧은 소리 입자(그레인)를 시간·음높이를 흩뜨려 뿌린다.
 * 파편, 불꽃 튀는 소리, 모래·자갈, 에너지 효과처럼 불규칙한 질감에 쓴다.
 */
export interface GrainOpts {
  t: number;
  /** 입자를 뿌리는 시간 범위 (초) */
  dur: number;
  count: number;
  /** 입자 원천: 필터된 노이즈 / 사인 / 날카로운 클릭(공진 노이즈) */
  source: 'noise' | 'sine' | 'click';
  freq: [number, number];
  /** 사인 입자 음높이 변화 배율 (1.8이면 위로 미끄러짐 — 물방울) */
  freqGlide?: number;
  q?: number;
  grainDur: [number, number];
  gain: number;
  /** 밀도 분포: decay = 앞쪽에 몰림, rise = 뒤로 갈수록 많아짐, flat = 균일 */
  shape: 'decay' | 'rise' | 'flat';
  /** 입자 음량이 시간에 따라 줄어드는지 */
  fade?: boolean;
}

export function grains(ctx: SynthContext, out: AudioNode, rng: Rng, o: GrainOpts): void {
  for (let i = 0; i < o.count; i++) {
    const u = rng.next();
    const pos = o.shape === 'decay' ? u * u : o.shape === 'rise' ? Math.sqrt(u) : u;
    const t = o.t + pos * o.dur;
    const len = rng.range(o.grainDur[0], o.grainDur[1]);
    // 주파수는 로그 균일 분포
    const f = o.freq[0] * Math.pow(o.freq[1] / o.freq[0], rng.next());
    const amp = o.gain * rng.range(0.35, 1) * (o.fade === false ? 1 : 1 - 0.6 * pos);
    const g = ctx.createGain();
    // 짧은 하닝 창에 가까운 엔벨로프 (클릭 없는 입자)
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + Math.min(0.002, len * 0.3));
    g.gain.setTargetAtTime(0, t + len * 0.3, len * 0.25);
    g.connect(out);
    if (o.source === 'sine') {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(f, t);
      if (o.freqGlide) osc.frequency.exponentialRampToValueAtTime(f * o.freqGlide, t + len);
      osc.connect(g);
      osc.start(t);
      osc.stop(t + len * 2 + 0.01);
    } else {
      const src = noiseSource(ctx, 'white', rng, t, len * 2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = o.source === 'click' ? (o.q ?? 8) : (o.q ?? 1.5);
      src.connect(bp).connect(g);
    }
  }
}
