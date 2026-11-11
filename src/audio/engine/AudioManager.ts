import * as Tone from 'tone';
import { AudioMixer } from './AudioMixer';
import { dbToGain, DEFAULT_VARIATION, Rng } from './Randomization';
import { SoundGenerator } from './SoundGenerator';
import { intensityBucket, SOUNDS, type SoundDef, type SoundParams } from './SoundEffects';
import { dopplerRate, distance, Listener, SpatialChain, type Vec3 } from './SpatialAudio';

/**
 * 절차적 효과음 엔진 (게임 엔진과 독립).
 *
 *   AudioEngine.play('metal_impact', { intensity: 0.9, material: 'steel', variation: true })
 *   AudioEngine.play('explosion', { size: 'large', environment: 'cave', position })
 *   AudioEngine.play('footstep', { material: 'stone', weight: 'heavy', velocity: 2 })
 *   AudioEngine.play('magic_charge', { intensity: 0.8, duration: 2.5 })
 *
 * 음성 관리: 전체 동시 재생 수와 소리별 동시 재생 수를 제한하고, 넘치면 우선순위가 낮고
 * 오래된 음성을 부드럽게 끈다. 재생이 끝난 노드는 바로 연결을 끊어 누수를 막는다.
 */

export interface PlayOptions extends SoundParams {
  /** 3D 위치 (없으면 청취자 기준 2D) */
  position?: Vec3;
  sourceVelocity?: Vec3;
  /** 0..1 가림 정도 (없으면 occlusionFn으로 계산) */
  occlusion?: number;
  /** 이 소리만 다른 환경 리버브를 쓰고 싶을 때 (없으면 현재 환경) */
  environment?: string;
  /** 추가 음량 (dB) */
  gainDb?: number;
  /** 추가 음높이 배율 */
  pitch?: number;
  /** 반복 방지 변조 (기본 true) */
  variation?: boolean;
  refDistance?: number;
}

interface Voice {
  name: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  spatial: SpatialChain | null;
  priority: number;
  started: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly mixer: AudioMixer;
  readonly generator: SoundGenerator;
  readonly listener: Listener;
  private voices: Voice[] = [];
  private lastVariant = new Map<string, number>();
  private rng = new Rng((Math.random() * 1e9) | 0);
  maxVoices = 40;
  /** 음원 위치 → 가림 정도 (게임이 레이캐스트로 제공) */
  occlusionFn: ((pos: Vec3) => number) | null = null;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    // Tone.js가 별도의 AudioContext를 만들지 않도록 같은 컨텍스트를 공유
    Tone.setContext(this.ctx);
    this.mixer = new AudioMixer(this.ctx);
    this.generator = new SoundGenerator(this.ctx);
    this.listener = new Listener(this.ctx);
  }

  /** 브라우저 자동 재생 정책: 사용자 입력 안에서 호출 */
  async unlock(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  setEnvironment(env: string): void {
    this.mixer.setEnvironment(env);
  }

  setVolume(v: number): void {
    this.mixer.setVolume(v);
  }

  /**
   * 녹음된 샘플을 효과음으로 등록 (절차적 레시피와 같은 음성 관리·공간 처리·믹서를 거친다).
   * 여러 버퍼를 주면 변형본으로 번갈아 쓴다.
   */
  registerSample(
    name: string,
    buffers: AudioBuffer[],
    o: { bus: SoundDef['bus']; peakDb: number; maxVoices?: number; priority?: number; spatial?: boolean; variation?: SoundDef['variation'] },
  ): void {
    SOUNDS[name] = {
      bus: o.bus, duration: () => 0, variants: buffers.length, keys: [], peakDb: o.peakDb,
      maxVoices: o.maxVoices ?? 6, priority: o.priority ?? 5, spatial: o.spatial, variation: o.variation,
      render: () => undefined,
    };
    this.generator.put(this.generator.key(name, {}), buffers.map((b) => this.generator.prepare(b, o.peakDb)));
  }

  /** 압축 오디오 파일을 디코딩 */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  /** 미리 렌더링해 둘 소리 목록 */
  prewarm(list: [string, SoundParams][], onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.generator.prewarm(list, onProgress);
  }

  /**
   * 효과음 재생. 아직 렌더링되지 않은 조합이면 렌더링 후 재생한다(지연이 생기므로 prewarm 권장).
   */
  play(name: string, o: PlayOptions = {}): void {
    const def = SOUNDS[name];
    if (!def) {
      console.warn(`알 수 없는 효과음: ${name}`);
      return;
    }
    const buffers = this.generator.get(name, o);
    if (buffers) this.start(name, buffers, o);
    else void this.generator.ensure(name, o).then((b) => this.start(name, b, o));
  }

  private start(name: string, buffers: AudioBuffer[], o: PlayOptions): void {
    if (!this.running) return;
    const def = SOUNDS[name];
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vary = o.variation !== false;
    const v = { ...DEFAULT_VARIATION, ...def.variation };

    // ── 음성 제한
    this.reap();
    const same = this.voices.filter((x) => x.name === name);
    if (same.length >= def.maxVoices) this.stopVoice(same[0]);
    if (this.voices.length >= this.maxVoices) {
      const victim = [...this.voices].sort((a, b) => a.priority - b.priority || a.started - b.started)[0];
      if (victim.priority > def.priority) return; // 더 중요한 소리만 있으면 이 소리를 버린다
      this.stopVoice(victim);
    }

    // ── 변형본 선택 (직전과 다른 것)
    let idx = Math.floor(this.rng.next() * buffers.length);
    const last = this.lastVariant.get(name);
    if (buffers.length > 1 && idx === last) idx = (idx + 1) % buffers.length;
    this.lastVariant.set(name, idx);

    const src = ctx.createBufferSource();
    src.buffer = buffers[idx];
    let rate = o.pitch ?? 1;
    if (vary) rate *= Math.pow(2, ((this.rng.next() * 2 - 1) * v.pitchCents) / 1200);
    const pos = def.spatial === false ? undefined : o.position;
    if (pos && o.sourceVelocity) rate *= dopplerRate(this.listener, pos, o.sourceVelocity);
    src.playbackRate.value = rate;

    // 세기: 캐시 묶음과 실제 값의 차이를 음량·밝기로 연속 보정
    const I = o.intensity ?? 0.8;
    const bucket = def.keys.includes('intensity') ? intensityBucket(o.intensity) : 0.8;
    let gainDb = (o.gainDb ?? 0) + 20 * Math.log10(Math.max(0.05, I / bucket)) * 0.6;
    if (vary) gainDb += (this.rng.next() * 2 - 1) * v.gainDb;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(gainDb);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(20000, (6000 + 14000 * Math.min(1, I)) * (vary ? 1 + (this.rng.next() * 2 - 1) * v.filterPct : 1));
    src.connect(tone).connect(gain);

    const bus = this.mixer.buses[def.bus];
    let spatial: SpatialChain | null = null;
    if (pos) {
      const occ = o.occlusion ?? this.occlusionFn?.(pos) ?? 0;
      const send = def.bus === 'ui' ? 0 : 0.18 + Math.min(0.25, distance(pos, this.listener.pos) / 120);
      spatial = new SpatialChain(ctx, bus, (n) => this.mixer.connectSend(n), { position: pos, velocity: o.sourceVelocity, occlusion: occ, refDistance: o.refDistance }, send);
      gain.connect(spatial.input);
    } else {
      gain.connect(bus);
      if (def.bus !== 'ui') {
        const s = ctx.createGain();
        s.gain.value = 0.12;
        gain.connect(s);
        this.mixer.connectSend(s);
      }
    }
    if (o.environment) this.mixer.setEnvironment(o.environment);

    const when = now + (vary ? this.rng.next() * v.timing : 0);
    src.start(when);
    const voice: Voice = { name, src, gain, spatial, priority: def.priority, started: now };
    src.onended = () => this.release(voice);
    this.voices.push(voice);
  }

  /** 음성을 짧게 페이드아웃하고 정리 (뚝 끊기는 클릭 방지) */
  private stopVoice(v: Voice): void {
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + 0.03);
    try {
      v.src.stop(t + 0.035);
    } catch {
      /* 이미 멈춤 */
    }
    this.voices = this.voices.filter((x) => x !== v);
  }

  private release(v: Voice): void {
    this.voices = this.voices.filter((x) => x !== v);
    v.src.disconnect();
    v.gain.disconnect();
    v.spatial?.disconnect();
  }

  /** 끝났는데 onended가 늦은 음성 정리 */
  private reap(): void {
    const t = this.ctx.currentTime;
    for (const v of [...this.voices]) if (v.src.buffer && t - v.started > v.src.buffer.duration * 2 + 1) this.release(v);
  }

  get activeVoices(): number {
    return this.voices.length;
  }
}
