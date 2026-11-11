/**
 * 경기 규칙 설정. 시간/승리 조건은 모두 여기서 바꾼다.
 */
export interface MatchConfig {
  /** 경기 시작 전 대기 (초) */
  waitTime: number;
  /** 구매 단계 (초) — 스폰 구역 밖으로 나갈 수 없다 */
  buyTime: number;
  /** 라운드 시작 알림 (초) */
  roundStartTime: number;
  /** 라운드 제한 시간 (초) */
  roundTime: number;
  /** Core 설치에 필요한 시간 (초) */
  plantTime: number;
  /** Core 해체에 필요한 시간 (초) */
  defuseTime: number;
  /** 해체를 이 비율까지 진행하면 중단해도 그 지점부터 이어서 할 수 있다 (0이면 없음) */
  defuseCheckpoint: number;
  /** Core 설치 후 폭발까지 (초) */
  coreTime: number;
  /** 라운드 결과 표시 (초) */
  roundEndTime: number;
  /** 이 라운드 수마다 공격/수비 진영 교체 */
  roundsPerHalf: number;
  /** 먼저 이만큼 이기면 경기 승리 */
  winRounds: number;
  /** 폭발 반경 (m) / 중심 피해 */
  explosionRadius: number;
  explosionDamage: number;
  /** Core 해체/줍기 거리 (m) */
  interactRange: number;
}

export const DEFAULT_MATCH: MatchConfig = {
  waitTime: 2,
  buyTime: 20,
  roundStartTime: 1.5,
  roundTime: 100,
  plantTime: 4,
  defuseTime: 7,
  defuseCheckpoint: 0.5,
  coreTime: 45,
  roundEndTime: 6,
  roundsPerHalf: 12,
  winRounds: 13,
  explosionRadius: 16,
  explosionDamage: 500,
  interactRange: 1.6,
};

/** 경기 방식: 일반(13승, 12라운드마다 교체) / 짧은 경기(5승, 4라운드마다 교체 — 빠른 대전) */
export type MatchMode = 'standard' | 'swift';

export const MATCH_MODES: Record<MatchMode, { label: string; desc: string; winRounds: number; roundsPerHalf: number }> = {
  standard: { label: 'STANDARD', desc: '13승 · 12라운드마다 공수 교체', winRounds: 13, roundsPerHalf: 12 },
  swift: { label: 'SHORT', desc: '5승 · 4라운드마다 공수 교체 (최대 9라운드)', winRounds: 5, roundsPerHalf: 4 },
};

/** 경기 방식에 맞게 승리 라운드·교체 주기를 바꾼 설정 */
export function withMode(cfg: MatchConfig, mode: MatchMode): MatchConfig {
  const m = MATCH_MODES[mode];
  return { ...cfg, winRounds: m.winRounds, roundsPerHalf: m.roundsPerHalf };
}
