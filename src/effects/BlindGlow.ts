import * as THREE from 'three';

/**
 * 섬광에 눈이 먼 캐릭터 표시: 눈 높이에서 하얗게 번쩍이는 빛 (얼굴이 빛에 덮인 모습).
 *   - 밝은 중심 + 넓게 번지는 후광 + 천천히 도는 빛줄기
 *   - 남은 실명 시간이 줄면 서서히 약해진다
 * 대상마다 스프라이트 묶음을 하나씩 재사용한다.
 */

interface Glow {
  group: THREE.Group;
  core: THREE.Sprite;
  halo: THREE.Sprite;
  rays: THREE.Sprite;
  seed: number;
}

let texCache: { core: THREE.Texture; halo: THREE.Texture; rays: THREE.Texture } | null = null;

function radial(size: number, stops: [number, string][]): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textures() {
  if (texCache) return texCache;
  const core = radial(64, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,252,235,0.95)'], [0.6, 'rgba(255,240,200,0.35)'], [1, 'rgba(255,230,180,0)']]);
  const halo = radial(64, [[0, 'rgba(255,250,230,0.55)'], [0.5, 'rgba(255,235,190,0.18)'], [1, 'rgba(255,220,160,0)']]);
  // 빛줄기: 가운데에서 뻗는 얇은 선 여러 개
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.translate(64, 64);
  for (let i = 0; i < 8; i++) {
    g.rotate(Math.PI / 4);
    const grad = g.createLinearGradient(0, 0, 60, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -2.5);
    g.lineTo(i % 2 ? 44 : 62, 0);
    g.lineTo(0, 2.5);
    g.fill();
  }
  const rays = new THREE.CanvasTexture(c);
  rays.colorSpace = THREE.SRGBColorSpace;
  texCache = { core, halo, rays };
  return texCache;
}

function sprite(map: THREE.Texture): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  s.renderOrder = 6;
  return s;
}

export class BlindGlow {
  readonly group = new THREE.Group();
  private glows = new Map<string, Glow>();
  private time = 0;

  /**
   * @param list 지금 눈이 먼 대상: id, 눈 위치, 남은 시간(초)
   */
  update(dt: number, camera: THREE.Camera, list: { id: string; eye: THREE.Vector3; left: number }[]): void {
    this.time += dt;
    const seen = new Set<string>();
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const t of list) {
      seen.add(t.id);
      let gl = this.glows.get(t.id);
      if (!gl) {
        const tx = textures();
        gl = { group: new THREE.Group(), core: sprite(tx.core), halo: sprite(tx.halo), rays: sprite(tx.rays), seed: Math.random() * 10 };
        gl.group.add(gl.halo, gl.rays, gl.core);
        this.group.add(gl.group);
        this.glows.set(t.id, gl);
      }
      // 얼굴 바로 앞(카메라 쪽)으로 살짝 띄워 머리에 가려지지 않게
      const toCam = camPos.clone().sub(t.eye).normalize();
      gl.group.position.copy(t.eye).addScaledVector(toCam, 0.18);
      gl.group.visible = true;
      // 남은 시간 0.6초 동안 서서히 꺼짐, 그 전에는 빠르게 일렁임
      const k = Math.min(1, t.left / 0.6);
      const flicker = 0.85 + 0.15 * Math.sin(this.time * 31 + gl.seed) * Math.sin(this.time * 13 + gl.seed * 2);
      const a = k * flicker;
      (gl.core.material as THREE.SpriteMaterial).opacity = a;
      (gl.halo.material as THREE.SpriteMaterial).opacity = a * 0.9;
      (gl.rays.material as THREE.SpriteMaterial).opacity = a * 0.8;
      gl.core.scale.setScalar(0.42 + 0.05 * flicker);
      gl.halo.scale.setScalar(1.3 * (0.8 + 0.2 * k));
      gl.rays.scale.setScalar(1.05 * (0.7 + 0.3 * k));
      (gl.rays.material as THREE.SpriteMaterial).rotation = this.time * 0.8 + gl.seed;
    }
    for (const [id, gl] of this.glows) if (!seen.has(id)) gl.group.visible = false;
  }

  clear(): void {
    for (const gl of this.glows.values()) gl.group.visible = false;
  }
}
