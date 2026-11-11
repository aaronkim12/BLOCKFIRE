import * as THREE from 'three';

/**
 * 총구 화염 (절차적 셰이더, 더하기 혼합).
 *  - 정면: 갈래 수·길이가 매번 달라지는 별 모양 폭발 + 뜨거운 중심
 *  - 옆면(교차 2장): 총구 방향으로 뻗는 원뿔형 화염, 노이즈로 끝이 찢어짐
 *  - 2프레임에 걸쳐 밝게 → 붉게 식으며 사라짐
 * 총구(muzzle) 오브젝트의 자식으로 붙이고 trigger()로 잠깐 보여준다.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const NOISE = /* glsl */ `
float mh(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float mn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mh(i), mh(i + vec2(1, 0)), f.x), mix(mh(i + vec2(0, 1)), mh(i + vec2(1, 1)), f.x), f.y); }
vec3 heat(float t) { // 0 어두운 주황 → 1 흰색
  return mix(mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.7, 0.25), smoothstep(0.0, 0.5, t)), vec3(1.0, 0.97, 0.85), smoothstep(0.5, 1.0, t));
}`;

/** 정면 별 모양 */
const FRONT = /* glsl */ `
uniform float uSeed;
uniform float uLife;
varying vec2 vUv;
${NOISE}
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float n = floor(4.0 + mh(vec2(uSeed, 1.0)) * 3.0);
  float petal = pow(abs(cos(a * n * 0.5 + uSeed * 6.0)), 6.0);
  float jag = mn(vec2(a * 3.0 + uSeed * 10.0, uSeed));
  float reach = 0.25 + petal * (0.55 + 0.25 * jag);
  float shape = 1.0 - smoothstep(reach * 0.5, reach, r);
  float core = exp(-r * r * 30.0);
  float t = clamp(core + shape * 0.6, 0.0, 1.0) * (0.55 + 0.45 * uLife);
  float alpha = clamp(shape * 0.9 + core, 0.0, 1.0) * uLife;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(heat(t) * (0.8 + core), alpha);
}`;

/** 옆면 원뿔 화염: vUv.x = 총구(−1) → 앞(+1), vUv.y = 폭 */
const SIDE = /* glsl */ `
uniform float uSeed;
uniform float uLife;
varying vec2 vUv;
${NOISE}
void main() {
  float x = vUv.x * 0.5 + 0.5; // 0 총구 → 1 끝
  float len = 0.65 + 0.35 * mh(vec2(uSeed, 3.0));
  float width = mix(0.55, 0.05, x / len) * (0.8 + 0.4 * mn(vec2(x * 6.0 + uSeed * 9.0, uSeed)));
  float body = (1.0 - smoothstep(width * 0.4, width, abs(vUv.y))) * (1.0 - smoothstep(len * 0.7, len, x));
  float n = mn(vec2(x * 9.0 - uSeed * 20.0, vUv.y * 5.0 + uSeed * 7.0));
  body *= smoothstep(0.15, 0.55, n + (1.0 - x) * 0.6);
  float t = clamp(body * (1.2 - x), 0.0, 1.0) * (0.5 + 0.5 * uLife);
  float alpha = body * uLife;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(heat(t), alpha);
}`;

let frontMat: THREE.ShaderMaterial | null = null;
let sideMat: THREE.ShaderMaterial | null = null;

function makeMat(frag: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSeed: { value: 0 }, uLife: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

const LIFE = 0.055;

export class MuzzleFlash {
  readonly object = new THREE.Group();
  private timer = 0;
  private front: THREE.ShaderMaterial;
  private side: THREE.ShaderMaterial;

  constructor(size = 0.18) {
    // 인스턴스마다 seed가 달라야 하므로 머티리얼을 복제 (프로그램은 공유)
    frontMat ??= makeMat(FRONT);
    sideMat ??= makeMat(SIDE);
    this.front = frontMat.clone();
    this.side = sideMat.clone();
    const front = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.3, size * 1.3), this.front);
    // 옆면: 원점이 총구, -Z 방향으로 뻗음
    const sideGeo = new THREE.PlaneGeometry(size * 2.6, size * 1.1);
    sideGeo.translate(size * 1.3, 0, 0);
    const a = new THREE.Mesh(sideGeo, this.side);
    a.rotation.y = Math.PI / 2;
    const b = new THREE.Mesh(sideGeo, this.side);
    // 같은 방향(-Z)으로 뻗되 a와 직각으로 교차 (Ry 후 Rz)
    b.rotation.set(0, Math.PI / 2, Math.PI / 2, 'ZYX');
    this.object.add(a, b, front);
    front.position.z = -size * 0.15;
    this.object.visible = false;
    this.object.traverse((o) => (o.renderOrder = 5));
  }

  trigger(): void {
    this.timer = LIFE;
    this.object.visible = true;
    this.object.rotation.z = Math.random() * Math.PI * 2;
    this.object.scale.setScalar(0.85 + Math.random() * 0.4);
    const seed = Math.random() * 100;
    this.front.uniforms.uSeed.value = seed;
    this.side.uniforms.uSeed.value = seed;
    this.front.uniforms.uLife.value = 1;
    this.side.uniforms.uLife.value = 1;
  }

  update(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    const k = THREE.MathUtils.clamp(this.timer / LIFE, 0, 1);
    this.front.uniforms.uLife.value = k;
    this.side.uniforms.uLife.value = k;
    if (this.timer <= 0) this.object.visible = false;
  }
}
