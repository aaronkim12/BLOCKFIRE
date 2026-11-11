import { AGENTS, ROLE_LABEL, SLOTS, type AbilitySlot, type AgentDef, type RoleClass } from '../abilities/abilityData';
import { DIFFICULTY_LABEL, type BotDifficulty } from '../ai/botConfig';
import { MATCH_MODES, withMode, type MatchMode } from '../rounds/matchConfig';
import type { Game } from '../core/Game';
import { AgentPreview } from './AgentPreview';
import type { NetClient } from '../net/NetClient';
import type { RoomInfo } from '../net/protocol';
import { effectIcon, roleIcon } from './icons';

const SLOT_LABEL: Record<AbilitySlot, string> = { ability1: '기본', ability2: '기본', signature: '고유', ultimate: '궁극기' };
const ROLES: (RoleClass | 'all')[] = ['all', 'duelist', 'initiator', 'sentinel', 'controller'];

/**
 * 경기/연습 시작 전 캐릭터 선택 화면.
 *   왼쪽: 역할군 필터, 캐릭터 정보, 능력 4개 (선택한 능력의 설명을 크게)
 *   가운데: 대표 색으로 칠한 3D 캐릭터 미리보기 (드래그로 회전)
 *   아래: 캐릭터 목록 (역할 아이콘 + 이니셜)
 *   오른쪽 아래: 봇 난이도(경기) · BACK · LOCK IN
 */
export class AgentSelect {
  private root: HTMLDivElement;
  private selected: string;
  private role: RoleClass | 'all' = 'all';
  private focusSlot: AbilitySlot = 'signature';
  private onConfirm: (() => void) | null = null;
  private preview = new AgentPreview();
  private locking = false;
  /** 온라인 캐릭터 선택 (서버가 확정·시간 관리) */
  private net: NetClient | null = null;
  private room: RoomInfo | null = null;
  /** 선택 마감 시각 (내 시계, ms) */
  private selectEnds = 0;
  private clock = 0;

  constructor(container: HTMLElement, private game: Game) {
    this.selected = game.agentId;
    this.root = document.createElement('div');
    this.root.className = 'agent-select';
    this.root.hidden = true;
    container.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('mouseover', (e) => {
      const ab = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
      if (ab && ab.dataset.slot !== this.focusSlot) {
        this.focusSlot = ab.dataset.slot as AbilitySlot;
        this.renderDetail();
      }
    });
  }

  private onClick(e: Event): void {
    if (this.locking || this.myLocked) return;
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>('[data-agent]');
    if (card) this.select(card.dataset.agent!);
    const role = t.closest<HTMLElement>('[data-role]');
    if (role) {
      this.role = role.dataset.role as RoleClass | 'all';
      this.render();
    }
    const slot = t.closest<HTMLElement>('[data-slot]');
    if (slot) {
      this.focusSlot = slot.dataset.slot as AbilitySlot;
      this.renderDetail();
    }
    const diff = t.closest<HTMLElement>('[data-diff]');
    if (diff) {
      this.game.botDifficulty = diff.dataset.diff as BotDifficulty;
      this.renderFooter();
    }
    const mode = t.closest<HTMLElement>('[data-mode]');
    if (mode) {
      const m = mode.dataset.mode as MatchMode;
      this.game.matchMode = m;
      this.game.matchConfig = withMode(this.game.matchConfig, m);
      this.renderFooter();
    }
    if (t.closest('[data-act="lock"]')) this.lock();
    if (t.closest('[data-act="cancel"]')) this.hide();
  }

  show(title: string, onConfirm: () => void): void {
    this.onConfirm = onConfirm;
    this.selected = this.game.agentId;
    this.root.dataset.title = title;
    this.root.hidden = false;
    this.locking = false;
    this.root.classList.remove('locking');
    this.render();
    this.preview.start();
  }

  hide(): void {
    this.root.hidden = true;
    this.preview.stop();
    this.net = null;
    this.room = null;
    clearInterval(this.clock);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** 온라인: 경기 시작 전 캐릭터 선택 (모두 LOCK IN 하거나 시간이 끝나면 서버가 경기를 시작) */
  showOnline(net: NetClient, room: RoomInfo): void {
    this.net = net;
    this.onConfirm = null;
    this.root.dataset.title = 'ONLINE · 캐릭터 선택';
    this.root.hidden = false;
    this.locking = false;
    this.root.classList.remove('locking');
    this.room = room;
    const me = room.players.find((p) => p.id === net.id);
    this.selected = me?.agent ?? this.game.agentId;
    this.selectEnds = Date.now() + room.selectLeft * 1000;
    this.render();
    this.preview.start();
    clearInterval(this.clock);
    this.clock = window.setInterval(() => this.renderTimer(), 250);
  }

  /** 온라인: 방 정보가 바뀜 (팀원 선택·확정) */
  updateRoom(room: RoomInfo): void {
    if (!this.net) return;
    this.room = room;
    this.selectEnds = Date.now() + room.selectLeft * 1000;
    const me = room.players.find((p) => p.id === this.net!.id);
    // 서버가 받아들인 내 캐릭터 (거절되면 되돌아감)
    if (me && me.agent !== this.selected) this.selected = me.agent;
    this.render();
  }

  private get myLocked(): boolean {
    return !!this.room?.players.find((p) => p.id === this.net?.id)?.locked;
  }

  /** 같은 팀의 다른 사람이 고른 캐릭터 → 이름 */
  private takenBy(): Map<string, { name: string; locked: boolean }> {
    const out = new Map<string, { name: string; locked: boolean }>();
    const me = this.room?.players.find((p) => p.id === this.net?.id);
    if (!me) return out;
    for (const p of this.room!.players) if (p.id !== me.id && p.team === me.team) out.set(p.agent, { name: p.name, locked: p.locked });
    return out;
  }

  private renderTimer(): void {
    const el = this.root.querySelector('.as-timer');
    if (el) el.textContent = String(Math.max(0, Math.ceil((this.selectEnds - Date.now()) / 1000)));
  }

  private get agent(): AgentDef {
    return AGENTS.find((a) => a.id === this.selected) ?? AGENTS[0];
  }

  private select(id: string): void {
    if (id === this.selected) return;
    if (this.net) {
      // 같은 팀이 이미 고른 캐릭터는 고를 수 없다
      if (this.takenBy().has(id)) return;
      this.net.send({ t: 'agent', agent: id });
    }
    this.selected = id;
    this.focusSlot = 'signature';
    this.render();
  }

  /** LOCK IN: 대표 색으로 잠깐 번쩍인 뒤 시작 */
  private lock(): void {
    if (this.net) {
      // 온라인: 서버에 확정. 모두 확정하면 서버가 경기를 시작한다
      if (this.myLocked) return;
      this.game.agentId = this.selected;
      this.net.send({ t: 'lock' });
      this.root.classList.add('locking');
      this.game.sound.play('ui', { gain: 0.8 });
      setTimeout(() => this.root.classList.remove('locking'), 380);
      return;
    }
    this.locking = true;
    this.game.agentId = this.selected;
    this.root.classList.add('locking');
    this.game.sound.play('ui', { gain: 0.8 });
    setTimeout(() => {
      this.hide();
      this.onConfirm?.();
    }, 380);
  }

  // ───────────────────────── 그리기 ─────────────────────────

  private render(): void {
    const a = this.agent;
    this.root.style.setProperty('--agent', a.color);
    const isMatch = this.root.dataset.title?.startsWith('MATCH');
    const online = !!this.net;
    const taken = this.takenBy();
    const locked = this.myLocked;
    this.root.innerHTML = `
      <div class="as-bg"><span>${a.name}</span></div>
      <header class="as-top">
        <p class="as-mode">${this.root.dataset.title ?? ''}</p>
        <h2>SELECT AGENT</h2>
        <nav class="as-roles">
          ${ROLES.map(
            (r) => `<button data-role="${r}" class="${r === this.role ? 'active' : ''}">${r === 'all' ? '' : roleIcon(r, 14)}<span>${r === 'all' ? 'ALL' : ROLE_LABEL[r]}</span></button>`,
          ).join('')}
        </nav>
      </header>
      <section class="as-info"></section>
      <div class="as-stage"></div>
      <footer class="as-bottom">
        <div class="as-roster">
          ${AGENTS.map((g) => {
            const dim = this.role !== 'all' && g.roleClass !== this.role;
            const by = taken.get(g.id);
            return `<button class="as-tile ${g.id === this.selected ? 'active' : ''} ${dim ? 'dim' : ''} ${by ? 'taken' : ''}" data-agent="${g.id}" style="--c:${g.color}" title="${by ? `${by.name} 선택` : g.name}" ${by ? 'disabled' : ''}>
              <i>${roleIcon(g.roleClass, 13)}</i><b>${g.name[0]}</b><span>${by ? by.name : g.name}</span></button>`;
          }).join('')}
        </div>
        <div class="as-actions">
          ${isMatch ? '<div class="as-diff as-matchmode"></div><div class="as-diff as-bots"></div>' : ''}
          ${online ? this.teamHtml() : ''}
          <div class="row">
            ${online ? '' : '<button data-act="cancel">BACK</button>'}
            <button data-act="lock" class="primary" ${locked ? 'disabled' : ''}>${locked ? '다른 플레이어를 기다리는 중…' : 'LOCK IN'}</button>
          </div>
        </div>
      </footer>`;
    this.root.querySelector('.as-stage')!.appendChild(this.preview.canvas);
    this.preview.setAgentColor(a.color);
    this.renderDetail();
    this.renderFooter();
  }

  private renderDetail(): void {
    const a = this.agent;
    const keys = this.game.settings.bindings;
    const keyOf = (s: AbilitySlot) => (keys[s][0] ?? '').replace('Key', '');
    const f = a.abilities[this.focusSlot];
    const cost = (s: AbilitySlot) => {
      const d = a.abilities[s];
      if (s === 'ultimate') return `궁극기 포인트 ${d.ultPoints}`;
      const extra = [d.recharge ? `${d.recharge}초마다 재충전` : '', d.killRecharge ? `${d.killRecharge}킬마다 재충전` : ''].filter(Boolean).join(' · ');
      if (s === 'signature') {
        const base = d.freeCharges >= d.maxCharges ? `라운드마다 무료 ${d.maxCharges}회` : `라운드마다 무료 ${d.freeCharges}회 · 추가 ${d.cost} 크레딧 (최대 ${d.maxCharges})`;
        return extra ? `${base} · ${extra}` : base;
      }
      return `${d.cost} 크레딧 · 최대 ${d.maxCharges}회${extra ? ' · ' + extra : ''}`;
    };
    const info = this.root.querySelector('.as-info');
    if (!info) return;
    info.innerHTML = `
      <div class="as-role">${roleIcon(a.roleClass, 16)}<span>${ROLE_LABEL[a.roleClass]}</span><em>${a.role.split('·').slice(1).join('·').trim()}</em></div>
      <h1>${a.name}</h1>
      <p class="as-tag">${a.tagline}</p>
      <p class="as-bio">${a.bio}</p>
      ${a.passiveText ? `<p class="as-passive"><b>패시브</b> ${a.passiveText}</p>` : ''}
      <div class="as-abilities">
        ${SLOTS.map(
          (s) => `<button data-slot="${s}" class="${s === this.focusSlot ? 'active' : ''} ${s === 'ultimate' ? 'ult' : ''}">
            ${effectIcon(a.abilities[s].effect, 26)}<kbd>${keyOf(s)}</kbd></button>`,
        ).join('')}
      </div>
      <div class="as-ability-detail">
        <h3>${f.name} <small>${SLOT_LABEL[this.focusSlot]}</small></h3>
        <p class="as-cost">${cost(this.focusSlot)}</p>
        <p>${f.description}</p>
      </div>`;
  }

  /** 온라인: 우리 팀 선택 현황 + 남은 시간 */
  private teamHtml(): string {
    const room = this.room;
    const me = room?.players.find((p) => p.id === this.net?.id);
    if (!room || !me) return '';
    const rows = room.players
      .filter((p) => p.team === me.team)
      .map((p) => {
        const a = AGENTS.find((x) => x.id === p.agent)!;
        return `<li class="${p.locked ? 'locked' : ''} ${p.id === me.id ? 'me' : ''}" style="--c:${a.color}"><b>${p.name}</b><span>${a.name}</span><em>${p.locked ? 'LOCKED' : '선택 중'}</em></li>`;
      })
      .join('');
    return `<div class="as-team"><div class="as-team-head"><span>TEAM ${me.team}</span><b class="as-timer">${room.selectLeft}</b></div><ul>${rows}</ul></div>`;
  }

  private renderFooter(): void {
    const modeRow = this.root.querySelector('.as-matchmode');
    if (modeRow)
      modeRow.innerHTML = `<span>MATCH</span>${(Object.keys(MATCH_MODES) as MatchMode[])
        .map((m) => `<button data-mode="${m}" class="${m === this.game.matchMode ? 'active' : ''}" title="${MATCH_MODES[m].desc}">${MATCH_MODES[m].label}</button>`)
        .join('')}<em>${MATCH_MODES[this.game.matchMode].desc}</em>`;
    const diff = this.root.querySelector('.as-bots');
    if (!diff) return;
    diff.innerHTML = `<span>BOT DIFFICULTY</span>${(Object.keys(DIFFICULTY_LABEL) as BotDifficulty[])
      .map((d) => `<button data-diff="${d}" class="${d === this.game.botDifficulty ? 'active' : ''}">${DIFFICULTY_LABEL[d]}</button>`)
      .join('')}`;
  }
}
