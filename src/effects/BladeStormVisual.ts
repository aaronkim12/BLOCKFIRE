import * as THREE from 'three';
import { createPSXMaterial } from '../graphics/PSXMaterial';

/**
 * 궁극기 STORM EDGE의 떠다니는 단검.
 *   fp    : 1인칭 — 화면 오른쪽 앞에 부채꼴로 떠서 출렁인다 (뷰모델 장면, 카메라 공간 m)
 *   world : 3인칭 — 캐릭터 가슴 높이에서 몸 주위를 천천히 돈다
 * 남은 단검 수만큼 보이고, 던지면 한 자루가 앞으로 날아가며 사라진다.
 */

const MAX = 5;

/** 단검 하나 (날끝이 +Y). world 모드는 날끝이 +X를 향하도록 감싼다 */
function knifeMesh(): THREE.Group {
  const g = new THREE.Group();
  // 날: 가늘고 뾰족한 마름모 (두께 6mm)
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.15);
  shape.lineTo(0.014, 0.035);
  shape.lineTo(0.011, 0);
  shape.lineTo(-0.011, 0);
  shape.lineTo(-0.014, 0.035);
  shape.closePath();
  const blade = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: false }),
    createPSXMaterial({ color: 0xe6eef4, emissive: 0x3a90b8 }),
  );
  blade.position.z = -0.002;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.006, 0.01), createPSXMaterial({ color: 0x506070, emissive: 0x7fdcff }));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.045, 0.01), createPSXMaterial({ color: 0x3a4048, emissive: 0x10202a }));
  grip.position.y = -0.026;
  g.add(blade, guard, grip);
  return g;
}

export class BladeStormVisual {
  readonly group = new THREE.Group();
  private knives: THREE.Group[] = [];
  private flying: { mesh: THREE.Group; t: number }[] = [];
  private count = 0;
  private time = 0;

  constructor(private mode: 'fp' | 'world') {
    for (let i = 0; i < MAX; i++) {
      const k = new THREE.Group();
      const inner = knifeMesh();
      if (mode === 'world') {
        inner.rotation.z = -Math.PI / 2; // 날끝이 바깥(+X)
        inner.scale.setScalar(2.4);
      } else inner.scale.setScalar(0.8);
      k.add(inner);
      this.knives.push(k);
      this.group.add(k);
    }
    this.group.visible = false;
    if (mode === 'fp') this.group.traverse((o) => (o.renderOrder = 4));
  }

  setCount(n: number): void {
    this.count = Math.max(0, Math.min(MAX, n));
  }

  /** 한 자루 던짐: 맨 끝 단검이 앞으로 날아간다 */
  throwOne(): void {
    const k = this.knives[Math.max(0, this.count - 1)];
    if (!k) return;
    const copy = k.clone();
    copy.position.copy(k.position);
    copy.quaternion.copy(k.quaternion);
    copy.scale.copy(k.scale);
    this.group.add(copy);
    this.flying.push({ mesh: copy, t: 0 });
  }

  update(dt: number): void {
    this.time += dt;
    const n = this.count;
    this.knives.forEach((k, i) => {
      k.visible = i < n;
      if (!k.visible) return;
      if (this.mode === 'fp') {
        // 화면 오른쪽 아래, 카드를 펼친 것처럼 부채꼴. 날끝은 위로, 살짝 앞으로 기울어 날 면이 보인다
        const spread = n > 1 ? (i / (n - 1) - 0.5) * 2 : 0;
        const a = spread * 0.55;
        const bob = Math.sin(this.time * 2.2 + i * 0.9) * 0.005;
        k.position.set(0.18 - Math.sin(a) * 0.045, -0.23 + Math.cos(a) * 0.045 + bob, -0.46 + Math.abs(spread) * 0.01);
        k.rotation.set(-0.5 + Math.sin(this.time * 1.7 + i) * 0.03, 0.15, a);
      } else {
        // 몸 주위를 돌며 날끝은 바깥쪽
        const a = this.time * 1.4 + (i / Math.max(1, n)) * Math.PI * 2;
        k.position.set(Math.cos(a) * 0.62, 1.25 + Math.sin(this.time * 2 + i) * 0.06, Math.sin(a) * 0.62);
        k.rotation.set(0, -a, 0);
      }
    });
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      if (this.mode === 'fp') {
        // 앞으로 쏘아지며 작아짐
        f.mesh.position.z -= dt * 9;
        f.mesh.rotation.x = Math.max(-1.5, f.mesh.rotation.x - dt * 12);
      } else f.mesh.translateX(dt * 30);
      f.mesh.scale.multiplyScalar(this.mode === 'fp' ? 0.92 : 1);
      if (f.t > 0.18) {
        f.mesh.removeFromParent();
        this.flying.splice(i, 1);
      }
    }
  }
}
