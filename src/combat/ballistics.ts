import type { WeaponCategory, WeaponDef } from '../weapons/weaponData';

/**
 * 사격 계산 (렌더링과 무관한 순수 로직).
 * Phase 8에서 서버가 같은 코드로 명중/피해를 판정할 수 있도록 three.js에 의존하지 않는다.
 */

const DEG = Math.PI / 180;

// ───────────────────────── 피해 ─────────────────────────

export type HitPart = 'head' | 'body' | 'leg';

/** 거리별 피해 배율 (falloff 표: [거리, 배율] — 해당 거리까지 그 배율) */
export function falloffMultiplier(def: WeaponDef, distance: number): number {
  for (const [d, m] of def.falloff) if (distance <= d) return m;
  return def.falloff[def.falloff.length - 1]?.[1] ?? 1;
}

export function rawDamage(def: WeaponDef, part: HitPart, distance: number): number {
  return Math.round(def.damage[part] * falloffMultiplier(def, distance));
}

/** 방어구는 받는 피해의 일부를 대신 흡수한다 (방어구가 남아 있는 동안) */
export const ARMOR_ABSORB = 0.66;

export interface Vitals {
  health: number;
  armor: number;
}

/** 피해 적용. 실제로 깎인 체력/방어구를 돌려준다 */
export function applyDamage(v: Vitals, damage: number): { health: number; armor: number } {
  const toArmor = Math.min(v.armor, Math.round(damage * ARMOR_ABSORB));
  const toHealth = Math.min(v.health, damage - toArmor);
  v.armor -= toArmor;
  v.health -= toHealth;
  return { health: toHealth, armor: toArmor };
}

// ───────────────────────── 탄 퍼짐 ─────────────────────────

export interface SpreadState {
  /** 수평 이동 속도 (m/s) */
  speed: number;
  grounded: boolean;
  crouching: boolean;
  /** 조준 진행도 0..1 */
  aim: number;
  /** 연사로 누적된 퍼짐 (도) */
  bloom: number;
}

/** 현재 탄 퍼짐 반각 (라디안) */
export function spreadAngle(def: WeaponDef, s: SpreadState): number {
  let deg = def.spread;
  // 저격총은 정조준하지 않으면 매우 부정확하다
  if (def.category === 'sniper') deg += 5 * (1 - s.aim);
  else deg *= 1 - 0.35 * s.aim;
  if (s.crouching) deg *= 0.85;
  // 이동 패널티: 걷기(약 3m/s)는 절반, 달리기는 전부
  const move = Math.min(1, Math.max(0, (s.speed - 0.6) / (5.4 - 0.6)));
  deg += def.moveSpread * move;
  if (!s.grounded) deg += def.category === 'shotgun' ? 2 : 7;
  deg += s.bloom;
  return deg * DEG;
}

/** 원뿔 안에서 균일한 무작위 방향 오프셋 (라디안, [yaw, pitch]) */
export function randomInCone(halfAngle: number, rand: () => number = Math.random): [number, number] {
  const r = halfAngle * Math.sqrt(rand());
  const t = rand() * Math.PI * 2;
  return [Math.cos(t) * r, Math.sin(t) * r];
}

// ───────────────────────── 반동 ─────────────────────────

export interface RecoilProfile {
  /** 한 발마다 위로 튀는 양 (도) */
  vertical: number;
  /** 좌우 흔들림 (도) — 연사 후반부에 커진다 */
  horizontal: number;
  /** 수직 반동 최대치 (도) */
  maxVertical: number;
  /** 회복 속도 (도/초) */
  recovery: number;
  /** 이 발수 이후부터 좌우로 흔들린다 */
  swayAfter: number;
  /** 한 발마다 늘어나는 탄 퍼짐 (도) */
  bloom: number;
  maxBloom: number;
}

const BASE: Record<WeaponCategory, RecoilProfile> = {
  rifle: { vertical: 0.55, horizontal: 0.35, maxVertical: 6, recovery: 14, swayAfter: 4, bloom: 0.25, maxBloom: 2.5 },
  smg: { vertical: 0.35, horizontal: 0.3, maxVertical: 4, recovery: 16, swayAfter: 5, bloom: 0.2, maxBloom: 2.2 },
  sidearm: { vertical: 1.1, horizontal: 0.25, maxVertical: 5, recovery: 18, swayAfter: 2, bloom: 0.45, maxBloom: 3 },
  shotgun: { vertical: 2.5, horizontal: 0.4, maxVertical: 6, recovery: 10, swayAfter: 1, bloom: 0, maxBloom: 0 },
  sniper: { vertical: 4, horizontal: 0.3, maxVertical: 6, recovery: 8, swayAfter: 1, bloom: 0, maxBloom: 0 },
  melee: { vertical: 0, horizontal: 0, maxVertical: 0, recovery: 30, swayAfter: 99, bloom: 0, maxBloom: 0 },
  core: { vertical: 0, horizontal: 0, maxVertical: 0, recovery: 30, swayAfter: 99, bloom: 0, maxBloom: 0 },
};

/** 무기별 반동 (카테고리 기본값을 무기의 kick 값으로 조정) */
export function recoilProfile(def: WeaponDef): RecoilProfile {
  const b = BASE[def.category];
  const k = def.category === 'rifle' || def.category === 'smg' ? def.kick / 0.9 : 1;
  return { ...b, vertical: b.vertical * k, horizontal: b.horizontal * k };
}

/**
 * 반동 상태. 사격할 때마다 조준점이 위로(그리고 연사 후반엔 좌우로) 밀리고,
 * 사격을 멈추면 원래 조준점으로 돌아온다.
 */
export class RecoilState {
  /** 조준 오프셋 (라디안) — 총알은 이 방향으로 나간다 */
  pitch = 0;
  yaw = 0;
  bloom = 0;
  shots = 0;
  private sinceShot = 99;
  private swayDir = 1;
  private profile: RecoilProfile = BASE.rifle;

  constructor(private rand: () => number = Math.random) {}

  onShot(def: WeaponDef): void {
    const p = recoilProfile(def);
    this.profile = p;
    this.shots++;
    this.sinceShot = 0;
    this.pitch = Math.min(p.maxVertical * DEG, this.pitch + p.vertical * DEG * (0.85 + this.rand() * 0.3));
    if (this.shots > p.swayAfter) {
      // 좌우로 몇 발씩 번갈아 흔들림
      if (this.rand() < 0.25) this.swayDir *= -1;
      this.yaw += this.swayDir * p.horizontal * DEG * (0.5 + this.rand());
    } else {
      this.yaw += (this.rand() - 0.5) * p.horizontal * 0.4 * DEG;
    }
    this.yaw = Math.max(-3 * DEG, Math.min(3 * DEG, this.yaw));
    this.bloom = Math.min(p.maxBloom, this.bloom + p.bloom);
  }

  update(dt: number): void {
    this.sinceShot += dt;
    if (this.sinceShot < 0.12) return;
    const r = this.profile.recovery * DEG * dt;
    const mag = Math.hypot(this.pitch, this.yaw);
    if (mag <= r) {
      this.pitch = 0;
      this.yaw = 0;
      this.shots = 0;
    } else {
      this.pitch -= (this.pitch / mag) * r;
      this.yaw -= (this.yaw / mag) * r;
    }
    this.bloom = Math.max(0, this.bloom - dt * 6);
  }

  reset(): void {
    this.pitch = this.yaw = this.bloom = 0;
    this.shots = 0;
    this.sinceShot = 99;
  }
}

/** 근접 공격 사거리 (m) */
export const MELEE_RANGE = 2.2;
/** 사격 최대 사거리 (m) */
export const MAX_RANGE = 200;
