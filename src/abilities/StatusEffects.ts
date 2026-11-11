import type { Damageable } from '../combat/CombatSystem';

/**
 * 능력이 거는 상태 이상 (대상 id 기준, 플레이어·봇·더미 공통).
 *   concuss  충격: 이동이 느려지고 조준이 흔들린다 (탄 퍼짐 증가, 화면 흔들림)
 *   suppress 억제: 능력을 쓸 수 없다
 *   jam      무력화: 주무기를 쓸 수 없다 (권총·칼만)
 *   slow     감속: 이동 속도 15% 감소
 *   haste    가속: 이동 속도 10% 증가
 *   stim     자극: 연사·이동 속도 10% 증가
 *   decay    쇠약: 체력이 일시적으로 깎였다가 시간이 지나면 돌아온다 (이것만으로는 죽지 않음)
 *   overheal 추가 체력: 100을 넘는 체력 (최대 150). 정해진 시간이 지나면 사라진다
 */
export type StatusKind = 'concuss' | 'suppress' | 'jam' | 'slow' | 'haste' | 'stim';

interface Decay {
  target: Damageable;
  /** 아직 돌려받지 못한 체력 */
  amount: number;
  /** 회복 시작까지 */
  delay: number;
}

export class StatusEffects {
  private timers = new Map<string, Map<StatusKind, number>>();
  private decays: Decay[] = [];
  private overheal = new Map<string, { target: Damageable; t: number }>();

  apply(id: string, kind: StatusKind, duration: number): void {
    let m = this.timers.get(id);
    if (!m) this.timers.set(id, (m = new Map()));
    m.set(kind, Math.max(m.get(kind) ?? 0, duration));
  }

  /** 서버가 보낸 상태로 덮어쓴다 (온라인: 내 상태 이상은 서버가 정함) */
  setAll(id: string, rec: Partial<Record<StatusKind, number>>): void {
    const m = new Map<StatusKind, number>();
    for (const [k, t] of Object.entries(rec)) if (t && t > 0) m.set(k as StatusKind, t);
    this.timers.set(id, m);
  }

  has(id: string, kind: StatusKind): boolean {
    return (this.timers.get(id)?.get(kind) ?? 0) > 0;
  }

  remaining(id: string, kind: StatusKind): number {
    return this.timers.get(id)?.get(kind) ?? 0;
  }

  /** 이동 속도 배율 */
  speedMul(id: string): number {
    let k = 1;
    if (this.has(id, 'slow')) k *= 0.85;
    if (this.has(id, 'concuss')) k *= 0.65;
    if (this.has(id, 'haste')) k *= 1.1;
    if (this.has(id, 'stim')) k *= 1.1;
    return k;
  }

  /** 연사 속도 배율 */
  fireRateMul(id: string): number {
    return this.has(id, 'stim') ? 1.1 : 1;
  }

  /** 쇠약: 체력을 amount만큼 깎는다 (1 아래로는 내려가지 않음). delay초 뒤부터 서서히 돌아온다 */
  decay(target: Damageable, amount: number, delay: number): void {
    const v = target.vitals;
    const take = Math.max(0, Math.min(amount, v.health - 1));
    if (take <= 0) return;
    v.health -= take;
    this.decays.push({ target, amount: take, delay });
  }

  /** 지금 쇠약으로 깎여 있는 체력 (HUD 표시용) */
  decayed(id: string): number {
    let n = 0;
    for (const d of this.decays) if (d.target.id === id) n += d.amount;
    return n;
  }

  /** 추가 체력: 체력 +amount (최대 150), duration초 뒤 100을 넘는 만큼은 사라진다 */
  addOverheal(target: Damageable, amount: number, duration = 10): void {
    target.vitals.health = Math.min(150, target.vitals.health + amount);
    this.overheal.set(target.id, { target, t: duration });
  }

  update(dt: number): void {
    for (const m of this.timers.values())
      for (const [k, t] of m) {
        if (t - dt <= 0) m.delete(k);
        else m.set(k, t - dt);
      }
    for (let i = this.decays.length - 1; i >= 0; i--) {
      const d = this.decays[i];
      if (!d.target.alive) {
        this.decays.splice(i, 1);
        continue;
      }
      d.delay -= dt;
      if (d.delay > 0) continue;
      const back = Math.min(d.amount, 20 * dt);
      d.target.vitals.health = Math.min(this.overheal.has(d.target.id) ? 150 : 100, d.target.vitals.health + back);
      d.amount -= back;
      if (d.amount <= 0.01) this.decays.splice(i, 1);
    }
    for (const [id, o] of this.overheal) {
      o.t -= dt;
      if (!o.target.alive || o.target.vitals.health <= 100) {
        this.overheal.delete(id);
        continue;
      }
      if (o.t <= 0) {
        o.target.vitals.health = 100;
        this.overheal.delete(id);
      }
    }
  }

  clear(): void {
    this.timers.clear();
    this.decays = [];
    this.overheal.clear();
  }
}
