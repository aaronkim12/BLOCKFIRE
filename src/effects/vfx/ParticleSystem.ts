import * as THREE from 'three';
import { sceneDepth } from './VfxMaterials';
import { particleAtlas } from './VfxTextures';

/**
 * 인스턴싱 파티클 풀.
 * - 사각형 1장(InstancedBufferGeometry) × N 인스턴스, 드로우 콜 1회
 * - 정점 셰이더에서 카메라를 향하는 빌보드(회전 포함) 또는 속도 방향 줄무늬(불똥·예광탄)를 만든다
 * - 시뮬레이션은 CPU의 고정 배열(SoA)에서, 할당 없이 돌린다 (죽은 입자는 맨 뒤와 바꿔 제거)
 * - 반투명 풀은 매 프레임 카메라 거리로 정렬해 겹친 연기가 자연스럽게 섞인다
 */

export interface Emit {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  life: number;
  /** 시작/끝 크기 (m). 끝 크기로 ease-out 보간 */
  size: number;
  sizeEnd?: number;
  /** 끝 크기까지 커지는 시간 (초, 기본 = 수명) */
  grow?: number;
  color: THREE.Color;
  colorEnd?: THREE.Color;
  alpha?: number;
  /** 서서히 나타나는 시간 (초) */
  fadeIn?: number;
  /** 사라지는 시간 (초, 수명 끝에서부터) */
  fadeOut?: number;
  rot?: number;
  rotVel?: number;
  /** 초당 속도 감쇠 비율 (0이면 없음) */
  drag?: number;
  /** 아래로 당기는 가속 (음수면 떠오름) */
  gravity?: number;
  frame: number;
  /** >0: 속도 × stretch 길이의 줄무늬. <0: |stretch| 길이 고정 줄무늬 (예광탄) */
  stretch?: number;
  /** 줄무늬 이동 한계 거리 (예광탄이 벽을 뚫고 나가지 않게) */
  limit?: number;
  /** 좌우로 흔들리는 난류 세기 (m/s) */
  wobble?: number;
  /** 바닥 높이: 밑으로 떨어지면 튕김 */
  floor?: number;
  bounce?: number;
}

// 입자 하나의 필드 (Float32Array 안의 오프셋)
const F = {
  px: 0, py: 1, pz: 2, vx: 3, vy: 4, vz: 5, age: 6, life: 7, s0: 8, s1: 9,
  r0: 10, g0: 11, b0: 12, r1: 13, g1: 14, b1: 15, a: 16, fin: 17, fout: 18,
  rot: 19, rotv: 20, drag: 21, grav: 22, frame: 23, stretch: 24, limit: 25,
  wob: 26, phase: 27, sx: 28, sy: 29, sz: 30, floor: 31, bounce: 32, speed: 33, grow: 34,
} as const;
const STRIDE = 35;

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iAxis;
attribute vec4 iColor;
attribute vec4 iData; // size, rot, frame, mode(0 빌보드 / 1 줄무늬)
uniform float uNearFade;
varying vec2 vUv;
varying vec4 vColor;
varying float vUp; // 화면 기준 위아래 위치 (0 아래 → 1 위)
varying float vViewZ;
#include <fog_pars_vertex>
void main() {
  float size = iData.x;
  float frame = iData.z;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  bool streak = iData.w > 0.5;
  if (streak) {
    vec4 tail = modelViewMatrix * vec4(iPos + iAxis, 1.0);
    vec3 d = tail.xyz - mvPosition.xyz;
    vec3 side = cross(d, mvPosition.xyz);
    float sl = length(side);
    if (sl > 1e-6) {
      side /= sl;
      mvPosition.xyz += d * (0.5 - position.y) + side * position.x * size;
    } else streak = false;
  }
  if (!streak) {
    float c = cos(iData.y), s = sin(iData.y);
    vec2 o = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
    mvPosition.xy += o * size;
    vUp = o.y + 0.5;
  } else vUp = 0.5;
  vec2 cell = vec2(mod(frame, 4.0), floor(frame / 4.0 + 0.001));
  vUv = vec2((cell.x + uv.x) * 0.25, 1.0 - (cell.y + 1.0 - uv.y) * 0.25);
  vColor = iColor;
  // 카메라에 너무 가까운 입자는 화면을 덮지 않도록 흐려진다
  vColor.a *= smoothstep(uNearFade * 0.25, uNearFade, -mvPosition.z);
  vViewZ = mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uLit;
uniform sampler2D uDepth;
uniform vec2 uDepthRes;
uniform float uNear;
uniform float uFar;
uniform float uSoftOn;
uniform float uSoft;
varying vec2 vUv;
varying vec4 vColor;
varying float vUp;
varying float vViewZ;
#include <packing>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, vUv);
  // 위에서 오는 빛: 위쪽은 밝고 아래쪽은 그늘 (연기 덩어리의 부피감)
  float light = mix(1.0, mix(0.7, 1.12, smoothstep(0.05, 0.95, vUp)), uLit);
  vec4 c = vec4(vColor.rgb * t.rgb * light, vColor.a * t.a);
  // 부드러운 입자: 뒤의 벽·바닥과 가까울수록 흐려져 교차선이 보이지 않음
  if (uSoftOn > 0.5) {
    float d = texture2D(uDepth, gl_FragCoord.xy / uDepthRes).x;
    float sceneZ = perspectiveDepthToViewZ(d, uNear, uFar);
    c.a *= clamp((vViewZ - sceneZ) / uSoft, 0.0, 1.0);
  }
  if (c.a < 0.003) discard;
  gl_FragColor = c;
  #include <fog_fragment>
}`;

const _v = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private data: Float32Array;
  private count = 0;
  private aPos: THREE.InstancedBufferAttribute;
  private aAxis: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aData: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private order: number[] = [];
  private depth: Float32Array;

  constructor(
    readonly max: number,
    readonly additive: boolean,
    nearFade = 0.9,
  ) {
    this.data = new Float32Array(max * STRIDE);
    this.depth = new Float32Array(max);
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aAxis = mk(3);
    this.aColor = mk(4);
    this.aData = mk(4);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iAxis', this.aAxis);
    geo.setAttribute('iColor', this.aColor);
    geo.setAttribute('iData', this.aData);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: null }, uNearFade: { value: nearFade }, uLit: { value: additive ? 0 : 1 }, uSoft: { value: additive ? 0.25 : 0.7 } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // 더하기 혼합은 안개색을 더하면 안 되므로 안개 없이 (거리 감쇠는 알파로 충분)
      fog: !additive,
    });
    mat.uniforms.uMap.value = particleAtlas();
    // 공유 uniform 객체를 그대로 연결 (한 곳에서 갱신)
    mat.uniforms.uDepth = sceneDepth.tex;
    mat.uniforms.uDepthRes = sceneDepth.res;
    mat.uniforms.uNear = sceneDepth.near;
    mat.uniforms.uFar = sceneDepth.far;
    mat.uniforms.uSoftOn = sceneDepth.on;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  get active(): number {
    return this.count;
  }

  emit(e: Emit): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max); // 가득 차면 아무거나 덮어씀
    const d = this.data;
    const o = i * STRIDE;
    d[o + F.px] = d[o + F.sx] = e.pos.x;
    d[o + F.py] = d[o + F.sy] = e.pos.y;
    d[o + F.pz] = d[o + F.sz] = e.pos.z;
    d[o + F.vx] = e.vel?.x ?? 0;
    d[o + F.vy] = e.vel?.y ?? 0;
    d[o + F.vz] = e.vel?.z ?? 0;
    d[o + F.speed] = e.vel ? e.vel.length() : 0;
    d[o + F.age] = 0;
    d[o + F.life] = Math.max(0.001, e.life);
    d[o + F.s0] = e.size;
    d[o + F.s1] = e.sizeEnd ?? e.size;
    d[o + F.r0] = e.color.r;
    d[o + F.g0] = e.color.g;
    d[o + F.b0] = e.color.b;
    const ce = e.colorEnd ?? e.color;
    d[o + F.r1] = ce.r;
    d[o + F.g1] = ce.g;
    d[o + F.b1] = ce.b;
    d[o + F.a] = e.alpha ?? 1;
    d[o + F.fin] = e.fadeIn ?? 0;
    d[o + F.fout] = e.fadeOut ?? e.life * 0.5;
    d[o + F.rot] = e.rot ?? Math.random() * Math.PI * 2;
    d[o + F.rotv] = e.rotVel ?? 0;
    d[o + F.drag] = e.drag ?? 0;
    d[o + F.grav] = e.gravity ?? 0;
    d[o + F.frame] = e.frame;
    d[o + F.stretch] = e.stretch ?? 0;
    d[o + F.limit] = e.limit ?? 0;
    d[o + F.wob] = e.wobble ?? 0;
    d[o + F.phase] = Math.random() * 100;
    d[o + F.floor] = e.floor ?? -1e9;
    d[o + F.bounce] = e.bounce ?? 0.3;
    d[o + F.grow] = e.grow ?? e.life;
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  update(dt: number, camera: THREE.Camera): void {
    const d = this.data;
    // ── 시뮬레이션
    for (let i = 0; i < this.count; ) {
      const o = i * STRIDE;
      d[o + F.age] += dt;
      if (d[o + F.age] >= d[o + F.life]) {
        // 맨 뒤 입자와 바꿔서 제거
        this.count--;
        if (i !== this.count) d.copyWithin(o, this.count * STRIDE, this.count * STRIDE + STRIDE);
        continue;
      }
      if (d[o + F.stretch] >= 0 || d[o + F.limit] <= 0) {
        const drag = d[o + F.drag];
        if (drag > 0) {
          const k = Math.exp(-drag * dt);
          d[o + F.vx] *= k;
          d[o + F.vy] *= k;
          d[o + F.vz] *= k;
        }
        d[o + F.vy] -= d[o + F.grav] * dt;
        const wob = d[o + F.wob];
        let wx = 0;
        let wz = 0;
        if (wob > 0) {
          const t = d[o + F.age] * 1.3 + d[o + F.phase];
          wx = Math.sin(t) * wob;
          wz = Math.cos(t * 0.83 + 1.7) * wob;
        }
        d[o + F.px] += (d[o + F.vx] + wx) * dt;
        d[o + F.py] += d[o + F.vy] * dt;
        d[o + F.pz] += (d[o + F.vz] + wz) * dt;
        if (d[o + F.py] < d[o + F.floor]) {
          d[o + F.py] = d[o + F.floor];
          const b = d[o + F.bounce];
          d[o + F.vy] = Math.abs(d[o + F.vy]) * b;
          d[o + F.vx] *= 0.55;
          d[o + F.vz] *= 0.55;
          d[o + F.rotv] *= 0.5;
        }
      }
      d[o + F.rot] += d[o + F.rotv] * dt;
      i++;
    }

    // ── 정렬 (반투명만): 먼 것부터
    camera.getWorldPosition(_cam);
    const order = this.order;
    order.length = this.count;
    for (let i = 0; i < this.count; i++) order[i] = i;
    if (!this.additive && this.count > 1) {
      for (let i = 0; i < this.count; i++) {
        const o = i * STRIDE;
        this.depth[i] = _v.set(d[o + F.px], d[o + F.py], d[o + F.pz]).distanceToSquared(_cam);
      }
      const depth = this.depth;
      order.sort((a, b) => depth[b] - depth[a]);
    }

    // ── 인스턴스 속성 기록
    const P = this.aPos.array as Float32Array;
    const A = this.aAxis.array as Float32Array;
    const C = this.aColor.array as Float32Array;
    const D = this.aData.array as Float32Array;
    for (let j = 0; j < this.count; j++) {
      const o = order[j] * STRIDE;
      const life = d[o + F.life];
      const age = d[o + F.age];
      const t = age / life;
      const g = Math.min(1, age / d[o + F.grow]);
      const e = 1 - (1 - g) * (1 - g); // ease-out
      let alpha = d[o + F.a];
      const fin = d[o + F.fin];
      const fout = d[o + F.fout];
      if (fin > 0 && age < fin) alpha *= age / fin;
      if (fout > 0 && life - age < fout) alpha *= (life - age) / fout;
      const stretch = d[o + F.stretch];
      let mode = 0;
      let x = d[o + F.px];
      let y = d[o + F.py];
      let z = d[o + F.pz];
      let ax = 0;
      let ay = 0;
      let az = 0;
      if (stretch > 0) {
        mode = 1;
        ax = -d[o + F.vx] * stretch;
        ay = -d[o + F.vy] * stretch;
        az = -d[o + F.vz] * stretch;
      } else if (stretch < 0) {
        // 고정 길이 줄무늬: 시작점에서 limit까지 직선으로 날아감 (머리·꼬리 모두 limit에서 멈춤)
        mode = 1;
        const sp = d[o + F.speed];
        const lim = d[o + F.limit] > 0 ? d[o + F.limit] : Infinity;
        const head = Math.min(lim, sp * age);
        const tail = Math.min(lim, Math.max(0, sp * age + stretch));
        const inv = sp > 0 ? 1 / sp : 0;
        const dx = d[o + F.vx] * inv;
        const dy = d[o + F.vy] * inv;
        const dz = d[o + F.vz] * inv;
        x = d[o + F.sx] + dx * head;
        y = d[o + F.sy] + dy * head;
        z = d[o + F.sz] + dz * head;
        ax = -dx * (head - tail);
        ay = -dy * (head - tail);
        az = -dz * (head - tail);
      }
      P[j * 3] = x;
      P[j * 3 + 1] = y;
      P[j * 3 + 2] = z;
      A[j * 3] = ax;
      A[j * 3 + 1] = ay;
      A[j * 3 + 2] = az;
      C[j * 4] = d[o + F.r0] + (d[o + F.r1] - d[o + F.r0]) * t;
      C[j * 4 + 1] = d[o + F.g0] + (d[o + F.g1] - d[o + F.g0]) * t;
      C[j * 4 + 2] = d[o + F.b0] + (d[o + F.b1] - d[o + F.b0]) * t;
      C[j * 4 + 3] = alpha;
      D[j * 4] = d[o + F.s0] + (d[o + F.s1] - d[o + F.s0]) * e;
      D[j * 4 + 1] = d[o + F.rot];
      D[j * 4 + 2] = d[o + F.frame];
      D[j * 4 + 3] = mode;
    }
    for (const a of [this.aPos, this.aAxis, this.aColor, this.aData]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.count;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
