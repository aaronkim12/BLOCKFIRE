import type { AbilitySlot } from '../abilities/abilityData';
import type { Game } from '../core/Game';
import { WEAPONS, getWeapon, type WeaponCategory, type WeaponDef } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import { OnlineMatch } from '../net/OnlineMatch';

/**
 * 구매 메뉴의 상품과 구매/환불 처리.
 * 크레딧: 경기에서는 Economy, 연습 모드에서는 무제한.
 * 구매 단계 동안 이번 라운드에 산 물건은 우클릭으로 환불할 수 있다.
 */

export type ShopCategory = 'sidearm' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'shield' | 'ability';

export interface ShopItem {
  id: string;
  category: ShopCategory;
  name: string;
  price: number;
  /** 카드에 보일 한 줄 설명 */
  detail: string;
  weapon?: WeaponDef;
  shield?: number;
  ability?: AbilitySlot;
}

export const CATEGORY_LABEL: Record<ShopCategory, string> = {
  sidearm: '권총',
  smg: '기관단총',
  shotgun: '산탄총',
  rifle: '돌격소총',
  sniper: '저격소총',
  shield: '방어구',
  ability: '능력',
};

export const SHIELDS = [
  { id: 'shield-light', name: 'LIGHT SHIELD', value: 25, price: 400 },
  { id: 'shield-heavy', name: 'HEAVY SHIELD', value: 50, price: 1000 },
];

interface Purchase {
  item: ShopItem;
  paid: number;
  /** 되돌릴 이전 상태 */
  prevWeapon?: string | null;
  prevArmor?: number;
}

export class Shop {
  private purchases: Purchase[] = [];

  constructor(private game: Game) {}

  /** 상품 목록 (현재 에이전트의 능력 포함) */
  catalog(): ShopItem[] {
    const items: ShopItem[] = [];
    const cats: WeaponCategory[] = ['sidearm', 'smg', 'shotgun', 'rifle', 'sniper'];
    for (const c of cats)
      for (const w of WEAPONS.filter((w) => w.category === c))
        items.push({
          id: w.id,
          category: c as ShopCategory,
          name: w.name,
          price: w.price,
          detail: `${w.damage.head}/${w.damage.body}/${w.damage.leg} · ${w.fireRate}발/초 · ${w.magazine}발`,
          weapon: w,
        });
    for (const s of SHIELDS) items.push({ id: s.id, category: 'shield', name: s.name, price: s.price, detail: `방어구 ${s.value}`, shield: s.value });
    const ab = this.game.abilities;
    for (const slot of ['ability1', 'ability2'] as AbilitySlot[]) {
      const d = ab.def(slot);
      items.push({ id: `ability-${slot}`, category: 'ability', name: d.name, price: d.cost, detail: `${ab.charges[slot]}/${d.maxCharges} 충전`, ability: slot });
    }
    return items;
  }

  get credits(): number {
    const g = this.game;
    return g.match ? g.match.economy.get('player') : Infinity;
  }

  /** 지금 살 수 있는 시간/장소인지 */
  get open(): boolean {
    const g = this.game;
    if (!g.match) return true;
    return g.match.rm.state === 'BuyPhase' && g.local.alive;
  }

  owned(item: ShopItem): boolean {
    const g = this.game;
    if (item.weapon) return g.inventory.get(item.weapon.slot)?.def.id === item.weapon.id;
    if (item.shield) return g.local.vitals.armor >= item.shield;
    if (item.ability) return !g.abilities.canBuy(item.ability);
    return false;
  }

  /** 이번 라운드에 산 상품 (환불 가능) */
  /** 바닥에 버린 무기: 이번 구매 단계 환불 목록에서 뺀다 (버리고 환불받는 것 방지) */
  forget(itemId: string): void {
    this.purchases = this.purchases.filter((p) => p.item.id !== itemId);
  }

  refundable(item: ShopItem): boolean {
    const m = this.game.match;
    if (m instanceof OnlineMatch) return m.refundable.includes(item.id);
    return this.purchases.some((p) => p.item.id === item.id);
  }

  canBuy(item: ShopItem): boolean {
    return this.open && !this.owned(item) && item.price <= this.credits;
  }

  async buy(item: ShopItem): Promise<boolean> {
    if (!this.canBuy(item)) return false;
    const g = this.game;
    // 온라인: 서버가 크레딧·장비를 정하고 스냅샷으로 알려 준다
    if (g.match instanceof OnlineMatch) {
      g.net?.send({ t: 'buy', item: item.id });
      g.sound.play('ui', { gain: 0.7 });
      return true;
    }
    if (g.match && !(g.match.economy as import('./Economy').Economy).spend('player', item.price)) return false;
    const p: Purchase = { item, paid: item.price };
    if (item.weapon) {
      p.prevWeapon = g.inventory.get(item.weapon.slot)?.def.id ?? null;
      g.inventory.give(item.weapon, await loadWeaponTemplate(item.weapon), true);
    } else if (item.shield) {
      p.prevArmor = g.local.vitals.armor;
      g.local.vitals.armor = item.shield;
    } else if (item.ability) {
      g.abilities.buyCharge(item.ability);
    }
    this.purchases.push(p);
    g.sound.play('ui', { gain: 0.7 });
    return true;
  }

  /** 이번 라운드에 산 것을 되돌리고 환불 */
  async sell(item: ShopItem): Promise<boolean> {
    if (!this.open) return false;
    if (this.game.match instanceof OnlineMatch) {
      if (!this.refundable(item)) return false;
      this.game.net?.send({ t: 'sell', item: item.id });
      this.game.sound.play('ui', { gain: 0.5, pitch: 0.7 });
      return true;
    }
    const i = this.purchases.map((p) => p.item.id).lastIndexOf(item.id);
    if (i < 0) return false;
    const p = this.purchases.splice(i, 1)[0];
    const g = this.game;
    if (item.weapon) {
      if (p.prevWeapon) {
        const prev = getWeapon(p.prevWeapon);
        g.inventory.give(prev, await loadWeaponTemplate(prev), true);
      } else {
        g.inventory.remove(item.weapon.slot);
      }
    } else if (item.shield) {
      g.local.vitals.armor = p.prevArmor ?? 0;
    } else if (item.ability) {
      g.abilities.sellCharge(item.ability);
    }
    (g.match?.economy as import('./Economy').Economy | undefined)?.refund('player', p.paid);
    g.sound.play('ui', { gain: 0.5, pitch: 0.7 });
    return true;
  }

  /** 구매 단계가 끝나면 환불 기록을 지운다 */
  lockIn(): void {
    this.purchases = [];
  }
}
