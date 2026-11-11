import * as Tone from 'tone';
import { filter } from './AudioEffects';
import type { SynthContext } from './NoiseGenerator';
import { dbToGain, Rng } from './Randomization';
import { intensityBucket, SOUNDS, type SoundDef, type SoundParams } from './SoundEffects';

/**
 * 레시피 → 오디오 버퍼.
 * Tone.Offline으로 렌더링(Tone 신스와 네이티브 Web Audio 노드를 같은 그래프에서 사용)한 뒤
 *   DC 제거 · 피크 정규화 · 시작/끝 페이드로 다듬어 변형본별로 캐시한다.
 * 재생할 때는 노드를 새로 만들지 않고 이 버퍼만 재사용한다.
 */

const START = 0.004; // 레시피 시작 시각 (첫 샘플 클릭 방지 여유)

export class SoundGenerator {
  private cache = new Map<string, AudioBuffer[]>();
  private pending = new Map<string, Promise<AudioBuffer[]>>();
  /** 렌더링 직렬화 (Tone.Offline은 전역 컨텍스트를 잠시 바꾸므로 동시에 돌리지 않는다) */
  private queue: Promise<unknown> = Promise.resolve();
  renderMs = 0;
  renderCount = 0;

  constructor(private target: BaseAudioContext) {}

  /** 캐시 키: 소리 이름 + 결과를 바꾸는 매개변수 */
  key(name: string, p: SoundParams): string {
    const def = SOUNDS[name];
    if (!def) return name;
    return name + '|' + def.keys.map((k) => (k === 'intensity' ? intensityBucket(p.intensity) : (p[k] ?? ''))).join('|');
  }

  get(name: string, p: SoundParams): AudioBuffer[] | undefined {
    return this.cache.get(this.key(name, p));
  }

  /** 필요하면 렌더링하고 변형본 목록을 돌려준다 */
  ensure(name: string, p: SoundParams): Promise<AudioBuffer[]> {
    const def = SOUNDS[name];
    if (!def) return Promise.reject(new Error(`알 수 없는 효과음: ${name}`));
    const key = this.key(name, p);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    let pend = this.pending.get(key);
    if (!pend) {
      // 캐시 키에 들어가는 값으로 렌더링 (세기는 묶음 대표값)
      const params: SoundParams = { ...p };
      if (def.keys.includes('intensity')) params.intensity = intensityBucket(p.intensity);
      pend = this.renderVariants(name, def, params, key);
      this.pending.set(key, pend);
    }
    return pend;
  }

  private async renderVariants(name: string, def: SoundDef, p: SoundParams, key: string): Promise<AudioBuffer[]> {
    const out: AudioBuffer[] = [];
    let seed = 0;
    for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
    for (let v = 0; v < def.variants; v++) out.push(await this.renderOne(def, p, seed + v * 7919));
    this.cache.set(key, out);
    this.pending.delete(key);
    void name;
    return out;
  }

  /** 한 변형본 렌더링 (직렬) */
  renderOne(def: SoundDef, p: SoundParams, seed: number): Promise<AudioBuffer> {
    const job = this.queue.then(async () => {
      const t0 = performance.now();
      const dur = def.duration(p) + START + 0.05;
      const sr = this.target.sampleRate;
      const rendered = await Tone.Offline(
        (ctx) => {
          const c = ctx as unknown as SynthContext;
          // 출력: DC/초저역 제거 하이패스 → 대상
          const out = c.createGain();
          const hp = filter(c, 'highpass', 22);
          out.connect(hp);
          hp.connect(ctx.rawContext.destination as unknown as AudioNode);
          def.render({ ctx: c, out, rng: new Rng(seed), t: START }, p);
        },
        dur,
        1,
        sr,
      );
      const buf = this.finish(rendered.get()!, def.peakDb);
      this.renderMs += performance.now() - t0;
      this.renderCount++;
      return buf;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** 대상 컨텍스트의 버퍼로 복사하면서 다듬기 */
  /** 외부에서 들어온 녹음 버퍼도 같은 기준(DC 제거·피크 정규화·끝 페이드)으로 다듬는다 */
  prepare(src: AudioBuffer, peakDb: number): AudioBuffer {
    return this.finish(src, peakDb);
  }

  /** 이미 만든 버퍼를 캐시에 직접 넣는다 (녹음 샘플) */
  put(key: string, buffers: AudioBuffer[]): void {
    this.cache.set(key, buffers);
  }

  private finish(src: AudioBuffer, peakDb: number): AudioBuffer {
    // 스테레오 녹음은 모노로 합친다 (위치는 공간 처리에서 다시 정함)
    const d = new Float32Array(src.length);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const ch = src.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] += ch[i] / src.numberOfChannels;
    }
    // DC 오프셋 제거
    let mean = 0;
    for (let i = 0; i < d.length; i++) mean += d[i];
    mean /= d.length;
    let peak = 0;
    for (let i = 0; i < d.length; i++) {
      d[i] -= mean;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    // 피크 정규화 → 소리 사이의 상대 음량은 peakDb로 결정
    const k = peak > 1e-6 ? dbToGain(peakDb) / peak : 1;
    for (let i = 0; i < d.length; i++) d[i] *= k;
    // 끝부분: 남은 꼬리를 자연스럽게 0으로 (20ms) — 잘림 클릭 방지
    const fade = Math.min(d.length, Math.floor(0.02 * src.sampleRate));
    for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
    // 앞부분 무음 구간(START) 제거하지 않음: 1ms 미만이라 지연에 영향 없음
    const out = this.target.createBuffer(1, d.length, src.sampleRate);
    out.copyToChannel(d, 0);
    return out;
  }

  /** 여러 소리를 미리 렌더링 (로딩 화면) */
  async prewarm(list: [string, SoundParams][], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    for (const [name, p] of list) {
      await this.ensure(name, p);
      onProgress?.(++done, list.length);
    }
  }

  get size(): number {
    let n = 0;
    for (const v of this.cache.values()) n += v.length;
    return n;
  }
}
