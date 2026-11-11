import type { Game } from '../core/Game';
import { CATEGORY_LABEL, type ShopCategory, type ShopItem } from '../economy/Shop';

const COLUMNS: ShopCategory[][] = [['sidearm'], ['smg', 'shotgun'], ['rifle'], ['sniper'], ['shield', 'ability']];

/**
 * 구매 메뉴 (B). 좌클릭 구매 / 우클릭 환불(이번 라운드에 산 것만).
 * 열려 있는 동안 포인터 락을 풀어 마우스로 고를 수 있게 한다.
 */
export class BuyMenu {
  private root: HTMLDivElement;
  private grid: HTMLDivElement;
  private creditsEl: HTMLElement;
  private timerEl: HTMLElement;
  isOpen = false;
  private renderKey = '';

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'buy-menu';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="bm-panel">
        <header>
          <h2>ARMORY</h2>
          <div class="bm-credits"><span>CREDITS</span><b>0</b></div>
          <div class="bm-timer"></div>
          <p class="bm-help">좌클릭 구매 · 우클릭 환불 · <kbd>B</kbd> 닫기</p>
        </header>
        <div class="bm-grid"></div>
      </div>`;
    container.appendChild(this.root);
    this.grid = this.root.querySelector('.bm-grid')!;
    this.creditsEl = this.root.querySelector('.bm-credits b')!;
    this.timerEl = this.root.querySelector('.bm-timer')!;

    this.grid.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item;
      const item = id && this.items().find((i) => i.id === id);
      if (item) void this.game.shop.buy(item).then(() => this.render(true));
    });
    this.grid.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item;
      const item = id && this.items().find((i) => i.id === id);
      if (item) void this.game.shop.sell(item).then(() => this.render(true));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'Escape' || this.game.settings.bindings.buy.includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    }, true);
  }

  private items(): ShopItem[] {
    return this.game.shop.catalog();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.game.input.suspended = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.render(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.game.input.suspended = false;
    this.game.input.clear();
    if (this.game.state === 'playing' && !this.game.input.forceActive) this.game.input.requestLock();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else if (this.game.shop.open) this.open();
  }

  update(): void {
    if (!this.isOpen) return;
    const shop = this.game.shop;
    if (!shop.open) {
      this.close();
      return;
    }
    const m = this.game.match;
    this.timerEl.textContent = m ? `구매 시간 ${Math.ceil(m.rm.timeLeft)}초` : '연습 모드 · 무제한';
    this.render(false);
  }

  private render(force: boolean): void {
    const shop = this.game.shop;
    const credits = shop.credits;
    const items = this.items();
    const key = `${credits}|` + items.map((i) => `${i.id}${shop.owned(i) ? 1 : 0}${shop.refundable(i) ? 1 : 0}${i.detail}`).join(',');
    if (!force && key === this.renderKey) return;
    this.renderKey = key;
    this.creditsEl.textContent = isFinite(credits) ? credits.toLocaleString() : '∞';
    this.grid.innerHTML = COLUMNS.map(
      (cats) =>
        `<div class="bm-col">${cats
          .map(
            (c) =>
              `<h3>${CATEGORY_LABEL[c]}</h3>` +
              items
                .filter((i) => i.category === c)
                .map((i) => {
                  const owned = shop.owned(i);
                  const can = shop.canBuy(i);
                  const cls = ['bm-item', owned ? 'owned' : '', !owned && !can ? 'locked' : '', shop.refundable(i) ? 'refundable' : ''].join(' ');
                  const price = i.price === 0 ? 'FREE' : i.price.toLocaleString();
                  return `<button class="${cls}" data-item="${i.id}"><span class="bm-name">${i.name}</span><span class="bm-price">${owned ? 'OWNED' : price}</span><span class="bm-detail">${i.detail}</span></button>`;
                })
                .join(''),
          )
          .join('')}</div>`,
    ).join('');
  }
}
