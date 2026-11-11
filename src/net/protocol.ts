/**
 * 온라인 멀티플레이 메시지 (클라이언트 ↔ 서버, JSON over WebSocket).
 * 서버 권한: 라운드·경제·Core·명중/피해·능력 충전과 효과 판정은 서버가 정하고,
 * 클라이언트는 자기 이동(서버가 검사)과 입력(사격·구매·능력·설치)을 보낸다.
 */
import type { CoreState, EndReason, Participant, RoundResult, RoundState, TeamId } from '../rounds/RoundManager';
import type { AbilitySlot } from '../abilities/abilityData';
import type { StatusKind } from '../abilities/StatusEffects';

export const NET_PORT = 5174;
/** 서버 시뮬레이션 / 스냅샷 주기 (Hz) */
export const SERVER_TICK = 30;
export const SNAPSHOT_RATE = 20;
/** 클라이언트가 자기 상태를 보내는 주기 (Hz) */
export const CLIENT_SEND_RATE = 30;
/** 원격 플레이어를 이만큼(초) 과거 시점으로 그린다 (보간 버퍼) */
export const INTERP_DELAY = 0.1;
export const TEAM_SIZE = 5;

export type V3 = [number, number, number];

export interface LobbyPlayer {
  id: string;
  name: string;
  team: TeamId;
  agent: string;
  host: boolean;
  /** 캐릭터 선택 단계에서 LOCK IN 했는지 */
  locked: boolean;
}

/** 대기실 → 캐릭터 선택 → 경기 */
export type RoomPhase = 'lobby' | 'select' | 'match';
/** 캐릭터 선택 제한 시간 (초) */
export const SELECT_TIME = 40;

export interface RoomInfo {
  code: string;
  phase: RoomPhase;
  /** 캐릭터 선택 남은 시간 (초, 선택 단계일 때) */
  selectLeft: number;
  mode: import('../rounds/matchConfig').MatchMode;
  /** 방장이 고른 맵 (맵 id 또는 'random') */
  map: string;
  players: LobbyPlayer[];
  inMatch: boolean;
}

/** 클라이언트가 보내는 자기 상태 (이동은 클라이언트 예측, 서버가 속도·구역 검사) */
export interface PlayerState {
  p: V3;
  yaw: number;
  pitch: number;
  /** 앉기 0..1 */
  crouch: number;
  /** 수평 속도 (애니메이션) */
  v: [number, number];
  grounded: boolean;
  /** 손에 든 무기 id */
  weapon: string;
  /** 재장전 진행 (-1: 아님) */
  reload: number;
  /** 설치/해체 키를 누르고 있음 (서버가 진행도 계산) */
  act: 0 | 1 | 2;
  /** 이동 키를 누르고 있음 (설치/해체 취소) */
  moving: boolean;
  /** 질주 중 (맞지 않음) */
  dash?: boolean;
  /** 조종 중인 드론 위치 */
  drone?: V3;
  /** 마지막으로 받은 순간이동 번호 (그 전에 보낸 상태는 서버가 무시) */
  tp?: number;
}

/** 서버 스냅샷: 플레이어 한 명 */
export interface NetPlayer {
  id: string;
  s: PlayerState;
  alive: boolean;
  hp: number;
  armor: number;
  /** 지금 걸린 상태 이상 (남은 초) */
  st?: Partial<Record<StatusKind, number>>;
  /** 섬광에 눈이 먼 남은 시간 (초) */
  bl?: number;
}

export interface RoundSnap {
  sides: Record<TeamId, import('../rounds/RoundManager').Side>;
  state: RoundState;
  round: number;
  timeLeft: number;
  score: Record<TeamId, number>;
  core: CoreState;
  participants: Participant[];
  winner: TeamId | null;
  lastResult: RoundResult | null;
  history: RoundResult[];
}

/** 받는 사람 본인의 상태 (크레딧·장비·능력) */
export interface SelfSnap {
  credits: number;
  rewards: { amount: number; reason: string }[];
  primary: string | null;
  secondary: string;
  armor: number;
  charges: Record<AbilitySlot, number>;
  ult: number;
  /** 이번 구매 단계에 산 것 (환불 가능) */
  refundable: string[];
}

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'team'; team: TeamId }
  | { t: 'agent'; agent: string }
  /** 캐릭터 선택 확정 */
  | { t: 'lock' }
  | { t: 'start' }
  /** 방장: 경기 방식 */
  | { t: 'mode'; mode: import('../rounds/matchConfig').MatchMode }
  /** 방장: 맵 (맵 id 또는 'random') */
  | { t: 'map'; map: string }
  | { t: 'state'; s: PlayerState }
  /** 사격: 서버 시각 at 기준으로 되감아 판정 (지연 보정) */
  | { t: 'fire'; weapon: string; eye: V3; dirs: V3[]; at: number }
  | { t: 'buy'; item: string }
  | { t: 'sell'; item: string }
  | { t: 'drop' }
  /** 능력: 시선(eye·aim), alt 변형, 지도에서 고른 지점, 누른 시간(충격파) */
  | { t: 'cast'; slot: AbilitySlot; eye: V3; aim: V3; variant?: 0 | 1; points?: V3[]; held?: number }
  | { t: 'ping'; c: number }
  /** 개발용 (FAST=1 서버에서만): 순간이동 */
  | { t: 'dev'; p: V3; yaw: number };

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'error'; msg: string }
  | { t: 'start'; you: string; config: import('../rounds/matchConfig').MatchConfig; /** 이번 경기 맵 id (무작위면 서버가 뽑은 맵) */ map: string }
  | { t: 'snap'; time: number; players: NetPlayer[]; round: RoundSnap; you: SelfSnap }
  /** 내 위치를 서버가 정함 (라운드 시작 스폰, 이동 검사 실패) */
  | { t: 'teleport'; p: V3; yaw: number; seq: number }
  /** 지진 등으로 띄워짐 (내 캐릭터) */
  | { t: 'knock'; vy: number }
  | { t: 'hit'; shooter: string; target: string; part: 'head' | 'body' | 'leg'; damage: number; point: V3; from: V3 }
  | { t: 'shot'; shooter: string; weapon: string; from: V3; to: V3[] }
  | { t: 'kill'; shooter: string; shooterName: string; target: string; targetName: string; weapon: string; head: boolean }
  | { t: 'cast'; id: string; slot: AbilitySlot; eye: V3; aim: V3; variant?: 0 | 1; points?: V3[]; held?: number }
  | { t: 'round'; kind: 'end'; reason: EndReason; winner: TeamId }
  | { t: 'round'; kind: 'planted' | 'defused' | 'detonated' | 'swap' | 'matchEnd' | 'setup' | 'plantStart'; site?: string; winner?: TeamId }
  | { t: 'pong'; c: number; s: number };
