import type { MatchConfig } from '../rounds/matchConfig';
import type { CoreState, Participant, RoundState, Side, SiteId, TeamId } from '../rounds/RoundManager';

export interface RoundHUDData {
  state: RoundState;
  timeLeft: number;
  round: number;
  score: Record<TeamId, number>;
  myTeam: TeamId;
  mySide: Side;
  alive: Record<TeamId, number>;
  teamSize: Record<TeamId, number>;
  core: CoreState;
  carrying: boolean;
  inSite: SiteId | null;
  nearCore: boolean;
  /** 설치/해체 진행도 (-1: 없음, -2: 해체 체크포인트만 표시) */
  progress: number;
  checkpoint: number;
  progressLabel: string;
  alivePlayer: boolean;
  participants: Participant[];
  winner: TeamId | null;
  config: MatchConfig;
  /** 관전 중인 아군 이름 */
  spectating: string | null;
  credits: number;
  /** 이번 라운드 보상 내역 */
  rewards: { amount: number; reason: string }[];
}

const fmt = (t: number) => {
  const s = Math.ceil(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 경기 HUD: 상단 점수판, 라운드 배너, 설치/해체 진행, 안내, Tab 점수판, 경기 결과 */
export class RoundHUD {
  private root: HTMLDivElement;
  /** 라운드 중 크레딧 증가 표시 */
  private lastCredits = -1;
  private gain = 0;
  private gainTimer = 0;
  private q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
  private bannerTimer = 0;
  private lastFrame = performance.now();
  private scoreboardKey = '';

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'round-hud';
    this.root.innerHTML = `
      <div class="rh-top">
        <div class="rh-team mine"><div class="rh-pips"></div><b class="rh-score">0</b></div>
        <div class="rh-clock">
          <div class="rh-time">0:00</div>
          <div class="rh-core-icon" hidden></div>
          <div class="rh-sub">ROUND 1</div>
        </div>
        <div class="rh-team enemy"><b class="rh-score">0</b><div class="rh-pips"></div></div>
      </div>
      <div class="rh-banner" hidden><h2></h2><p></p></div>
      <div class="rh-prompt" hidden></div>
      <div class="rh-progress" hidden><span></span><div class="rh-bar"><i></i><em></em></div></div>
      <div class="rh-carry" hidden>◆ CORE</div>
      <div class="rh-credits"><span>¤</span><b>0</b><em class="rh-gain" hidden></em></div>
      <div class="rh-rewards" hidden></div>
      <div class="rh-scoreboard" hidden></div>
      <div class="rh-end" hidden><h1></h1><p class="rh-end-score"></p><p class="rh-end-hint">ESC → MAIN MENU</p></div>
    `;
    container.appendChild(this.root);
  }

  banner(title: string, sub: string, kind: 'win' | 'loss' | 'info' | 'alert'): void {
    const b = this.q('.rh-banner');
    b.className = `rh-banner ${kind}`;
    setText(b.querySelector('h2')!, title);
    setText(b.querySelector('p')!, sub);
    b.hidden = false;
    // 애니메이션 재시작
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
    this.bannerTimer = kind === 'win' || kind === 'loss' ? 4 : 2.6;
  }

  matchEnd(won: boolean, mine: number, theirs: number): void {
    this.q('.rh-banner').hidden = true;
    this.bannerTimer = 0;
    const e = this.q('.rh-end');
    e.hidden = false;
    e.className = `rh-end ${won ? 'win' : 'loss'}`;
    setText(e.querySelector('h1')!, won ? 'VICTORY' : 'DEFEAT');
    setText(this.q('.rh-end-score'), `${mine} : ${theirs}`);
  }

  setScoreboard(visible: boolean): void {
    this.q('.rh-scoreboard').hidden = !visible;
    this.root.classList.toggle('scoreboard-open', visible);
  }

  update(d: RoundHUDData): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const enemy: TeamId = d.myTeam === 'A' ? 'B' : 'A';

    // ── 상단: 점수 / 시간 / 생존 인원
    const teams = this.root.querySelectorAll<HTMLElement>('.rh-team');
    const fill = (el: HTMLElement, team: TeamId) => {
      setText(el.querySelector('.rh-score')!, String(d.score[team]));
      const pips = el.querySelector('.rh-pips')!;
      const want = d.teamSize[team];
      if (pips.children.length !== want) pips.innerHTML = '<i></i>'.repeat(want);
      [...pips.children].forEach((p, i) => p.classList.toggle('dead', i >= d.alive[team]));
    };
    fill(teams[0], d.myTeam);
    fill(teams[1], enemy);
    teams[0].dataset.side = d.mySide;
    teams[1].dataset.side = d.mySide === 'attack' ? 'defense' : 'attack';

    const planted = d.core.status === 'planted';
    const time = this.q('.rh-time');
    const icon = this.q('.rh-core-icon');
    icon.hidden = !planted;
    time.hidden = planted;
    setText(time, fmt(d.timeLeft));
    time.classList.toggle('low', d.state === 'ActiveRound' && d.timeLeft <= 10);
    const sub: Record<RoundState, string> = {
      Waiting: 'WAITING',
      BuyPhase: 'BUY PHASE',
      RoundStart: 'GET READY',
      ActiveRound: `ROUND ${d.round}`,
      ObjectivePlanted: 'CORE PLANTED',
      ObjectiveDefusing: 'DEFUSING',
      RoundEnd: `ROUND ${d.round}`,
      MatchEnd: 'MATCH END',
    };
    setText(this.q('.rh-sub'), `${sub[d.state]} · ${d.mySide === 'attack' ? 'ATK' : 'DEF'}`);

    // ── 배너
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.q('.rh-banner').hidden = true;
    }

    // ── 크레딧 / 보상 내역 (라운드 종료 ~ 구매 단계)
    setText(this.q('.rh-credits b'), d.credits.toLocaleString());
    // 라운드 중에 늘어난 크레딧(처치·설치)은 옆에 잠깐 +금액
    if (this.lastCredits >= 0 && d.credits > this.lastCredits && d.state !== 'RoundEnd' && d.state !== 'BuyPhase') {
      this.gain += d.credits - this.lastCredits;
      this.gainTimer = 1.6;
    }
    this.lastCredits = d.credits;
    const gainEl = this.q('.rh-gain');
    if (this.gainTimer > 0) {
      this.gainTimer -= dt;
      gainEl.hidden = false;
      setText(gainEl, `+${this.gain}`);
      if (this.gainTimer <= 0) this.gain = 0;
    } else gainEl.hidden = true;
    const rw = this.q('.rh-rewards');
    const showRewards = (d.state === 'RoundEnd' || d.state === 'BuyPhase') && d.rewards.length > 0;
    rw.hidden = !showRewards;
    if (showRewards) {
      const html = d.rewards.map((r) => `<div><span>${r.reason}</span><b>+${r.amount}</b></div>`).join('');
      if (rw.innerHTML !== html) rw.innerHTML = html;
    }

    // ── Core 운반 표시 / 안내 문구
    this.q('.rh-carry').hidden = !d.carrying || !d.alivePlayer;
    let prompt = '';
    if (d.alivePlayer && d.progress < 0) {
      if (d.state === 'BuyPhase' && d.core.status === 'dropped' && d.mySide === 'attack') prompt = `구매 단계 — ${Math.ceil(d.timeLeft)}초 · <kbd>B</kbd> 구매 · 앞에 놓인 Core를 주우세요`;
      else if (d.state === 'BuyPhase') prompt = `구매 단계 — ${Math.ceil(d.timeLeft)}초 · <kbd>B</kbd> 구매 메뉴`;
      else if (d.state === 'RoundStart') prompt = '준비…';
      else if (d.carrying && d.inSite && d.state === 'ActiveRound') prompt = `<kbd>4</kbd> Core를 들고 <kbd>LMB</kbd> 또는 <kbd>E</kbd> 길게 눌러 설치 (${d.inSite} 구역)`;
      else if (d.core.status === 'dropped' && d.mySide === 'attack') prompt = d.nearCore ? '<kbd>E</kbd> Core 줍기' : '바닥의 Core를 주우세요 (밟고 지나가거나 E)';
      else if (d.carrying && d.state === 'ActiveRound') prompt = 'A 또는 B 설치 구역으로 Core를 가져가세요';
      else if (d.mySide === 'defense' && planted && d.nearCore) prompt = `<kbd>E</kbd> 길게 눌러 Core 해체${d.checkpoint >= d.config.defuseCheckpoint && d.config.defuseCheckpoint > 0 ? ' (절반부터 재개)' : ''}`;
      else if (d.mySide === 'defense' && planted) prompt = `Core가 ${d.core.site} 구역에 설치되었습니다 — 해체하세요`;
    }
    if (!d.alivePlayer && d.state !== 'RoundEnd' && d.state !== 'MatchEnd')
      prompt = d.spectating === 'CORE' ? '아군 전멸 — 설치된 <b>CORE</b>를 보는 중 · 마우스로 시점 회전' : d.spectating ? `관전 중: <b>${d.spectating}</b> · 마우스로 시점 회전 · <kbd>LMB</kbd>/<kbd>RMB</kbd> 대상 변경` : '관전 중 — 살아 있는 아군이 없습니다 · 마우스로 시점 회전';
    const pr = this.q('.rh-prompt');
    pr.hidden = !prompt;
    if (prompt && pr.innerHTML !== prompt) pr.innerHTML = prompt;

    // ── 설치/해체 진행 막대
    const bar = this.q('.rh-progress');
    bar.hidden = d.progress < 0;
    if (d.progress >= 0) {
      setText(bar.querySelector('span')!, `${d.progressLabel} ${Math.floor(d.progress * 100)}%`);
      (bar.querySelector('i') as HTMLElement).style.width = `${d.progress * 100}%`;
      const cp = bar.querySelector('em') as HTMLElement;
      cp.hidden = d.progressLabel.includes('해체') ? d.config.defuseCheckpoint <= 0 : true;
      cp.style.left = `${d.config.defuseCheckpoint * 100}%`;
    }

    // ── Tab 점수판
    const sb = this.q('.rh-scoreboard');
    if (!sb.hidden) {
      const key = d.participants.map((p) => `${p.id}${p.alive}${p.kills}${p.deaths}`).join() + d.score.A + d.score.B;
      if (key !== this.scoreboardKey) {
        this.scoreboardKey = key;
        const rows = (team: TeamId) =>
          d.participants
            .filter((p) => p.team === team)
            .map((p) => `<tr class="${p.alive ? '' : 'dead'} ${p.id === 'player' ? 'me' : ''}"><td>${p.name}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`)
            .join('');
        sb.innerHTML = `
          <h3>ROUND ${d.round} · ${d.score[d.myTeam]} : ${d.score[enemy]}</h3>
          <table><thead><tr><th>아군 (${d.mySide === 'attack' ? '공격' : '수비'})</th><th>K</th><th>D</th></tr></thead><tbody class="mine">${rows(d.myTeam)}</tbody></table>
          <table><thead><tr><th>적군</th><th>K</th><th>D</th></tr></thead><tbody class="enemy">${rows(enemy)}</tbody></table>`;
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 값이 바뀔 때만 DOM 글자를 고친다 (매 프레임 같은 값을 써도 화면 재계산이 일어남) */
function setText(el: Element, v: string | number): void {
  const s = String(v);
  if (el.textContent !== s) el.textContent = s;
}
