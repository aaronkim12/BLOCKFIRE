import type { Game } from '../core/Game';
import type { TeamId } from '../rounds/RoundManager';

/**
 * 온라인 경기 채팅.
 *   Enter: 채팅 입력 열기 → 다시 Enter로 보내기 · Esc 취소 · Tab: 전체 ↔ 팀 채팅 전환
 *   메시지는 화면 왼쪽 아래에 쌓이고 10초 뒤 흐려진다 (입력 중에는 모두 보임)
 */
export class ChatBox {
  private root: HTMLDivElement;
  private log: HTMLDivElement;
  private bar: HTMLDivElement;
  private input: HTMLInputElement;
  private mode: HTMLSpanElement;
  private typing = false;
  private teamOnly = false;

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'chat-box';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="chat-log"></div><div class="chat-bar" hidden><span class="chat-mode"></span><input maxlength="120" placeholder="메시지 입력 · Enter 보내기 · Tab 전체/팀 · Esc 취소" /></div>`;
    container.appendChild(this.root);
    this.log = this.root.querySelector('.chat-log')!;
    this.bar = this.root.querySelector('.chat-bar')!;
    this.input = this.root.querySelector('input')!;
    this.mode = this.root.querySelector('.chat-mode')!;

    window.addEventListener('keydown', (e) => {
      if (this.typing || this.root.hidden || this.game.state !== 'playing') return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.openInput();
      }
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.send();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.closeInput();
      } else if (e.code === 'Tab') {
        e.preventDefault();
        this.teamOnly = !this.teamOnly;
        this.updateMode();
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get isTyping(): boolean {
    return this.typing;
  }

  /** 온라인 경기 중에만 보인다 */
  setVisible(on: boolean): void {
    if (this.root.hidden === !on) return;
    this.root.hidden = !on;
    if (!on) this.closeInput();
  }

  private openInput(): void {
    this.typing = true;
    this.bar.hidden = false;
    this.root.classList.add('typing');
    this.updateMode();
    // 입력하는 동안 게임 조작 멈춤 (걷기·사격 키가 글자로 들어가지 않게)
    this.game.input.suspended = true;
    this.game.input.clear();
    this.input.value = '';
    this.input.focus();
  }

  private closeInput(): void {
    if (!this.typing) return;
    this.typing = false;
    this.bar.hidden = true;
    this.root.classList.remove('typing');
    this.input.blur();
    this.game.input.suspended = false;
    this.game.input.clear();
  }

  private updateMode(): void {
    this.mode.textContent = this.teamOnly ? '[팀]' : '[전체]';
    this.mode.className = `chat-mode ${this.teamOnly ? 'team' : 'all'}`;
  }

  private send(): void {
    const text = this.input.value.trim();
    if (text) this.game.net?.send({ t: 'chat', text, team: this.teamOnly });
    this.closeInput();
  }

  /** 받은 메시지 */
  add(m: { name: string; team: TeamId; text: string; teamOnly: boolean }): void {
    const line = document.createElement('div');
    line.className = `chat-line team-${m.team}`;
    const tag = document.createElement('em');
    tag.textContent = m.teamOnly ? '[팀] ' : '[전체] ';
    const name = document.createElement('b');
    name.textContent = `${m.name}: `;
    const text = document.createElement('span');
    text.textContent = m.text;
    line.append(tag, name, text);
    this.log.appendChild(line);
    while (this.log.children.length > 30) this.log.firstElementChild!.remove();
    // 10초 뒤 흐리게 (입력 중에는 CSS가 다시 보이게 함)
    setTimeout(() => line.classList.add('old'), 10000);
  }

  clear(): void {
    this.log.innerHTML = '';
  }
}
