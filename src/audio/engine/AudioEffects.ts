import type { SynthContext } from './NoiseGenerator';
import { Rng } from './Randomization';

/**
 * 후처리 프로세서: 필터, EQ, 포화(saturation), 왜곡, 딜레이, 컨볼루션 리버브.
 * 소리마다 필요한 것만 골라 쓴다.
 */

/** tanh 포화 곡선 (drive 1 = 약간, 4 = 강한 압축감) */
export function saturationCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

/** 하드 클리핑 왜곡 + 비대칭 (거친 질감) */
export function distortionCurve(amount: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const k = amount * 50;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)) + 0.03 * x * x;
  }
  return c;
}

export function saturate(ctx: SynthContext, drive: number): WaveShaperNode {
  const w = ctx.createWaveShaper();
  w.curve = saturationCurve(drive);
  w.oversample = '4x';
  return w;
}

export function filter(ctx: SynthContext, type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

/** 직렬 노드 연결 헬퍼: a → b → c, 마지막 노드 반환 */
export function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

export interface ReverbSpec {
  /** 잔향 길이 (초) */
  duration: number;
  /** 감쇠 곡선 지수 (클수록 빨리 사라짐) */
  decay: number;
  /** 초기 반사까지 지연 (초) */
  preDelay: number;
  /** 시간이 지날수록 고역이 빨리 사라지는 정도 0..1 */
  damping: number;
  /** 초기 반사 개수 (벽이 가까운 공간일수록 많고 강함) */
  early: number;
  /** 스테레오 폭 */
  stereo: boolean;
}

/** 환경 프리셋 */
export const ENVIRONMENTS: Record<string, ReverbSpec> = {
  outdoor: { duration: 1.4, decay: 4.5, preDelay: 0.06, damping: 0.75, early: 2, stereo: true },
  indoor: { duration: 1.1, decay: 3.2, preDelay: 0.012, damping: 0.5, early: 8, stereo: true },
  hall: { duration: 2.4, decay: 2.6, preDelay: 0.025, damping: 0.45, early: 6, stereo: true },
  cave: { duration: 3.8, decay: 2.0, preDelay: 0.035, damping: 0.35, early: 10, stereo: true },
  // 총소리에 미리 섞는 짧은 근거리 반사 (모노)
  slap: { duration: 0.5, decay: 5, preDelay: 0.004, damping: 0.6, early: 4, stereo: false },
};

/**
 * 알고리즘으로 임펄스 응답을 만든다 (외부 IR 파일 없음):
 * 초기 반사(희소한 임펄스) + 지수 감쇠하는 확산 노이즈 꼬리, 시간에 따라 고역 감쇠.
 */
export function makeImpulse(ctx: SynthContext, spec: ReverbSpec, seed = 7): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(spec.duration * sr);
  const ch = spec.stereo ? 2 : 1;
  const buf = ctx.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    const rng = new Rng(seed + c * 101);
    const d = new Float32Array(len);
    const pre = Math.floor(spec.preDelay * sr);
    // 확산 꼬리: 노이즈 × 지수 감쇠, 1차 저역 통과 계수를 시간에 따라 낮춤 (고역 감쇠)
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      const a = 1 - spec.damping * 0.97 * x; // 필터 계수 1 → 0.03
      lp += a * ((rng.next() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - x, spec.decay) * 0.6;
    }
    // 초기 반사
    for (let e = 0; e < spec.early; e++) {
      const idx = pre + Math.floor(rng.range(0.002, 0.08) * sr);
      if (idx < len) d[idx] += (rng.next() < 0.5 ? -1 : 1) * rng.range(0.3, 0.8) * (1 - e / (spec.early + 1));
    }
    // 시작 부분 클릭 방지 페이드
    for (let i = 0; i < Math.min(len, 64); i++) d[i] *= i / 64;
    buf.copyToChannel(d, c);
  }
  return buf;
}

/** 컨볼루션 리버브 (dry/wet) */
export function reverb(ctx: SynthContext, input: AudioNode, out: AudioNode, spec: ReverbSpec, wet: number, seed?: number): void {
  const conv = ctx.createConvolver();
  conv.normalize = true;
  conv.buffer = makeImpulse(ctx, spec, seed);
  const g = ctx.createGain();
  g.gain.value = wet;
  input.connect(conv).connect(g).connect(out);
}

/** 피드백 딜레이 (에코) */
export function echo(ctx: SynthContext, input: AudioNode, out: AudioNode, time: number, feedback: number, wet: number, lowpass = 3000): void {
  const d = ctx.createDelay(2);
  d.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const lp = filter(ctx, 'lowpass', lowpass);
  const w = ctx.createGain();
  w.gain.value = wet;
  input.connect(d);
  d.connect(lp).connect(fb).connect(d);
  lp.connect(w).connect(out);
}
