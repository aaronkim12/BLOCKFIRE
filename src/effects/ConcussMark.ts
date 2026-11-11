import * as THREE from 'three';

/**
 * 충격(concuss) 상태 표시: 머리 위에서 빙글빙글 도는 주황색 별 고리 + 흔들리는 머리 둘레 빛.
 * 맞은 적이 정말 충격을 받았는지 멀리서도 알아볼 수 있게 한다. 남은 시간이 줄면 서서히 사라짐.
 */

const STARS = 5;
const COLOR = 0xffa040;

let starTex: THREE.Texture | null = null;
function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  // 부드러운 빛 + 네 갈래 별
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? s * 0.48 : s * 0.12;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const x = s / 2 + Math.cos(a) * r;
    const y = s / 2 + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  starTex = new THREE.CanvasTexture(c);
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}

interface Mark {
  group: THREE.Group;
  stars: THREE.Sprite[];
  seed: number;
}

export class ConcussMark {
  readonly group = new THREE.Group();
  private marks = new Map<string, Mark>();
  private time = 0;

  private make(): Mark {
    const group = new THREE.Group();
    const stars: THREE.Sprite[] = [];
    for (let i = 0; i < STARS; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color: COLOR, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      sp.scale.setScalar(0.16);
      group.add(sp);
      stars.push(sp);
    }
    this.group.add(group);
    return { group, stars, seed: Math.random() * 10 };
  }

  /** @param list 충격 상태인 캐릭터: 머리 위치와 남은 시간 */
  update(dt: number, list: { id: string; head: THREE.Vector3; left: number }[]): void {
    this.time += dt;
    const seen = new Set<string>();
    for (const it of list) {
      seen.add(it.id);
      let m = this.marks.get(it.id);
      if (!m) this.marks.set(it.id, (m = this.make()));
      m.group.visible = true;
      m.group.position.copy(it.head).setY(it.head.y + 0.28);
      const fade = Math.min(1, it.left / 0.6);
      const t = this.time * 3.2 + m.seed;
      m.stars.forEach((s, i) => {
        const a = t + (i / STARS) * Math.PI * 2;
        // 기울어진 고리 (흔들리는 느낌)
        s.position.set(Math.cos(a) * 0.38, Math.sin(a * 2 + m!.seed) * 0.05 + Math.sin(a) * 0.06, Math.sin(a) * 0.38);
        (s.material as THREE.SpriteMaterial).opacity = fade * (0.7 + 0.3 * Math.sin(this.time * 9 + i));
        s.scale.setScalar(0.24 + 0.06 * Math.sin(this.time * 6 + i * 1.7));
      });
    }
    for (const [id, m] of this.marks) if (!seen.has(id)) m.group.visible = false;
  }
}
