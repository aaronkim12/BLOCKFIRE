import type { Game } from '../core/Game';
import { registerCustomMap } from '../maps';
import { analyzeMap, MAX_SIZE, MIN_SIZE, type FairnessReport } from '../maps/fairness';
import {
  checkCustom, decodeShare, deleteMyMap, encodeShare, loadMyMaps, newMapId, saveMyMap, THEMES, toDefinition,
  type CustomMapData, type ThemeId,
} from '../maps/custom';
import { fromGallery, listGallery, publishMap, type GalleryItem } from '../maps/gallery';
import { MERIDIAN } from '../maps/meridian';

/**
 * 맵 에디터: 격자에 칸을 칠해 맵을 만들고, 공정성 검사를 통과하면 저장·공유·게시한다.
 *   - 좌클릭 드래그: 칠하기 / 우클릭 드래그: 벽으로 지우기 / 사각형 도구
 *   - 좌우 대칭: 한쪽을 칠하면 반대쪽도 (A↔B 바뀜) — 양쪽 구역이 똑같이 공정해지도록
 *   - 오른쪽에 실시간 공정성 검사 (오류가 하나라도 있으면 게시·온라인 사용 불가)
 *   - 시험 플레이(연습 모드), 내 맵 저장, 공유 코드 복사/불러오기, 맵 게시판
 */

const TILES: { ch: string; label: string; color: string }[] = [
  { ch: '#', label: '벽', color: '#1b1f27' },
  { ch: '.', label: '바닥', color: '#5a606b' },
  { ch: '+', label: '실내 (지붕)', color: '#2c3038' },
  { ch: 'A', label: 'A 설치 구역', color: '#7a5634' },
  { ch: 'B', label: 'B 설치 구역', color: '#34567a' },
  { ch: 'T', label: '공격 스폰', color: '#7a3434' },
  { ch: 'D', label: '수비 스폰', color: '#34407a' },
  { ch: 'c', label: '상자 (낮음)', color: '#8a6a40' },
  { ch: 'C', label: '큰 상자 (시야 차단)', color: '#a0743a' },
  { ch: 'w', label: '낮은 벽', color: '#5c6068' },
  { ch: 'p', label: '기둥', color: '#70747c' },
  { ch: 'h', label: '발판 (높이 1.6m)', color: '#5a5e70' },
  { ch: 's', label: '계단 (발판 옆)', color: '#4a4e5a' },
];
const COLOR = Object.fromEntries(TILES.map((t) => [t.ch, t.color]));
const MIRROR: Record<string, string> = { A: 'B', B: 'A' };

export class MapEditor {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: CustomMapData;
  private grid: string[][] = [];
  private tile = '.';
  private brush = 1;
  private rectMode = false;
  private mirror = true;
  private painting: 0 | 1 | 2 = 0;
  private rectStart: [number, number] | null = null;
  private hover: [number, number] | null = null;
  private undo: string[][] = [];
  private checkTimer = 0;
  private open = false;

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'map-editor';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="me-top">
        <b class="me-title">MAP EDITOR</b>
        <label>이름 <input data-f="name" maxlength="20" /></label>
        <label>만든 사람 <input data-f="author" maxlength="16" /></label>
        <label>분위기 <select data-f="theme">${Object.entries(THEMES).map(([id, t]) => `<option value="${id}">${t.label}</option>`).join('')}</select></label>
        <label>크기 <input data-f="cols" type="number" min="${MIN_SIZE}" max="${MAX_SIZE}" /> × <input data-f="rows" type="number" min="${MIN_SIZE}" max="${MAX_SIZE}" /></label>
        <button data-act="resize">크기 적용</button>
        <span class="me-gap"></span>
        <button data-act="new-blank">빈 맵</button>
        <button data-act="new-example">예시에서 시작</button>
        <button data-act="close" class="primary">닫기</button>
      </header>
      <aside class="me-tools">
        <h4>칸</h4>
        <div class="me-tiles">${TILES.map((t) => `<button data-tile="${t.ch}" title="${t.label}"><i style="background:${t.color}">${/[a-z]/.test(t.ch) ? t.ch : ''}</i>${t.label}</button>`).join('')}</div>
        <h4>도구</h4>
        <div class="me-row"><span>붓 크기</span>${[1, 2, 3].map((b) => `<button data-brush="${b}">${b}</button>`).join('')}</div>
        <button data-act="rect">사각형 채우기</button>
        <button data-act="mirror">좌우 대칭</button>
        <button data-act="undo">되돌리기 (Ctrl+Z)</button>
        <p class="me-help">좌클릭: 칠하기 · 우클릭: 벽으로 지우기<br>가장자리는 항상 벽입니다.<br>좌우 대칭을 켜면 A↔B가 바뀌어 반대쪽에도 칠해집니다.</p>
      </aside>
      <main class="me-canvas"><canvas></canvas></main>
      <aside class="me-side">
        <h4>공정성 검사</h4>
        <div class="me-verdict"></div>
        <table class="me-stats"></table>
        <ul class="me-errors"></ul>
        <ul class="me-warnings"></ul>
        <nav class="me-actions">
          <button data-act="test">시험 플레이 (연습)</button>
          <button data-act="save">내 맵에 저장</button>
          <button data-act="copy">공유 코드 복사</button>
          <button data-act="import">공유 코드로 불러오기</button>
          <button data-act="publish" class="primary">맵 게시판에 올리기</button>
          <button data-act="gallery">맵 게시판 보기</button>
          <button data-act="mine">내 맵 목록</button>
        </nav>
        <p class="me-status"></p>
      </aside>
      <div class="me-modal" hidden><div class="me-modal-box"><header><b class="me-modal-title"></b><button data-act="modal-close">닫기</button></header><div class="me-modal-body"></div></div></div>`;
    container.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.map = this.fromExample();
    this.loadGrid(this.map.layout);

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
    window.addEventListener('resize', () => this.open && this.draw());
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !(e.target as HTMLElement).matches('input, textarea')) {
        e.preventDefault();
        this.doUndo();
      }
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    this.syncFields();
    this.refreshButtons();
    requestAnimationFrame(() => this.draw());
    this.scheduleCheck(0);
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.closeModal();
  }

  // ───────────────────────── 맵 데이터 ─────────────────────────

  private fromExample(): CustomMapData {
    return { id: newMapId(), name: 'MY MAP', author: '', theme: 'sunset', layout: MERIDIAN.layout.slice() };
  }

  private blank(cols = 30, rows = 30): string[] {
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 || c === 0 || r === rows - 1 || c === cols - 1 ? '#' : '.')).join(''));
  }

  private loadGrid(layout: string[]): void {
    this.grid = layout.map((r) => [...r]);
    this.undo = [];
  }

  private layout(): string[] {
    return this.grid.map((r) => r.join(''));
  }

  private current(): CustomMapData {
    return { ...this.map, layout: this.layout() };
  }

  private syncFields(): void {
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    q<HTMLInputElement>('[data-f="name"]').value = this.map.name;
    q<HTMLInputElement>('[data-f="author"]').value = this.map.author || this.game.onlineLobby?.playerName || '';
    q<HTMLSelectElement>('[data-f="theme"]').value = this.map.theme;
    q<HTMLInputElement>('[data-f="cols"]').value = String(this.grid[0].length);
    q<HTMLInputElement>('[data-f="rows"]').value = String(this.grid.length);
  }

  private refreshButtons(): void {
    this.root.querySelectorAll<HTMLElement>('[data-tile]').forEach((b) => b.classList.toggle('active', b.dataset.tile === this.tile));
    this.root.querySelectorAll<HTMLElement>('[data-brush]').forEach((b) => b.classList.toggle('active', Number(b.dataset.brush) === this.brush));
    this.root.querySelector('[data-act="rect"]')!.classList.toggle('active', this.rectMode);
    this.root.querySelector('[data-act="mirror"]')!.classList.toggle('active', this.mirror);
  }

  // ───────────────────────── 입력 ─────────────────────────

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    const f = t.dataset.f;
    if (f === 'name') this.map.name = t.value.trim().slice(0, 20) || 'MY MAP';
    if (f === 'author') this.map.author = t.value.trim().slice(0, 16);
    if (f === 'theme') this.map.theme = t.value as ThemeId;
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!el) return;
    if (el.dataset.tile) {
      this.tile = el.dataset.tile;
      this.refreshButtons();
      return;
    }
    if (el.dataset.brush) {
      this.brush = Number(el.dataset.brush);
      this.refreshButtons();
      return;
    }
    if (el.dataset.gallery !== undefined) return this.onGalleryButton(el);
    if (el.dataset.mine !== undefined) return this.onMineButton(el);
    switch (el.dataset.act) {
      case 'close':
        this.hide();
        this.game.closeMapEditor();
        break;
      case 'rect':
        this.rectMode = !this.rectMode;
        this.refreshButtons();
        break;
      case 'mirror':
        this.mirror = !this.mirror;
        this.refreshButtons();
        break;
      case 'undo':
        this.doUndo();
        break;
      case 'resize':
        this.resize();
        break;
      case 'new-blank':
        if (!confirm('지금 맵을 지우고 빈 맵으로 시작할까요?')) return;
        this.map = { id: newMapId(), name: 'MY MAP', author: this.map.author, theme: this.map.theme, layout: this.blank() };
        this.loadGrid(this.map.layout);
        this.after();
        break;
      case 'new-example':
        if (!confirm('지금 맵을 지우고 예시 맵에서 시작할까요?')) return;
        this.map = { ...this.fromExample(), author: this.map.author };
        this.loadGrid(this.map.layout);
        this.after();
        break;
      case 'test':
        this.testPlay();
        break;
      case 'save':
        this.save();
        break;
      case 'copy':
        void navigator.clipboard?.writeText(encodeShare(this.current())).then(
          () => this.status('공유 코드를 복사했습니다 — 친구가 "공유 코드로 불러오기"에 붙여 넣으면 됩니다'),
          () => this.showCode(),
        );
        if (!navigator.clipboard) this.showCode();
        break;
      case 'import': {
        const code = prompt('공유 코드를 붙여 넣으세요 (BFM1:...)');
        if (!code) return;
        const m = decodeShare(code);
        if (!m) return this.status('공유 코드를 읽을 수 없습니다', true);
        this.map = m;
        this.loadGrid(m.layout);
        this.after();
        this.status(`"${m.name}" 맵을 불러왔습니다`);
        break;
      }
      case 'publish':
        void this.publish();
        break;
      case 'gallery':
        void this.openGallery();
        break;
      case 'mine':
        this.openMine();
        break;
      case 'modal-close':
        this.closeModal();
        break;
    }
  }

  private cellAt(e: MouseEvent): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const rows = this.grid.length;
    const cols = this.grid[0].length;
    const c = Math.floor(((e.clientX - r.left) / r.width) * cols);
    const row = Math.floor(((e.clientY - r.top) / r.height) * rows);
    if (c < 0 || row < 0 || c >= cols || row >= rows) return null;
    return [row, c];
  }

  private onDown(e: MouseEvent): void {
    const cell = this.cellAt(e);
    if (!cell) return;
    e.preventDefault();
    this.pushUndo();
    this.painting = e.button === 2 ? 2 : 1;
    if (this.rectMode) this.rectStart = cell;
    else this.paintAt(cell);
    this.draw();
  }

  private onMove(e: MouseEvent): void {
    if (!this.open) return;
    this.hover = this.cellAt(e);
    if (this.painting && !this.rectMode && this.hover) this.paintAt(this.hover);
    this.draw();
  }

  private onUp(): void {
    if (!this.painting) return;
    if (this.rectMode && this.rectStart && this.hover) {
      const [r0, c0] = this.rectStart;
      const [r1, c1] = this.hover;
      for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
        for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) this.set(r, c, this.painting === 2 ? '#' : this.tile);
    }
    this.painting = 0;
    this.rectStart = null;
    this.after();
  }

  private paintAt([r, c]: [number, number]): void {
    const h = Math.floor(this.brush / 2);
    for (let dr = -h; dr < this.brush - h; dr++) for (let dc = -h; dc < this.brush - h; dc++) this.set(r + dr, c + dc, this.painting === 2 ? '#' : this.tile);
  }

  /** 칸 하나 칠하기 (가장자리는 벽 고정, 대칭이면 반대쪽도) */
  private set(r: number, c: number, ch: string): void {
    const rows = this.grid.length;
    const cols = this.grid[0].length;
    if (r <= 0 || c <= 0 || r >= rows - 1 || c >= cols - 1) return;
    this.grid[r][c] = ch;
    if (this.mirror) {
      const mc = cols - 1 - c;
      if (mc !== c) this.grid[r][mc] = MIRROR[ch] ?? ch;
    }
  }

  private pushUndo(): void {
    this.undo.push(this.layout());
    if (this.undo.length > 60) this.undo.shift();
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.grid = prev.map((r) => [...r]);
    this.after();
  }

  private resize(): void {
    const q = (s: string) => this.root.querySelector<HTMLInputElement>(s)!;
    const cols = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(q('[data-f="cols"]').value) || 30));
    const rows = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(q('[data-f="rows"]').value) || 30));
    this.pushUndo();
    const old = this.grid;
    this.grid = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => (r === 0 || c === 0 || r === rows - 1 || c === cols - 1 ? '#' : old[r]?.[c] && r < old.length - 1 && c < old[0].length - 1 ? old[r][c] : '.')),
    );
    this.after();
  }

  /** 편집 뒤: 다시 그리고 잠시 뒤 검사 */
  private after(): void {
    this.syncFields();
    this.draw();
    this.scheduleCheck(250);
  }

  // ───────────────────────── 검사 ─────────────────────────

  private scheduleCheck(ms: number): void {
    clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.runCheck(), ms);
  }

  private runCheck(): FairnessReport {
    const def = toDefinition(this.current());
    const r = analyzeMap(def);
    const ok = r.errors.length === 0;
    const v = this.root.querySelector('.me-verdict')!;
    v.className = `me-verdict ${ok ? 'ok' : 'bad'}`;
    v.textContent = ok ? '✔ 공정성 검사 통과 — 저장·게시·온라인 사용 가능' : `✘ 고칠 곳 ${r.errors.length}개`;
    const s = r.stats;
    this.root.querySelector('.me-stats')!.innerHTML = s
      ? `<tr><th></th><th>A</th><th>B</th></tr>
         <tr><td>공격 스폰 → 구역</td><td>${s.atkToA}칸</td><td>${s.atkToB}칸</td></tr>
         <tr><td>수비 스폰 → 구역</td><td>${s.defToA}칸</td><td>${s.defToB}칸</td></tr>
         <tr><td>구역 입구</td><td>${s.entrancesA}곳</td><td>${s.entrancesB}곳</td></tr>
         <tr><td>스폰 사이</td><td colspan="2">${s.spawnGap}칸 · A↔B ${s.rotate}칸</td></tr>`
      : '';
    const list = (sel: string, items: string[]) => {
      const ul = this.root.querySelector(sel)!;
      ul.innerHTML = '';
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
      }
    };
    list('.me-errors', r.errors);
    list('.me-warnings', r.warnings);
    return r;
  }

  // ───────────────────────── 동작 ─────────────────────────

  private testPlay(): void {
    const r = this.runCheck();
    if (!r.stats) return this.status('시험 플레이하려면 먼저 스폰·구역을 놓고 모든 곳에 갈 수 있게 만들어 주세요', true);
    const def = toDefinition(this.current());
    registerCustomMap(def, r.errors.length === 0);
    this.hide();
    this.game.testCustomMap(def.id);
  }

  private save(): void {
    const r = this.runCheck();
    const m = this.current();
    saveMyMap(m);
    const def = toDefinition(m);
    if (r.errors.length === 0) {
      registerCustomMap(def, true);
      this.status(`"${m.name}" 저장 완료 — 연습·봇 대전·온라인 맵 선택에 나옵니다`);
    } else {
      registerCustomMap(def, false);
      this.status(`"${m.name}" 저장했지만 공정성 검사를 통과해야 맵 선택에 나옵니다`, true);
    }
  }

  private async publish(): Promise<void> {
    const r = this.runCheck();
    if (r.errors.length) return this.status('공정성 검사를 통과한 맵만 올릴 수 있습니다', true);
    const m = this.current();
    if (!m.author) return this.status('"만든 사람"을 적어 주세요', true);
    this.save();
    this.status('게시하는 중…');
    try {
      await publishMap(m);
      this.status(`"${m.name}"을(를) 맵 게시판에 올렸습니다!`);
    } catch (e) {
      this.status((e as Error).message, true);
    }
  }

  private gallery: GalleryItem[] = [];

  private async openGallery(): Promise<void> {
    this.openModal('맵 게시판', '<p class="me-loading">불러오는 중…</p>');
    try {
      this.gallery = await listGallery();
    } catch (e) {
      this.setModalBody(`<p class="me-bad">${escapeHtml((e as Error).message)}</p>`);
      return;
    }
    if (!this.gallery.length) return this.setModalBody('<p>아직 올라온 맵이 없습니다. 첫 번째로 올려 보세요!</p>');
    const rows = this.gallery
      .map((g, i) => {
        const m = fromGallery(g);
        const ok = m ? checkCustom(toDefinition(m)).errors.length === 0 : false;
        return `<li class="${ok ? '' : 'bad'}"><b>${escapeHtml(g.name)}</b><span>${escapeHtml(g.author)} · ${g.cols}×${g.rows}${ok ? '' : ' · 검사 미통과'}</span>
          <button data-gallery="edit" data-i="${i}">에디터로 열기</button>
          <button data-gallery="add" data-i="${i}" ${ok ? '' : 'disabled'}>내 맵에 추가</button></li>`;
      })
      .join('');
    this.setModalBody(`<ul class="me-list">${rows}</ul>`);
  }

  private onGalleryButton(el: HTMLElement): void {
    const g = this.gallery[Number(el.dataset.i)];
    const m = g && fromGallery(g);
    if (!m) return;
    if (el.dataset.gallery === 'edit') {
      this.map = { ...m, id: newMapId() };
      this.loadGrid(m.layout);
      this.closeModal();
      this.after();
      this.status(`"${m.name}"을(를) 에디터로 불러왔습니다 (고쳐서 내 맵으로 저장할 수 있음)`);
    } else {
      saveMyMap(m);
      registerCustomMap(toDefinition(m), true);
      el.textContent = '추가됨 ✔';
      (el as HTMLButtonElement).disabled = true;
    }
  }

  private openMine(): void {
    const list = loadMyMaps();
    if (!list.length) return this.openModal('내 맵', '<p>저장한 맵이 없습니다.</p>');
    const rows = list
      .map((m) => {
        const ok = checkCustom(toDefinition(m)).errors.length === 0;
        return `<li class="${ok ? '' : 'bad'}"><b>${escapeHtml(m.name)}</b><span>${m.layout[0].length}×${m.layout.length}${ok ? ' · 검사 통과' : ' · 검사 미통과'}</span>
          <button data-mine="edit" data-id="${m.id}">열기</button><button data-mine="del" data-id="${m.id}">삭제</button></li>`;
      })
      .join('');
    this.openModal('내 맵', `<ul class="me-list">${rows}</ul>`);
  }

  private onMineButton(el: HTMLElement): void {
    const m = loadMyMaps().find((x) => x.id === el.dataset.id);
    if (!m) return;
    if (el.dataset.mine === 'edit') {
      this.map = m;
      this.loadGrid(m.layout);
      this.closeModal();
      this.after();
    } else if (confirm(`"${m.name}"을(를) 삭제할까요?`)) {
      deleteMyMap(m.id);
      this.openMine();
    }
  }

  private showCode(): void {
    this.openModal('공유 코드', `<textarea class="me-code" readonly>${encodeShare(this.current())}</textarea><p>위 코드를 복사해 친구에게 보내세요.</p>`);
  }

  private openModal(title: string, body: string): void {
    const m = this.root.querySelector<HTMLElement>('.me-modal')!;
    m.hidden = false;
    this.root.querySelector('.me-modal-title')!.textContent = title;
    this.setModalBody(body);
  }

  private setModalBody(html: string): void {
    this.root.querySelector('.me-modal-body')!.innerHTML = html;
  }

  private closeModal(): void {
    this.root.querySelector<HTMLElement>('.me-modal')!.hidden = true;
  }

  private status(text: string, bad = false): void {
    const p = this.root.querySelector('.me-status')!;
    p.textContent = text;
    p.classList.toggle('bad', bad);
  }

  // ───────────────────────── 그리기 ─────────────────────────

  private draw(): void {
    if (!this.open) return;
    const host = this.canvas.parentElement!;
    const rows = this.grid.length;
    const cols = this.grid[0].length;
    const px = Math.max(6, Math.floor(Math.min(host.clientWidth / cols, host.clientHeight / rows)));
    if (this.canvas.width !== cols * px || this.canvas.height !== rows * px) {
      this.canvas.width = cols * px;
      this.canvas.height = rows * px;
    }
    const g = this.ctx;
    g.fillStyle = '#07090d';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.font = `bold ${Math.floor(px * 0.6)}px Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const ch = this.grid[r][c];
        g.fillStyle = COLOR[ch] ?? '#3a3f48';
        g.fillRect(c * px, r * px, px - 1, px - 1);
        if (/[a-zA-Z]/.test(ch) && ch !== 'A' && ch !== 'B' && ch !== 'T' && ch !== 'D') {
          g.fillStyle = 'rgba(255,255,255,0.75)';
          g.fillText(ch, c * px + px / 2, r * px + px / 2);
        }
      }
    // 구역·스폰 글자
    g.font = `bold ${Math.floor(px * 1.6)}px Consolas, monospace`;
    for (const ch of ['A', 'B', 'T', 'D']) {
      let n = 0, sr = 0, sc = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (this.grid[r][c] === ch) { n++; sr += r; sc += c; }
      if (!n) continue;
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillText(ch === 'T' ? '공격' : ch === 'D' ? '수비' : ch, (sc / n + 0.5) * px, (sr / n + 0.5) * px);
    }
    // 대칭선
    if (this.mirror) {
      g.strokeStyle = 'rgba(159,227,255,0.35)';
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo((cols / 2) * px, 0);
      g.lineTo((cols / 2) * px, rows * px);
      g.stroke();
      g.setLineDash([]);
    }
    // 사각형 미리보기 / 붓 위치
    if (this.hover) {
      g.strokeStyle = '#9fe3ff';
      g.lineWidth = 2;
      if (this.rectMode && this.rectStart) {
        const [r0, c0] = this.rectStart;
        const [r1, c1] = this.hover;
        g.strokeRect(Math.min(c0, c1) * px, Math.min(r0, r1) * px, (Math.abs(c1 - c0) + 1) * px, (Math.abs(r1 - r0) + 1) * px);
      } else {
        const h = Math.floor(this.brush / 2);
        g.strokeRect((this.hover[1] - h) * px, (this.hover[0] - h) * px, this.brush * px, this.brush * px);
      }
      g.lineWidth = 1;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
