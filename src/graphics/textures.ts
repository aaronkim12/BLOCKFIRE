import * as THREE from 'three';

/**
 * PSX 스타일의 저해상도(32x32) 픽셀 텍스처를 절차적으로 생성한다.
 * 외부 이미지 없이 맵을 구성할 수 있고, 시드가 고정되어 매번 같은 결과가 나온다.
 */

export type TextureName =
  | 'concrete'
  | 'plaster'
  | 'brick'
  | 'metal'
  | 'crate'
  | 'ground'
  | 'tile'
  | 'siteA'
  | 'siteB'
  | 'hazard'
  | 'spawnAtk'
  | 'spawnDef'
  | 'roof'
  | 'stair'
  | 'trim';

const SIZE = 32;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGB = [number, number, number];

class PixelCanvas {
  readonly data = new Uint8ClampedArray(SIZE * SIZE * 4);
  constructor(readonly rand: () => number) {}

  set(x: number, y: number, c: RGB): void {
    x = ((x % SIZE) + SIZE) % SIZE;
    y = ((y % SIZE) + SIZE) % SIZE;
    const i = (y * SIZE + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }

  get(x: number, y: number): RGB {
    const i = (y * SIZE + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  fillNoise(base: RGB, amount: number): void {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) this.set(x, y, shade(base, (this.rand() - 0.5) * amount));
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }

  /** 기존 픽셀을 밝게/어둡게 */
  tint(x: number, y: number, amount: number): void {
    this.set(x, y, shade(this.get(((x % SIZE) + SIZE) % SIZE, ((y % SIZE) + SIZE) % SIZE), amount));
  }

  /** 얼룩 */
  blotches(count: number, radius: number, amount: number): void {
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(this.rand() * SIZE);
      const cy = Math.floor(this.rand() * SIZE);
      const r = 1 + this.rand() * radius;
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++)
          if (x * x + y * y <= r * r && this.rand() > 0.3) this.tint(cx + x, cy + y, amount);
    }
  }
}

function shade(c: RGB, amount: number): RGB {
  return [c[0] + amount, c[1] + amount, c[2] + amount];
}

const painters: Record<TextureName, (p: PixelCanvas) => void> = {
  concrete(p) {
    p.fillNoise([128, 126, 118], 22);
    p.blotches(6, 3, -10);
    // 거푸집 이음새
    for (let x = 0; x < SIZE; x++) p.tint(x, 15, -22);
    for (let y = 0; y < SIZE; y++) p.tint(0, y, -18);
  },
  plaster(p) {
    p.fillNoise([176, 158, 124], 26);
    p.blotches(7, 4, -18);
    p.blotches(4, 2, 14);
    // 세로 패널 이음새 + 아래쪽 때 (위로 갈수록 옅어짐)
    for (let y = 0; y < SIZE; y++) {
      p.tint(0, y, -34);
      p.tint(1, y, 10);
    }
    for (let y = 22; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) if (p.rand() < (y - 21) / 12) p.tint(x, y, -16);
    for (let x = 0; x < SIZE; x++) p.tint(x, SIZE - 1, -40);
  },
  brick(p) {
    p.fillNoise([92, 84, 76], 8); // 줄눈
    for (let row = 0; row < 8; row++) {
      const off = row % 2 === 0 ? 0 : 4;
      for (let col = 0; col < 4; col++) {
        const tone = (p.rand() - 0.5) * 26;
        const base: RGB = [150 + tone, 74 + tone * 0.6, 52 + tone * 0.4];
        for (let y = row * 4; y < row * 4 + 3; y++)
          for (let x = col * 8 + off; x < col * 8 + off + 7; x++)
            p.set(x, y, shade(base, (p.rand() - 0.5) * 16));
      }
    }
  },
  metal(p) {
    p.fillNoise([84, 96, 104], 10);
    for (let i = 0; i < SIZE; i++) {
      p.tint(i, 0, 30);
      p.tint(0, i, 30);
      p.tint(i, SIZE - 1, -30);
      p.tint(SIZE - 1, i, -30);
      p.tint(i, 16, -20);
    }
    for (const [x, y] of [[3, 3], [28, 3], [3, 28], [28, 28], [3, 13], [28, 13], [3, 19], [28, 19]])
      p.set(x, y, [168, 176, 180]);
    p.blotches(3, 2, -16);
  },
  crate(p) {
    p.fillNoise([150, 104, 56], 14);
    // 가로 판자 이음새
    for (let y = 0; y < SIZE; y += 8) for (let x = 0; x < SIZE; x++) p.tint(x, y, -36);
    // 테두리 프레임
    for (let i = 0; i < SIZE; i++)
      for (let k = 0; k < 3; k++) {
        p.set(i, k, [112, 74, 38]);
        p.set(i, SIZE - 1 - k, [112, 74, 38]);
        p.set(k, i, [112, 74, 38]);
        p.set(SIZE - 1 - k, i, [112, 74, 38]);
      }
    // 대각선 보강재
    for (let i = 3; i < SIZE - 3; i++) {
      p.set(i, i, [118, 80, 42]);
      p.set(i + 1, i, [118, 80, 42]);
      p.set(i, i + 1, [92, 60, 30]);
    }
  },
  ground(p) {
    p.fillNoise([104, 98, 84], 26);
    p.blotches(10, 2, -14);
    p.blotches(6, 1, 12);
  },
  tile(p) {
    for (let ty = 0; ty < 2; ty++)
      for (let tx = 0; tx < 2; tx++) {
        const dark = (tx + ty) % 2 === 0;
        const base: RGB = dark ? [118, 116, 108] : [142, 138, 126];
        for (let y = ty * 16; y < ty * 16 + 16; y++)
          for (let x = tx * 16; x < tx * 16 + 16; x++) p.set(x, y, shade(base, (p.rand() - 0.5) * 12));
      }
    for (let i = 0; i < SIZE; i++) {
      p.tint(i, 0, -30);
      p.tint(0, i, -30);
      p.tint(i, 16, -30);
      p.tint(16, i, -30);
    }
  },
  siteA: paintSite,
  siteB: paintSite,
  hazard(p) {
    // 설치 구역 경계선: 노랑/검정 사선 줄무늬
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const on = ((x + y) >> 3) % 2 === 0;
        p.set(x, y, shade(on ? [212, 172, 48] : [36, 34, 30], (p.rand() - 0.5) * 18));
      }
  },
  spawnAtk(p) {
    p.fillNoise([128, 82, 72], 16);
    p.blotches(4, 2, -12);
    for (let i = 0; i < SIZE; i++) p.tint(i, 0, -30);
  },
  spawnDef(p) {
    p.fillNoise([74, 98, 128], 16);
    p.blotches(4, 2, -12);
    for (let i = 0; i < SIZE; i++) p.tint(i, 0, -30);
  },
  roof(p) {
    // 골함석
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const wave = Math.sin((x / SIZE) * Math.PI * 8) * 18;
        p.set(x, y, shade([102, 108, 106], wave + (p.rand() - 0.5) * 10));
      }
    p.blotches(4, 3, -20);
  },
  stair(p) {
    p.fillNoise([120, 118, 112], 18);
    for (let x = 0; x < SIZE; x++) {
      p.set(x, 0, [200, 168, 48]);
      p.set(x, 1, [200, 168, 48]);
    }
  },
  trim(p) {
    p.fillNoise([60, 62, 66], 10);
    for (let i = 0; i < SIZE; i++) p.tint(i, 0, 26);
  },
};

function paintSite(p: PixelCanvas): void {
  // 콘크리트 판 바닥 (경계 줄무늬는 MapBuilder가 구역 외곽에만 따로 깐다)
  p.fillNoise([122, 116, 102], 20);
  p.blotches(6, 2, -14);
  for (let i = 0; i < SIZE; i++) {
    p.tint(i, 0, -26);
    p.tint(0, i, -26);
  }
}

const cache = new Map<TextureName, THREE.Texture>();

export function getTexture(name: TextureName): THREE.Texture {
  let tex = cache.get(name);
  if (tex) return tex;
  let seed = 0;
  for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  const p = new PixelCanvas(rng(seed));
  painters[name](p);
  tex = new THREE.DataTexture(p.data, SIZE, SIZE, THREE.RGBAFormat);
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // 가까이서는 PS1처럼 필터링 없이 픽셀이 그대로 보이고,
  // 멀리서는 밉맵으로 지글거림을 줄여 가독성을 확보한다
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cache.set(name, tex);
  return tex;
}
