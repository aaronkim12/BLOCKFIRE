import type { Rng } from './Randomization';

/**
 * 노이즈 생성 (White / Pink / Brown).
 * 원본 표본(4초)은 한 번만 계산해 두고, 렌더링마다 무작위 위치에서 잘라 쓴다.
 */
export type NoiseColor = 'white' | 'pink' | 'brown';

const SECONDS = 4;
const cache = new Map<string, Float32Array>();

function generate(color: NoiseColor, sampleRate: number): Float32Array {
  const n = SECONDS * sampleRate;
  const d = new Float32Array(n);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  if (color === 'white') {
    for (let i = 0; i < n; i++) d[i] = rnd();
  } else if (color === 'pink') {
    // Paul Kellet의 정밀 핑크 노이즈 필터 (-3dB/oct)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // 브라운 노이즈: 적분된 백색 노이즈 (-6dB/oct), 누설로 DC 방지
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * rnd()) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // 정규화
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < n; i++) d[i] /= peak;
  return d;
}

export function noiseData(color: NoiseColor, sampleRate: number): Float32Array {
  const key = `${color}@${sampleRate}`;
  let d = cache.get(key);
  if (!d) cache.set(key, (d = generate(color, sampleRate)));
  return d;
}

/** 렌더링 컨텍스트 (Tone.BaseContext 또는 네이티브 BaseAudioContext) */
export interface SynthContext {
  sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  createBiquadFilter(): BiquadFilterNode;
  createOscillator(): OscillatorNode;
  createWaveShaper(): WaveShaperNode;
  createConvolver(): ConvolverNode;
  createDelay(maxDelayTime?: number): DelayNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  createStereoPanner(): StereoPannerNode;
}

const bufferCache = new WeakMap<object, Map<string, AudioBuffer>>();

/** 컨텍스트별로 노이즈 버퍼를 한 번만 만든다 */
export function noiseBuffer(ctx: SynthContext, color: NoiseColor): AudioBuffer {
  let m = bufferCache.get(ctx);
  if (!m) bufferCache.set(ctx, (m = new Map()));
  let b = m.get(color);
  if (!b) {
    const data = noiseData(color, ctx.sampleRate);
    b = ctx.createBuffer(1, data.length, ctx.sampleRate);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    m.set(color, b);
  }
  return b;
}

/** 무작위 위치에서 시작하는 노이즈 소스 */
export function noiseSource(ctx: SynthContext, color: NoiseColor, rng: Rng, t: number, dur: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, color);
  src.loop = true;
  src.start(t, rng.range(0, SECONDS - 0.1));
  src.stop(t + dur + 0.05);
  return src;
}
