import * as THREE from 'three';
import { PLAYER_SHAPE } from '../core/config';
import type { PlayerController } from '../player/PlayerController';
import type { Team } from '../player/CharacterModel';
import type { WeaponDef } from '../weapons/weaponData';
import { RecoilState, randomInCone, spreadAngle, type Vitals } from './ballistics';
import type { Damageable, DamageEvent } from './CombatSystem';
import type { Capsule } from './Hitbox';

export const PLAYER_MAX_HEALTH = 100;
export const PRACTICE_ARMOR = 50;
const RESPAWN_TIME = 3;

/**
 * 로컬 플레이어의 전투 상태: 체력/방어구, 반동, 탄 퍼짐, 피격 판정, 사망.
 * 1인칭에서는 플레이어 모델이 보이지 않으므로 피격 판정은 이동 충돌 박스 기준의 단순한 캡슐을 쓴다.
 */
export class LocalPlayer implements Damageable {
  readonly id = 'player';
  readonly name = 'YOU';
  team: Team = 'attack';
  /** 오버드라이브: 이동 퍼짐 없음 */
  noMoveSpread = false;
  /** 충격 상태: 탄 퍼짐 배율 */
  spreadMul = 1;
  /** 무적 (되살아난 직후·질주 중) */
  invulnerable = false;
  /** 쓰러질 피해를 받으면 대신 처리하고 true (REKINDLE) */
  cheatDeath?: () => boolean;
  alive = true;
  vitals: Vitals = { health: PLAYER_MAX_HEALTH, armor: PRACTICE_ARMOR };
  readonly recoil = new RecoilState();
  /** 사망 후 경과 시간 (살아 있으면 -1) */
  deadTime = -1;
  /** 마지막으로 계산한 탄 퍼짐 반각 (라디안) — 조준선 표시용 */
  spread = 0;
  onHurt?: (e: DamageEvent) => void;
  onDeath?: (e: DamageEvent) => void;

  constructor(private controller: PlayerController) {}

  get respawnIn(): number {
    return Math.max(0, RESPAWN_TIME - this.deadTime);
  }

  center(out: THREE.Vector3): THREE.Vector3 {
    const p = this.controller.position;
    return out.set(p.x, p.y + this.controller.height * 0.55, p.z);
  }

  hitboxes(): Capsule[] {
    const p = this.controller.position;
    const eye = p.y + this.controller.eyeHeight;
    const v = (y: number) => new THREE.Vector3(p.x, y, p.z);
    const hip = p.y + (this.controller.crouching ? 0.55 : 0.85);
    return [
      { part: 'head', a: v(eye + 0.03), b: v(eye + 0.03), radius: 0.13 },
      { part: 'body', a: v(hip), b: v(eye - 0.28), radius: 0.24 },
      { part: 'leg', a: v(p.y + 0.12), b: v(hip), radius: 0.16 },
    ];
  }

  onDamaged(e: DamageEvent): void {
    this.onHurt?.(e);
  }

  onKilled(e: DamageEvent): void {
    this.deadTime = 0;
    this.onDeath?.(e);
  }

  /** @returns 부활할 시점이 되면 true */
  update(dt: number, weapon: WeaponDef | undefined, aim: number): boolean {
    this.recoil.update(dt);
    const c = this.controller;
    if (weapon) {
      this.spread = spreadAngle(weapon, {
        speed: this.noMoveSpread ? 0 : c.horizontalSpeed,
        grounded: this.noMoveSpread || c.grounded,
        crouching: c.crouching,
        aim,
        bloom: this.recoil.bloom,
      }) * this.spreadMul;
    }
    if (!this.alive) {
      this.deadTime += dt;
      return this.deadTime >= RESPAWN_TIME;
    }
    return false;
  }

  /** 지진 등으로 공중에 띄워짐 */
  knock(vy: number): void {
    this.controller.velocity.y = Math.max(this.controller.velocity.y, vy);
    this.controller.grounded = false;
  }

  revive(armor = PRACTICE_ARMOR): void {
    this.alive = true;
    this.deadTime = -1;
    this.vitals.health = PLAYER_MAX_HEALTH;
    this.vitals.armor = armor;
    this.recoil.reset();
  }

  /**
   * 이번 사격의 탄 방향들.
   * 조준 방향 + 반동 오프셋 + 원뿔 안 무작위 퍼짐 (산탄은 탄 수만큼).
   */
  shotDirections(weapon: WeaponDef): THREE.Vector3[] {
    const c = this.controller;
    const rot = new THREE.Euler(c.pitch + this.recoil.pitch, c.yaw + this.recoil.yaw, 0, 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(rot);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const pellets = weapon.pellets ?? 1;
    // 산탄은 무기 고유의 원뿔에 이동 패널티만 더한다
    const cone = pellets > 1 ? (weapon.spread * Math.PI) / 180 + Math.max(0, this.spread - (weapon.spread * Math.PI) / 180) * 0.5 : this.spread;
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < pellets; i++) {
      const [x, y] = randomInCone(cone);
      dirs.push(forward.clone().addScaledVector(right, Math.tan(x)).addScaledVector(up, Math.tan(y)).normalize());
    }
    return dirs;
  }

  /** 근접 공격 방향 (퍼짐 없음) */
  aimDirection(): THREE.Vector3 {
    const c = this.controller;
    return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(c.pitch, c.yaw, 0, 'YXZ'));
  }

  eyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.controller.position;
    return out.set(p.x, p.y + this.controller.eyeHeight, p.z);
  }
}

export { PLAYER_SHAPE };
