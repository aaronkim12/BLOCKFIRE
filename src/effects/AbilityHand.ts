import * as THREE from 'three';
import { createPSXMaterial } from '../graphics/PSXMaterial';

/**
 * 1인칭: 던지는 능력을 손에 들고 있다가 던지는 동작.
 * 팔은 따로 만들지 않고, 1인칭 팔 모델(Y Bot)이 Mixamo "Toss Grenade" 클립을 재생한다.
 * 이 클래스는 클립의 어느 시점을 얼마나 섞을지(시간·가중치)와 손에 쥔 물건만 관리한다.
 *
 * Toss Grenade 클립 (3.2초) 분석:
 *   0 ~ 0.7   소총을 내리고 수류탄을 꺼냄
 *   ~1.12     오른손으로 수류탄을 앞에 들고 있음      ← 들고 있는 자세
 *   1.2 ~ 1.7 팔을 뒤로 젖힘 (와인드업)
 *   ~1.84     앞으로 뿌리며 손을 떠남                  ← 발동 시점
 *   2.0 ~ 3.2 소총 자세로 돌아옴
 *
 * 물건 종류
 *   orb     화염구·빛 구슬 (손 위에서 일렁이는 불꽃)
 *   beacon  신호기 (불빛이 깜빡이는 원통 장치)
 *   grenade 수류탄·소이탄 (가운데 띠가 빛남)
 *   shard   파편 (빛나는 결정)
 */
export type ThrowItem = 'orb' | 'beacon' | 'grenade' | 'shard';

/** 클립 안의 시점 (초) */
const HOLD_T = 1.12;
const RELEASE_T = 1.84;
const CLIP_END = 3.2;
/** 던지기 구간 재생 배속 (실제 게임처럼 빠르게) */
const THROW_SPEED = 2.2;
/** 손을 떠난 뒤 소총 자세로 돌아오는 구간 배속 */
const RETURN_SPEED = 3.2;

/** 던지기 시작부터 손을 떠나는 시점까지 (초) */
export const THROW_RELEASE = (RELEASE_T - HOLD_T) / THROW_SPEED;
/** 던지기 동작 전체 길이 (초) */
export const THROW_TIME = THROW_RELEASE + (CLIP_END - RELEASE_T) / RETURN_SPEED;

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
  /** 손에 쥔 물건 (팔 모델의 오른손 마운트에 붙인다) */
  readonly item = new THREE.Group();
  private model: THREE.Group | null = null;
  private itemKey = '';
  private flames: THREE.Sprite[] = [];
  private time = 0;
  /** 던지기 진행 (초, -1이면 들고 있기) */
  private throwT = -1;
  private show = 0;
  private holding = false;

  /** 팔 자세를 클립 쪽으로 섞는 정도 0..1 */
  get weight(): number {
    // 던진 뒤 소총 자세로 돌아오는 끝 무렵에 무기 IK 자세로 넘겨준다
    if (this.throwT >= 0) return smooth((CLIP_END - this.clipTime) / 0.7);
    return smooth(this.show);
  }

  /** 지금 재생할 클립 시점 (초) */
  get clipTime(): number {
    if (this.throwT < 0) return HOLD_T + Math.sin(this.time * 2.1) * 0.015;
    if (this.throwT < THROW_RELEASE) return HOLD_T + this.throwT * THROW_SPEED;
    return Math.min(CLIP_END - 0.01, RELEASE_T + (this.throwT - THROW_RELEASE) * RETURN_SPEED);
  }

  get active(): boolean {
    return this.weight > 0.01;
  }

  get throwing(): boolean {
    return this.throwT >= 0;
  }

  /** 손에 들기 (null이면 집어넣기) */
  setHeld(item: ThrowItem | null, color = 0xffffff): void {
    this.holding = !!item;
    if (!item) return;
    const key = `${item}:${color}`;
    if (key === this.itemKey && this.model) return;
    this.itemKey = key;
    if (this.model) this.item.remove(this.model);
    this.model = this.buildItem(item, color);
    this.item.add(this.model);
  }

  /** 던지기 시작 (THROW_RELEASE초 뒤에 손을 떠남). 좌·우클릭 같은 동작, 날아가는 거리만 다름 */
  throw(_underhand = false): void {
    this.throwT = 0;
  }

  private buildItem(kind: ThrowItem, color: number): THREE.Group {
    const g = new THREE.Group();
    this.flames = [];
    if (kind === 'orb') {
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 1), createPSXMaterial({ color: 0xffffff, emissive: color }));
      g.add(core, glowSprite(color, 0.11));
      for (let i = 0; i < 5; i++) {
        const f = glowSprite(color, 0.045);
        g.add(f);
        this.flames.push(f);
      }
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
    } else if (kind === 'grenade') {
      const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.036, 0), createPSXMaterial({ color: 0x44484f }));
      body.scale.set(1, 1.25, 1);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.037, 0.007, 4, 10), createPSXMaterial({ color: 0x111111, emissive: color }));
      band.rotation.x = Math.PI / 2;
      const glow = glowSprite(color, 0.07);
      this.flames.push(glow);
      g.add(body, band, glow);
    } else {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.04, 0), createPSXMaterial({ color: 0xdddddd, emissive: color }));
      crystal.scale.set(0.8, 1.4, 0.8);
      const glow = glowSprite(color, 0.14);
      this.flames.push(glow);
      g.add(crystal, glow);
    }
    return g;
  }

  update(dt: number): void {
    this.time += dt;
    // 꺼내기/집어넣기
    const want = this.holding ? 1 : 0;
    this.show += Math.sign(want - this.show) * Math.min(Math.abs(want - this.show), dt * 6);
    if (this.throwT >= 0) {
      this.throwT += dt;
      if (this.throwT >= THROW_TIME) {
        this.throwT = -1;
        this.holding = false;
        this.show = 0;
      }
    }
    // 물건은 손을 떠나기 전까지만 (꺼낼 때는 손이 반쯤 올라왔을 때부터)
    this.item.visible = this.throwT >= 0 ? this.throwT < THROW_RELEASE : this.holding && this.show > 0.5;
    if (!this.model || !this.item.visible) return;
    this.model.rotation.y += dt * 2;
    // 불꽃: 위로 피어오르며 반복
    this.flames.forEach((f, i) => {
      const ph = (this.time * 1.6 + i / Math.max(1, this.flames.length)) % 1;
      if (this.flames.length > 1) {
        f.position.set(Math.sin(i * 2.3 + this.time * 3) * 0.022, 0.01 + ph * 0.08, Math.cos(i * 1.7 + this.time * 2.6) * 0.02);
        (f.material as THREE.SpriteMaterial).opacity = (1 - ph) * 0.9;
        f.scale.setScalar(0.05 * (1 - ph * 0.6));
      } else {
        (f.material as THREE.SpriteMaterial).opacity = 0.6 + 0.4 * Math.sin(this.time * 9);
      }
    });
  }
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
