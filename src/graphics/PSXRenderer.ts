import * as THREE from 'three';
import type { PSXSettings } from '../core/settings';
import { psxUniforms } from './PSXMaterial';

/**
 * PSX 스타일 렌더링 파이프라인.
 * 1) 장면을 낮은 해상도 렌더 타깃에 그린다.
 * 2) 후처리에서 sRGB 변환 → 4x4 Bayer 디더링 → 채널당 N비트 색상 양자화.
 * 3) 최근접 필터로 화면 크기까지 확대한다 (픽셀이 그대로 보이도록).
 */
export class PSXRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMaterial: THREE.ShaderMaterial;
  private settings: PSXSettings;
  /**
   * 깊이 사전 패스: 입자를 뺀 장면의 깊이만 따로 그린다.
   * 입자가 벽·바닥과 만나는 곳을 부드럽게 흐리는 데(soft particle) 쓴다.
   * (그리는 중인 렌더 타깃의 깊이는 읽을 수 없으므로 별도 타깃이 필요)
   */
  private depthTarget: THREE.WebGLRenderTarget;
  private depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

  constructor(canvas: HTMLCanvasElement, settings: PSXSettings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // 1인칭 팔 모델의 잘라내기 평면용
    this.renderer.localClippingEnabled = true;
    // 필터링 없는 저해상도 그림자 → 계단 현상이 그대로 보이는 PSX풍 그림자
    this.renderer.shadowMap.type = THREE.BasicShadowMap;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });

    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });

    this.postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorLevels: { value: 31 },
        uDither: { value: 1 },
      },
      vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uResolution;
uniform float uColorLevels;
uniform float uDither;
varying vec2 vUv;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  // 4x4 Bayer 행렬 (0..15)
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0 - 0.5;
}

vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// 0.8까지는 그대로, 그 위는 1을 향해 부드럽게 압축 (섬광·폭발 같은 HDR 값의 가장자리가 계단지지 않게)
vec3 shoulder(vec3 c) {
  vec3 over = max(c - 0.8, 0.0);
  return min(c, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
}

void main() {
  vec3 col = linearToSRGB(shoulder(texture2D(tScene, vUv).rgb));
  // 저해상도 픽셀 단위로 디더 패턴을 적용 (확대되어도 패턴이 픽셀과 일치)
  vec2 px = floor(vUv * uResolution);
  col += uDither * bayer4(px) / uColorLevels;
  col = floor(col * uColorLevels + 0.5) / uColorLevels;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    this.applySettings(settings);
  }

  applySettings(s: PSXSettings): void {
    this.settings = s;
    psxUniforms.uJitter.value = s.vertexJitter > 0 ? 1 : 0;
    psxUniforms.uAffine.value = [0, 0.25, 0.7][s.affineWarp] ?? 0;
    this.postMaterial.uniforms.uDither.value = s.dithering ? 1 : 0;
    this.postMaterial.uniforms.uColorLevels.value = Math.pow(2, s.colorBits) - 1;
    this.resize();
  }

  /** 깊이 사전 패스 결과 (입자 셰이더가 읽음) */
  get depthTexture(): THREE.DepthTexture {
    return this.depthTarget.depthTexture!;
  }

  /** 내부 렌더 해상도 (픽셀) */
  get internalSize(): THREE.Vector2 {
    return this.postMaterial.uniforms.uResolution.value as THREE.Vector2;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    // 픽셀 배율은 CSS 픽셀 기준 (고DPI 화면에서도 같은 크기의 픽셀로 보이도록)
    const scale = Math.max(1, this.settings.pixelScale);
    const pr = this.settings.pixelScale <= 1 ? this.renderer.getPixelRatio() : 1;
    const iw = Math.max(1, Math.floor((w * pr) / scale));
    const ih = Math.max(1, Math.floor((h * pr) / scale));
    this.target.setSize(iw, ih);
    // 부드러운 입자의 흐림 계산에는 절반 해상도 깊이로 충분 (UV로 읽으므로 크기가 달라도 됨)
    this.depthTarget.setSize(Math.max(1, Math.ceil(iw / 2)), Math.max(1, Math.ceil(ih / 2)));
    this.postMaterial.uniforms.uResolution.value.set(iw, ih);
    // 지터 '약하게'는 렌더 픽셀 격자에, '강하게'는 PS1 원본(세로 240) 수준의 거친 격자에 스냅
    const snapH = this.settings.vertexJitter >= 2 ? Math.min(ih, 240) : ih;
    psxUniforms.uSnapResolution.value.set((snapH * iw) / ih, snapH);
  }

  /**
   * @param overlay 1인칭 뷰모델처럼 메인 장면 위에 깊이를 비우고 그릴 장면 (같은 PSX 후처리를 거친다)
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    overlay?: { scene: THREE.Scene; camera: THREE.Camera },
    depthPrepass?: { hide: THREE.Object3D[] },
  ): void {
    const r = this.renderer;
    if (depthPrepass) {
      // 깊이만: 색 쓰기 없음, 그림자 맵은 본 패스에서 한 번만 갱신
      const hidden = depthPrepass.hide.map((o) => o.visible);
      depthPrepass.hide.forEach((o) => (o.visible = false));
      const auto = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      const bg = scene.background;
      scene.background = null;
      scene.overrideMaterial = this.depthOnly;
      r.setRenderTarget(this.depthTarget);
      r.render(scene, camera);
      scene.overrideMaterial = null;
      scene.background = bg;
      r.shadowMap.autoUpdate = auto;
      depthPrepass.hide.forEach((o, i) => (o.visible = hidden[i]));
    }
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    if (overlay) {
      r.autoClear = false;
      r.clearDepth();
      r.render(overlay.scene, overlay.camera);
      r.autoClear = true;
    }
    r.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }
}
