import * as THREE from 'three';
import type { AABB, CollisionWorld } from '../physics/CollisionWorld';
import type { Team } from '../player/CharacterModel';
import type { WeaponDef } from '../weapons/weaponData';
import { applyDamage, MAX_RANGE, MELEE_RANGE, rawDamage, type HitPart, type Vitals } from './ballistics';
import { rayHitboxes, type Capsule } from './Hitbox';

/** 피해를 받을 수 있는 대상 (플레이어, 더미, 이후 봇/원격 플레이어) */
export interface Damageable {
  readonly id: string;
  readonly name: string;
  readonly team: Team;
  alive: boolean;
  vitals: Vitals;
  /** 대략적인 위치와 반경 (넓은 범위 검사용) */
  center(out: THREE.Vector3): THREE.Vector3;
  hitboxes(): Capsule[];
  onDamaged?(info: DamageEvent): void;
  onKilled?(info: DamageEvent): void;
  /** 무적 (피해를 받지 않음): 되살아난 직후, 질주 중 */
  invulnerable?: boolean;
  /** 치명상을 받았을 때 죽음을 피하면 true (되돌아오기 궁극기, 드론 파괴) */
  cheatDeath?(): boolean;
}

export interface Shooter {
  id: string;
  name: string;
  team: Team;
}

export interface DamageEvent {
  shooter: Shooter;
  target: Damageable;
  weapon: WeaponDef;
  part: HitPart;
  damage: number;
  /** 실제로 깎인 체력 + 방어구 */
  dealt: number;
  point: THREE.Vector3;
  from: THREE.Vector3;
  killed: boolean;
  distance: number;
}

export interface CombatEvents {
  /** 벽/바닥에 맞음 */
  onImpact?(point: THREE.Vector3, normal: THREE.Vector3, material?: string): void;
  /** 대상에 맞음 (산탄은 탄마다 호출) */
  onHit?(e: DamageEvent): void;
  /** 한 번의 사격이 끝난 뒤, 대상별로 합산된 결과 (히트마커/피해 숫자) */
  onShotResult?(shooter: Shooter, results: DamageEvent[]): void;
  onKill?(e: DamageEvent): void;
  /** 예광탄 (총구 → 착탄점) */
  onTracer?(from: THREE.Vector3, to: THREE.Vector3, shooter: Shooter): void;
}

const _c = new THREE.Vector3();

/**
 * 히트스캔 사격 판정.
 * 레이 하나(산탄은 여러 개)에 대해 벽과 대상의 피격 부위를 검사해 가장 가까운 것에 맞힌다.
 */
export class CombatSystem {
  readonly targets: Damageable[] = [];
  /** 최근 사격 결과 (테스트/디버그용) */
  lastResults: DamageEvent[] = [];
  /**
   * 피해를 정하는 쪽인지. 온라인 클라이언트는 false: 예광탄·착탄만 그리고
   * 피해·처치는 서버가 보내 준 결과를 따른다.
   */
  authority = true;

  constructor(
    private world: CollisionWorld,
    public events: CombatEvents = {},
  ) {}

  addTarget(t: Damageable): void {
    this.targets.push(t);
  }

  /**
   * @param dirs 탄 방향들 (정규화). 산탄총은 여러 개
   * @param tracerFrom 예광탄 시작점 (총구)
   */
  fire(shooter: Shooter, weapon: WeaponDef, origin: THREE.Vector3, dirs: THREE.Vector3[], tracerFrom?: THREE.Vector3): DamageEvent[] {
    const results: DamageEvent[] = [];
    dirs.forEach((dir, i) => {
      const hit = this.trace(shooter, weapon, origin, dir, MAX_RANGE);
      if (hit.event) results.push(hit.event);
      // 산탄총은 예광탄을 몇 줄만 그린다
      if (tracerFrom && (dirs.length === 1 || i % 4 === 0)) this.events.onTracer?.(tracerFrom, hit.point, shooter);
    });
    const merged = this.merge(results);
    this.lastResults = merged;
    this.events.onShotResult?.(shooter, merged);
    return merged;
  }

  /** 근접 공격 (짧은 레이 + 약간 넓은 판정) */
  melee(shooter: Shooter, weapon: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3): DamageEvent[] {
    const hit = this.trace(shooter, weapon, origin, dir, MELEE_RANGE, 0.12);
    const results = hit.event ? [hit.event] : [];
    this.lastResults = results;
    this.events.onShotResult?.(shooter, results);
    return results;
  }

  private trace(
    shooter: Shooter,
    weapon: WeaponDef,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    range: number,
    inflate = 0,
  ): { point: THREE.Vector3; event: DamageEvent | null } {
    const wall = this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range);
    const wallDist = wall ? wall.distance : range;

    let best: { t: number; target: Damageable; part: HitPart } | null = null;
    for (const t of this.targets) {
      // 아군은 맞지 않고 총알이 통과한다
      if (!t.alive || t.invulnerable || t.id === shooter.id || t.team === shooter.team) continue;
      // 넓은 범위 검사: 레이와 대상 중심의 거리
      t.center(_c);
      const toC = _c.clone().sub(origin);
      const along = toC.dot(dir);
      if (along < -1 || along > wallDist + 1.5) continue;
      if (toC.addScaledVector(dir, -along).lengthSq() > 1.6 * 1.6) continue;
      const boxes = inflate > 0 ? t.hitboxes().map((b) => ({ ...b, radius: b.radius + inflate })) : t.hitboxes();
      const h = rayHitboxes(origin, dir, boxes, wallDist);
      if (h && (!best || h.distance < best.t)) best = { t: h.distance, target: t, part: h.part };
    }

    if (!best) {
      const point = origin.clone().addScaledVector(dir, wallDist);
      if (wall) this.events.onImpact?.(point, boxNormal(wall.box, point), wall.box.material);
      return { point, event: null };
    }
    const point = origin.clone().addScaledVector(dir, best.t);
    if (!this.authority) return { point, event: null };
    const target = best.target;
    const damage = rawDamage(weapon, best.part, best.t);
    const dealt = applyDamage(target.vitals, damage);
    const killed = target.vitals.health <= 0 && !target.cheatDeath?.();
    const event: DamageEvent = {
      shooter, target, weapon, part: best.part, damage, dealt: dealt.health + dealt.armor,
      point, from: origin.clone(), killed, distance: best.t,
    };
    if (killed) target.alive = false;
    target.onDamaged?.(event);
    this.events.onHit?.(event);
    if (killed) {
      target.onKilled?.(event);
      this.events.onKill?.(event);
    }
    return { point, event };
  }

  /**
   * 총알이 아닌 피해 (능력 화염 지대, Core 폭발 등). 처치되면 일반 사격과 같은 경로로 처리된다.
   */
  applyDirectDamage(shooter: Shooter, weapon: WeaponDef, target: Damageable, damage: number, point: THREE.Vector3): DamageEvent | null {
    if (!this.authority || !target.alive || target.invulnerable || damage <= 0) return null;
    const dealt = applyDamage(target.vitals, damage);
    const killed = target.vitals.health <= 0 && !target.cheatDeath?.();
    const e: DamageEvent = {
      shooter, target, weapon, part: 'body', damage, dealt: dealt.health + dealt.armor,
      point: point.clone(), from: point.clone(), killed, distance: 0,
    };
    if (killed) target.alive = false;
    target.onDamaged?.(e);
    if (killed) {
      target.onKilled?.(e);
      this.events.onKill?.(e);
    }
    return e;
  }

  /** 같은 대상에 맞은 탄(산탄)을 하나로 합친다 */
  private merge(list: DamageEvent[]): DamageEvent[] {
    const map = new Map<Damageable, DamageEvent>();
    for (const e of list) {
      const m = map.get(e.target);
      if (!m) {
        map.set(e.target, { ...e });
      } else {
        m.damage += e.damage;
        m.dealt += e.dealt;
        m.killed ||= e.killed;
        if (e.part === 'head') m.part = 'head';
      }
    }
    return [...map.values()];
  }
}

/** 충돌 박스 표면 위의 점에서 바깥쪽 법선 */
export function boxNormal(b: AABB, p: THREE.Vector3): THREE.Vector3 {
  const d = [
    [Math.abs(p.x - b.minX), -1, 0, 0],
    [Math.abs(p.x - b.maxX), 1, 0, 0],
    [Math.abs(p.y - b.minY), 0, -1, 0],
    [Math.abs(p.y - b.maxY), 0, 1, 0],
    [Math.abs(p.z - b.minZ), 0, 0, -1],
    [Math.abs(p.z - b.maxZ), 0, 0, 1],
  ];
  d.sort((a, c) => a[0] - c[0]);
  return new THREE.Vector3(d[0][1], d[0][2], d[0][3]);
}
