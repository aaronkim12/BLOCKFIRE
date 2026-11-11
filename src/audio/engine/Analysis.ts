/**
 * 품질 검수용 분석 (매뉴얼 13장).
 * 렌더링된 버퍼의 파형·스펙트럼을 수치로 측정한다:
 *   피크/클리핑, RMS, 크레스트 팩터, 스펙트럼 중심(밝기), 대역별 에너지, 어택 시간,
 *   -40dB까지의 감쇠 시간, 시작/끝 레벨(클릭 여부), 변형본 사이 상관(반복감)
 */

export interface SoundMetrics {
  duration: number;
  peakDb: number;
  clipped: number;
  rmsDb: number;
  crestDb: number;
  /** 스펙트럼 중심 (Hz) — 클수록 밝은 소리 */
  centroid: number;
  /** 대역 에너지 비율: 저역(<250) / 중역 / 고역(>4k) */
  bands: { low: number; mid: number; high: number };
  /** 피크의 10% → 90%에 도달하는 시간 (ms) */
  attackMs: number;
  /** 피크 이후 -40dB 아래로 떨어지는 시간 (ms) */
  decayMs: number;
  /** 첫/마지막 샘플 크기 (클릭 검사) */
  startLevel: number;
  endLevel: number;
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));

/** 반복 FFT (radix-2, 제자리) */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** 프레임별 크기 스펙트럼 (Hann 창) */
export function spectrogram(d: Float32Array, size = 1024, hop = 256): Float32Array[] {
  const frames: Float32Array[] = [];
  const win = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  for (let s = 0; s + size <= d.length; s += hop) {
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    for (let i = 0; i < size; i++) re[i] = d[s + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    frames.push(mag);
  }
  return frames;
}

export function analyze(buf: AudioBuffer): SoundMetrics {
  const d = buf.getChannelData(0);
  const sr = buf.sampleRate;
  let peak = 0;
  let peakIdx = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) {
      peak = a;
      peakIdx = i;
    }
    if (a >= 0.999) clipped++;
    sum += d[i] * d[i];
  }
  // 소리가 있는 구간(-50dB 위)만으로 RMS
  let active = 0;
  let activeSum = 0;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > peak * 0.003) {
      active++;
      activeSum += d[i] * d[i];
    }
  }
  const rms = Math.sqrt(activeSum / Math.max(1, active));
  void sum;
  // 어택: 10% → 90% (포락선 = 5ms 이동 최대값)
  let t10 = -1;
  let t90 = -1;
  for (let i = 0; i <= peakIdx; i++) {
    const a = Math.abs(d[i]);
    if (t10 < 0 && a >= peak * 0.1) t10 = i;
    if (t90 < 0 && a >= peak * 0.9) {
      t90 = i;
      break;
    }
  }
  // 감쇠: 피크 이후 10ms 창 RMS가 -40dB 아래로 내려가는 시점
  const w = Math.floor(0.01 * sr);
  let decayIdx = d.length;
  for (let s = peakIdx; s + w < d.length; s += w) {
    let e = 0;
    for (let i = 0; i < w; i++) e += d[s + i] * d[s + i];
    if (Math.sqrt(e / w) < peak * 0.01) {
      decayIdx = s;
      break;
    }
  }
  // 스펙트럼: 프레임 합산
  const frames = spectrogram(d, 2048, 1024);
  const total = new Float32Array(1024);
  for (const f of frames) for (let i = 0; i < f.length; i++) total[i] += f[i] * f[i];
  let num = 0;
  let den = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let i = 1; i < total.length; i++) {
    const hz = (i * sr) / 2048;
    num += hz * total[i];
    den += total[i];
    if (hz < 250) low += total[i];
    else if (hz < 4000) mid += total[i];
    else high += total[i];
  }
  const e = low + mid + high || 1;
  return {
    duration: d.length / sr,
    peakDb: db(peak),
    clipped,
    rmsDb: db(rms),
    crestDb: db(peak) - db(rms),
    centroid: den > 0 ? num / den : 0,
    bands: { low: low / e, mid: mid / e, high: high / e },
    attackMs: t10 >= 0 && t90 >= 0 ? ((t90 - t10) / sr) * 1000 : 0,
    decayMs: ((decayIdx - peakIdx) / sr) * 1000,
    startLevel: Math.abs(d[0]),
    endLevel: Math.abs(d[d.length - 1]),
  };
}

/** 두 변형본의 정규화 상관 (1에 가까울수록 똑같이 들림) */
export function similarity(a: AudioBuffer, b: AudioBuffer): number {
  const x = a.getChannelData(0);
  const y = b.getChannelData(0);
  const n = Math.min(x.length, y.length);
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < n; i++) {
    xy += x[i] * y[i];
    xx += x[i] * x[i];
    yy += y[i] * y[i];
  }
  return xy / Math.sqrt(xx * yy || 1);
}

/** 스펙트로그램을 캔버스에 그린다 (로그 주파수 축, dB 색상) */
export function drawSpectrogram(canvas: HTMLCanvasElement, buf: AudioBuffer): void {
  const g = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const sr = buf.sampleRate;
  const frames = spectrogram(buf.getChannelData(0), 1024, 128);
  const img = g.createImageData(W, H);
  const fMin = 30;
  const fMax = sr / 2;
  for (let x = 0; x < W; x++) {
    const f = frames[Math.min(frames.length - 1, Math.floor((x / W) * frames.length))];
    if (!f) continue;
    for (let y = 0; y < H; y++) {
      const hz = fMin * Math.pow(fMax / fMin, 1 - y / H);
      const bin = Math.min(f.length - 1, Math.round((hz / sr) * 1024));
      const v = Math.max(0, Math.min(1, (db(f[bin]) + 70) / 70));
      const i = (y * W + x) * 4;
      // 어두운 남색 → 주황 → 흰색
      img.data[i] = Math.min(255, v * 400);
      img.data[i + 1] = Math.min(255, Math.max(0, v - 0.35) * 380);
      img.data[i + 2] = Math.min(255, 40 + Math.max(0, v - 0.75) * 800);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // 파형 겹쳐 그리기
  const d = buf.getChannelData(0);
  g.strokeStyle = 'rgba(120, 220, 255, 0.7)';
  g.beginPath();
  for (let x = 0; x < W; x++) {
    let m = 0;
    const s0 = Math.floor((x / W) * d.length);
    const s1 = Math.floor(((x + 1) / W) * d.length);
    for (let i = s0; i < s1; i++) m = Math.max(m, Math.abs(d[i]));
    g.moveTo(x, H / 2 - (m * H) / 2.2);
    g.lineTo(x, H / 2 + (m * H) / 2.2);
  }
  g.stroke();
}
