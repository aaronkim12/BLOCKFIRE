import * as THREE from 'three';
import { createBeamMaterial, vfxTime } from '../effects/vfx/VfxMaterials';
import { createPSXMaterial } from '../graphics/PSXMaterial';

/** 바닥 고리: 회전하는 눈금 + 안쪽으로 모이는 맥동 (설치: 빨강, 떨어짐: 노랑) */
function createMarkerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: vfxTime, uColor: { value: new THREE.Color(0xff6030) }, uPulse: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uPulse;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float outer = exp(-pow((r - 0.92) / 0.025, 2.0));
  float ticks = step(0.55, fract((a + uTime * 0.8) * 16.0 / 6.2831)) * exp(-pow((r - 0.8) / 0.04, 2.0));
  float wave = exp(-pow((r - (1.0 - fract(uTime * 0.7))) / 0.05, 2.0)) * 0.5;
  float inner = (1.0 - smoothstep(0.0, 0.45, r)) * 0.25;
  float alpha = (outer + ticks * 0.9 + wave + inner + uPulse * (1.0 - smoothstep(0.0, 0.95, r)) * 0.4) * uAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor * (1.0 + outer), alpha);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

/**
 * Core (폭탄 장치) 모델 — 기본 도형으로 만든 PSX풍 장치.
 * 설치되면 불빛이 깜빡이고(남은 시간이 줄수록 빨라짐), 폭발 모양은 Vfx.explosion이 그린다.
 */
/**
 * Core 장치 본체 (원점 = 바닥 중심, 높이 약 0.46m).
 * 바닥에 놓인 Core와 손에 든 Core(무기 슬롯 4)가 같은 모델을 쓴다.
 */
export function createCoreDevice(): { group: THREE.Group; lamp: THREE.MeshLambertMaterial; keypad: THREE.Mesh } {
  const group = new THREE.Group();
  const dark = createPSXMaterial({ color: 0x2c2f35 });
  const metal = createPSXMaterial({ color: 0x6b7078 });
  const glow = createPSXMaterial({ color: 0x331a08, emissive: 0xff8a20 });
  const lamp = createPSXMaterial({ color: 0x220000, emissive: 0x000000 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.1, 8), dark);
  base.position.y = 0.05;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.3, 8), metal);
  body.position.y = 0.25;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.34, 6), glow);
  core.position.y = 0.27;
  group.add(base, body, core);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.16), dark);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 0.19, 0.22, Math.sin(a) * 0.19);
    fin.rotation.y = -a;
    group.add(fin);
  }
  // 앞면 키패드 (설치할 때 누르는 부분)
  const keypad = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.03), createPSXMaterial({ color: 0x1a1c20, emissive: 0x103010 }));
  keypad.position.set(0, 0.3, -0.17);
  keypad.rotation.x = -0.3;
  const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), lamp);
  lampMesh.position.y = 0.46;
  group.add(keypad, lampMesh);
  group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group, lamp, keypad };
}

export class CoreModel {
  readonly root = new THREE.Group();
  private device = new THREE.Group();
  private lampMat: THREE.MeshLambertMaterial;
  private light = new THREE.PointLight(0xff4020, 0, 6, 1.5);
  private ring: THREE.Mesh;
  private ringMat = createMarkerMaterial();
  /** 멀리서도 보이는 빛 기둥 */
  private beam: THREE.Mesh;
  private beamMat = createBeamMaterial(0xffd040, 0.6);
  private blastLight = new THREE.PointLight(0xffb060, 0, 40, 1.2);
  private blastTime = -1;
  private blink = 0;
  /** 0..1, 클수록 빨리 깜빡임 */
  urgency = 0;
  armed = false;

  constructor() {
    const dev = createCoreDevice();
    this.lampMat = dev.lamp;
    this.device.add(dev.group);
    this.light.position.y = 0.6;
    this.device.add(this.light);


    // 설치 위치 표시 고리 (바닥)
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.ring.renderOrder = 2;
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 6, 12, 1, true), this.beamMat);
    this.beam.geometry.translate(0, 3, 0);
    this.beam.renderOrder = 3;
    this.blastLight.position.y = 1.5;
    this.root.add(this.device, this.ring, this.beam, this.blastLight);
    this.root.visible = false;
  }

  /** 바닥에 놓인 상태 (dropped: 옆으로 누움 / planted: 세움) */
  place(pos: THREE.Vector3, mode: 'dropped' | 'planted'): void {
    this.root.position.copy(pos);
    this.root.visible = true;
    this.device.visible = true;
    this.armed = mode === 'planted';
    // 바닥에 떨어진 Core도 멀리서 보이도록 고리를 표시 (설치: 빨강, 떨어짐: 노랑)
    this.ring.visible = true;
    this.ringMat.uniforms.uColor.value.setHex(this.armed ? 0xff4020 : 0xffd040);
    this.ringMat.uniforms.uAlpha.value = 1;
    // 떨어진 Core는 빛 기둥으로 위치를 알림 (설치된 Core는 깜빡이는 불빛으로 충분)
    this.beam.visible = !this.armed;
    this.device.rotation.set(mode === 'dropped' ? Math.PI / 2 : 0, Math.random() * Math.PI, 0);
    this.device.position.y = mode === 'dropped' ? 0.2 : 0;
  }

  hide(): void {
    this.root.visible = false;
    this.armed = false;
    this.light.intensity = 0;
  }

  /** 해체됨: 불빛이 꺼짐 */
  disarm(): void {
    this.armed = false;
    this.lampMat.emissive.setHex(0x0040ff);
    this.light.intensity = 0;
    this.ring.visible = false;
    this.beam.visible = false;
  }

  explode(): void {
    this.armed = false;
    this.device.visible = false;
    this.ring.visible = false;
    this.beam.visible = false;
    this.blastTime = 0;
  }

  update(dt: number): void {
    if (this.armed) {
      // 깜빡임 주기: 1초 → 0.12초
      const period = THREE.MathUtils.lerp(1, 0.12, this.urgency);
      this.blink = (this.blink + dt / period) % 1;
      const on = this.blink < 0.35;
      this.lampMat.emissive.setHex(on ? 0xff2010 : 0x200000);
      this.light.intensity = on ? 3 : 0;
      this.ringMat.uniforms.uPulse.value = on ? 1 : 0;
    }
    if (this.blastTime >= 0) {
      this.blastTime += dt;
      const t = this.blastTime;
      // 모양은 Vfx.explosion, 여기서는 주변을 비추는 불빛만 (깜빡이며 꺼짐)
      const k = Math.max(0, 1 - t / 1.4);
      this.blastLight.intensity = 90 * k * k * (0.8 + 0.2 * Math.sin(t * 40));
      if (t > 1.4) {
        this.blastTime = -1;
        this.blastLight.intensity = 0;
      }
    }
  }

  /** 설치 직후 잠깐 깜빡임 주기 초기화 */
  resetBlink(): void {
    this.blink = 0;
    this.lampMat.emissive.setHex(0x200000);
  }
}
