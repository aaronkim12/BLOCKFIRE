import * as THREE from 'three';
import { createPSXMaterial } from '../graphics/PSXMaterial';

/**
 * 1인칭: 던지는 능력을 손에 들고 있다가 던지는 모습 (뷰모델 장면, 카메라 공간 m).
 *   orb     화염구·빛 구슬 (손 위에서 일렁이는 불꽃)
 *   beacon  신호기 (불빛이 깜빡이는 원통 장치)
 *   grenade 수류탄·소이탄 (가운데 띠가 빛남)
 *   shard   파편 (빛나는 결정)
 * 좌클릭: 오버핸드 — 팔을 뒤로 젖혔다가 앞으로 내리꽂으며 놓는다
 * 우클릭: 언더핸드 — 아래에서 앞으로 올려 던진다
 */
export type ThrowItem = 'orb' | 'beacon' | 'grenade' | 'shard';

/** 던지기 동작 길이와 손을 떠나는 시점 (초) */
export const THROW_TIME = 0.38;
export const THROW_RELEASE = 0.18;

const SKIN = 0xe9e6e1;
const JOINT = 0x2a2c30;

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

function glowSprite(color: number, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size);
  return s;
}

export class AbilityHand {
  readonly group = new THREE.Group();
  /** 팔 (손목이 원점, 팔뚝은 뒤쪽 +Z) */
  private arm = new THREE.Group();
  private hold = new THREE.Group();
  private item: THREE.Group | null = null;
  private itemKey = '';
  private flames: THREE.Sprite[] = [];
  private time = 0;
  /** 던지기 진행 (초, -1이면 들고 있기) */
  private throwT = -1;
  private underhand = false;
  private show = 0;
  private holding = false;

  constructor() {
    const skin = createPSXMaterial({ color: SKIN });
    const joint = createPSXMaterial({ color: JOINT });
    // 팔뚝 (소매 + 피부), 손바닥, 손가락 (물건을 감싸 쥔 모양)
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.3), skin);
    forearm.position.set(0.0, -0.045, 0.19);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.12), joint);
    sleeve.position.set(0.0, -0.045, 0.34);
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.04), joint);
    wrist.position.set(0, -0.045, 0.035);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.035, 0.09), skin);
    palm.position.set(0, -0.05, -0.02);
    this.arm.add(forearm, sleeve, wrist, palm);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.022), skin);
      f.position.set(-0.033 + i * 0.022, -0.02, -0.07);
      f.rotation.x = -0.5;
      this.arm.add(f);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.045, 0.022), skin);
    thumb.position.set(-0.058, -0.03, -0.01);
    thumb.rotation.z = 0.7;
    this.arm.add(thumb);
    // 손 위에 물건 (손바닥 위 0.04m)
    this.hold.position.set(0, -0.0, -0.03);
    this.arm.add(this.hold);
    this.group.add(this.arm);
    this.group.visible = false;
    this.group.traverse((o) => (o.renderOrder = 5));
  }

  get active(): boolean {
    return this.group.visible;
  }

  get throwing(): boolean {
    return this.throwT >= 0;
  }

  /** 손에 들기 (null이면 집어넣기) */
  setHeld(item: ThrowItem | null, color = 0xffffff): void {
    this.holding = !!item;
    if (!item) return;
    const key = `${item}:${color}`;
    if (key === this.itemKey && this.item) return;
    this.itemKey = key;
    if (this.item) this.hold.remove(this.item);
    this.item = this.buildItem(item, color);
    this.hold.add(this.item);
  }

  /** 던지기 시작 (THROW_RELEASE초 뒤에 손을 떠남) */
  throw(underhand: boolean): void {
    this.throwT = 0;
    this.underhand = underhand;
  }

  private buildItem(kind: ThrowItem, color: number): THREE.Group {
    const g = new THREE.Group();
    this.flames = [];
    if (kind === 'orb') {
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 1), createPSXMaterial({ color: 0xffffff, emissive: color }));
      g.add(core, glowSprite(color, 0.1));
      // 손 위에서 일렁이는 불꽃 / 빛 조각
      for (let i = 0; i < 5; i++) {
        const f = glowSprite(color, 0.04);
        g.add(f);
        this.flames.push(f);
      }
      g.position.y = 0.035;
    } else if (kind === 'beacon') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.08, 8), createPSXMaterial({ color: 0x3a3e46 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 4, 10), createPSXMaterial({ color: 0x222222, emissive: color }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.02;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 4), createPSXMaterial({ color: 0xffffff, emissive: color }));
      lamp.position.y = 0.05;
      const glow = glowSprite(color, 0.09);
      glow.position.y = 0.05;
      this.flames.push(glow);
      g.add(body, ring, lamp, glow);
      g.position.y = 0.04;
    } else if (kind === 'grenade') {
      const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.036, 0), createPSXMaterial({ color: 0x44484f }));
      body.scale.set(1, 1.25, 1);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.037, 0.007, 4, 10), createPSXMaterial({ color: 0x111111, emissive: color }));
      band.rotation.x = Math.PI / 2;
      const glow = glowSprite(color, 0.07);
      this.flames.push(glow);
      g.add(body, band, glow);
      g.position.y = 0.04;
    } else {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.04, 0), createPSXMaterial({ color: 0xdddddd, emissive: color }));
      crystal.scale.set(0.8, 1.4, 0.8);
      const glow = glowSprite(color, 0.14);
      this.flames.push(glow);
      g.add(crystal, glow);
      g.position.y = 0.045;
    }
    return g;
  }

  update(dt: number, bob: { x: number; y: number }): void {
    this.time += dt;
    // 나타나기/사라지기 (아래에서 올라옴)
    const want = this.holding || this.throwT >= 0 ? 1 : 0;
    this.show += Math.sign(want - this.show) * Math.min(Math.abs(want - this.show), dt * 7);
    this.group.visible = this.show > 0.01;
    if (!this.group.visible) return;
    const e = 1 - Math.pow(1 - this.show, 3);
    // 들고 있는 자세: 화면 오른쪽 아래, 손바닥을 위로
    const pos = new THREE.Vector3(0.27 + bob.x, -0.24 + bob.y - (1 - e) * 0.25, -0.62);
    const rot = new THREE.Euler(0.45, -0.25, 0.1, 'YXZ');
    pos.y += Math.sin(this.time * 2.1) * 0.004;
    let itemVisible = true;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const t = this.throwT;
      if (!this.underhand) {
        // 오버핸드: 뒤로 젖혀 올렸다가(0~0.18) 앞으로 내리꽂고(0.18~0.26) 아래로 빠짐
        const wind = smooth(Math.min(1, t / THROW_RELEASE));
        const snap = smooth(Math.min(1, Math.max(0, (t - THROW_RELEASE) / 0.08)));
        const drop = smooth(Math.max(0, (t - 0.26) / 0.12));
        pos.add(new THREE.Vector3(0.05 * wind - 0.08 * snap, 0.17 * wind - 0.22 * snap - 0.2 * drop, 0.12 * wind - 0.3 * snap));
        rot.x += -0.9 * wind + 1.6 * snap;
        rot.z += -0.3 * wind + 0.2 * snap;
      } else {
        // 언더핸드: 아래로 내렸다가 앞으로 올려 놓음
        const wind = smooth(Math.min(1, t / THROW_RELEASE));
        const snap = smooth(Math.min(1, Math.max(0, (t - THROW_RELEASE) / 0.09)));
        const drop = smooth(Math.max(0, (t - 0.27) / 0.11));
        pos.add(new THREE.Vector3(-0.02 * wind - 0.04 * snap, -0.1 * wind + 0.16 * snap - 0.24 * drop, 0.08 * wind - 0.28 * snap));
        rot.x += 0.5 * wind - 0.9 * snap;
      }
      itemVisible = t < THROW_RELEASE;
      if (t >= THROW_TIME) {
        this.throwT = -1;
        this.holding = false;
      }
    }
    this.arm.position.copy(pos);
    this.arm.rotation.copy(rot);
    if (this.item) {
      this.item.visible = itemVisible;
      this.item.rotation.y += dt * 2;
      // 불꽃: 위로 피어오르며 반복
      this.flames.forEach((f, i) => {
        const ph = (this.time * 1.6 + i / Math.max(1, this.flames.length)) % 1;
        if (this.flames.length > 1) {
          f.position.set(Math.sin(i * 2.3 + this.time * 3) * 0.022, 0.01 + ph * 0.08, Math.cos(i * 1.7 + this.time * 2.6) * 0.02);
          (f.material as THREE.SpriteMaterial).opacity = (1 - ph) * 0.9;
          f.scale.setScalar(0.045 * (1 - ph * 0.6));
        } else {
          (f.material as THREE.SpriteMaterial).opacity = 0.6 + 0.4 * Math.sin(this.time * 9);
        }
      });
    }
  }
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
