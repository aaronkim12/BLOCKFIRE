import type { MatchConfig } from './matchConfig';

/**
 * 라운드 상태 머신 (렌더링과 무관한 순수 로직 — Phase 8에서 서버가 그대로 사용).
 *
 *   Waiting → BuyPhase → RoundStart → ActiveRound ─┬→ RoundEnd → (다음 라운드 BuyPhase | MatchEnd)
 *                                                   └→ ObjectivePlanted ⇄ ObjectiveDefusing → RoundEnd
 *
 * 팀은 'A'/'B'로 고정이고, 진영(공격/수비)은 전반/후반에 바뀐다.
 */

export type Side = 'attack' | 'defense';
export type TeamId = 'A' | 'B';
export type RoundState =
  | 'Waiting'
  | 'BuyPhase'
  | 'RoundStart'
  | 'ActiveRound'
  | 'ObjectivePlanted'
  | 'ObjectiveDefusing'
  | 'RoundEnd'
  | 'MatchEnd';
export type EndReason = 'elimination' | 'timeout' | 'detonated' | 'defused';
export type SiteId = 'A' | 'B';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Participant {
  id: string;
  name: string;
  team: TeamId;
  alive: boolean;
  kills: number;
  deaths: number;
}

export type CoreStatus = 'carried' | 'dropped' | 'planted' | 'defused' | 'detonated';

export interface CoreState {
  status: CoreStatus;
  carrierId: string | null;
  position: Vec3 | null;
  site: SiteId | null;
  /** 설치 진행도 0..1 (설치 중인 참가자) */
  plantProgress: number;
  planterId: string | null;
  /** 해체 진행도 0..1 */
  defuseProgress: number;
  defuserId: string | null;
  /** 폭발까지 남은 시간 (설치 후) */
  timer: number;
}

export interface RoundResult {
  round: number;
  winner: TeamId;
  reason: EndReason;
}

export interface RoundEvents {
  onState?(state: RoundState, prev: RoundState): void;
  /** 새 라운드 준비 (구매 단계 시작): 모두 부활/재배치 */
  onRoundSetup?(round: number): void;
  onRoundEnd?(result: RoundResult): void;
  onSideSwap?(): void;
  onMatchEnd?(winner: TeamId): void;
  onPlantStart?(id: string): void;
  onPlanted?(id: string, site: SiteId): void;
  onDefuseStart?(id: string): void;
  onDefused?(id: string): void;
  onDetonated?(): void;
  onCoreDropped?(pos: Vec3): void;
  onCorePicked?(id: string): void;
}

export class RoundManager {
  state: RoundState = 'Waiting';
  /** 현재 상태의 남은 시간 (ActiveRound: 라운드 시간, Planted: 폭발까지) */
  timeLeft = 0;
  round = 0;
  readonly score: Record<TeamId, number> = { A: 0, B: 0 };
  /** 팀 → 진영 (진영 교체 때 바뀜, 온라인 스냅샷으로 전달) */
  sides: Record<TeamId, Side> = { A: 'attack', B: 'defense' };
  readonly participants = new Map<string, Participant>();
  core: CoreState = RoundManager.freshCore();
  readonly history: RoundResult[] = [];
  winner: TeamId | null = null;
  lastResult: RoundResult | null = null;

  constructor(
    public config: MatchConfig,
    public events: RoundEvents = {},
  ) {}

  private static freshCore(): CoreState {
    return {
      status: 'carried', carrierId: null, position: null, site: null,
      plantProgress: 0, planterId: null, defuseProgress: 0, defuserId: null, timer: 0,
    };
  }

  // ───────────────────────── 참가자 / 진영 ─────────────────────────

  addParticipant(p: Omit<Participant, 'alive' | 'kills' | 'deaths'>): void {
    this.participants.set(p.id, { ...p, alive: true, kills: 0, deaths: 0 });
  }

  sideOf(team: TeamId): Side {
    return this.sides[team];
  }

  teamOn(side: Side): TeamId {
    return this.sides.A === side ? 'A' : 'B';
  }

  sideOfPlayer(id: string): Side | null {
    const p = this.participants.get(id);
    return p ? this.sides[p.team] : null;
  }

  aliveCount(team: TeamId): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.team === team && p.alive) n++;
    return n;
  }

  /** 공격/수비가 실제로 싸울 수 있는 상태 */
  get combatActive(): boolean {
    return this.state === 'ActiveRound' || this.state === 'ObjectivePlanted' || this.state === 'ObjectiveDefusing';
  }

  get canMove(): boolean {
    return this.state !== 'RoundStart';
  }

  // ───────────────────────── 진행 ─────────────────────────

  start(): void {
    this.setState('Waiting', this.config.waitTime);
  }

  update(dt: number): void {
    if (this.state === 'MatchEnd') return;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    const c = this.core;

    switch (this.state) {
      case 'Waiting':
        if (this.timeLeft === 0) this.beginRound();
        break;
      case 'BuyPhase':
        if (this.timeLeft === 0) this.setState('RoundStart', this.config.roundStartTime);
        break;
      case 'RoundStart':
        if (this.timeLeft === 0) this.setState('ActiveRound', this.config.roundTime);
        break;
      case 'ActiveRound':
        if (this.checkElimination()) break;
        if (this.timeLeft === 0) this.endRound(this.teamOn('defense'), 'timeout');
        break;
      case 'ObjectivePlanted':
      case 'ObjectiveDefusing':
        c.timer = this.timeLeft;
        if (this.timeLeft === 0) {
          c.status = 'detonated';
          this.events.onDetonated?.();
          this.endRound(this.teamOn('attack'), 'detonated');
          break;
        }
        // 설치 후에는 공격팀이 전멸해도 폭발/해체로 결과가 정해진다. 수비팀 전멸은 즉시 공격 승리.
        if (this.aliveCount(this.teamOn('defense')) === 0) this.endRound(this.teamOn('attack'), 'elimination');
        break;
      case 'RoundEnd':
        if (this.timeLeft === 0) this.nextRound();
        break;
    }
  }

  private beginRound(): void {
    this.round++;
    this.core = RoundManager.freshCore();
    for (const p of this.participants.values()) p.alive = true;
    this.events.onRoundSetup?.(this.round);
    this.setState('BuyPhase', this.config.buyTime);
  }

  private nextRound(): void {
    if (this.winner) {
      this.setState('MatchEnd', 0);
      this.events.onMatchEnd?.(this.winner);
      return;
    }
    // 전반이 끝나면 진영 교체
    if (this.round === this.config.roundsPerHalf) {
      this.sides = { A: this.sides.B, B: this.sides.A };
      this.events.onSideSwap?.();
    }
    this.beginRound();
  }

  private checkElimination(): boolean {
    const atk = this.teamOn('attack');
    const def = this.teamOn('defense');
    if (this.aliveCount(def) === 0) {
      this.endRound(atk, 'elimination');
      return true;
    }
    if (this.aliveCount(atk) === 0) {
      this.endRound(def, 'elimination');
      return true;
    }
    return false;
  }

  private endRound(winner: TeamId, reason: EndReason): void {
    if (this.state === 'RoundEnd' || this.state === 'MatchEnd') return;
    this.score[winner]++;
    const result = { round: this.round, winner, reason };
    this.history.push(result);
    this.lastResult = result;
    this.cancelInteractions();
    if (this.score[winner] >= this.config.winRounds) this.winner = winner;
    this.setState('RoundEnd', this.config.roundEndTime);
    this.events.onRoundEnd?.(result);
  }

  private setState(s: RoundState, duration: number): void {
    const prev = this.state;
    this.state = s;
    this.timeLeft = duration;
    this.events.onState?.(s, prev);
  }

  // ───────────────────────── 사망 / Core ─────────────────────────

  /** 참가자 사망. Core를 들고 있었다면 그 자리에 떨어뜨린다 */
  notifyDeath(id: string, killerId: string | null, at: Vec3): void {
    const p = this.participants.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    p.deaths++;
    const k = killerId ? this.participants.get(killerId) : null;
    if (k && k.team !== p.team) k.kills++;
    if (this.core.planterId === id) this.cancelPlant(id);
    if (this.core.defuserId === id) this.cancelDefuse(id);
    if (this.core.status === 'carried' && this.core.carrierId === id) {
      this.core.status = 'dropped';
      this.core.carrierId = null;
      this.core.position = { ...at };
      this.events.onCoreDropped?.(at);
    }
  }

  /** 쓰러진 참가자가 다시 살아남 (능력). 교전 중에만 가능 */
  revive(id: string): boolean {
    const p = this.participants.get(id);
    if (!p || p.alive || !this.combatActive) return false;
    p.alive = true;
    return true;
  }

  /** Core를 바닥에 놓는다 (라운드 시작 시 공격 스폰) */
  placeCoreOnGround(at: Vec3): void {
    this.core.status = 'dropped';
    this.core.carrierId = null;
    this.core.position = { ...at };
    this.events.onCoreDropped?.(at);
  }

  /** 들고 있던 Core를 버린다 (G) */
  dropCore(id: string, at: Vec3): boolean {
    const c = this.core;
    if (c.status !== 'carried' || c.carrierId !== id) return false;
    this.cancelPlant(id);
    this.placeCoreOnGround(at);
    return true;
  }

  /** 라운드 시작 시 Core를 공격팀 한 명에게 준다 */
  giveCore(id: string): void {
    this.core.status = 'carried';
    this.core.carrierId = id;
    this.core.position = null;
  }

  /** 떨어진 Core 줍기 (공격팀만) */
  tryPickup(id: string, at: Vec3): boolean {
    const c = this.core;
    if (c.status !== 'dropped' || !c.position) return false;
    if (this.sideOfPlayer(id) !== 'attack' || !this.participants.get(id)?.alive) return false;
    if (dist(at, c.position) > this.config.interactRange) return false;
    c.status = 'carried';
    c.carrierId = id;
    c.position = null;
    this.events.onCorePicked?.(id);
    return true;
  }

  /**
   * 설치 버튼을 누르고 있는 동안 매 프레임 호출.
   * @param site 지금 서 있는 설치 구역 (구역 밖이면 null)
   * @returns 설치 진행도 (설치할 수 없으면 -1)
   */
  holdPlant(id: string, site: SiteId | null, at: Vec3, dt: number): number {
    const c = this.core;
    if (
      this.state !== 'ActiveRound' ||
      c.status !== 'carried' ||
      c.carrierId !== id ||
      !site ||
      this.sideOfPlayer(id) !== 'attack' ||
      !this.participants.get(id)?.alive
    ) {
      this.cancelPlant(id);
      return -1;
    }
    if (c.planterId !== id) {
      c.planterId = id;
      c.plantProgress = 0;
      this.events.onPlantStart?.(id);
    }
    c.plantProgress = Math.min(1, c.plantProgress + dt / this.config.plantTime);
    if (c.plantProgress >= 1) {
      c.status = 'planted';
      c.carrierId = null;
      c.position = { ...at };
      c.site = site;
      c.planterId = null;
      c.timer = this.config.coreTime;
      this.setState('ObjectivePlanted', this.config.coreTime);
      this.events.onPlanted?.(id, site);
    }
    return c.plantProgress;
  }

  cancelPlant(id: string): void {
    if (this.core.planterId !== id) return;
    this.core.planterId = null;
    this.core.plantProgress = 0;
  }

  /**
   * 해체 버튼을 누르고 있는 동안 매 프레임 호출.
   * @returns 해체 진행도 (해체할 수 없으면 -1)
   */
  holdDefuse(id: string, at: Vec3, dt: number): number {
    const c = this.core;
    const ok =
      (this.state === 'ObjectivePlanted' || this.state === 'ObjectiveDefusing') &&
      this.sideOfPlayer(id) === 'defense' &&
      this.participants.get(id)?.alive &&
      c.position !== null &&
      dist(at, c.position) <= this.config.interactRange &&
      (c.defuserId === null || c.defuserId === id);
    if (!ok) {
      this.cancelDefuse(id);
      return -1;
    }
    if (c.defuserId !== id) {
      c.defuserId = id;
      this.state = 'ObjectiveDefusing';
      this.events.onState?.('ObjectiveDefusing', 'ObjectivePlanted');
      this.events.onDefuseStart?.(id);
    }
    c.defuseProgress = Math.min(1, c.defuseProgress + dt / this.config.defuseTime);
    if (c.defuseProgress >= 1) {
      c.status = 'defused';
      c.defuserId = null;
      this.events.onDefused?.(id);
      this.endRound(this.teamOn('defense'), 'defused');
    }
    return c.defuseProgress;
  }

  /** 해체 중단: 체크포인트(절반)를 넘겼다면 그 지점부터 다시 시작한다 */
  cancelDefuse(id: string): void {
    const c = this.core;
    if (c.defuserId !== id) return;
    c.defuserId = null;
    const cp = this.config.defuseCheckpoint;
    c.defuseProgress = cp > 0 && c.defuseProgress >= cp ? cp : 0;
    if (this.state === 'ObjectiveDefusing') {
      this.state = 'ObjectivePlanted';
      this.events.onState?.('ObjectivePlanted', 'ObjectiveDefusing');
    }
  }

  private cancelInteractions(): void {
    if (this.core.planterId) this.cancelPlant(this.core.planterId);
    if (this.core.defuserId) this.cancelDefuse(this.core.defuserId);
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
