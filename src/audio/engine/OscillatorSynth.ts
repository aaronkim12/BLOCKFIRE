import type { SynthContext } from './NoiseGenerator';

/**
 * 오실레이터 합성 헬퍼: 엔벨로프, 피치 엔벨로프, FM / AM, 서브 오실레이터.
 * 모든 함수는 (ctx, 출력 노드, 시작 시간)을 받아 노드를 연결하고 일정을 잡는다.
 */

/** 진폭 엔벨로프: 0 → peak (attack) → hold → 지수 감쇠 */
export function envelope(param: AudioParam, t: number, peak: number, attack: number, hold: number, decay: number): void {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + Math.max(0.0005, attack));
  if (hold > 0) param.setValueAtTime(peak, t + attack + hold);
  // setTargetAtTime: 시간 상수 decay/4 → decay초 뒤 약 -35dB
  param.setTargetAtTime(0, t + attack + hold, Math.max(0.001, decay / 4));
}

/** 지수 주파수 스윕 */
export function sweep(param: AudioParam, t: number, from: number, to: number, dur: number): void {
  param.setValueAtTime(Math.max(1, from), t);
  param.exponentialRampToValueAtTime(Math.max(1, to), t + Math.max(0.001, dur));
}

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** 피치 엔벨로프 목표 주파수 */
  freqEnd?: number;
  pitchTime?: number;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  detune?: number;
}

/** 단일 오실레이터 + 피치/진폭 엔벨로프 */
export function tone(ctx: SynthContext, out: AudioNode, t: number, o: ToneOpts): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  if (o.detune) osc.detune.value = o.detune;
  if (o.freqEnd !== undefined) sweep(osc.frequency, t, o.freq, o.freqEnd, o.pitchTime ?? o.decay);
  else osc.frequency.setValueAtTime(o.freq, t);
  const g = ctx.createGain();
  envelope(g.gain, t, o.gain, o.attack ?? 0.001, o.hold ?? 0, o.decay);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + (o.attack ?? 0) + (o.hold ?? 0) + o.decay * 1.6 + 0.05);
  return osc;
}

export interface FMOpts {
  carrier: number;
  carrierEnd?: number;
  /** 변조파 주파수 = carrier × ratio */
  ratio: number;
  /** 변조 지수 (시작 → 끝) */
  index: number;
  indexEnd?: number;
  gain: number;
  attack?: number;
  decay: number;
  type?: OscillatorType;
}

/** 2-오퍼레이터 FM 합성 (금속성·전자음) */
export function fm(ctx: SynthContext, out: AudioNode, t: number, o: FMOpts): void {
  const car = ctx.createOscillator();
  car.type = o.type ?? 'sine';
  const mod = ctx.createOscillator();
  const modGain = ctx.createGain();
  const dur = (o.attack ?? 0.002) + o.decay * 1.6;
  if (o.carrierEnd) {
    sweep(car.frequency, t, o.carrier, o.carrierEnd, o.decay);
    sweep(mod.frequency, t, o.carrier * o.ratio, o.carrierEnd * o.ratio, o.decay);
  } else {
    car.frequency.setValueAtTime(o.carrier, t);
    mod.frequency.setValueAtTime(o.carrier * o.ratio, t);
  }
  // 변조 깊이(Hz) = index × 변조파 주파수
  modGain.gain.setValueAtTime(o.index * o.carrier * o.ratio, t);
  modGain.gain.linearRampToValueAtTime((o.indexEnd ?? o.index) * (o.carrierEnd ?? o.carrier) * o.ratio, t + o.decay);
  mod.connect(modGain).connect(car.frequency);
  const g = ctx.createGain();
  envelope(g.gain, t, o.gain, o.attack ?? 0.002, 0, o.decay);
  car.connect(g).connect(out);
  car.start(t);
  mod.start(t);
  car.stop(t + dur);
  mod.stop(t + dur);
}

/** 진폭 변조 (링 모듈레이션 포함: depth=1, offset=0) */
export function amNode(ctx: SynthContext, t: number, rate: number, depth: number, dur: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = 1 - depth / 2;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const lg = ctx.createGain();
  lg.gain.value = depth / 2;
  lfo.connect(lg).connect(g.gain);
  lfo.start(t);
  lfo.stop(t + dur);
  return g;
}

/** 서브 오실레이터: 피치가 떨어지는 저역 충격 (무게감) */
export function sub(ctx: SynthContext, out: AudioNode, t: number, from: number, to: number, dur: number, gain: number): void {
  tone(ctx, out, t, { freq: from, freqEnd: to, pitchTime: dur * 0.5, gain, attack: 0.002, decay: dur });
}
