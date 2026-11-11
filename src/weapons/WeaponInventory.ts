import type { WeaponDef, WeaponSlot } from './weaponData';
import type { WeaponTemplate } from './WeaponModels';

export interface OwnedWeapon {
  def: WeaponDef;
  template: WeaponTemplate;
  mag: number;
  reserve: number;
}

export type WeaponState = 'equipping' | 'ready' | 'reloading';

export interface WeaponControls {
  fireHeld: boolean;
  firePressed: boolean;
  reloadPressed: boolean;
  aimHeld: boolean;
  /** 이번 프레임에 선택한 슬롯 (없으면 null) */
  selectSlot: WeaponSlot | null;
  /** +1 다음 무기, -1 이전 무기, 0 없음 */
  cycle: number;
  lastWeapon: boolean;
}

export interface WeaponEvents {
  onFire?: (w: OwnedWeapon) => void;
  onDryFire?: (w: OwnedWeapon) => void;
  onSwitch?: (w: OwnedWeapon) => void;
  onReloadStart?: (w: OwnedWeapon) => void;
}

/**
 * 플레이어가 가진 무기 (슬롯 1 주무기 / 2 보조무기 / 3 근접)와 무기 상태 머신.
 *   equipping → ready ⇄ reloading
 * 사격 판정(명중/피해)은 Phase 4에서 onFire 이벤트에 연결한다.
 */
export class WeaponInventory {
  private slots = new Map<WeaponSlot, OwnedWeapon>();
  currentSlot: WeaponSlot = 2;
  private previousSlot: WeaponSlot | null = null;
  state: WeaponState = 'equipping';
  private stateTime = 0;
  private cooldown = 0;
  /** 조준 진행도 0..1 */
  aim = 0;
  /** 연습 모드: 탄약이 줄지 않음 */
  infiniteAmmo = false;
  /** 연사 속도 배율 (능력 버프) */
  fireRateMul = 1;

  constructor(private events: WeaponEvents = {}) {}

  get current(): OwnedWeapon | undefined {
    return this.slots.get(this.currentSlot);
  }

  get(slot: WeaponSlot): OwnedWeapon | undefined {
    return this.slots.get(slot);
  }

  /** 꺼내기 진행도 0..1 */
  get equipProgress(): number {
    const w = this.current;
    if (!w || this.state !== 'equipping') return 1;
    return Math.min(1, this.stateTime / w.def.equipTime);
  }

  /** 재장전 진행도 0..1, 재장전 중이 아니면 -1 */
  get reloadProgress(): number {
    const w = this.current;
    if (!w || this.state !== 'reloading') return -1;
    return Math.min(1, this.stateTime / w.def.reloadTime);
  }

  give(def: WeaponDef, template: WeaponTemplate, equip = false): void {
    this.slots.set(def.slot, { def, template, mag: def.magazine, reserve: def.reserve });
    if (equip || def.slot === this.currentSlot) this.switchTo(def.slot, true);
  }

  /** 무기를 모두 뺀다 (경기 시작 / 사망 후 라운드 시작) */
  clear(): void {
    this.slots.clear();
  }

  /** 모든 무기의 탄약을 가득 채운다 (부활 시) */
  refill(): void {
    for (const w of this.slots.values()) {
      w.mag = w.def.magazine;
      w.reserve = w.def.reserve;
    }
  }

  remove(slot: WeaponSlot): void {
    this.slots.delete(slot);
    if (slot === this.currentSlot) this.switchToBest();
  }

  /** 가진 무기 중 가장 우선순위가 높은 슬롯으로 */
  switchToBest(): void {
    for (const s of [1, 2, 3, 4] as WeaponSlot[]) {
      if (this.slots.has(s)) {
        this.switchTo(s, true);
        return;
      }
    }
  }

  switchTo(slot: WeaponSlot, force = false): void {
    const w = this.slots.get(slot);
    if (!w) return;
    if (!force && slot === this.currentSlot) return;
    if (slot !== this.currentSlot) this.previousSlot = this.currentSlot;
    this.currentSlot = slot;
    this.setState('equipping');
    this.cooldown = 0;
    this.events.onSwitch?.(w);
  }

  update(dt: number, c: WeaponControls): void {
    this.stateTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // ── 무기 교체 (재장전 중에도 가능, 재장전은 취소된다)
    if (c.selectSlot) this.switchTo(c.selectSlot);
    else if (c.lastWeapon && this.previousSlot && this.slots.has(this.previousSlot)) this.switchTo(this.previousSlot);
    else if (c.cycle !== 0) this.cycle(c.cycle);

    const w = this.current;
    if (!w) return;

    if (this.state === 'equipping' && this.stateTime >= w.def.equipTime) this.setState('ready');
    if (this.state === 'reloading' && this.stateTime >= w.def.reloadTime) {
      const need = w.def.magazine - w.mag;
      const take = this.infiniteAmmo ? need : Math.min(need, w.reserve);
      w.mag += take;
      if (!this.infiniteAmmo) w.reserve -= take;
      this.setState('ready');
    }

    // ── 재장전
    if (c.reloadPressed && this.canReload(w)) this.startReload(w);

    // ── 사격
    const wantsFire = w.def.category !== 'core' && (w.def.automatic ? c.fireHeld : c.firePressed);
    if (wantsFire && this.cooldown === 0) {
      if (this.state === 'reloading' && w.mag > 0 && w.def.category === 'shotgun') {
        // 산탄총은 장전 중에도 남은 탄으로 바로 쏠 수 있다
        this.setState('ready');
      }
      if (this.state === 'ready') {
        if (w.def.magazine === 0 || w.mag > 0) {
          if (w.def.magazine > 0 && !this.infiniteAmmo) w.mag--;
          this.cooldown = 1 / (w.def.fireRate * this.fireRateMul);
          this.events.onFire?.(w);
        } else if (c.firePressed) {
          this.events.onDryFire?.(w);
          if (this.canReload(w)) this.startReload(w);
        }
      }
    }
    // 탄창이 비면 자동 재장전
    if (this.state === 'ready' && w.def.magazine > 0 && w.mag === 0 && this.cooldown === 0 && this.canReload(w))
      this.startReload(w);

    // ── 조준 (준비 상태에서만)
    const aimTarget = c.aimHeld && this.state === 'ready' && w.def.adsZoom > 1 ? 1 : 0;
    const aimSpeed = w.def.category === 'sniper' ? 5 : 8;
    this.aim += Math.sign(aimTarget - this.aim) * Math.min(Math.abs(aimTarget - this.aim), dt * aimSpeed);
  }

  private cycle(dir: number): void {
    const order: WeaponSlot[] = [1, 2, 3, 4];
    let i = order.indexOf(this.currentSlot);
    for (let n = 0; n < 4; n++) {
      i = (i + dir + 4) % 4;
      if (this.slots.has(order[i])) {
        this.switchTo(order[i]);
        return;
      }
    }
  }

  private canReload(w: OwnedWeapon): boolean {
    return (
      w.def.magazine > 0 &&
      w.mag < w.def.magazine &&
      (w.reserve > 0 || this.infiniteAmmo) &&
      this.state === 'ready'
    );
  }

  private startReload(w: OwnedWeapon): void {
    this.setState('reloading');
    this.events.onReloadStart?.(w);
  }

  private setState(s: WeaponState): void {
    this.state = s;
    this.stateTime = 0;
  }
}
