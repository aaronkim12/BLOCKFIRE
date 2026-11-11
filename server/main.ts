import { WebSocketServer, type WebSocket } from 'ws';
import { AGENTS } from '../src/abilities/abilityData';
import { NET_PORT, SELECT_TIME, SERVER_TICK, TEAM_SIZE, type RoomPhase, type ClientMsg, type LobbyPlayer, type RoomInfo, type ServerMsg } from '../src/net/protocol';
import { DEFAULT_MATCH, MATCH_MODES, withMode, type MatchConfig, type MatchMode } from '../src/rounds/matchConfig';
import type { TeamId } from '../src/rounds/RoundManager';
import { ServerMatch } from './ServerMatch';
import { createStaticServer } from './static';

/**
 * BLOCKFIRE 온라인 서버 (Node.js + WebSocket).
 *   방 만들기/참가(4글자 코드), 팀·캐릭터 선택, 방장이 경기 시작
 *   경기는 ServerMatch가 30Hz로 시뮬레이션하고 20Hz로 스냅샷을 보낸다 (서버 권한)
 * 실행: npm run server   (포트: 환경 변수 PORT, 기본 5174)
 * 배포: npm run build 후 npm start — 같은 포트로 게임 파일(dist/)도 함께 제공
 */

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  room: Room | null;
}

class Room {
  readonly players: LobbyPlayer[] = [];
  match: ServerMatch | null = null;
  /** 경기 시작 후 흐른 시간 (지연 보정 기준 시각) */
  time = 0;
  /** 경기가 끝나 결과를 보여 주는 중 */
  ending = false;
  /** 경기 방식 (방장이 고름) */
  mode: MatchMode = 'standard';
  /** 대기실 → 캐릭터 선택 → 경기 */
  selecting = false;
  /** 캐릭터 선택 마감 시각 (ms) */
  selectEnds = 0;
  get phase(): RoomPhase {
    return this.match ? 'match' : this.selecting ? 'select' : 'lobby';
  }
  get config(): MatchConfig {
    // FAST(테스트 서버)는 짧은 시간 설정을 그대로 쓴다
    return process.env.FAST ? { ...DEFAULT_MATCH } : withMode({ ...DEFAULT_MATCH }, this.mode);
  }

  constructor(readonly code: string) {}

  info(): RoomInfo {
    const selectLeft = this.selecting ? Math.max(0, Math.ceil((this.selectEnds - Date.now()) / 1000)) : 0;
    return { code: this.code, phase: this.phase, selectLeft, mode: this.mode, players: this.players, inMatch: !!this.match };
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players) clients.get(p.id)?.ws.send(data);
  }

  sendRoom(): void {
    this.broadcast({ t: 'room', room: this.info() });
  }
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
let nextId = 1;

function send(c: Client | undefined, msg: ServerMsg): void {
  if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

/** 인원이 적은 팀 (같으면 A) */
function openTeam(room: Room): TeamId | null {
  const a = room.players.filter((p) => p.team === 'A').length;
  const b = room.players.filter((p) => p.team === 'B').length;
  if (a >= TEAM_SIZE && b >= TEAM_SIZE) return null;
  return a <= b ? 'A' : 'B';
}

/** 팀 안에서 아직 아무도 고르지 않은 캐릭터 */
function freeAgent(room: Room, team: TeamId, prefer?: string): string {
  const taken = new Set(room.players.filter((p) => p.team === team).map((p) => p.agent));
  if (prefer && !taken.has(prefer)) return prefer;
  return AGENTS.find((a) => !taken.has(a.id))?.id ?? AGENTS[0].id;
}

function joinRoom(c: Client, room: Room): void {
  if (room.match || room.selecting) return send(c, { t: 'error', msg: '이미 경기를 시작한 방입니다' });
  const team = openTeam(room);
  if (!team) return send(c, { t: 'error', msg: '방이 가득 찼습니다 (5대5)' });
  leaveRoom(c);
  c.room = room;
  room.players.push({ id: c.id, name: c.name, team, agent: freeAgent(room, team), host: room.players.length === 0, locked: false });
  room.sendRoom();
}

function leaveRoom(c: Client): void {
  const room = c.room;
  if (!room) return;
  c.room = null;
  const i = room.players.findIndex((p) => p.id === c.id);
  if (i >= 0) {
    const wasHost = room.players[i].host;
    room.players.splice(i, 1);
    if (wasHost && room.players[0]) room.players[0].host = true;
  }
  room.match?.removePlayer(c.id);
  send(c, { t: 'room', room: null });
  if (room.players.length === 0) rooms.delete(room.code);
  else {
    room.sendRoom();
    // 나간 사람만 기다리던 중이었으면 바로 시작
    if (room.selecting) checkSelect(room);
  }
}

function handle(c: Client, m: ClientMsg): void {
  const room = c.room;
  const me = room?.players.find((p) => p.id === c.id);
  switch (m.t) {
    case 'hello':
      c.name = String(m.name || 'PLAYER').slice(0, 16).toUpperCase();
      return;
    case 'ping':
      return send(c, { t: 'pong', c: m.c, s: room?.match ? room.time : 0 });
    case 'create': {
      const r = new Room(newCode());
      rooms.set(r.code, r);
      joinRoom(c, r);
      return;
    }
    case 'join': {
      const r = rooms.get(String(m.code).toUpperCase());
      if (!r) return send(c, { t: 'error', msg: '방을 찾을 수 없습니다' });
      joinRoom(c, r);
      return;
    }
    case 'leave':
      leaveRoom(c);
      return;
  }
  if (!room || !me) return;
  if (room.match) {
    room.match.handle(c.id, m);
    return;
  }
  switch (m.t) {
    case 'team': {
      if (room.selecting) return;
      if (me.team === m.team || room.players.filter((p) => p.team === m.team).length >= TEAM_SIZE) return;
      me.team = m.team;
      me.agent = freeAgent(room, m.team, me.agent);
      room.sendRoom();
      return;
    }
    case 'agent': {
      if (me.locked || !AGENTS.some((a) => a.id === m.agent)) return;
      if (room.players.some((p) => p.team === me.team && p.agent === m.agent && p.id !== me.id)) return send(c, { t: 'error', msg: '같은 팀에서 이미 고른 캐릭터입니다' });
      me.agent = m.agent;
      room.sendRoom();
      return;
    }
    case 'lock': {
      if (!room.selecting || me.locked) return;
      // 고른 캐릭터를 같은 팀이 먼저 확정했으면 거절
      if (room.players.some((p) => p.team === me.team && p.agent === me.agent && p.id !== me.id && p.locked))
        return send(c, { t: 'error', msg: '같은 팀에서 이미 확정한 캐릭터입니다' });
      me.locked = true;
      room.sendRoom();
      checkSelect(room);
      return;
    }
    case 'mode':
      if (room.selecting || !me.host || !(m.mode in MATCH_MODES)) return;
      room.mode = m.mode;
      room.sendRoom();
      return;
    case 'start':
      if (!me.host || room.selecting) return;
      // 캐릭터 선택 단계로
      room.selecting = true;
      room.selectEnds = Date.now() + (process.env.FAST ? 15 : SELECT_TIME) * 1000;
      for (const p of room.players) p.locked = false;
      room.sendRoom();
      return;
  }
}

/** 모두 확정했거나 시간이 끝나면 경기 시작 (시간이 끝나면 지금 고른 캐릭터로) */
function checkSelect(room: Room): void {
  if (!room.selecting || room.players.length === 0) return;
  const allLocked = room.players.every((p) => p.locked);
  if (!allLocked && Date.now() < room.selectEnds) return;
  // 같은 팀 중복 정리 (확정하지 않은 사람이 비어 있는 캐릭터로)
  for (const p of room.players) {
    if (room.players.some((o) => o.id !== p.id && o.team === p.team && o.agent === p.agent && (o.locked || room.players.indexOf(o) < room.players.indexOf(p)))) {
      p.agent = freeAgent(room, p.team);
    }
    p.locked = true;
  }
  room.selecting = false;
  startMatch(room);
}

function startMatch(room: Room): void {
  const match = new ServerMatch(room.players, (id, msg) => {
    if (id === null) room.broadcast(msg);
    else send(clients.get(id), msg);
  }, room.config);
  room.match = match;
  room.time = 0;
  for (const p of room.players) send(clients.get(p.id), { t: 'start', you: p.id, config: room.config });
  room.sendRoom();
  match.start();
}

// ── 시뮬레이션 루프 (모든 방)
const DT = 1 / SERVER_TICK;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const steps = Math.min(5, Math.round((now - last) / 1000 / DT));
  last += steps * DT * 1000;
  if (steps === 0) return;
  for (const room of rooms.values()) {
    if (room.selecting) checkSelect(room);
    const m = room.match;
    if (!m) continue;
    for (let i = 0; i < steps; i++) m.update(DT);
    room.time += steps * DT;
    if (m.rm.state === 'MatchEnd' && !room.ending) {
      room.ending = true;
      // 결과 화면을 잠시 보여 준 뒤 대기실로
      setTimeout(() => {
        room.match = null;
        room.ending = false;
        for (const p of room.players) p.locked = false;
        room.sendRoom();
      }, 8000);
    }
  }
}, DT * 1000);

const port = Number(process.env.PORT ?? NET_PORT);
const http = createStaticServer();
const wss = new WebSocketServer({ server: http });
http.listen(port);
wss.on('connection', (ws) => {
  const c: Client = { id: `p${nextId++}`, ws, name: 'PLAYER', room: null };
  clients.set(c.id, c);
  send(c, { t: 'welcome', id: c.id });
  ws.on('message', (data) => {
    let m: ClientMsg;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    try {
      handle(c, m);
    } catch (e) {
      console.error('[server] message error', m.t, e);
    }
  });
  ws.on('close', () => {
    leaveRoom(c);
    clients.delete(c.id);
  });
});
console.log(`[BLOCKFIRE] server listening on http://0.0.0.0:${port} (WebSocket 같은 주소)`);

// 테스트용: 짧은 경기 설정 (환경 변수 FAST=1)
if (process.env.FAST) {
  Object.assign(DEFAULT_MATCH, { waitTime: 0.5, buyTime: 10, roundStartTime: 0.5, roundTime: 60, coreTime: 25, roundEndTime: 3, roundsPerHalf: 2, winRounds: 3 });
}
