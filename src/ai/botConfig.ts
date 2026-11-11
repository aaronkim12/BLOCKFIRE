/**
 * 봇 난이도. 반응 시간·조준 오차·회전 속도·헤드샷 성향·연사 제어가 달라진다.
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface BotSkill {
  /** 적을 처음 본 뒤 첫 발까지 (초) [최소, 최대] */
  reaction: [number, number];
  /** 표적을 잡을 때의 초기 조준 오차 (도) */
  aimError: number;
  /** 초기 오차가 줄어드는 속도 (1/초) */
  errorDecay: number;
  /** 최대 회전 속도 (도/초) */
  turnSpeed: number;
  /** 머리를 노릴 확률 */
  headChance: number;
  /** 연사 시 퍼짐 누적 배율 (클수록 제어를 못 함) */
  sprayFactor: number;
  /** 시야각 (도, 전체) */
  fov: number;
  /** 사격 중 멈추는(카운터 스트레이프) 확률 */
  stopToShoot: number;
  /** 능력을 쓰는 빈도 배율 */
  abilityUse: number;
}

export const BOT_SKILL: Record<BotDifficulty, BotSkill> = {
  easy: { reaction: [0.6, 0.95], aimError: 8, errorDecay: 1.6, turnSpeed: 200, headChance: 0.08, sprayFactor: 1.5, fov: 100, stopToShoot: 0.35, abilityUse: 0.5 },
  normal: { reaction: [0.33, 0.55], aimError: 4.5, errorDecay: 3, turnSpeed: 330, headChance: 0.22, sprayFactor: 1.1, fov: 115, stopToShoot: 0.7, abilityUse: 1 },
  hard: { reaction: [0.18, 0.3], aimError: 2.2, errorDecay: 5.5, turnSpeed: 560, headChance: 0.42, sprayFactor: 0.8, fov: 130, stopToShoot: 0.95, abilityUse: 1.3 },
};

export const DIFFICULTY_LABEL: Record<BotDifficulty, string> = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };

/** 봇 이름 (자체 제작) */
export const ALLY_NAMES = ['KESTREL', 'DRIFT', 'NOVA', 'ROOK'];
export const ENEMY_NAMES = ['VANTA', 'HEX', 'BRUTE', 'LYNX', 'ORBIT'];
