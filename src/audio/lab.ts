import { analyze, AudioEngine, drawSpectrogram, similarity, type SoundMetrics, type SoundParams } from './engine';
import { LAB_SET } from './soundSet';

/**
 * 오디오 랩: 모든 효과음을 렌더링해 측정값·스펙트로그램을 보여 주고 재생해 본다.
 * 자동 검수 결과는 window.__audioLab 에 담긴다 (Playwright 테스트용).
 */

interface LabResult {
  label: string;
  name: string;
  params: SoundParams;
  metrics: SoundMetrics;
  /** 변형본 사이 최대 상관 */
  maxSimilarity: number;
  issues: string[];
}

const engine = new AudioEngine();
const grid = document.getElementById('grid')!;
const status = document.getElementById('status')!;
const results: LabResult[] = [];
(window as unknown as { __audioLab: unknown }).__audioLab = { engine, results, done: false };

/** 물리적으로 저역이 대부분인 소리 (폭발, 산탄총 총구 폭발) */
const LOW_HEAVY = /explosion|shotgun|rubber/;

function check(label: string, m: SoundMetrics, sim: number): string[] {
  const issues: string[] = [];
  if (m.clipped > 0) issues.push(`클리핑 ${m.clipped}샘플`);
  if (m.peakDb > -0.3) issues.push('피크 과다');
  if (m.startLevel > 0.02) issues.push('시작 클릭');
  if (m.endLevel > 0.002) issues.push('끝 잘림');
  if (m.bands.low > (LOW_HEAVY.test(label) ? 0.95 : 0.85)) issues.push('저역 과다');
  if (sim > 0.97) issues.push('변형본이 거의 같음');
  return issues;
}

async function run(): Promise<void> {
  await engine.unlock();
  const t0 = performance.now();
  for (const [label, name, params] of LAB_SET) {
    const bufs = await engine.generator.ensure(name, params);
    const m = analyze(bufs[0]);
    let sim = 0;
    for (let i = 1; i < bufs.length; i++) sim = Math.max(sim, similarity(bufs[0], bufs[i]));
    const issues = check(label, m, sim);
    results.push({ label, name, params, metrics: m, maxSimilarity: sim, issues });

    const card = document.createElement('div');
    card.className = 'card' + (issues.length ? ' fail' : '');
    card.dataset.label = label;
    card.innerHTML = `<h3><span>${label}</span><button>▶ 재생</button></h3><canvas width="640" height="180"></canvas>
      <dl>
        <dt>길이</dt><dd>${m.duration.toFixed(2)}s</dd><dt>피크</dt><dd>${m.peakDb.toFixed(1)} dB</dd>
        <dt>RMS</dt><dd>${m.rmsDb.toFixed(1)} dB</dd><dt>크레스트</dt><dd>${m.crestDb.toFixed(1)} dB</dd>
        <dt>중심</dt><dd>${Math.round(m.centroid)} Hz</dd><dt>어택</dt><dd>${m.attackMs.toFixed(1)} ms</dd>
        <dt>감쇠</dt><dd>${Math.round(m.decayMs)} ms</dd><dt>저/중/고</dt><dd>${(m.bands.low * 100).toFixed(0)}/${(m.bands.mid * 100).toFixed(0)}/${(m.bands.high * 100).toFixed(0)}%</dd>
        <dt>변형 상관</dt><dd>${sim.toFixed(2)}</dd><dt>문제</dt><dd class="${issues.length ? 'warn' : ''}">${issues.join(', ') || '없음'}</dd>
      </dl>`;
    drawSpectrogram(card.querySelector('canvas')!, bufs[0]);
    card.querySelector('button')!.addEventListener('click', () => engine.play(name, params));
    grid.appendChild(card);
    status.textContent = `렌더링 ${results.length}/${LAB_SET.length}…`;
  }
  const ms = performance.now() - t0;
  const bad = results.filter((r) => r.issues.length).length;
  status.textContent = `완료: ${results.length}종 · 버퍼 ${engine.generator.size}개 · 렌더링 ${Math.round(ms)}ms · 문제 ${bad}건`;
  Object.assign((window as unknown as { __audioLab: object }).__audioLab, { done: true, ms, buffers: engine.generator.size });
}

document.getElementById('start')!.addEventListener('click', () => void run(), { once: true });
