import * as THREE from 'three';
import { MuzzleFlash } from '../effects/MuzzleFlash';
import { BladeStormVisual } from '../effects/BladeStormVisual';
import { AbilityHand } from '../effects/AbilityHand';
import { CharacterModel, type Team } from '../player/CharacterModel';
import type { WeaponCategory } from './weaponData';
import type { WeaponInventory } from './WeaponInventory';
import type { WeaponTemplate } from './WeaponModels';

/**
 * 1인칭 뷰모델 (팔 + 무기).
 * 메인 장면과 분리된 장면/카메라로 그려서 벽에 파묻히지 않고,
 * 플레이어의 시야각 설정과 관계없이 일정한 크기로 보인다.
 *
 * 팔은 3인칭과 같은 캐릭터 모델을 사용하고(머리/다리 숨김),
 * 무기 위치는 여기서 절차적으로 계산한 뒤 팔이 IK로 따라 잡는다.
 */

/** 허리 사격 위치 (카메라 공간, 손잡이 기준, m) */
const HIP: Record<WeaponCategory, [number, number, number]> = {
  rifle: [0.15, -0.19, -0.4],
  smg: [0.14, -0.18, -0.38],
  shotgun: [0.15, -0.19, -0.37],
  sniper: [0.15, -0.19, -0.38],
  sidearm: [0.12, -0.16, -0.44],
  melee: [0.18, -0.22, -0.4],
  // Core: 두 손으로 가슴 앞에 든다 (무기 원점 = 장치 중심)
  core: [0.2, -0.3, -0.62],
};

const ARM_SCALE = 1.3;

export interface ViewModelInput {
  dt: number;
  /** 수평 이동 속도 (m/s) */
  speed: number;
  grounded: boolean;
  crouch: number;
  /** 이번 프레임 마우스 이동량 (픽셀) — 무기 흔들림(sway) */
  lookDX: number;
  lookDY: number;
  /** 수직 속도 — 점프/착지 반동 */
  verticalVelocity: number;
  /** Core 설치 진행도 0..1 (설치 중이 아니면 -1) */
  plant: number;
}

/**
 * 장전 애니메이션 중 어깨를 축으로 팔을 들어 올리는 각도.
 * Mixamo 장전 자세는 총이 가슴 높이라 1인칭 화면에서는 아래로 벗어난다.
 * 몸 전체를 올리면 어깨가 카메라를 가리므로, 어깨 위치는 그대로 두고 회전만 한다.
 */
const RELOAD_RAISE = 0.32;
/** 던지기(Toss Grenade) 동작 중 같은 방식으로 팔을 드는 각도 */
const THROW_RAISE = 0.2;
/** 어깨 중심 (카메라 공간) — init()의 배치와 같아야 한다 */
const SHOULDER = new THREE.Vector3(0, -0.24, -0.08);
const _x = new THREE.Vector3(1, 0, 0);
/** Core를 바닥에 내려놓은 위치 (설치 중, 카메라 공간) */
/** 설치할 때 무릎 꿇은 눈높이 (m) — 바닥이 손이 닿는 거리에 오도록 */
export const PLANT_EYE = 0.75;
/** Core를 바닥에 내려놓은 위치 (무릎 꿇은 카메라 기준, 장치 중심) */
const CORE_GROUND = new THREE.Vector3(0, -PLANT_EYE + 0.13, -0.78);
/** 설치할 때 시선을 숙이는 각도 (라디안) */
export const PLANT_LOOK = 0.62;

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private arms: CharacterModel | null = null;
  private template: WeaponTemplate | null = null;
  private flash = new MuzzleFlash(0.16);
  /** 궁극기 투척 단검 (화면 앞에 떠다님) */
  readonly storm = new BladeStormVisual('fp');
  /** 던지는 능력을 든 손 */
  readonly abilityHand = new AbilityHand();
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  // 애니메이션 상태
  private bobPhase = 0;
  private bobAmount = 0;
  private sway = new THREE.Vector2();
  private kick = 0;
  private kickVel = 0;
  private swing = 0;
  private landing = 0;
  private lastVy = 0;
  private time = 0;
  private armsBase = new THREE.Vector3();
  /** 설치 동작 진행 (0: 들고 있음 → 1: 바닥에 내려놓음) */
  private plantBlend = 0;
  visible = true;

  /** 지금 설치 동작 때문에 숙인 시선 각도 — 게임 카메라도 같은 만큼 숙인다 */
  get plantLook(): number {
    return PLANT_LOOK * smooth(this.plantBlend);
  }

  constructor() {
    this.camera = new THREE.PerspectiveCamera(64, 1, 0.01, 10);
    this.hemi = new THREE.HemisphereLight(0xb8c4dc, 0x6a5440, 1.6);
    this.sun = new THREE.DirectionalLight(0xffe2b8, 1.6);
    this.sun.position.set(0.5, 1, 0.3);
    this.scene.add(this.hemi, this.sun, this.storm.group);
  }

  async init(team: Team): Promise<void> {
    const arms = await CharacterModel.create({ team, firstPerson: true, white: true });
    this.arms = arms;
    this.scene.add(arms.root);
    // 1인칭 팔은 실제보다 크게 만든다 (FPS 뷰모델의 일반적인 기법).
    // 실제 비율의 팔로는 화면 앞쪽에 놓인 총의 핸드가드까지 손이 닿지 않는다.
    arms.root.scale.setScalar(ARM_SCALE);
    // 어깨가 카메라 바로 아래에 오도록 몸 전체를 배치
    const shoulder = arms.shoulderCenter().multiplyScalar(ARM_SCALE);
    arms.root.position.set(-shoulder.x, -shoulder.y - 0.24, -shoulder.z - 0.08);
    arms.setHandScale(1 / ARM_SCALE);
    arms.recalibrate();
    // 무기 마운트는 카메라 원점·실제 크기로 둔다 (무기 위치를 카메라 공간 미터 단위로 지정)
    arms.weaponMount.position.copy(arms.root.position).negate().divideScalar(ARM_SCALE);
    arms.weaponMount.scale.setScalar(1 / ARM_SCALE);
    arms.calibrateHold();
    arms.calibrateItemMount();
    arms.itemMount.add(this.abilityHand.item);
    this.armsBase.copy(arms.root.position);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(template: WeaponTemplate | null): void {
    if (!this.arms) return;
    this.template = template;
    this.arms.setWeapon(template);
    this.flash.object.removeFromParent();
    if (this.arms.weapon && template?.def.category !== 'melee') this.arms.weapon.muzzle.add(this.flash.object);
  }

  /** 실내/그늘에서는 무기도 어둡게 (메인 장면의 밝기와 맞춤) */
  setLighting(inShadow: boolean, dt: number): void {
    const target = inShadow ? 0.25 : 1.6;
    this.sun.intensity += (target - this.sun.intensity) * Math.min(1, dt * 6);
  }

  onFire(): void {
    if (!this.template) return;
    if (this.template.def.id === 'storm') {
      this.storm.throwOne();
      return;
    }
    if (this.template.def.category === 'melee') {
      this.swing = 1;
      return;
    }
    this.kickVel += 9 * this.template.def.kick;
    this.flash.trigger();
  }

  update(inv: WeaponInventory, input: ViewModelInput): void {
    const arms = this.arms;
    const t = this.template;
    const storm = t?.def.id === 'storm';
    this.storm.group.visible = this.visible && storm;
    // 던지는 능력: 같은 팔 모델이 Toss Grenade 클립으로 꺼내 들고 던진다
    this.abilityHand.update(input.dt);
    const throwW = this.abilityHand.weight;
    if (storm) {
      this.storm.setCount(inv.current?.mag ?? 0);
      this.storm.update(input.dt);
    }
    if (!arms || !t || !arms.weapon) return;
    const { dt } = input;
    this.time += dt;
    const def = t.def;
    const aim = inv.aim;

    // ── 보행 흔들림 (bob)
    const moving = input.grounded ? Math.min(1, input.speed / 5.4) : 0;
    this.bobAmount += (moving - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * (4 + input.speed * 1.4);
    const bobScale = this.bobAmount * (1 - aim * 0.85);
    const bobX = Math.sin(this.bobPhase) * 0.012 * bobScale;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.012 * bobScale;

    // ── 마우스 흔들림 (sway): 무기가 시점 이동을 살짝 늦게 따라온다
    const swayK = 0.0004 * (1 - aim * 0.8);
    this.sway.x += (-input.lookDX * swayK - this.sway.x) * Math.min(1, dt * 10);
    this.sway.y += (-input.lookDY * swayK - this.sway.y) * Math.min(1, dt * 10);
    this.sway.clampLength(0, 0.06);

    // ── 점프/착지
    if (this.lastVy < -3 && input.grounded) this.landing = Math.min(1, -this.lastVy / 12);
    this.lastVy = input.grounded ? 0 : input.verticalVelocity;
    this.landing = Math.max(0, this.landing - dt * 4);
    const airLift = input.grounded ? 0 : THREE.MathUtils.clamp(-input.verticalVelocity * 0.003, -0.02, 0.02);

    // ── 사격 반동 (감쇠 스프링)
    this.kickVel += (-this.kick * 220 - this.kickVel * 22) * dt;
    this.kick += this.kickVel * dt;
    this.swing = Math.max(0, this.swing - dt * 3.5);

    // ── 숨쉬기
    const breathe = Math.sin(this.time * 1.6) * 0.003 * (1 - aim * 0.7);

    // ── 위치/회전 조합
    const hip = new THREE.Vector3(...HIP[def.category]);
    // 정조준: 총의 가장 높은 부분(가늠자/조준기)이 화면 중앙 바로 아래에 오도록
    const ads = new THREE.Vector3(0, -(t.bounds.max.y + 0.006), def.category === 'sidearm' ? -0.38 : -0.3);
    const pos = hip.lerp(ads, aim);
    const rot = new THREE.Euler(0, 0, 0, 'YXZ');
    // 허리 사격 시 총을 살짝 안쪽으로 기울임
    rot.y = 0.04 * (1 - aim);
    rot.z = 0.03 * (1 - aim);

    pos.x += bobX + this.sway.x;
    pos.y += bobY + breathe + this.sway.y - this.landing * 0.03 + airLift - input.crouch * 0.01;
    rot.y += this.sway.x * 1.5;
    rot.x += this.sway.y * 1.5;

    // 반동: 뒤로 밀리고 총구가 들림
    pos.z += this.kick * 0.03;
    rot.x += this.kick * 0.06;

    // 근접 공격: 오른쪽 위에서 왼쪽 아래로 베기
    if (this.swing > 0) {
      const s = Math.sin((1 - this.swing) * Math.PI);
      pos.x -= s * 0.12;
      pos.y += s * 0.04;
      rot.y += s * 0.9;
      rot.z += s * 0.6;
    }

    // 꺼내기: 아래에서 올라옴
    const eq = 1 - easeOutCubic(inv.equipProgress);
    pos.y -= eq * 0.25;
    rot.x -= eq * 1.0;

    // ── 재장전: 3인칭과 같은 Mixamo 장전 동작. 시작/끝 10%에서 IK 자세와 섞는다
    const rp = inv.reloadProgress;
    const animW = rp >= 0 ? smooth(Math.min(1, rp / 0.1, (1 - rp) / 0.1)) : 0;
    // 던지는 능력을 든 동안에도 팔을 살짝 들어 손이 화면 안에 오도록
    const raise = RELOAD_RAISE * animW + THROW_RAISE * throwW;
    arms.root.position.copy(this.armsBase).sub(SHOULDER).applyAxisAngle(_x, raise).add(SHOULDER);
    arms.root.rotation.x = raise;

    // ── Core: 두 손으로 들고 있다가, 설치할 때 바닥에 내려놓고 키패드를 누른다
    let tap = -1;
    if (def.category === 'core') {
      const target = input.plant >= 0 ? 1 : 0;
      this.plantBlend += Math.sign(target - this.plantBlend) * Math.min(Math.abs(target - this.plantBlend), dt * 3.5);
      const k = smooth(this.plantBlend);
      // 바닥 위치는 숙인 시선 기준이 아니라 원래 시선 기준 → 카메라를 숙인 만큼 되돌려 계산
      pos.lerp(CORE_GROUND, k);
      // 바닥에 놓인 장치는 똑바로 선다 (뷰모델 카메라만 아래를 본다)
      rot.set(rot.x * (1 - k), rot.y * (1 - k), rot.z * (1 - k));
      if (input.plant >= 0 && k > 0.95) tap = Math.max(0, Math.sin(this.time * 13));
    } else {
      this.plantBlend = 0;
    }
    this.camera.rotation.x = -this.plantLook;

    arms.weapon.root.position.copy(pos);
    arms.weapon.root.rotation.copy(rot);
    arms.updateFirstPerson(rp, animW, tap);
    if (throwW > 0.001) {
      arms.blendFirstPersonClip('grenade', this.abilityHand.clipTime, throwW);
      // 들고 있는 동안 걷기 흔들림
      arms.root.position.x += bobX * throwW;
      arms.root.position.y += bobY * throwW;
    }
    // 능력을 든 동안 총은 내려 둔다
    arms.weapon.root.visible = throwW < 0.5;
    this.flash.update(dt);
    // 저격총 정조준 시에는 조준경 화면만 보여 준다
    arms.root.visible = this.visible && !storm && !(def.category === 'sniper' && aim > 0.95 && throwW < 0.01);
  }
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
