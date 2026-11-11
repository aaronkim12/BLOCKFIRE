import type { Game } from '../core/Game';
import { NetClient } from '../net/NetClient';
import { TEAM_SIZE, type RoomInfo, type ServerMsg } from '../net/protocol';
import type { TeamId } from '../rounds/RoundManager';
import { MATCH_MODES, type MatchMode } from '../rounds/matchConfig';

/**
 * 온라인 대기실: 이름 → 방 만들기 / 코드로 참가 → 팀(A·B, 최대 5명)과 캐릭터 고르기 → 방장이 시작.
 * 경기가 끝나면 서버가 방을 대기 상태로 돌려 다시 이 화면으로 온다.
 */
export class OnlineLobby {
  private root: HTMLDivElement;
  private net = new NetClient();
  private onCancel: (() => void) | null = null;

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'online-lobby';
    this.root.hidden = true;
    container.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).matches('[data-field="code"]')) this.join();
      e.stopPropagation();
    });
    this.net.on((m) => this.onMessage(m));
    game.net = this.net;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(onCancel: () => void): void {
    this.onCancel = onCancel;
    this.root.hidden = false;
    this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private get name(): string {
    try {
      return localStorage.getItem('blockfire.name') || 'PLAYER';
    } catch {
      return 'PLAYER';
    }
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.net.connected) return true;
    const input = this.root.querySelector<HTMLInputElement>('[data-field="name"]');
    const name = (input?.value || this.name).trim().slice(0, 16) || 'PLAYER';
    try {
      localStorage.setItem('blockfire.name', name);
    } catch {
      /* 저장 안 됨 */
    }
    this.status('서버에 연결하는 중…');
    try {
      await this.net.connect(name, undefined, (t) => this.status(t));
      return true;
    } catch (e) {
      this.status(String((e as Error).message), true);
      return false;
    }
  }

  private async create(): Promise<void> {
    if (await this.ensureConnected()) this.net.send({ t: 'create' });
  }

  private async join(): Promise<void> {
    const code = this.root.querySelector<HTMLInputElement>('[data-field="code"]')?.value.trim().toUpperCase() ?? '';
    if (code.length !== 4) return this.status('방 코드 4글자를 입력하세요', true);
    if (await this.ensureConnected()) this.net.send({ t: 'join', code });
  }

  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act!;
    switch (act) {
      case 'create':
        void this.create();
        break;
      case 'join':
        void this.join();
        break;
      case 'team':
        this.net.send({ t: 'team', team: el.dataset.team as TeamId });
        break;
      case 'agent':
        this.net.send({ t: 'agent', agent: el.dataset.agent! });
        break;
      case 'mode':
        this.net.send({ t: 'mode', mode: el.dataset.mode as MatchMode });
        break;
      case 'start':
        this.net.send({ t: 'start' });
        break;
      case 'leave':
        this.net.send({ t: 'leave' });
        break;
      case 'back':
        this.net.send({ t: 'leave' });
        this.hide();
        this.onCancel?.();
        break;
    }
  }

  private onMessage(m: ServerMsg): void {
    if (m.t === 'error') this.status(m.msg, true);
    if (m.t === 'start') {
      this.hide();
      this.game.agentSelect.hide();
      this.game.startOnline(this.net, m.config);
    }
    if (m.t === 'room') {
      // 방장이 시작 → 캐릭터 선택 화면
      if (m.room?.phase === 'select') {
        this.root.hidden = true;
        if (!this.game.agentSelect.isOpen) this.game.agentSelect.showOnline(this.net, m.room);
        else this.game.agentSelect.updateRoom(m.room);
        return;
      }
      if (this.game.agentSelect.isOpen && this.game.mode !== 'online' && m.room?.phase !== 'match') {
        // 선택이 취소되면 (서버 연결 끊김 등) 대기실로
        this.game.agentSelect.hide();
        this.root.hidden = false;
      }
      // 경기가 끝나 대기실로 돌아옴
      if (this.game.mode === 'online' && (!m.room || !m.room.inMatch)) {
        this.game.endOnline();
        this.root.hidden = false;
        if (!m.room) this.status('서버 연결이 끊겼습니다', true);
      }
      if (!this.root.hidden) this.render();
    }
  }

  private status(text: string, error = false): void {
    const el = this.root.querySelector<HTMLElement>('.ol-status');
    if (el) {
      el.textContent = text;
      el.classList.toggle('error', error);
    }
  }

  private render(): void {
    const room = this.net.room;
    this.root.innerHTML = room ? this.roomHtml(room) : this.entryHtml();
  }

  private entryHtml(): string {
    return `
      <div class="ol-panel">
        <h2>ONLINE <small>5대5 온라인 대전</small></h2>
        <label class="ol-field">이름<input data-field="name" maxlength="16" value="${escapeHtml(this.name)}" /></label>
        <div class="ol-row">
          <button data-act="create" class="primary">방 만들기</button>
        </div>
        <div class="ol-row">
          <input data-field="code" maxlength="4" placeholder="방 코드" />
          <button data-act="join">참가</button>
        </div>
        <p class="ol-status">${escapeHtml(this.net.lastError)}</p>
        <p class="ol-hint">서버: ${escapeHtml(NetClient.defaultUrl())} · 같은 방 코드를 친구에게 알려 주세요</p>
        <nav class="ol-row"><button data-act="back">BACK</button></nav>
      </div>`;
  }

  private roomHtml(room: RoomInfo): string {
    const me = room.players.find((p) => p.id === this.net.id);
    const team = (t: TeamId) => {
      const list = room.players.filter((p) => p.team === t);
      const rows = list
        .map((p) => `<li class="${p.id === this.net.id ? 'me' : ''}"><b>${escapeHtml(p.name)}</b>${p.host ? '<em>HOST</em>' : ''}</li>`)
        .join('');
      const empty = Array.from({ length: TEAM_SIZE - list.length }, () => '<li class="empty">빈 자리</li>').join('');
      const canJoin = me && me.team !== t && list.length < TEAM_SIZE;
      return `<div class="ol-team team-${t}"><h3>TEAM ${t} <small>${list.length}/${TEAM_SIZE}</small></h3><ul>${rows}${empty}</ul>
        ${canJoin ? `<button data-act="team" data-team="${t}">이 팀으로</button>` : ''}</div>`;
    };
    return `
      <div class="ol-panel wide">
        <h2>ROOM <span class="ol-code">${room.code}</span> <small>${room.inMatch ? '경기 중' : '대기 중'}</small></h2>
        <div class="ol-teams">${team('A')}${team('B')}</div>
        <h3>경기 방식</h3>
        <div class="ol-modes">${(Object.keys(MATCH_MODES) as MatchMode[])
          .map((m) => `<button data-act="mode" data-mode="${m}" class="${room.mode === m ? 'active' : ''}" ${me?.host ? '' : 'disabled'}><b>${MATCH_MODES[m].label}</b><small>${MATCH_MODES[m].desc}</small></button>`)
          .join('')}</div>
        <p class="ol-hint">경기를 시작하면 캐릭터 선택 화면에서 캐릭터를 고릅니다 (같은 팀 중복 불가).</p>
        <p class="ol-status">${escapeHtml(this.net.lastError)}</p>
        <nav class="ol-row">
          <button data-act="leave">방 나가기</button>
          ${me?.host ? '<button data-act="start" class="primary">경기 시작</button>' : '<span class="ol-wait">방장이 시작하기를 기다리는 중…</span>'}
        </nav>
      </div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
