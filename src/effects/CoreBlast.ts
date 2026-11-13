import * as THREE from 'three';

/**
 * Core 폭발: 발로란트의 스파이크처럼 거대한 빛의 구가 폭발 반경까지 점점 커지며 맵을 덮는다.
 *   0 ~ 1.8초   구가 반경 R까지 커짐 (처음엔 빠르게, 끝에서 느리게)
 *   1.8 ~ 3.4초  가장자리가 밝게 일렁이다가 서서히 사라짐
 * 바닥에는 같은 크기로 퍼지는 충격파 고리, 가운데에는 눈부신 섬광.
 */

const GROW = 1.8;
const FADE = 1.6;

const vert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  varying float vY;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - wp.xyz);
    vY = position.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const frag = /* glsl */ `
  uniform float uOpacity;
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vView;
  varying float vY;
  void main() {
    // 가장자리일수록 밝게 (안에서 봐도 구의 경계가 보이도록 양면)
    float rim = 1.0 - abs(dot(normalize(vN), vView));
    rim = pow(rim, 1.6);
    // 표면을 따라 흐르는 띠
    float bands = 0.5 + 0.5 * sin(vY * 9.0 - uTime * 7.0);
    vec3 hot = vec3(1.0, 0.55, 0.2);
    vec3 white = vec3(1.0, 0.95, 0.85);
    vec3 col = mix(hot, white, rim);
    float a = (0.08 + rim * 0.75 + bands * 0.07) * uOpacity;
    gl_FragColor = vec4(col * a, a);
  }
`;

interface Blast {
  t: number;
  radius: number;
  sphere: THREE.Mesh;
  ring: THREE.Mesh;
  flash: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

export class CoreBlast {
  readonly group = new THREE.Group();
  private blasts: Blast[] = [];
  private sphereGeo = new THREE.SphereGeometry(1, 40, 24);
  private ringGeo = new THREE.RingGeometry(0.92, 1, 64);
  private flashGeo = new THREE.SphereGeometry(1, 16, 10);

  constructor() {
    this.group.name = 'core-blast';
  }

  start(center: THREE.Vector3, radius: number): void {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uOpacity: { value: 1 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const sphere = new THREE.Mesh(this.sphereGeo, mat);
    sphere.position.copy(center);
    sphere.frustumCulled = false;
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(center.x, center.y - 0.45, center.z);
    const flash = new THREE.Mesh(this.flashGeo, new THREE.MeshBasicMaterial({ color: 0xfff4dc, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    flash.position.copy(center);
    this.group.add(sphere, ring, flash);
    this.blasts.push({ t: 0, radius, sphere, ring, flash, mat });
  }

  update(dt: number): void {
    for (const b of [...this.blasts]) {
      b.t += dt;
      const t = b.t;
      const grow = Math.min(1, t / GROW);
      const e = 1 - Math.pow(1 - grow, 3);
      const r = Math.max(0.3, b.radius * e);
      b.sphere.scale.setScalar(r);
      const fade = t < GROW ? 1 : Math.max(0, 1 - (t - GROW) / FADE);
      b.mat.uniforms.uOpacity.value = fade * (t < GROW ? 0.85 + 0.15 * Math.sin(t * 30) : 1);
      b.mat.uniforms.uTime.value = t;
      // 바닥 충격파: 구보다 조금 앞서 퍼진다
      const rr = b.radius * Math.min(1.15, (1 - Math.pow(1 - Math.min(1, t / (GROW * 0.8)), 2)) * 1.15);
      b.ring.scale.setScalar(Math.max(0.3, rr));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / (GROW + 0.4)) * 0.9;
      // 가운데 섬광: 처음 0.5초
      const f = Math.max(0, 1 - t / 0.5);
      b.flash.scale.setScalar(1.5 + 6 * (1 - f));
      (b.flash.material as THREE.MeshBasicMaterial).opacity = f;
      if (t > GROW + FADE) {
        this.group.remove(b.sphere, b.ring, b.flash);
        b.mat.dispose();
        (b.ring.material as THREE.Material).dispose();
        (b.flash.material as THREE.Material).dispose();
        this.blasts.splice(this.blasts.indexOf(b), 1);
      }
    }
  }

  clear(): void {
    for (const b of this.blasts) this.group.remove(b.sphere, b.ring, b.flash);
    this.blasts = [];
  }
}
