/**
 * 크레딧 경제 (렌더링과 무관한 순수 로직 — Phase 8에서 서버가 그대로 사용).
 * 수치는 ECONOMY에서 조정한다.
 */

export const ECONOMY = {
  startCredits: 800,
  maxCredits: 9000,
  killReward: 200,
  winReward: 3000,
  /** 연패 보상: 1패, 2패, 3패 이상 */
  lossRewards: [1900, 2400, 2900],
  /** Core를 설치하면 공격팀 전원이 받는 보너스 (라운드에서 져도 받음) */
  plantReward: 300,
  /** 진 라운드에서 살아남은 사람은 연패 보상 대신 이만큼만 받는다 (총을 아끼며 버틴 경우) */
  survivorReward: 1000,
};

export type TeamKey = 'A' | 'B';

export class Economy {
  private credits = new Map<string, number>();
  private teams = new Map<string, TeamKey>();
  private lossStreak: Record<TeamKey, number> = { A: 0, B: 0 };
  /** 이번 라운드에 받은 보상 내역 (HUD 표시용) */
  lastRewards = new Map<string, { amount: number; reason: string }[]>();

  add(id: string, team: TeamKey): void {
    this.credits.set(id, ECONOMY.startCredits);
    this.teams.set(id, team);
  }

  get(id: string): number {
    return this.credits.get(id) ?? 0;
  }

  /** 지불. 크레딧이 모자라면 false */
  spend(id: string, amount: number): boolean {
    const c = this.get(id);
    if (amount > c) return false;
    this.credits.set(id, c - amount);
    return true;
  }

  refund(id: string, amount: number): void {
    this.give(id, amount, '');
  }

  private give(id: string, amount: number, reason: string): void {
    this.credits.set(id, Math.min(ECONOMY.maxCredits, this.get(id) + amount));
    if (reason) {
      const list = this.lastRewards.get(id) ?? [];
      list.push({ amount, reason });
      this.lastRewards.set(id, list);
    }
  }

  onKill(killerId: string, victimTeam: TeamKey): void {
    if (this.teams.get(killerId) && this.teams.get(killerId) !== victimTeam) this.give(killerId, ECONOMY.killReward, '처치');
  }

  onPlant(team: TeamKey): void {
    for (const [id, t] of this.teams) if (t === team) this.give(id, ECONOMY.plantReward, 'Core 설치');
  }

  /**
   * 라운드 종료 보상.
   * @param survivors 진 팀에서 살아남은 참가자: 연패 보상 대신 1000
   */
  onRoundEnd(winner: TeamKey, survivors: Set<string> = new Set()): void {
    const loser: TeamKey = winner === 'A' ? 'B' : 'A';
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]++;
    const lossAmount = ECONOMY.lossRewards[Math.min(ECONOMY.lossRewards.length, this.lossStreak[loser]) - 1];
    for (const [id, t] of this.teams) {
      if (t === winner) this.give(id, ECONOMY.winReward, '라운드 승리');
      else if (survivors.has(id)) this.give(id, ECONOMY.survivorReward, '패배 · 생존');
      else this.give(id, lossAmount, `라운드 패배 (${this.lossStreak[loser]}연패)`);
    }
  }

  /** 진영 교체: 크레딧과 연패 기록 초기화 */
  resetHalf(): void {
    for (const id of this.credits.keys()) this.credits.set(id, ECONOMY.startCredits);
    this.lossStreak = { A: 0, B: 0 };
  }

  clearRewards(): void {
    this.lastRewards.clear();
  }
}
