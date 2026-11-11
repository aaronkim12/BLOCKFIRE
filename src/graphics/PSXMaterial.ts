import * as THREE from 'three';

/**
 * PSX 효과용 전역 유니폼. 모든 PSX 머티리얼이 같은 객체를 참조하므로
 * 값을 바꾸면 리컴파일 없이 즉시 반영된다.
 */
export const psxUniforms = {
  /** 버텍스 스냅 격자 해상도 (내부 렌더 해상도와 동일하게 맞춘다) */
  uSnapResolution: { value: new THREE.Vector2(480, 270) },
  /** 0 = 끔, 1 = 켬 */
  uJitter: { value: 1 },
  /** 0 = 원근 보정 텍스처, 1 = 완전 아핀 텍스처 */
  uAffine: { value: 0.65 },
};

export interface PSXMaterialOptions {
  map?: THREE.Texture;
  color?: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** 1인칭 무기 등 흔들리면 안 되는 오브젝트는 false */
  jitter?: boolean;
}

/**
 * MeshLambertMaterial(조명/그림자/안개 그대로 사용)에
 * PSX 버텍스 지터와 아핀 텍스처 매핑을 주입한 머티리얼.
 */
export function createPSXMaterial(opts: PSXMaterialOptions = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    map: opts.map ?? null,
    color: opts.color ?? 0xffffff,
    emissive: opts.emissive ?? 0x000000,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  const jitterEnabled = opts.jitter ?? true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnapResolution = psxUniforms.uSnapResolution;
    shader.uniforms.uJitter = jitterEnabled ? psxUniforms.uJitter : { value: 0 };
    shader.uniforms.uAffine = psxUniforms.uAffine;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform vec2 uSnapResolution;
uniform float uJitter;
varying float vPsxDepth;
#ifdef USE_MAP
varying vec2 vAffineUv;
varying float vAffineW;
#endif`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
// PSX 버텍스 지터: 정점을 화면 픽셀 격자에 스냅 (GTE의 정수 좌표 연산 재현)
if (uJitter > 0.5 && gl_Position.w > 0.0) {
  vec2 halfRes = uSnapResolution * 0.5;
  vec2 ndc = gl_Position.xy / gl_Position.w;
  ndc = floor(ndc * halfRes + 0.5) / halfRes;
  gl_Position.xy = ndc * gl_Position.w;
}
vPsxDepth = -mvPosition.z;
#ifdef USE_MAP
// 아핀 텍스처: UV에 w를 곱해 두고 프래그먼트에서 나누면 화면 공간 선형 보간이 된다
vAffineUv = vMapUv * gl_Position.w;
vAffineW = gl_Position.w;
#endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uAffine;
varying float vPsxDepth;
#ifdef USE_MAP
varying vec2 vAffineUv;
varying float vAffineW;
#endif`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#ifdef USE_MAP
  // 가까운 면의 아핀 왜곡은 화면 가장자리에서 크게 일그러져 보이므로
  // 카메라 근처에서는 원근 보정 UV로 서서히 전환한다 (먼 곳만 PS1 느낌 유지)
  float psxAffine = uAffine * smoothstep(2.0, 8.0, vPsxDepth);
  vec2 psxUv = mix(vMapUv, vAffineUv / vAffineW, psxAffine);
  diffuseColor *= texture2D(map, psxUv);
#endif`,
      );
  };
  mat.customProgramCacheKey = () => `psx-${jitterEnabled ? 1 : 0}`;
  return mat;
}
