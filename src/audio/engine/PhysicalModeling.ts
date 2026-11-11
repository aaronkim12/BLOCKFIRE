import type { MaterialProfile } from './MaterialProfiles';
import { noiseSource, type NoiseColor, type SynthContext } from './NoiseGenerator';
import { envelope, sub, tone } from './OscillatorSynth';
import type { Rng } from './Randomization';
import { grains } from './GranularSynth';

/**
 * 물리 모델링 근사.
 *  - 모달 합성: 물체의 고유 진동 모드를 감쇠 사인파로 더한다 (금속·유리의 울림)
 *  - 공진 필터: 노이즈를 재질 공진 대역으로 걸러 둔탁한 몸통 소리를 만든다 (목재·석재)
 *  - 충돌 모델: 트랜지언트 + 저역 충격 + 모드 공진 + 노이즈 공진 + 파편
 */

export interface ImpactParams {
  t: number;
  /** 0..1 충돌 세기 (속도·질량) */
  intensity: number;
  /** 물체 크기 배율: 크면 모드 주파수가 내려간다 */
  size?: number;
  /** 충돌체의 단단함 0..1: 단단할수록 고역 트랜지언트가 강함 */
  hardness?: number;
  /** 파편 레이어 사용 */
  debris?: boolean;
  gain?: number;
  /** 감쇠 시간 배율 (손에 쥔 작은 부품은 손이 진동을 흡수해 짧게 울린다) */
  decayScale?: number;
}

/** 필터를 거친 노이즈 버스트 */
export function noiseBurst(
  ctx: SynthContext, out: AudioNode, rng: Rng,
  o: { t: number; color?: NoiseColor; type?: BiquadFilterType; freq: number; freqEnd?: number; q?: number; gain: number; attack?: number; decay: number; hold?: number; hp?: number },
): void {
  const total = (o.attack ?? 0.001) + (o.hold ?? 0) + o.decay * 1.6 + 0.02;
  const src = noiseSource(ctx, o.color ?? 'white', rng, o.t, total);
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.Q.value = o.q ?? 0.8;
  if (o.freqEnd) {
    f.frequency.setValueAtTime(o.freq, o.t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), o.t + (o.attack ?? 0) + (o.hold ?? 0) + o.decay);
  } else f.frequency.value = o.freq;
  let node: AudioNode = src.connect(f);
  if (o.hp) {
    const h = ctx.createBiquadFilter();
    h.type = 'highpass';
    h.frequency.value = o.hp;
    node = node.connect(h);
  }
  const g = ctx.createGain();
  envelope(g.gain, o.t, o.gain, o.attack ?? 0.001, o.hold ?? 0, o.decay);
  node.connect(g).connect(out);
}

/** 모달 합성: 재질의 모드 비율로 감쇠 사인파를 더한다 */
export function modal(ctx: SynthContext, out: AudioNode, rng: Rng, m: MaterialProfile, t: number, gain: number, sizeScale = 1, decayScale = 1): void {
  const nyq = ctx.sampleRate / 2;
  m.modes.forEach((ratio, i) => {
    // 실제 물체는 모드가 완전히 정수비가 아니다 → 미세한 비조화 (±1.2%)
    const f = rng.jitter(m.resonance * ratio / sizeScale, 0.012);
    if (f > nyq * 0.9) return;
    // 내부 마찰: 높은 모드일수록 빨리 감쇠
    const decay = (m.decay * decayScale) / (1 + m.damping * i * 1.8);
    const amp = gain * m.modeGains[i] * rng.jitter(1, 0.15);
    tone(ctx, out, t, { freq: f, gain: amp, attack: 0.0008, decay: Math.max(0.006, decay) });
  });
}

/** 공진 필터를 거친 노이즈 (둔탁한 재질의 몸통) */
export function noiseResonance(ctx: SynthContext, out: AudioNode, rng: Rng, m: MaterialProfile, t: number, gain: number, sizeScale = 1, decayScale = 1): void {
  const q = Math.min(40, Math.max(0.6, 1 / Math.max(0.025, m.bandwidth)));
  noiseBurst(ctx, out, rng, {
    t, color: 'pink', freq: rng.jitter(m.resonance / sizeScale, 0.08), q, gain: gain * Math.sqrt(q) * 0.5,
    attack: 0.001, decay: Math.max(0.02, m.decay * decayScale * 0.7 + 0.015),
  });
}

/** 범용 충돌 모델 */
export function impact(ctx: SynthContext, out: AudioNode, rng: Rng, m: MaterialProfile, p: ImpactParams): void {
  const I = p.intensity;
  const size = p.size ?? 1;
  const hard = p.hardness ?? 0.8;
  const G = p.gain ?? 1;
  // 1) 트랜지언트: 아주 짧은 광대역 충격 (단단할수록 밝다)
  noiseBurst(ctx, out, rng, {
    t: p.t, color: 'white', type: 'lowpass', freq: m.highResponse * (0.45 + 0.55 * I * hard), q: 0.5,
    gain: G * m.transient * (0.5 + 0.5 * I), attack: 0.0004, decay: 0.004 + 0.004 * (1 - hard), hp: 400,
  });
  // 2) 저역 충격 (무게감)
  if (m.lowResponse > 0.15) {
    const f = Math.min(220, Math.max(45, (m.resonance * 0.22) / size));
    sub(ctx, out, p.t, f * 1.8, f, 0.03 + 0.09 * m.lowResponse * size, G * m.lowResponse * I * 0.7);
  }
  // 3) 재질 공진: 모드(울림) + 노이즈 공진(몸통)
  modal(ctx, out, rng, m, p.t + 0.0005, G * (1 - m.noiseRatio) * I * 0.55, size, p.decayScale ?? 1);
  noiseResonance(ctx, out, rng, m, p.t, G * m.noiseRatio * I * 0.55, size, p.decayScale ?? 1);
  // 4) 파편 (입자 질감)
  if (p.debris !== false) debris(ctx, out, rng, m, p.t + 0.008, I * G);
}

/** 재질별 파편 질감 (그래뉼러) */
export function debris(ctx: SynthContext, out: AudioNode, rng: Rng, m: MaterialProfile, t: number, I: number): void {
  switch (m.debris) {
    case 'grit':
    case 'dust':
      grains(ctx, out, rng, { t, dur: 0.12 + 0.15 * I, count: Math.round(10 + 22 * I), source: 'noise', freq: [1800, 7000], q: 2.2, grainDur: [0.002, 0.008], gain: 0.22 * I, shape: 'decay' });
      if (m.debris === 'dust') noiseBurst(ctx, out, rng, { t, color: 'pink', freq: 2500, q: 0.4, gain: 0.08 * I, attack: 0.01, decay: 0.25 });
      break;
    case 'splinter':
      grains(ctx, out, rng, { t, dur: 0.1 + 0.1 * I, count: Math.round(5 + 10 * I), source: 'click', freq: [900, 3500], q: 6, grainDur: [0.004, 0.015], gain: 0.25 * I, shape: 'decay' });
      break;
    case 'shard':
      grains(ctx, out, rng, { t, dur: 0.35 + 0.4 * I, count: Math.round(8 + 18 * I), source: 'sine', freq: [3500, 9500], grainDur: [0.015, 0.06], gain: 0.12 * I, shape: 'decay' });
      break;
    case 'crunch':
      grains(ctx, out, rng, { t, dur: 0.08 + 0.08 * I, count: Math.round(14 + 20 * I), source: 'noise', freq: [700, 4000], q: 1.5, grainDur: [0.002, 0.006], gain: 0.25 * I, shape: 'flat' });
      break;
    case 'splash':
      grains(ctx, out, rng, { t, dur: 0.3, count: Math.round(12 + 20 * I), source: 'sine', freq: [600, 2400], freqGlide: 1.8, grainDur: [0.01, 0.04], gain: 0.12 * I, shape: 'decay' });
      noiseBurst(ctx, out, rng, { t, color: 'white', freq: 3000, q: 0.6, gain: 0.2 * I, attack: 0.005, decay: 0.25 });
      break;
  }
}
