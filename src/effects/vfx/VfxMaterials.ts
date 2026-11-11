import * as THREE from 'three';

/**
 * 면(面) 효과용 ShaderMaterial: 능력 방벽, 지역 바닥, 충격파 고리, 빛 기둥.
 * 모두 공용 시간 uniform(vfxTime)을 쓰므로 프레임마다 한 번만 갱신하면 된다.
 */

export const vfxTime = { value: 0 };

/** 부드러운 입자용 장면 깊이 (PSXRenderer의 깊이 사전 패스). Game이 연결하고 Vfx가 매 프레임 near/far를 갱신 */
export const sceneDepth = {
  tex: { value: null as THREE.Texture | null },
  res: { value: new THREE.Vector2(1, 1) },
  near: { value: 0.05 },
  far: { value: 300 },
  on: { value: 0 },
};

const NOISE = /* glsl */ `
float vh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vh(i), vh(i + vec2(1, 0)), f.x), mix(vh(i + vec2(0, 1)), vh(i + vec2(1, 1)), f.x), f.y);
}
float vfbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}
// 육각 격자: 셀 중심까지 거리 (0 중심 → 0.5 가장자리)
float hexDist(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  q = abs(q);
  return max(dot(q, s * 0.5), q.x);
}
`;

function fogUniforms(extra: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...extra };
}

// ───────────────────────── 능력 방벽 ─────────────────────────
/**
 * 에너지 결정 방벽: 육각 격자 + 위로 흐르는 노이즈 띠 + 가장자리 발광 + 시야각 프레넬,
 * 솟아오를 때 윗선이 밝게 타오르고, 총알이 맞은 자리에서 파문이 퍼지며, 내구도가 줄면 금이 간다.
 */
export function createBarrierMaterial(color: THREE.ColorRepresentation, size: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: fogUniforms({
      uTime: vfxTime,
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size.clone() },
      uRise: { value: 0 },
      uHp: { value: 1 },
      uFade: { value: 1 },
      uHits: { value: [new THREE.Vector4(0, -999, 0, -99), new THREE.Vector4(0, -999, 0, -99), new THREE.Vector4(0, -999, 0, -99), new THREE.Vector4(0, -999, 0, -99)] },
    }),
    vertexShader: /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vView;
uniform vec3 uSize;
#include <fog_pars_vertex>
void main() {
  vLocal = position / uSize + 0.5;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uSize;
uniform float uRise;
uniform float uHp;
uniform float uFade;
uniform vec4 uHits[4];
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vView;
#include <fog_pars_fragment>
${NOISE}
void main() {
  if (vLocal.y > uRise) discard;
  // 방벽 면의 2D 좌표 (긴 축 + 높이, m 단위)
  float along = uSize.x > uSize.z ? vWorld.x : vWorld.z;
  vec2 p = vec2(along, vWorld.y);
  float hx = hexDist(p * 2.2);
  float hexLine = smoothstep(0.42, 0.5, hx);
  float flow = vfbm(vec2(p.x * 0.8, p.y * 1.2 - uTime * 0.9));
  float band = smoothstep(0.55, 0.8, vfbm(vec2(p.x * 0.35, p.y * 0.5 - uTime * 0.35)));
  // 상자 가장자리 발광
  vec3 l = vLocal;
  float ex = min(l.x, 1.0 - l.x) * uSize.x;
  float ey = min(l.y, 1.0 - l.y) * uSize.y;
  float ez = min(l.z, 1.0 - l.z) * uSize.z;
  float edgeD = uSize.x > uSize.z ? min(ex, ey) : min(ez, ey);
  float edge = 1.0 - smoothstep(0.0, 0.12, edgeD);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
  // 솟아오르는 윗선
  float riseLine = (1.0 - smoothstep(0.0, 0.06, uRise - vLocal.y)) * step(uRise, 0.999);
  // 피격 파문
  float ripple = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = uTime - uHits[i].w;
    if (age < 0.0 || age > 0.5) continue;
    float d = distance(vWorld, uHits[i].xyz);
    float k = 1.0 - age / 0.5;
    ripple += exp(-pow((d - age * 2.4) / 0.05, 2.0)) * k * k * 0.6;
    ripple += exp(-d * d * 60.0) * max(0.0, 1.0 - age * 5.0);
  }
  // 손상: 노이즈 금 (내구도가 낮을수록 넓게)
  float crackN = vfbm(p * 3.1 + 4.0);
  float crack = (1.0 - smoothstep(0.0, 0.025, abs(crackN - 0.5))) * smoothstep(0.85, 0.35, uHp);
  vec3 base = uColor * (0.18 + 0.22 * flow + 0.25 * band);
  vec3 glow = uColor * (hexLine * 0.55 + edge * 1.2 + fres * 0.6 + ripple * 1.2) + vec3(0.9, 1.0, 1.0) * (riseLine * 2.0 + ripple * 0.5);
  glow += mix(uColor, vec3(1.0, 0.45, 0.3), 0.5) * crack * 1.5;
  // 깜빡임: 내구도가 낮으면 불안정
  float flicker = 1.0 - (1.0 - uHp) * 0.35 * step(0.92, vnoise(vec2(uTime * 18.0, 0.0)));
  float alpha = clamp(0.62 + hexLine * 0.2 + edge * 0.4 + fres * 0.3 + ripple * 0.3 + riseLine, 0.0, 1.0) * uFade * flicker;
  gl_FragColor = vec4((base + glow) * flicker, alpha);
  #include <fog_fragment>
}`,
    transparent: true,
    fog: true,
    side: THREE.FrontSide,
  });
}

// ───────────────────────── 지역 바닥 ─────────────────────────
/**
 * kind 0 = 화염 (용암처럼 갈라진 바닥 + 일렁이는 테두리)
 * kind 1 = 봉쇄장 (회전하는 문양 고리 + 육각 격자 + 방사선)
 */
export function createZoneMaterial(color: THREE.ColorRepresentation, kind: 0 | 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: vfxTime,
      uColor: { value: new THREE.Color(color) },
      uKind: { value: kind },
      uLife: { value: 0 }, // 0 → 1 펼쳐짐, 끝날 때 다시 0으로
      uSeed: { value: Math.random() * 100 },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uKind;
uniform float uLife;
uniform float uSeed;
varying vec2 vUv;
${NOISE}
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float spread = uLife;
  float wobble = (vfbm(vec2(a * 2.0 + uSeed, uTime * 0.6)) - 0.5) * 0.06;
  float edgeR = spread * (0.97 + wobble);
  if (r > edgeR + 0.03) discard;
  float rim = exp(-pow((r - edgeR) / 0.025, 2.0));
  vec3 col;
  float alpha;
  if (uKind < 0.5) {
    // 화염: 갈라진 용암 무늬, 안쪽이 밝고 일렁임
    vec2 p = vUv * 4.0 + uSeed;
    float n = vfbm(p + vec2(0.0, uTime * 0.25));
    float cracks = 1.0 - smoothstep(0.0, 0.09, abs(vfbm(p * 0.9 - uTime * 0.05) - 0.5));
    float heat = smoothstep(0.35, 0.85, n) * (0.6 + 0.4 * sin(uTime * 6.0 + n * 9.0));
    col = mix(uColor * 0.25, uColor * 1.6 + vec3(0.3, 0.15, 0.0), heat) + vec3(1.0, 0.75, 0.3) * cracks * 1.2;
    col += uColor * rim * 2.0;
    alpha = (0.35 + heat * 0.4 + cracks * 0.5) * smoothstep(edgeR + 0.03, edgeR - 0.08, r) + rim;
  } else {
    // 봉쇄장: 회전 문양 고리 + 육각 격자 + 바깥으로 흐르는 방사 파동
    float rot = a + uTime * 0.4;
    float ring1 = exp(-pow((r - spread * 0.82) / 0.012, 2.0));
    float runes = step(0.5, fract(rot * 12.0 / 6.2831)) * exp(-pow((r - spread * 0.9) / 0.035, 2.0));
    float spokes = pow(abs(cos(rot * 4.0)), 60.0) * smoothstep(0.1, 0.8, r);
    float hex = smoothstep(0.43, 0.5, hexDist(vUv * 9.0));
    float wave = exp(-pow((fract(r * 2.0 - uTime * 0.5) - 0.5) / 0.08, 2.0));
    col = uColor * (0.25 + hex * 0.6 + wave * 0.5 + ring1 * 2.0 + runes * 1.6 + spokes * 0.8 + rim * 2.0);
    alpha = (0.18 + hex * 0.25 + wave * 0.2 + ring1 + runes * 0.8 + spokes * 0.4) * smoothstep(edgeR + 0.03, edgeR - 0.05, r) + rim;
  }
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * smoothstep(0.0, 0.15, uLife));
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────── 충격파 고리 ─────────────────────────
/** 노이즈로 가장자리가 찢긴 고리. uProgress 0→1로 퍼지며 얇아지고 사라진다 */
export function createRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uProgress: { value: 0 },
      uAlpha: { value: 1 },
      uWidth: { value: 0.15 },
      uSeed: { value: 0 },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uAlpha;
uniform float uWidth;
uniform float uSeed;
varying vec2 vUv;
${NOISE}
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float n = vfbm(vec2(a * 3.0 + uSeed, uProgress * 2.0 + uSeed));
  float e = 1.0 - pow(1.0 - uProgress, 3.0);
  float w = uWidth * (1.0 - uProgress * 0.7);
  float ring = exp(-pow((r - e * 0.95) / max(0.005, w * (0.6 + n)), 2.0));
  float inner = smoothstep(e * 0.95, 0.0, r) * 0.25 * (1.0 - uProgress);
  float alpha = (ring * (0.6 + 0.6 * n) + inner) * uAlpha * (1.0 - uProgress);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor * (1.0 + ring), alpha);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────── 빛 기둥 ─────────────────────────
/** 열린 원기둥에 쓰는 세로 그라데이션 빛 (위로 갈수록 사라지고 위로 흐르는 띠) */
export function createBeamMaterial(color: THREE.ColorRepresentation, intensity = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: vfxTime,
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
varying float vFres;
varying float vCamDist;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vCamDist = distance(cameraPosition.xz, w.xz);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vFres = abs(dot(n, normalize(cameraPosition - w.xyz)));
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying float vFres;
varying float vCamDist;
${NOISE}
void main() {
  float h = vUv.y;
  float fade = pow(1.0 - h, 1.6) * smoothstep(0.0, 0.03, h);
  float flow = 0.55 + 0.45 * vnoise(vec2(vUv.x * 12.0, h * 6.0 - uTime * 2.5));
  // 원기둥 가장자리(실루엣)가 더 밝아 부피감이 생김
  float edge = 0.35 + 0.65 * pow(1.0 - vFres, 1.5);
  float a = fade * flow * edge * uIntensity * smoothstep(1.2, 6.0, vCamDist);
  gl_FragColor = vec4(uColor * (1.0 + fade), a);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
