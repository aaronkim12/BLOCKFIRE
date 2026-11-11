import * as Tone from 'tone';
import { chain, distortionCurve, ENVIRONMENTS, filter, reverb, saturate } from './AudioEffects';
import { grains } from './GranularSynth';
import { material, MATERIALS, type MaterialName } from './MaterialProfiles';
import type { SynthContext } from './NoiseGenerator';
import { envelope, fm, sub, tone } from './OscillatorSynth';
import { debris, impact, modal, noiseBurst } from './PhysicalModeling';
import type { PlaybackVariation, Rng } from './Randomization';

/**
 * 효과음 레시피 모음 (코드로 정의된 프리셋).
 * 레시피는 오프라인 컨텍스트에서 실행되어 버퍼로 렌더링되고, 변형본별로 캐시된다.
 *
 * 레이어 원칙 (매뉴얼 3장)
 *   Transient : 순간 충격, 공격의 시작
 *   Body      : 중심 질감, 무게감
 *   Texture   : 마찰, 파편, 공기 흐름
 *   Resonance : 재질 고유의 울림
 *   Tail      : 잔향, 감쇠, 공간감
 * 소리마다 필요한 레이어만 조합한다.
 */

export type BusName = 'weapons' | 'world' | 'foley' | 'abilities' | 'ui';

export interface SoundParams {
  /** 0..1 세기 */
  intensity?: number;
  material?: string;
  size?: 'small' | 'medium' | 'large';
  weight?: 'light' | 'normal' | 'heavy';
  /** 이동/충돌 속도 (m/s) */
  velocity?: number;
  /** 총기 탄종 */
  caliber?: string;
  /** 지속 시간이 있는 효과 (초) */
  duration?: number;
  /** 장비 동작 종류 */
  kind?: string;
}

export interface RenderAPI {
  ctx: SynthContext;
  out: AudioNode;
  rng: Rng;
  /** 시작 시각 (오프라인 컨텍스트 기준) */
  t: number;
}

export interface SoundDef {
  bus: BusName;
  /** 렌더링 길이 (초) */
  duration: (p: SoundParams) => number;
  /** 캐시할 변형본 수 (반복 방지) */
  variants: number;
  /** 렌더링 결과를 바꾸는 매개변수 (캐시 키) */
  keys: (keyof SoundParams)[];
  /** 정규화 목표 피크 (dBFS) — 소리 사이의 상대 음량 */
  peakDb: number;
  /** 같은 소리의 동시 재생 수 제한 */
  maxVoices: number;
  /** 음성 부족 시 우선순위 (높을수록 덜 빼앗김) */
  priority: number;
  variation?: Partial<PlaybackVariation>;
  /** false면 위치와 무관한 2D 소리 (UI) */
  spatial?: boolean;
  render(r: RenderAPI, p: SoundParams): void;
}

/** 세기를 3단계로 묶는다 (캐시 크기 제한, 재생 시 음량·필터로 연속 보정) */
export function intensityBucket(i = 0.8): number {
  return i < 0.45 ? 0.3 : i < 0.8 ? 0.65 : 1;
}

// ───────────────────────── 공통 헬퍼 ─────────────────────────

/** 작은 금속 부품 딸깍 (모달 + 트랜지언트) */
function click(r: RenderAPI, t: number, mat: MaterialName, gain: number, size = 0.35): void {
  impact(r.ctx, r.out, r.rng, MATERIALS[mat], { t, intensity: 1, size, hardness: 1, debris: false, gain, decayScale: 0.12 });
}

/** 마찰 (미끄러짐): 대역 통과 노이즈 + 미세 입자 */
function friction(r: RenderAPI, t: number, dur: number, from: number, to: number, g0: number): void {
  const gain = g0 * 0.4;
  noiseBurst(r.ctx, r.out, r.rng, { t, color: 'white', freq: from, freqEnd: to, q: 3, gain, attack: dur * 0.3, hold: dur * 0.4, decay: dur * 0.3 });
  grains(r.ctx, r.out, r.rng, { t, dur, count: Math.round(dur * 120), source: 'click', freq: [Math.min(from, to), Math.max(from, to) * 1.5], q: 10, grainDur: [0.001, 0.003], gain: gain * 0.5, shape: 'flat', fade: false });
}

/** 공기 이동 (휘두르기·투척·돌진) */
function whoosh(r: RenderAPI, t: number, dur: number, peakFreq: number, gain: number): void {
  const { ctx, rng } = r;
  noiseBurst(ctx, r.out, rng, { t, color: 'pink', freq: peakFreq * 0.35, freqEnd: peakFreq, q: 1.6, gain, attack: dur * 0.55, decay: dur * 0.45 });
  noiseBurst(ctx, r.out, rng, { t: t + dur * 0.4, color: 'white', freq: peakFreq * 1.8, freqEnd: peakFreq * 0.6, q: 2.5, gain: gain * 0.35, attack: dur * 0.2, decay: dur * 0.5 });
}

/** 옷·장비 바스락 (그래뉼러) */
function rustle(r: RenderAPI, t: number, dur: number, gain: number): void {
  grains(r.ctx, r.out, r.rng, { t, dur, count: Math.round(dur * 140), source: 'noise', freq: [900, 5000], q: 1.2, grainDur: [0.004, 0.018], gain, shape: 'flat' });
}

// ───────────────────────── 총기 ─────────────────────────

interface Caliber {
  crack: number;
  blastLP: [number, number];
  blastDecay: number;
  sub: [number, number, number];
  subGain: number;
  tail: number;
  mech: number;
  /** 초음속 탄의 날카로운 N파 */
  supersonic: boolean;
  casing: 'brass' | 'shell' | 'none';
}

const CALIBERS: Record<string, Caliber> = {
  pistol9: { crack: 0.75, blastLP: [9000, 1500], blastDecay: 0.07, sub: [150, 62, 0.09], subGain: 0.5, tail: 0.18, mech: 3300, supersonic: false, casing: 'brass' },
  smg: { crack: 0.65, blastLP: [8000, 1700], blastDecay: 0.05, sub: [165, 70, 0.07], subGain: 0.42, tail: 0.13, mech: 3700, supersonic: false, casing: 'brass' },
  rifle556: { crack: 1, blastLP: [11500, 1800], blastDecay: 0.085, sub: [132, 50, 0.12], subGain: 0.72, tail: 0.22, mech: 2900, supersonic: true, casing: 'brass' },
  rifle762: { crack: 1, blastLP: [10000, 1300], blastDecay: 0.115, sub: [112, 42, 0.16], subGain: 0.88, tail: 0.27, mech: 2450, supersonic: true, casing: 'brass' },
  sniper: { crack: 1.2, blastLP: [13000, 950], blastDecay: 0.17, sub: [96, 34, 0.28], subGain: 1, tail: 0.42, mech: 2000, supersonic: true, casing: 'brass' },
  shotgun: { crack: 0.8, blastLP: [7200, 850], blastDecay: 0.16, sub: [102, 38, 0.22], subGain: 1, tail: 0.33, mech: 2200, supersonic: false, casing: 'shell' },
  revolver: { crack: 1.1, blastLP: [10000, 1150], blastDecay: 0.13, sub: [120, 45, 0.18], subGain: 0.85, tail: 0.3, mech: 2600, supersonic: false, casing: 'none' },
};

function gunshot(r: RenderAPI, p: SoundParams): void {
  const c = CALIBERS[p.caliber ?? 'rifle556'] ?? CALIBERS.rifle556;
  const { ctx, rng, t } = r;
  // 총구 폭발음은 포화를 거쳐 단단하게, 그 다음 짧은 반사(slap)를 섞는다
  const blastBus = ctx.createGain();
  const sat = saturate(ctx, 2.2);
  blastBus.connect(sat).connect(r.out);
  reverb(ctx, blastBus, r.out, ENVIRONMENTS.slap, c.tail * 0.9, rng.int(1, 9999));

  // Transient: 장약 점화 순간의 광대역 크랙
  noiseBurst(ctx, r.out, rng, { t, color: 'white', type: 'highpass', freq: 2200, q: 0.7, gain: c.crack * 0.6, attack: 0.0003, decay: 0.0035 });
  // 초음속 탄의 N파 (날카로운 '딱')
  if (c.supersonic) tone(ctx, r.out, t, { type: 'sawtooth', freq: rng.cents(3600, 60), freqEnd: 1800, pitchTime: 0.002, gain: c.crack * 0.35, attack: 0.0002, decay: 0.003 });
  // Body: 총구 폭발 — 핑크 노이즈를 저역 통과 필터로 쓸어내린다
  noiseBurst(ctx, blastBus, rng, { t, color: 'pink', type: 'lowpass', freq: rng.jitter(c.blastLP[0], 0.08), freqEnd: c.blastLP[1], q: 0.9, gain: 1, attack: 0.0006, decay: rng.jitter(c.blastDecay, 0.1) });
  noiseBurst(ctx, blastBus, rng, { t, color: 'pink', freq: rng.jitter(700, 0.1), q: 1.1, gain: 0.75, attack: 0.001, decay: c.blastDecay * 1.4 });
  // 저역 충격 (가슴을 치는 압력)
  sub(ctx, blastBus, t, c.sub[0], c.sub[1], c.sub[2], c.subGain);
  // Texture: 노리쇠·작동부의 금속음
  const mech = { ...MATERIALS.steel, resonance: c.mech, decay: 0.05 };
  modal(ctx, r.out, rng, mech, t + rng.range(0.008, 0.014), 0.07, 1, 1);
  modal(ctx, r.out, rng, mech, t + rng.range(0.035, 0.05), 0.045, 1.15, 0.8);
  // 탄피가 바닥에 떨어지는 소리 (멀리, 작게)
  const drop = t + rng.range(0.32, 0.45);
  if (c.casing === 'brass') {
    const brass = { ...MATERIALS.steel, resonance: rng.range(4200, 5200), decay: 0.12 };
    modal(ctx, r.out, rng, brass, drop, 0.025);
    modal(ctx, r.out, rng, brass, drop + rng.range(0.06, 0.1), 0.012, 1.05);
  } else if (c.casing === 'shell') {
    click(r, drop, 'polymer', 0.035, 0.8);
  }
}

// ───────────────────────── 장비 동작 (Foley) ─────────────────────────

function mechanism(r: RenderAPI, p: SoundParams): void {
  const t = r.t;
  const rng = r.rng;
  switch (p.kind) {
    case 'mag_out':
      click(r, t, 'steel', 0.35, 0.3); // 탄창 멈치 버튼
      friction(r, t + 0.02, 0.12, 1600, 900, 0.18); // 탄창이 빠져나옴
      click(r, t + 0.15, 'polymer', 0.4, 0.9);
      break;
    case 'mag_in':
      friction(r, t, 0.07, 800, 1500, 0.15);
      click(r, t + 0.075, 'polymer', 0.55, 0.85); // 탄창 삽입
      click(r, t + 0.08, 'steel', 0.6, 0.45); // 걸쇠 맞물림
      sub(r.ctx, r.out, t + 0.078, 160, 80, 0.06, 0.35);
      break;
    case 'charge':
      friction(r, t, 0.1, 1200, 2200, 0.2); // 장전손잡이 당김
      click(r, t + 0.1, 'steel', 0.35, 0.5);
      click(r, t + 0.2, 'steel', 0.8, 0.6); // 노리쇠 전진 쾅
      sub(r.ctx, r.out, t + 0.2, 180, 90, 0.05, 0.3);
      break;
    case 'bolt':
      click(r, t, 'steel', 0.4, 0.5); // 손잡이 들기
      friction(r, t + 0.06, 0.1, 900, 1700, 0.2); // 뒤로
      friction(r, t + 0.22, 0.09, 1700, 1000, 0.2); // 앞으로
      click(r, t + 0.32, 'steel', 0.7, 0.55); // 잠김
      break;
    case 'pump':
      friction(r, t, 0.07, 700, 1300, 0.22);
      click(r, t + 0.07, 'steel', 0.6, 0.7);
      click(r, t + 0.075, 'wood', 0.4, 0.8);
      friction(r, t + 0.16, 0.06, 1300, 700, 0.22);
      click(r, t + 0.22, 'steel', 0.75, 0.7);
      break;
    case 'slide':
      friction(r, t, 0.05, 1500, 2600, 0.12);
      click(r, t + 0.05, 'steel', 0.85, 0.4);
      break;
    case 'revolver_open':
      click(r, t, 'steel', 0.4, 0.35);
      grains(r.ctx, r.out, rng, { t: t + 0.03, dur: 0.12, count: 6, source: 'click', freq: [2500, 4500], q: 12, grainDur: [0.003, 0.006], gain: 0.25, shape: 'flat', fade: false });
      break;
    case 'revolver_close':
      click(r, t, 'steel', 0.8, 0.5);
      break;
    case 'revolver_cock':
      click(r, t, 'steel', 0.4, 0.35);
      click(r, t + 0.07, 'steel', 0.55, 0.3);
      break;
    case 'shell_load':
      friction(r, t, 0.05, 900, 1400, 0.12);
      click(r, t + 0.05, 'polymer', 0.5, 0.7);
      click(r, t + 0.055, 'steel', 0.3, 0.6);
      break;
    case 'dry_fire':
      click(r, t, 'steel', 0.7, 0.28); // 공이치기
      tone(r.ctx, r.out, t + 0.002, { freq: rng.cents(5200, 50), gain: 0.05, decay: 0.05 }); // 스프링 울림
      break;
    case 'equip':
      rustle(r, t, 0.22, 0.12);
      click(r, t + 0.12, 'steel', 0.25, 0.5);
      click(r, t + 0.16, 'polymer', 0.2, 0.7);
      break;
    case 'core_tap':
      click(r, t, 'polymer', 0.6, 0.4);
      tone(r.ctx, r.out, t, { type: 'square', freq: 1760, gain: 0.04, decay: 0.03 });
      break;
    default:
      click(r, t, 'steel', 0.5, 0.5);
  }
}

// ───────────────────────── 충돌 / 피격 ─────────────────────────

function bulletImpact(r: RenderAPI, p: SoundParams): void {
  const m = material(p.material);
  const I = p.intensity ?? 1;
  impact(r.ctx, r.out, r.rng, m, { t: r.t, intensity: I, size: 0.7, hardness: 1, debris: true });
  // 금속 표면: 가끔 도탄 (피치가 내려가는 휘파람)
  if ((p.material === 'steel' || p.material === 'iron') && r.rng.chance(0.35)) {
    const f = r.rng.range(2600, 4200);
    tone(r.ctx, r.out, r.t + 0.01, { freq: f, freqEnd: f * 0.55, pitchTime: 0.3, gain: 0.12, attack: 0.01, decay: 0.3 });
  }
}

function bodyHit(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  // 살 재질의 저역 응답을 낮춰 쓴다: 총알 피격은 무거운 쿵보다 짧은 "퍽"이 중심
  impact(ctx, r.out, rng, { ...MATERIALS.flesh, lowResponse: 0.35 }, { t, intensity: 1, size: 1.1, hardness: 0.4, debris: false, gain: 0.45 });
  // 젖은 타격감: 짧은 저역 노이즈 + 천 스침
  noiseBurst(ctx, r.out, rng, { t, color: 'brown', type: 'lowpass', freq: 900, q: 0.8, gain: 0.22, attack: 0.001, decay: 0.06 });
  noiseBurst(ctx, r.out, rng, { t, color: 'pink', freq: rng.range(1300, 1900), q: 1.1, gain: 1.2, attack: 0.0008, decay: 0.04 });
  rustle(r, t + 0.005, 0.06, 0.15);
}

/** 헤드샷: 금속성 '딩' — 전술 FPS의 핵심 피드백 (헬멧 공진을 과장) */
function headHit(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  noiseBurst(ctx, r.out, rng, { t, color: 'white', type: 'highpass', freq: 3000, gain: 0.5, attack: 0.0003, decay: 0.004 });
  const helm = { ...MATERIALS.steel, resonance: rng.cents(1950, 20), decay: 0.38, damping: 0.15 };
  modal(ctx, r.out, rng, helm, t, 0.55);
  bodyHit({ ...r, t: t + 0.002 });
}

// ───────────────────────── 발소리 ─────────────────────────

function footstep(r: RenderAPI, p: SoundParams): void {
  const m = material(p.material, 'concrete');
  const I = p.intensity ?? 0.8;
  const w = p.weight === 'heavy' ? 1.35 : p.weight === 'light' ? 0.75 : 1;
  const { ctx, rng, t } = r;
  // 뒤꿈치 → 앞꿈치 두 번의 접촉 (간격은 걸음 속도에 따라)
  const roll = rng.range(0.025, 0.05) * (1.4 - I * 0.5);
  const sole = { ...m, transient: m.transient * 0.55, highResponse: m.highResponse * 0.7 }; // 고무 밑창이 고역을 깎음
  impact(ctx, r.out, rng, sole, { t, intensity: I * w, size: w, hardness: 0.45, debris: true, gain: 1 });
  impact(ctx, r.out, rng, sole, { t: t + roll, intensity: I * 0.55, size: w * 0.9, hardness: 0.4, debris: false, gain: 0.6 });
  // 단단한 바닥: 신발 끌림 (스커프)
  if (m.noiseRatio < 0.9 && m.debris !== 'crunch') noiseBurst(ctx, r.out, rng, { t: t + roll * 0.5, color: 'white', freq: rng.range(2200, 3800), q: 1.8, gain: 0.12 * I, attack: 0.006, decay: 0.04 });
  // 장비 흔들림 (가끔)
  if (rng.chance(0.4)) rustle(r, t + 0.02, 0.06, 0.05 * I);
  if (rng.chance(0.2)) click(r, t + rng.range(0.03, 0.07), 'steel', 0.05, 0.6);
}

// ───────────────────────── 폭발 ─────────────────────────

function explosion(r: RenderAPI, p: SoundParams): void {
  const { ctx, rng, t } = r;
  const S = p.size === 'small' ? 0.55 : p.size === 'large' ? 1.35 : 1;
  const bus = ctx.createGain();
  const dist = ctx.createWaveShaper();
  dist.curve = distortionCurve(0.35);
  dist.oversample = '4x';
  const lp = filter(ctx, 'lowpass', 9000);
  chain(bus, dist, lp, r.out);
  reverb(ctx, bus, r.out, ENVIRONMENTS.outdoor, 0.45 * S, rng.int(1, 9999));
  // Transient: 초기 충격파 크랙
  noiseBurst(ctx, bus, rng, { t, color: 'white', type: 'highpass', freq: 1200, gain: 1, attack: 0.0005, decay: 0.012 });
  // 저주파 에너지: 깊게 떨어지는 서브 + Tone 멤브레인 킥으로 압력감
  sub(ctx, bus, t, 90 * (1.2 - S * 0.2), 24, 0.9 * S, 1);
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.08 * S, octaves: 5, envelope: { attack: 0.001, decay: 0.6 * S, sustain: 0, release: 0.2 } });
  kick.volume.value = -4;
  kick.connect(bus as unknown as Tone.InputNode);
  kick.triggerAttackRelease(38 / S, 0.4 * S, t);
  // 광대역 폭발 노이즈: 높은 대역에서 시작해 무겁게 가라앉음
  noiseBurst(ctx, bus, rng, { t, color: 'pink', type: 'lowpass', freq: 7000, freqEnd: 260, q: 0.7, gain: 0.9, attack: 0.002, hold: 0.04 * S, decay: 1.1 * S });
  // 공기 파열·잔향: 브라운 노이즈 저역 우르릉
  noiseBurst(ctx, bus, rng, { t: t + 0.03, color: 'brown', type: 'lowpass', freq: 400, freqEnd: 90, q: 0.7, gain: 0.8, attack: 0.05, decay: 2.2 * S });
  // 파편: 떨어지는 자갈·금속 조각
  noiseBurst(ctx, bus, rng, { t, color: 'pink', freq: 1600, freqEnd: 600, q: 0.9, gain: 0.6, attack: 0.001, decay: 0.35 * S });
  grains(ctx, r.out, rng, { t: t + 0.12, dur: 1.6 * S, count: Math.round(110 * S), source: 'noise', freq: [1200, 6000], q: 2, grainDur: [0.003, 0.014], gain: 0.4, shape: 'decay' });
  debris(ctx, r.out, rng, MATERIALS.iron, t + 0.4, 0.3);
}

// ───────────────────────── 능력 / SF ─────────────────────────

function smoke(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  click(r, t, 'iron', 0.5, 0.6); // 깡통 터지는 소리
  noiseBurst(ctx, r.out, rng, { t, color: 'white', type: 'highpass', freq: 1500, gain: 0.6, attack: 0.001, decay: 0.04 });
  // 가스 분출 쉬익: 랜덤 진폭 변조된 고역 노이즈
  const src = ctx.createGain();
  noiseBurst(ctx, src, rng, { t: t + 0.03, color: 'white', freq: 4500, q: 0.7, gain: 0.6, attack: 0.08, hold: 0.6, decay: 0.8 });
  noiseBurst(ctx, src, rng, { t: t + 0.03, color: 'pink', freq: 1400, q: 0.8, gain: 0.35, attack: 0.15, hold: 0.4, decay: 0.9 });
  const am = ctx.createGain();
  am.gain.value = 1;
  for (let i = 0; i < 24; i++) am.gain.setValueAtTime(rng.range(0.6, 1), t + 0.05 + i * 0.06);
  src.connect(am).connect(r.out);
}

function wallUp(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  // 에너지 상승 (Tone FM 신스: 활공하며 변조 지수 증가)
  const synth = new Tone.FMSynth({ harmonicity: 1.5, modulationIndex: 6, envelope: { attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.3 }, modulationEnvelope: { attack: 0.2, decay: 0.2, sustain: 0.8, release: 0.3 } });
  synth.volume.value = -10;
  synth.connect(r.out as unknown as Tone.InputNode);
  synth.triggerAttackRelease(80, 0.5, t);
  synth.frequency.exponentialRampTo(220, 0.45, t);
  // 지면이 갈라지는 마찰 + 결정이 솟는 유리 공진
  grains(ctx, r.out, rng, { t, dur: 0.45, count: 50, source: 'noise', freq: [250, 1400], q: 1.5, grainDur: [0.006, 0.02], gain: 0.25, shape: 'rise' });
  modal(ctx, r.out, rng, { ...MATERIALS.glass, resonance: 1500, decay: 0.7 }, t + 0.45, 0.25);
  impact(ctx, r.out, rng, MATERIALS.stone, { t: t + 0.44, intensity: 0.9, size: 1.6, hardness: 0.8 });
}

function beacon(r: RenderAPI): void {
  const { ctx, t } = r;
  // 소나 핑: FM 벨 + 짧게 상승하는 사인
  fm(ctx, r.out, t, { carrier: r.rng.cents(1180, 40), ratio: r.rng.jitter(3.5, 0.03), index: 3, indexEnd: 0.3, gain: 0.35, attack: 0.002, decay: r.rng.jitter(0.45, 0.1) });
  tone(ctx, r.out, t, { freq: r.rng.cents(900, 60), freqEnd: 1600, pitchTime: 0.08, gain: 0.15, decay: 0.12 });
}

function zoneIgnite(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  // 점화: 상승하는 화염 숨소리 + 저역 압력
  noiseBurst(ctx, r.out, rng, { t, color: 'pink', freq: 300, freqEnd: 1800, q: 0.9, gain: 0.8, attack: 0.12, decay: 0.5 });
  sub(ctx, r.out, t, 90, 45, 0.4, 0.5);
  // 불꽃 튀는 소리: 날카로운 클릭 입자
  grains(ctx, r.out, rng, { t: t + 0.1, dur: 0.9, count: 45, source: 'click', freq: [1500, 6500], q: 9, grainDur: [0.001, 0.004], gain: 0.35, shape: 'flat' });
  noiseBurst(ctx, r.out, rng, { t: t + 0.1, color: 'brown', type: 'lowpass', freq: 700, gain: 0.35, attack: 0.1, hold: 0.4, decay: 0.4 });
}

function flarePop(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  noiseBurst(ctx, r.out, rng, { t, color: 'white', type: 'highpass', freq: 800, gain: 1, attack: 0.0004, decay: 0.03 });
  sub(ctx, r.out, t, 160, 60, 0.12, 0.6);
  // 고역 링 (두 사인의 맥놀이) — 귀가 멍한 느낌
  tone(ctx, r.out, t + 0.01, { freq: 3850, gain: 0.12, attack: 0.01, decay: 0.7 });
  tone(ctx, r.out, t + 0.01, { freq: 3912, gain: 0.1, attack: 0.01, decay: 0.7 });
  grains(ctx, r.out, rng, { t: t + 0.02, dur: 0.3, count: 25, source: 'click', freq: [3000, 8000], q: 8, grainDur: [0.001, 0.003], gain: 0.25, shape: 'decay' });
}

function dash(r: RenderAPI): void {
  const { ctx, t } = r;
  whoosh(r, t, 0.3, 2200, 0.7);
  fm(ctx, r.out, t, { carrier: 300, carrierEnd: 1200, ratio: 2.01, index: 4, indexEnd: 1, gain: 0.25, attack: 0.01, decay: 0.22 });
}

function energyCharge(r: RenderAPI, p: SoundParams): void {
  const { ctx, rng, t } = r;
  const D = Math.max(0.4, Math.min(4, p.duration ?? 0.9));
  const I = p.intensity ?? 0.8;
  const synth = new Tone.FMSynth({ harmonicity: 2.01, modulationIndex: 2, envelope: { attack: D * 0.6, decay: 0.1, sustain: 1, release: 0.25 } });
  synth.volume.value = -9;
  synth.connect(r.out as unknown as Tone.InputNode);
  synth.triggerAttackRelease(150, D, t);
  synth.frequency.exponentialRampTo(150 + 800 * I, D, t);
  synth.modulationIndex.linearRampTo(12 * I, D, t);
  // 모여드는 에너지 입자
  grains(ctx, r.out, rng, { t, dur: D, count: Math.round(70 * D), source: 'sine', freq: [1200, 5000], grainDur: [0.01, 0.04], gain: 0.08 * I, shape: 'rise', fade: false });
  noiseBurst(ctx, r.out, rng, { t, color: 'white', freq: 1500, freqEnd: 7000, q: 3, gain: 0.15 * I, attack: D * 0.9, decay: 0.15 });
}

function abilityThrow(r: RenderAPI): void {
  whoosh(r, r.t, 0.22, 1400, 0.6);
  rustle(r, r.t, 0.1, 0.08);
}

// ───────────────────────── Core / UI / 알림 ─────────────────────────

function coreBeep(r: RenderAPI): void {
  const { ctx, t } = r;
  const g = ctx.createGain();
  const bp = filter(ctx, 'bandpass', 2100, 3);
  envelope(g.gain, t, 0.7, 0.002, 0.05, 0.03);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = 2100;
  o.connect(bp).connect(g).connect(r.out);
  o.start(t);
  o.stop(t + 0.12);
  click(r, t, 'polymer', 0.06, 0.3);
}

function planted(r: RenderAPI): void {
  const { ctx, t } = r;
  click(r, t, 'iron', 0.9, 0.8); // 장치 고정 쿵
  sub(ctx, r.out, t, 120, 55, 0.15, 0.6);
  const s = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.08 } });
  s.volume.value = -16;
  s.connect(r.out as unknown as Tone.InputNode);
  ['A5', 'E6', 'A6'].forEach((n, i) => s.triggerAttackRelease(n, 0.08, t + 0.18 + i * 0.12));
  // 무장 완료 웅웅거림
  fm(ctx, r.out, t + 0.5, { carrier: 110, ratio: 1.5, index: 2, gain: 0.15, attack: 0.05, decay: 0.5 });
}

function plantStart(r: RenderAPI): void {
  click(r, r.t, 'polymer', 0.4, 0.5);
  fm(r.ctx, r.out, r.t, { carrier: 600, carrierEnd: 1500, ratio: 1.5, index: 1.5, gain: 0.25, decay: 0.2 });
}

function defused(r: RenderAPI): void {
  const { ctx, t } = r;
  fm(ctx, r.out, t, { carrier: 1300, carrierEnd: 90, ratio: 0.5, index: 3, indexEnd: 0.2, gain: 0.35, attack: 0.005, decay: 0.7 });
  click(r, t + 0.05, 'steel', 0.4, 0.5); // 릴레이 끊김
  click(r, t + 0.12, 'steel', 0.3, 0.45);
}

function hurt(r: RenderAPI): void {
  const { ctx, rng, t } = r;
  noiseBurst(ctx, r.out, rng, { t, color: 'brown', type: 'lowpass', freq: 600, gain: 0.3, attack: 0.002, decay: 0.1 });
  noiseBurst(ctx, r.out, rng, { t, color: 'pink', freq: 950, q: 1, gain: 1.1, attack: 0.001, decay: 0.06 });
  sub(ctx, r.out, t, 110, 60, 0.07, 0.18);
  // 짧은 이명
  tone(ctx, r.out, t + 0.01, { freq: rng.cents(3400, 30), gain: 0.04, attack: 0.02, decay: 0.35 });
}

function killConfirm(r: RenderAPI): void {
  const s = new Tone.FMSynth({ harmonicity: 3, modulationIndex: 4, envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.1 } });
  s.volume.value = -12;
  s.connect(r.out as unknown as Tone.InputNode);
  s.triggerAttackRelease('E6', 0.08, r.t);
  s.triggerAttackRelease('B6', 0.12, r.t + 0.08);
  sub(r.ctx, r.out, r.t, 120, 60, 0.12, 0.3);
}

function stinger(r: RenderAPI, notes: string[][], spacing: number, type: OscillatorType, cutoff: number): void {
  const lp = new Tone.Filter(cutoff, 'lowpass');
  lp.connect(r.out as unknown as Tone.InputNode);
  const poly = new Tone.PolySynth(Tone.Synth, { oscillator: { type: type as 'sawtooth' }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.5 } });
  poly.volume.value = -18;
  poly.connect(lp);
  notes.forEach((chord, i) => poly.triggerAttackRelease(chord, spacing * 1.2, r.t + i * spacing));
}

function uiTick(r: RenderAPI): void {
  click(r, r.t, 'polymer', 0.4, 0.25);
}

// ───────────────────────── 레지스트리 ─────────────────────────

const S = (d: SoundDef) => d;

export const SOUNDS: Record<string, SoundDef> = {
  gunshot: S({ bus: 'weapons', duration: () => 0.95, variants: 4, keys: ['caliber'], peakDb: -1.5, maxVoices: 10, priority: 9, variation: { pitchCents: 45 }, render: gunshot }),
  mechanism: S({ bus: 'foley', duration: () => 0.45, variants: 2, keys: ['kind'], peakDb: -9, maxVoices: 4, priority: 5, render: mechanism }),
  impact: S({ bus: 'world', duration: (p) => (material(p.material).debris === 'shard' ? 0.9 : 0.55), variants: 4, keys: ['material', 'intensity'], peakDb: -7, maxVoices: 12, priority: 4, render: bulletImpact }),
  metal_impact: S({ bus: 'world', duration: () => 1.2, variants: 4, keys: ['material', 'intensity'], peakDb: -5, maxVoices: 8, priority: 4, render: (r, p) => impact(r.ctx, r.out, r.rng, material(p.material, 'steel'), { t: r.t, intensity: p.intensity ?? 0.9, size: 1.2, debris: true }) }),
  hit_body: S({ bus: 'world', duration: () => 0.25, variants: 4, keys: [], peakDb: -5, maxVoices: 6, priority: 7, render: bodyHit }),
  hit_head: S({ bus: 'world', duration: () => 0.55, variants: 3, keys: [], peakDb: -3, maxVoices: 4, priority: 8, render: headHit }),
  footstep: S({ bus: 'foley', duration: () => 0.3, variants: 5, keys: ['material', 'weight', 'intensity'], peakDb: -12, maxVoices: 8, priority: 3, variation: { pitchCents: 60, gainDb: 2 }, render: footstep }),
  explosion: S({ bus: 'world', duration: (p) => (p.size === 'large' ? 4.5 : p.size === 'small' ? 2.2 : 3.4), variants: 2, keys: ['size'], peakDb: -0.5, maxVoices: 2, priority: 10, render: explosion }),
  knife: S({ bus: 'weapons', duration: () => 0.3, variants: 4, keys: [], peakDb: -8, maxVoices: 3, priority: 5, render: (r) => whoosh(r, r.t, 0.2, 2400, 0.8) }),
  ability: S({ bus: 'abilities', duration: () => 0.3, variants: 3, keys: [], peakDb: -9, maxVoices: 4, priority: 5, render: abilityThrow }),
  smoke: S({ bus: 'abilities', duration: () => 1.8, variants: 2, keys: [], peakDb: -6, maxVoices: 3, priority: 6, render: smoke }),
  wall_up: S({ bus: 'abilities', duration: () => 1.4, variants: 2, keys: [], peakDb: -4, maxVoices: 2, priority: 6, render: wallUp }),
  beacon: S({ bus: 'abilities', duration: () => 0.6, variants: 2, keys: [], peakDb: -9, maxVoices: 3, priority: 5, render: beacon }),
  zone: S({ bus: 'abilities', duration: () => 1.3, variants: 2, keys: [], peakDb: -5, maxVoices: 3, priority: 6, render: zoneIgnite }),
  flare: S({ bus: 'abilities', duration: () => 0.9, variants: 2, keys: [], peakDb: -2, maxVoices: 2, priority: 7, render: flarePop }),
  dash: S({ bus: 'abilities', duration: () => 0.45, variants: 3, keys: [], peakDb: -6, maxVoices: 2, priority: 6, render: dash }),
  magic_charge: S({ bus: 'abilities', duration: (p) => Math.max(0.4, Math.min(4, p.duration ?? 0.9)) + 0.4, variants: 2, keys: ['duration', 'intensity'], peakDb: -5, maxVoices: 2, priority: 6, render: energyCharge }),
  beep: S({ bus: 'world', duration: () => 0.2, variants: 1, keys: [], peakDb: -8, maxVoices: 2, priority: 8, variation: { pitchCents: 0, gainDb: 0 }, render: coreBeep }),
  plant_start: S({ bus: 'world', duration: () => 0.35, variants: 1, keys: [], peakDb: -9, maxVoices: 2, priority: 7, render: plantStart }),
  planted: S({ bus: 'world', duration: () => 1.3, variants: 1, keys: [], peakDb: -4, maxVoices: 1, priority: 9, variation: { pitchCents: 0 }, render: planted }),
  defused: S({ bus: 'world', duration: () => 1.1, variants: 1, keys: [], peakDb: -4, maxVoices: 1, priority: 9, variation: { pitchCents: 0 }, render: defused }),
  hurt: S({ bus: 'ui', duration: () => 0.5, variants: 3, keys: [], peakDb: -6, maxVoices: 2, priority: 8, spatial: false, render: hurt }),
  kill: S({ bus: 'ui', duration: () => 0.5, variants: 1, keys: [], peakDb: -7, maxVoices: 2, priority: 8, spatial: false, variation: { pitchCents: 0 }, render: killConfirm }),
  ui: S({ bus: 'ui', duration: () => 0.12, variants: 2, keys: [], peakDb: -14, maxVoices: 3, priority: 2, spatial: false, render: uiTick }),
  round_start: S({ bus: 'ui', duration: () => 1.3, variants: 1, keys: [], peakDb: -8, maxVoices: 1, priority: 9, spatial: false, variation: { pitchCents: 0 },
    render: (r) => stinger(r, [['A3', 'E4'], ['A3', 'E4', 'A4']], 0.22, 'sawtooth', 2400) }),
  round_win: S({ bus: 'ui', duration: () => 2, variants: 1, keys: [], peakDb: -6, maxVoices: 1, priority: 9, spatial: false, variation: { pitchCents: 0 },
    render: (r) => stinger(r, [['C4', 'E4', 'G4'], ['D4', 'F#4', 'A4'], ['G4', 'B4', 'D5', 'G5']], 0.18, 'sawtooth', 3200) }),
  round_lose: S({ bus: 'ui', duration: () => 2, variants: 1, keys: [], peakDb: -6, maxVoices: 1, priority: 9, spatial: false, variation: { pitchCents: 0 },
    render: (r) => stinger(r, [['A3', 'C4', 'E4'], ['F3', 'Ab3', 'C4'], ['D3', 'F3', 'A3']], 0.24, 'triangle', 1600) }),
};
