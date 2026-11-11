import { ENVIRONMENTS, makeImpulse } from './AudioEffects';
import type { SynthContext } from './NoiseGenerator';
import type { BusName } from './SoundEffects';

/**
 * 믹서: 버스(무기/월드/장비/능력/UI) → 마스터 → 글루 컴프레서 → 리미터 → 출력.
 * 환경 리버브는 센드 버스로 공유한다 (소리마다 리버브 노드를 만들지 않음).
 *
 * 저역 과다·클리핑·급격한 음량 변화를 막기 위해
 *   - 마스터 앞 로우셸프로 80Hz 이하를 살짝 줄이고
 *   - 컴프레서(느린 글루) + 리미터(빠른 천장 -1dBFS)를 직렬로 둔다.
 */
export class AudioMixer {
  readonly master: GainNode;
  readonly buses: Record<BusName, GainNode>;
  private reverbs = new Map<string, { conv: ConvolverNode; gain: GainNode }>();
  environment = 'outdoor';

  constructor(private ctx: AudioContext) {
    const c = ctx;
    this.master = c.createGain();
    const shelf = c.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 80;
    shelf.gain.value = -2;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    glue.knee.value = 6;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.master.connect(shelf).connect(glue).connect(limiter).connect(c.destination);

    const mk = (gain: number) => {
      const g = c.createGain();
      g.gain.value = gain;
      g.connect(this.master);
      return g;
    };
    this.buses = { weapons: mk(0.9), world: mk(0.85), foley: mk(0.8), abilities: mk(0.85), ui: mk(0.7) };

    for (const env of ['outdoor', 'indoor', 'hall', 'cave']) {
      const conv = c.createConvolver();
      conv.normalize = true;
      conv.buffer = makeImpulse(c as unknown as SynthContext, ENVIRONMENTS[env], 31);
      const gain = c.createGain();
      gain.gain.value = env === this.environment ? 1 : 0;
      conv.connect(gain).connect(this.master);
      this.reverbs.set(env, { conv, gain });
    }
  }

  /** 리버브 센드 입력 (모든 환경 리버브에 보내고, 활성 환경만 출력) */
  connectSend(node: AudioNode): void {
    for (const r of this.reverbs.values()) node.connect(r.conv);
  }

  /** 환경 전환 (부드럽게 크로스페이드) */
  setEnvironment(env: string): void {
    if (!this.reverbs.has(env) || env === this.environment) return;
    this.environment = env;
    const t = this.ctx.currentTime;
    for (const [name, r] of this.reverbs) r.gain.gain.setTargetAtTime(name === env ? 1 : 0, t, 0.25);
  }

  setVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
}
