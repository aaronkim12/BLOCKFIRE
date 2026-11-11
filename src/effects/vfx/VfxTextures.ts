import * as THREE from 'three';

/**
 * VFX용 절차적 텍스처 (CanvasTexture, 외부 이미지 없음).
 *
 * 파티클 아틀라스 (4×4, 칸당 128px)
 *   0-5   연기 덩어리: fBm 노이즈 + 부드러운 알파 마스크, 위쪽에서 빛을 받은 음영 (외곽이 원으로 보이지 않게 불규칙)
 *   6-7   먼지: 옅고 찢어진 연기
 *   8-11  불꽃 혀: 위로 갈수록 가늘어지는 노이즈 불꽃
 *   12    부드러운 빛 (glow)
 *   13    불똥/예광 줄무늬 (머리가 밝고 꼬리로 갈수록 사라짐)
 *   14-15 파편 조각 (불규칙 다각형, 면 음영)
 */

export const FRAME = {
  smoke: [0, 1, 2, 3, 4, 5],
  dust: [6, 7],
  flame: [8, 9, 10, 11],
  glow: 12,
  streak: 13,
  chunk: [14, 15],
} as const;

const CELL = 128;
const GRID = 4;

// ── 값 노이즈 / fBm ──────────────────────────────────────────
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

export function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise(x * f, y * f, seed + i * 17);
    f *= 2.03;
    amp *= 0.5;
  }
  return v / (1 - Math.pow(0.5, octaves));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

type CellFn = (u: number, v: number) => [number, number]; // [밝기, 알파], u,v ∈ [-1,1]

function paintCell(img: ImageData, frame: number, fn: CellFn): void {
  const ox = (frame % GRID) * CELL;
  const oy = Math.floor(frame / GRID) * CELL;
  const W = img.width;
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const u = ((x + 0.5) / CELL) * 2 - 1;
      const v = ((y + 0.5) / CELL) * 2 - 1;
      const [l, a] = fn(u, v);
      const i = ((oy + y) * W + ox + x) * 4;
      const c = Math.round(clamp01(l) * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = Math.round(clamp01(a) * 255);
    }
}

/** 덩어리 몸체 (부드러운 구름 실루엣) */
function smokeBody(u: number, v: number, seed: number): number {
  let body = 0;
  for (let k = 0; k < 4; k++) {
    const ang = hash(k, 1, seed) * Math.PI * 2;
    const rr = 0.18 + hash(k, 2, seed) * 0.22;
    const d = Math.hypot(u - Math.cos(ang) * rr, v - Math.sin(ang) * rr * 0.8) / (0.42 + hash(k, 3, seed) * 0.22);
    body = Math.max(body, 1 - smoothstep(0.3, 1, d));
  }
  return body;
}

/**
 * 연기 밀도: 몸체는 꽉 차 있고, 노이즈(도메인 워프 fBm)는 가장자리만 깎아 낸다.
 * (안쪽까지 노이즈로 깎으면 덩어리에 구멍이 뚫려 얼룩처럼 보인다)
 */
function smokeDensity(u: number, v: number, seed: number, wispy: boolean): number {
  const body = smokeBody(u, v, seed);
  const wx = fbm(u * 2.2 + 3.1, v * 2.2, seed + 5, 3) - 0.5;
  const wy = fbm(u * 2.2, v * 2.2 + 7.7, seed + 9, 3) - 0.5;
  const n = fbm((u + wx * 0.6) * 3.2, (v + wy * 0.6) * 3.2, seed, 5);
  const fade = 1 - smoothstep(0.62, 0.98, Math.hypot(u, v)); // 칸 경계에서 반드시 0
  if (wispy) return clamp01(body * smoothstep(0.32, 0.8, n) * fade * 1.1);
  const edgeW = 0.3 + 0.7 * (1 - body);
  const d = body * 1.3 - 0.3 + (n - 0.5) * 1.1 * edgeW;
  return clamp01(smoothstep(0, 0.55, d) * fade);
}

function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL * GRID;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(canvas.width, canvas.height);

  // 연기: 방향 없는 음영만 굽는다 (빛 방향은 셰이더가 화면 기준으로 줌 → 입자가 회전해도 항상 위에서 빛을 받음)
  //  - 얇은 가장자리는 빛이 투과해 밝고, 두꺼운 안쪽은 약간 어두움 + 잔잔한 노이즈 결
  const shadeSmoke = (seed: number, wispy: boolean): CellFn => (u, v) => {
    const d = smokeDensity(u, v, seed, wispy);
    if (d <= 0.001) return [0, 0];
    const detail = fbm(u * 5 + 11, v * 5, seed + 21, 3);
    const thick = smokeBody(u, v, seed);
    const l = 0.86 - thick * 0.16 + (detail - 0.5) * 0.22 + (1 - d) * 0.12;
    return [l + (wispy ? 0.06 : 0), d];
  };
  FRAME.smoke.forEach((f, i) => paintCell(img, f, shadeSmoke(101 + i * 31, false)));
  FRAME.dust.forEach((f, i) => paintCell(img, f, shadeSmoke(401 + i * 53, true)));

  // 불꽃 혀: 아래가 넓고 위로 가늘어짐, 위쪽 노이즈로 흔들림
  FRAME.flame.forEach((f, i) =>
    paintCell(img, f, (u, v) => {
      const seed = 701 + i * 13;
      const h = (1 - v) * 0.5; // 0 바닥 → 1 꼭대기
      const wob = (fbm(h * 3 + i, i * 2.1, seed, 3) - 0.5) * 0.5 * h;
      const width = 0.62 * (1 - h) ** 0.8 + 0.04;
      const x = Math.abs(u - wob) / width;
      const n = fbm(u * 3 + i, v * 2.5 - i, seed + 3, 4);
      // 아래·옆·위 모두 칸 경계 전에 0이 되도록 (사각형 테두리가 보이지 않게)
      const border = 1 - smoothstep(0.8, 0.97, Math.max(Math.abs(u), Math.abs(v)));
      const shape = (1 - smoothstep(0.35, 1, x)) * smoothstep(0.02, 0.22, h) * (1 - smoothstep(0.7, 0.95, h)) * border;
      const a = clamp01(shape * smoothstep(0.25, 0.65, n + (1 - h) * 0.35));
      const core = clamp01(1 - x * 1.3) * (1 - h);
      return [0.55 + 0.45 * core, a];
    }),
  );

  // 부드러운 빛
  paintCell(img, FRAME.glow, (u, v) => {
    const r = Math.hypot(u, v);
    const a = Math.exp(-r * r * 5.5) * (1 - smoothstep(0.8, 1, r));
    return [1, a];
  });

  // 줄무늬: 가로는 가우시안, 세로는 머리(위)가 밝고 꼬리(아래)로 사라짐
  paintCell(img, FRAME.streak, (u, v) => {
    const head = (1 - v) * 0.5; // 1 = 머리
    const across = Math.exp(-u * u * 9);
    const along = smoothstep(0, 0.85, head) * (1 - smoothstep(0.93, 1, head));
    return [0.75 + 0.25 * across, across * along];
  });
  ctx.putImageData(img, 0, 0);

  // 파편: 불규칙 다각형 + 면 음영 (캔버스 경로로 그림)
  FRAME.chunk.forEach((f, i) => {
    const ox = (f % GRID) * CELL + CELL / 2;
    const oy = Math.floor(f / GRID) * CELL + CELL / 2;
    const pts: [number, number][] = [];
    const n = 5 + i;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + hash(k, 9, i) * 0.6;
      const r = CELL * (0.22 + hash(k, 4, i + 3) * 0.2);
      pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
    for (let k = 0; k < n; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % n];
      const shade = 120 + Math.round(hash(k, 7, i) * 135);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.beginPath();
      ctx.moveTo(ox + (hash(i, 1, 5) - 0.5) * 10, oy + (hash(i, 2, 5) - 0.5) * 10);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fill();
    }
  });
  return canvas;
}

let atlas: THREE.CanvasTexture | null = null;

export function particleAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  atlas = new THREE.CanvasTexture(buildAtlas());
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.anisotropy = 1;
  return atlas;
}

// ── 탄흔 데칼 (재질별 4종, 2×2 아틀라스, 칸당 64px) ─────────────
export const DECAL = { concrete: 0, wood: 1, metal: 2, dirt: 3 } as const;

let decals: THREE.CanvasTexture | null = null;

export function decalAtlas(): THREE.CanvasTexture {
  if (decals) return decals;
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S * 2;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(S * 2, S * 2);
  const paint = (cell: number, fn: (u: number, v: number) => [number, number, number, number]) => {
    const ox = (cell % 2) * S;
    const oy = Math.floor(cell / 2) * S;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = ((x + 0.5) / S) * 2 - 1;
        const v = ((y + 0.5) / S) * 2 - 1;
        const [r, g, b, a] = fn(u, v);
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = Math.round(clamp01(a) * 255);
      }
  };
  const ang = (u: number, v: number) => Math.atan2(v, u);
  // 콘크리트: 깊은 구멍 + 깨진 테두리 + 방사형 균열 + 그을음
  paint(DECAL.concrete, (u, v) => {
    const r = Math.hypot(u, v);
    const n = fbm(u * 6, v * 6, 11, 4);
    const crack = Math.pow(Math.abs(Math.sin(ang(u, v) * 5 + n * 3)), 40) * (1 - smoothstep(0.3, 0.9, r));
    const hole = 1 - smoothstep(0.14, 0.2 + n * 0.08, r);
    const rim = (1 - smoothstep(0.2, 0.42 + n * 0.12, r)) - hole;
    const soot = (1 - smoothstep(0.3, 0.85, r + n * 0.2)) * 0.45;
    const l = hole ? 14 : rim > 0.1 ? 150 + n * 60 : 40;
    return [l, l * 0.97, l * 0.93, Math.max(hole, rim * 0.9, crack * 0.8, soot)];
  });
  // 나무: 결 방향으로 찢긴 구멍
  paint(DECAL.wood, (u, v) => {
    const r = Math.hypot(u * 0.75, v * 1.5);
    const n = fbm(u * 2, v * 12, 23, 4);
    const hole = 1 - smoothstep(0.12, 0.2, r);
    const tear = (1 - smoothstep(0.15, 0.55, Math.hypot(u * 0.45, v * 2.2) + n * 0.15)) * 0.8;
    const l = hole ? 20 : 120 + n * 70;
    return [l, l * 0.78, l * 0.52, Math.max(hole, tear)];
  });
  // 금속: 움푹 팬 자국 + 밝게 벗겨진 테두리
  paint(DECAL.metal, (u, v) => {
    const r = Math.hypot(u, v);
    const n = fbm(u * 8, v * 8, 37, 3);
    const dent = 1 - smoothstep(0.12, 0.22, r);
    const ring = Math.exp(-Math.pow((r - 0.28) / 0.07, 2));
    const scorch = (1 - smoothstep(0.25, 0.75, r + n * 0.15)) * 0.5;
    const l = dent ? 35 : ring > 0.3 ? 220 : 60;
    return [l, l, l * 1.02, Math.max(dent, ring, scorch)];
  });
  // 흙: 흩어진 어두운 구덩이
  paint(DECAL.dirt, (u, v) => {
    const r = Math.hypot(u, v);
    const n = fbm(u * 5, v * 5, 53, 4);
    const pit = 1 - smoothstep(0.2, 0.6 + n * 0.3, r);
    const l = 28 + n * 40;
    return [l, l * 0.85, l * 0.7, pit * smoothstep(0.25, 0.6, n + 0.2)];
  });
  ctx.putImageData(img, 0, 0);
  decals = new THREE.CanvasTexture(canvas);
  decals.colorSpace = THREE.SRGBColorSpace;
  decals.magFilter = THREE.LinearFilter;
  decals.minFilter = THREE.LinearMipmapLinearFilter;
  return decals;
}
