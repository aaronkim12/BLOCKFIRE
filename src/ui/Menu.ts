import type { Game, GameState } from '../core/Game';
import { DEFAULT_BINDINGS, GRAPHICS_PRESETS, type Action, type GraphicsPreset } from '../core/settings';
import { WEAPONS } from '../weapons/weaponData';

const ACTION_LABELS: Record<Action, string> = {
  forward: '앞으로',
  back: '뒤로',
  left: '왼쪽',
  right: '오른쪽',
  jump: '점프',
  walk: '걷기',
  crouch: '앉기',
  fire: '사격',
  aim: '조준',
  reload: '재장전',
  interact: '상호작용',
  buy: '구매 메뉴',
  scoreboard: '점수판',
  slot1: '주무기',
  slot2: '보조무기',
  slot3: '근접무기',
  nextWeapon: '다음 무기',
  prevWeapon: '이전 무기',
  lastWeapon: '직전 무기',
  slot4: 'Core',
  ability1: '능력 1',
  ability2: '능력 2',
  signature: '고유 능력',
  ultimate: '궁극기',
  drop: 'Core 버리기',
};

function keyLabel(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  if (code === 'WheelUp') return 'Wheel ↑';
  if (code === 'WheelDown') return 'Wheel ↓';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Left', ' L').replace('Right', ' R');
}

/** 메인 메뉴 · 일시정지 메뉴 · 설정 화면 */
export class Menu {
  private root: HTMLDivElement;
  private main: HTMLDivElement;
  private pause: HTMLDivElement;
  private settingsPanel: HTMLDivElement;
  private returnTo: 'main' | 'pause' = 'main';
  private rebinding: Action | null = null;

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'menu-layer';
    this.root.innerHTML = `
      <div class="menu main-menu">
        <h1 class="logo">BLOCK<span>FIRE</span><sup class="beta">BETA</sup></h1>
        <p class="tagline">TACTICAL // RETRO // 5v5</p>
        <nav>
          <button data-act="play">PLAY <small>온라인 5대5</small></button>
          <button data-act="match" class="primary">MATCH <small>5대5 · 봇 대전</small></button>
          <button data-act="practice">PRACTICE</button>
          <button data-act="collection" disabled title="Phase 6 이후 구현 예정">COLLECTION <small>준비 중</small></button>
          <button data-act="settings">SETTINGS</button>
        </nav>
        <a class="feedback-link" href="https://forms.gle/xcjLgypmjX18rDAN7" target="_blank" rel="noopener noreferrer">💬 추가했으면 하는 기능 알려주기 <small>설문 참여</small></a>
        <p class="build">BUILD 0.8 · PHASE 8 · MAP: <span class="map-name">${game.map.def.name}</span></p>
      </div>
      <div class="menu pause-menu">
        <h2>PAUSED</h2>
        <nav>
          <button data-act="resume" class="primary">RESUME</button>
          <button data-act="settings">SETTINGS</button>
          <button data-act="respawn">RESPAWN</button>
          <button data-act="mainmenu">MAIN MENU</button>
        </nav>
        <div class="practice-grid">
          <label>주무기</label><select data-practice="primary"></select>
          <label>보조무기</label><select data-practice="secondary"></select>
          <label>무한 탄약</label><input type="checkbox" data-practice="infinite" />
          <label>더미 반격</label><input type="checkbox" data-practice="shoot" />
          <label>능력 무제한</label><input type="checkbox" data-practice="abilities" />
        </div>
        <p class="lock-hint"></p>
      </div>
      <div class="menu settings-panel">
        <h2>SETTINGS</h2>
        <div class="settings-grid"></div>
        <h3>KEY BINDINGS <small>클릭 후 새 키를 누르세요</small></h3>
        <div class="bindings-grid"></div>
        <nav class="row">
          <button data-act="reset-binds">기본값 복원</button>
          <button data-act="back" class="primary">BACK</button>
        </nav>
      </div>
    `;
    container.appendChild(this.root);
    this.main = this.root.querySelector('.main-menu')!;
    this.pause = this.root.querySelector('.pause-menu')!;
    this.settingsPanel = this.root.querySelector('.settings-panel')!;

    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.disabled) return;
      this.onAction(btn.dataset.act ?? '', btn);
    });
    window.addEventListener('keydown', this.onRebindKey, true);
    window.addEventListener('mousedown', this.onRebindMouse, true);

    this.buildSettings();
    this.buildBindings();
    this.buildPractice();
  }

  /** 연습 모드 무기 선택 */
  private buildPractice(): void {
    const g = this.game;
    for (const slot of ['primary', 'secondary'] as const) {
      const sel = this.pause.querySelector<HTMLSelectElement>(`select[data-practice="${slot}"]`)!;
      for (const w of WEAPONS.filter((w) => w.slot === (slot === 'primary' ? 1 : 2)))
        sel.add(new Option(`${w.name} (${w.category})`, w.id, false, w.id === g.practiceLoadout[slot]));
      sel.addEventListener('change', () => void g.setPracticeWeapon(slot, sel.value));
    }
    const inf = this.pause.querySelector<HTMLInputElement>('input[data-practice="infinite"]')!;
    inf.checked = g.inventory.infiniteAmmo;
    inf.addEventListener('change', () => (g.inventory.infiniteAmmo = inf.checked));
    const shoot = this.pause.querySelector<HTMLInputElement>('input[data-practice="shoot"]')!;
    shoot.checked = g.dummiesShoot;
    shoot.addEventListener('change', () => (g.dummiesShoot = shoot.checked));
    const abil = this.pause.querySelector<HTMLInputElement>('input[data-practice="abilities"]')!;
    abil.checked = g.infiniteAbilities;
    abil.addEventListener('change', () => {
      g.infiniteAbilities = abil.checked;
      g.abilities.infinite = abil.checked;
      if (abil.checked) g.abilities.fill();
    });
  }

  /** 캐릭터 선택에서 BACK을 누르면 메뉴를 다시 보인다 */
  private restoreOnCancel(): void {
    const check = () => {
      const sel = document.querySelector('.agent-select') as HTMLElement | null;
      if (sel && !sel.hidden) return requestAnimationFrame(check);
      if (this.game.state === 'menu') this.root.hidden = false;
    };
    requestAnimationFrame(check);
  }

  /** 맵이 바뀌면 메뉴의 맵 이름 갱신 */
  refresh(): void {
    const el = this.root.querySelector('.map-name');
    if (el) el.textContent = this.game.map.def.name;
  }

  show(state: GameState): void {
    this.root.hidden = state === 'playing';
    // 로딩 중에는 LoadingScreen이 화면을 덮는다
    this.main.hidden = state !== 'menu';
    for (const act of ['practice', 'match', 'play']) this.main.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)!.disabled = state === 'loading';
    // 연습 옵션은 연습 모드에서만
    this.pause.querySelector<HTMLElement>('.practice-grid')!.hidden = this.game.mode !== 'practice';
    this.pause.querySelector<HTMLElement>('button[data-act="respawn"]')!.hidden = this.game.mode !== 'practice';
    this.pause.hidden = state !== 'paused';
    this.settingsPanel.hidden = true;
    this.root.classList.toggle('dim', state === 'paused');
  }

  private onAction(act: string, btn: HTMLButtonElement): void {
    const g = this.game;
    switch (act) {
      case 'match':
        this.root.hidden = true;
        g.agentSelect.show('MATCH · 5대5 봇 대전', () => g.startMatch());
        this.restoreOnCancel();
        break;
      case 'play':
        this.root.hidden = true;
        g.onlineLobby.show(() => {
          if (g.state === 'menu') this.root.hidden = false;
        });
        break;
      case 'practice':
        this.root.hidden = true;
        g.agentSelect.show('PRACTICE', () => g.startPractice());
        this.restoreOnCancel();
        break;
      case 'resume':
        g.resume();
        // 포인터 락 해제 직후에는 브라우저가 재잠금을 거부할 수 있다
        setTimeout(() => {
          if (g.state === 'paused')
            this.pause.querySelector('.lock-hint')!.textContent = '잠시 후 RESUME을 다시 눌러주세요.';
        }, 300);
        break;
      case 'respawn':
        g.respawn();
        g.resume();
        break;
      case 'mainmenu':
        g.toMainMenu();
        break;
      case 'settings':
        this.returnTo = g.state === 'paused' ? 'pause' : 'main';
        this.main.hidden = this.pause.hidden = true;
        this.settingsPanel.hidden = false;
        break;
      case 'back':
        this.rebinding = null;
        this.settingsPanel.hidden = true;
        (this.returnTo === 'pause' ? this.pause : this.main).hidden = false;
        break;
      case 'reset-binds':
        g.settings.bindings = structuredClone(DEFAULT_BINDINGS);
        g.applySettings();
        this.buildBindings();
        break;
      case 'rebind':
        this.rebinding = btn.dataset.action as Action;
        btn.textContent = '...';
        btn.classList.add('waiting');
        break;
    }
  }

  private buildSettings(): void {
    const s = this.game.settings;
    const grid = this.settingsPanel.querySelector('.settings-grid')!;
    grid.innerHTML = '';

    const addRow = (label: string, control: HTMLElement) => {
      const l = document.createElement('label');
      l.textContent = label;
      grid.append(l, control);
    };
    const apply = () => this.game.applySettings();

    const slider = (min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const wrap = document.createElement('div');
      wrap.className = 'slider';
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min, max, step, value: String(get()) });
      const out = document.createElement('output');
      out.textContent = fmt(get());
      input.addEventListener('input', () => {
        set(Number(input.value));
        out.textContent = fmt(Number(input.value));
        apply();
      });
      wrap.append(input, out);
      return wrap;
    };
    const toggle = (get: () => boolean, set: (v: boolean) => void) => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = get();
      input.addEventListener('change', () => {
        set(input.checked);
        apply();
      });
      return input;
    };
    const select = (options: [string, number][], get: () => number, set: (v: number) => void) => {
      const sel = document.createElement('select');
      for (const [label, v] of options) sel.add(new Option(label, String(v), false, v === get()));
      sel.addEventListener('change', () => {
        set(Number(sel.value));
        apply();
      });
      return sel;
    };

    addRow('마우스 감도', slider(0.1, 5, 0.05, () => s.sensitivity, (v) => (s.sensitivity = v), (v) => v.toFixed(2)));
    addRow('시야각 (수평)', slider(70, 110, 1, () => s.fov, (v) => (s.fov = v), (v) => `${v}°`));
    addRow('효과음 음량', slider(0, 1, 0.05, () => s.volume, (v) => (s.volume = v), (v) => `${Math.round(v * 100)}%`));
    addRow('마우스 Y 반전', toggle(() => s.invertY, (v) => (s.invertY = v)));
    // 프리셋을 고르면 아래 세부 항목을 다시 그린다
    const presetSel = document.createElement('select');
    presetSel.add(new Option('사용자 지정', ''));
    for (const [id, label] of [['classic', '클래식 PS1'], ['modern', '레트로 모던 (권장)'], ['clean', '선명']] as const)
      presetSel.add(new Option(label, id, false, JSON.stringify(GRAPHICS_PRESETS[id]) === JSON.stringify(s.psx)));
    presetSel.addEventListener('change', () => {
      const id = presetSel.value as GraphicsPreset | '';
      if (!id) return;
      s.psx = { ...GRAPHICS_PRESETS[id] };
      apply();
      this.buildSettings();
    });
    addRow('그래픽 프리셋', presetSel);
    const levels: [string, number][] = [['끔', 0], ['약하게', 1], ['강하게', 2]];
    addRow(
      '픽셀 크기',
      select(
        [['1x (네이티브)', 1], ['2x (권장)', 2], ['3x', 3], ['4x (PS1)', 4]],
        () => s.psx.pixelScale,
        (v) => (s.psx.pixelScale = v),
      ),
    );
    addRow(
      '색상 깊이',
      select(
        [['4비트', 4], ['5비트 (PS1)', 5], ['6비트', 6], ['8비트 (끔)', 8]],
        () => s.psx.colorBits,
        (v) => (s.psx.colorBits = v),
      ),
    );
    addRow('버텍스 지터', select(levels, () => s.psx.vertexJitter, (v) => (s.psx.vertexJitter = v)));
    addRow('아핀 텍스처 왜곡', select(levels, () => s.psx.affineWarp, (v) => (s.psx.affineWarp = v)));
    addRow('디더링', toggle(() => s.psx.dithering, (v) => (s.psx.dithering = v)));
    addRow('안개', toggle(() => s.psx.fog, (v) => (s.psx.fog = v)));
    addRow('디버그 정보', toggle(() => s.showDebug, (v) => (s.showDebug = v)));
  }

  private buildBindings(): void {
    const grid = this.settingsPanel.querySelector('.bindings-grid')!;
    grid.innerHTML = '';
    const b = this.game.settings.bindings;
    for (const action of Object.keys(ACTION_LABELS) as Action[]) {
      const l = document.createElement('label');
      l.textContent = ACTION_LABELS[action];
      const btn = document.createElement('button');
      btn.dataset.act = 'rebind';
      btn.dataset.action = action;
      btn.className = 'bind';
      btn.textContent = b[action].map(keyLabel).join(' / ') || '—';
      grid.append(l, btn);
    }
  }

  private finishRebind(code: string): void {
    if (!this.rebinding) return;
    if (code !== 'Escape') {
      this.game.settings.bindings[this.rebinding] = [code];
      this.game.applySettings();
    }
    this.rebinding = null;
    this.buildBindings();
  }

  private onRebindKey = (e: KeyboardEvent): void => {
    if (!this.rebinding) return;
    e.preventDefault();
    e.stopPropagation();
    this.finishRebind(e.code);
  };

  private onRebindMouse = (e: MouseEvent): void => {
    if (!this.rebinding) return;
    // 바인딩 버튼 자체를 누른 첫 클릭은 무시 (click 이벤트로 대기 상태가 된다)
    if ((e.target as HTMLElement).closest('button.waiting')) return;
    e.preventDefault();
    e.stopPropagation();
    this.finishRebind(`Mouse${e.button}`);
  };
}
