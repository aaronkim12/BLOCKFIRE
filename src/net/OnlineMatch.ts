import * as THREE from 'three';
import type { AbilitySlot } from '../abilities/abilityData';
import { SLOTS } from '../abilities/abilityData';
import type { Game } from '../core/Game';
import { CoreModel } from '../objective/CoreModel';
import { buildSpawnBarrier, clampToZone, spawnZoneOf, type SpectateView } from '../rounds/MatchController';
import type { MatchConfig } from '../rounds/matchConfig';
import { RoundManager, type RoundState, type Side, type SiteId, type TeamId } from '../rounds/RoundManager';
import { RoundHUD } from '../ui/RoundHUD';
import { getWeapon } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import type { NetClient } from './NetClient';
import { CLIENT_SEND_RATE, type PlayerState, type ServerMsg, type V3 } from './protocol';
import { CORE_VIEW_DIST, orbitCamera, SPECTATE_DIST, SPECTATE_PITCH } from '../rounds/SpectateCam';
import { FloorWeapons } from '../rounds/FloorWeapons';
import { RemotePlayer } from './RemotePlayer';

const REASON_TEXT: Record<string, (mine: boolean) => string> = {
  elimination: (m) => (m ? '적 전멸' : '아군 전멸'),
  timeout: (m) => (m ? '시간 종료 — 방어 성공' : '시간 종료'),
  detonated: (m) => (m ? 'Core 폭발' : 'Core가 폭발했습니다'),
  defused: (m) => (m ? 'Core 해체 성공' : 'Core가 해체되었습니다'),
};

/** 서버가 보낸 크레딧을 MatchController.economy와 같은 모양으로 */
class EconomyMirror {
  credits = 0;
  lastRewards = new Map<string, { amount: number; reason: string }[]>();
  get(_id: string): number {
    return this.credits;
  }
}

/**
 * 온라인 경기 (클라이언트 쪽). 규칙은 서버(ServerMatch)가 진행하고, 여기서는
 *   - 서버 스냅샷을 RoundManager 거울·HUD·Core 모형에 반영
 *   - 다른 플레이어를 그리고, 사격·명중·처치·능력 사용을 화면에 재현
 *   - 내 상태(이동·설치/해체 키)를 30Hz로 보낸다
 * Game에서는 MatchController와 같은 자리(game.match)에 들어간다.
 */
export class OnlineMatch {
  readonly rm: RoundManager;
  readonly economy = new EconomyMirror();
  readonly core = new CoreModel();
  readonly remotes = new Map<string, RemotePlayer>();
  /** 바닥에 떨어진 무기 (서버 목록을 그림) */
  readonly floor: FloorWeapons;
  private pickupName: string | null = null;
  private prevInteract = false;
  /** 이번 구매 단계에 산 것 (환불 가능) — 서버가 알려 줌 */
  refundable: string[] = [];
  plantProgress = -1;
  spectatingName: string | null = null;
  private hud: RoundHUD;
  private barrier: THREE.Group;
  private off: () => void;
  private sendTimer = 0;
  private myTeamId: TeamId = 'A';
  private prevState: RoundState = 'Waiting';
  private beepTimer = 0;
  private deathPos = new THREE.Vector3();
  private spectateId: string | null = null;
  private spectateAngle = 0;
  private loadoutBusy = false;
  private lastSnapTime = 0;
  private pending = new Set<string>();
  /** 마지막으로 받은 순간이동 번호 */
  private tpSeq = 0;

  constructor(
    private game: Game,
    container: HTMLElement,
    private net: NetClient,
    config: MatchConfig,
  ) {
    this.rm = new RoundManager(config, {});
    this.hud = new RoundHUD(container);
    this.barrier = buildSpawnBarrier(game.map);
    this.floor = new FloorWeapons(game.map.collision);
    game.scene.add(this.core.root, this.barrier, this.floor.group);
    game.practice?.dummies.forEach((d) => d.setEnabled(false));
    if (game.practice) game.practice.showcaseVisible = false;
    const me = net.room?.players.find((p) => p.id === net.id);
    this.myTeamId = me?.team ?? 'A';
    for (const p of net.room?.players ?? []) this.rm.addParticipant({ id: p.id, name: p.name, team: p.team });
    this.off = net.on((m) => this.onMessage(m));
  }

  get myId(): string {
    return this.net.id;
  }

  get myTeam(): TeamId {
    return this.myTeamId;
  }

  get mySide(): Side {
    return this.rm.sideOf(this.myTeamId);
  }

  start(): void {}

  get movementLocked(): boolean {
    const c = this.rm.core;
    const interacting = (c.planterId === this.myId && c.plantProgress > 0 && c.status === 'carried') || (c.defuserId === this.myId && c.status === 'planted');
    return !this.rm.canMove || interacting;
  }

  get weaponsLocked(): boolean {
    const s = this.rm.state;
    return s === 'BuyPhase' || s === 'RoundStart' || s === 'Waiting';
  }

  get combatActive(): boolean {
    return this.rm.combatActive;
  }

  setScoreboard(on: boolean): void {
    this.hud.setScoreboard(on);
  }

  /** 되살아나기: 서버가 정한다 (스냅샷으로 반영) */
  reviveParticipant(_id: string): boolean {
    return true;
  }

  // ───────────────────────── 서버 메시지 ─────────────────────────

  private onMessage(m: ServerMsg): void {
    const g = this.game;
    switch (m.t) {
      case 'snap':
        this.applySnapshot(m);
        break;
      case 'knock':
        g.local.knock(m.vy);
        break;
      case 'teleport':
        this.tpSeq = m.seq;
        g.player.spawn(m.p[0], m.p[1], m.p[2], m.yaw);
        g.resetAccumulator();
        break;
      case 'hit': {
        const point = new THREE.Vector3(...m.point);
        const from = new THREE.Vector3(...m.from);
        g.effects.hit(point, from.clone().sub(point).normalize(), m.part === 'head');
        this.remotes.get(m.target)?.model.noteHit(from, point, m.part === 'head');
        if (m.shooter === this.myId) {
          g.hud.showHitmarker(m.part === 'head' ? 'head' : 'body');
          g.hud.addDamageNumber(point, m.damage, m.part);
          g.sound.play(m.part === 'head' ? 'hit_head' : 'hit_body', { gain: 0.7 });
        }
        if (m.target === this.myId) {
          g.sound.play('hurt', { gain: 0.9 });
          g.hud.showDamageFrom(from, g.camera);
        }
        break;
      }
      case 'shot': {
        const r = this.remotes.get(m.shooter);
        if (!r) break;
        const muzzle = r.onShot();
        for (const to of m.to) g.effects.tracer(muzzle, new THREE.Vector3(...to));
        g.sound.weapon(m.weapon, 'shot', muzzle);
        break;
      }
      case 'kill': {
        const mine = m.shooter === this.myId || m.target === this.myId;
        g.hud.addKill(m.shooterName, m.weapon, m.targetName, m.head, mine);
        if (m.shooter === this.myId) {
          g.hud.showHitmarker('kill');
          g.sound.play('kill', { gain: 0.7 });
          g.onlineKill();
        }
        if (m.target === this.myId) this.localDeath();
        break;
      }
      case 'cast':
        this.remotes.get(m.id)?.replayCast(m);
        break;
      case 'round':
        this.onRoundEvent(m);
        break;
    }
  }

  private onRoundEvent(m: Extract<ServerMsg, { t: 'round' }>): void {
    const g = this.game;
    switch (m.kind) {
      case 'end': {
        const mine = m.winner === this.myTeam;
        this.hud.banner(mine ? 'ROUND WIN' : 'ROUND LOSS', REASON_TEXT[m.reason](mine), mine ? 'win' : 'loss');
        g.sound.play(mine ? 'round_win' : 'round_lose', { gain: 0.8 });
        g.abilityFx.clear();
        break;
      }
      case 'swap':
        this.hud.banner('SIDE SWAP', '공격과 수비가 바뀝니다', 'info');
        break;
      case 'matchEnd': {
        const won = m.winner === this.myTeam;
        const other: TeamId = this.myTeam === 'A' ? 'B' : 'A';
        this.hud.matchEnd(won, this.rm.score[this.myTeam], this.rm.score[other]);
        g.sound.play(won ? 'round_win' : 'round_lose');
        break;
      }
      case 'plantStart':
        g.sound.play('plant_start', { gain: 0.6 });
        break;
      case 'planted':
        this.hud.banner('CORE PLANTED', `${m.site} 구역에 Core가 설치되었습니다`, 'alert');
        this.core.resetBlink();
        this.beepTimer = 0;
        break;
      case 'defused':
        this.core.disarm();
        g.sound.play('defused', { gain: 1 });
        break;
      case 'detonated': {
        const c = this.rm.core.position;
        if (c) {
          const center = new THREE.Vector3(c.x, c.y + 0.5, c.z);
          this.core.explode();
          g.sound.play('explosion', { at: center, size: 'large', intensity: 1 });
          g.effects.explosion(center, this.rm.config.explosionRadius);
          g.coreBlast.start(center, this.rm.config.explosionRadius);
          g.shake(0.6);
        }
        break;
      }
      case 'setup':
        g.abilityFx.clear();
        g.shop.lockIn();
        break;
    }
  }

  private applySnapshot(m: Extract<ServerMsg, { t: 'snap' }>): void {
    const g = this.game;
    const rm = this.rm;
    const r = m.round;
    this.lastSnapTime = m.time;
    // ── 라운드 거울
    rm.sides.A = r.sides.A;
    rm.sides.B = r.sides.B;
    rm.state = r.state;
    rm.round = r.round;
    rm.timeLeft = r.timeLeft;
    rm.score.A = r.score.A;
    rm.score.B = r.score.B;
    rm.core = r.core;
    rm.winner = r.winner;
    rm.lastResult = r.lastResult;
    rm.history.length = 0;
    rm.history.push(...r.history);
    for (const p of r.participants) {
      const q = rm.participants.get(p.id);
      if (q) Object.assign(q, p);
      else rm.participants.set(p.id, { ...p });
    }
    if (r.state !== this.prevState) this.onState(r.state, this.prevState);
    this.prevState = r.state;

    // ── 플레이어
    for (const np of m.players) {
      if (np.id === this.myId) {
        const L = g.local;
        L.vitals.health = np.hp;
        L.vitals.armor = np.armor;
        g.abilityFx.status.setAll(L.id, np.st ?? {});
        if (!L.alive && np.alive) this.localRevive();
        else if (L.alive && !np.alive) this.localDeath();
        continue;
      }
      let rp = this.remotes.get(np.id);
      if (!rp) {
        this.spawnRemote(np.id);
        continue;
      }
      rp.team = this.rm.sideOf(rp.teamId);
      g.abilityFx.setBlind(np.id, np.bl ?? 0);
      g.abilityFx.status.setAll(np.id, np.st ?? {});
      rp.push(m.time, np.s, np.alive, np.hp, np.armor);
    }

    this.floor.sync(m.floor ?? []);

    // ── 내 크레딧·장비·능력
    const you = m.you;
    this.economy.credits = you.credits;
    this.economy.lastRewards.set('player', you.rewards);
    this.refundable = you.refundable;
    const ab = g.abilities;
    for (const s of SLOTS) if (s !== 'ultimate') ab.charges[s as AbilitySlot] = you.charges[s as AbilitySlot];
    ab.ultPoints = you.ult;
    void this.syncLoadout(you.primary, you.secondary);
    // Core를 내가 들고 있는지
    const carrying = r.core.status === 'carried' && r.core.carrierId === this.myId;
    if (carrying !== !!g.inventory.get(4)) g.setCoreWeapon(carrying);
  }

  private spawnRemote(id: string): void {
    if (this.pending.has(id)) return;
    const info = this.net.room?.players.find((p) => p.id === id);
    if (!info) return;
    this.pending.add(id);
    // 팀 색: 팀 A = 파랑, 팀 B = 빨강 (대기실의 팀 색과 같다)
    const color = info.team === 'A' ? 'defense' : 'attack';
    void RemotePlayer.create(this.game, id, info.name, info.team, info.agent, color).then((rp) => {
      this.pending.delete(id);
      this.remotes.set(id, rp);
      this.game.combat.addTarget(rp);
    });
  }

  /** 서버 장비와 손에 든 장비가 다르면 맞춘다 */
  private async syncLoadout(primary: string | null, secondary: string): Promise<void> {
    if (this.loadoutBusy) return;
    const inv = this.game.inventory;
    const curP = inv.get(1)?.def.id ?? null;
    const curS = inv.get(2)?.def.id ?? null;
    if (curP === primary && curS === (secondary || null) && inv.get(3)) return;
    this.loadoutBusy = true;
    try {
      if (curP !== primary) {
        if (primary) {
          const d = getWeapon(primary);
          inv.give(d, await loadWeaponTemplate(d), true);
        } else inv.remove(1);
      }
      if (curS !== (secondary || null)) {
        if (secondary) {
          const d = getWeapon(secondary);
          inv.give(d, await loadWeaponTemplate(d), !inv.get(1));
        } else inv.remove(2);
      }
      if (!inv.get(3) && !this.game.stormActive) {
        const d = getWeapon('blade');
        inv.give(d, await loadWeaponTemplate(d));
      }
      if (!inv.current) inv.switchTo(inv.get(1) ? 1 : 2, true);
    } finally {
      this.loadoutBusy = false;
    }
  }

  private onState(s: RoundState, prev: RoundState): void {
    const g = this.game;
    if (s === 'BuyPhase') this.hud.banner(`ROUND ${this.rm.round}`, this.mySide === 'attack' ? '공격 — Core를 설치하라' : '수비 — Core 설치를 막아라', 'info');
    if (s === 'ActiveRound' && prev === 'RoundStart') g.sound.play('round_start', { gain: 0.7 });
    if (prev === 'BuyPhase') g.shop.lockIn();
    if (s === 'BuyPhase') {
      // 새 라운드: 능력 상태 초기화 (충전 수는 서버 스냅샷을 따른다)
      g.abilities.roundStart();
      g.local.team = this.mySide;
    }
  }

  private localDeath(): void {
    const L = this.game.local;
    if (!L.alive) return;
    L.alive = false;
    L.deadTime = 0;
    this.deathPos.copy(this.game.player.position);
    this.game.onlineDeath();
  }

  private localRevive(): void {
    const g = this.game;
    g.local.alive = true;
    g.local.deadTime = -1;
    g.local.recoil.reset();
    g.local.team = this.mySide;
    if (g.inventory.current) g.inventory.switchTo(g.inventory.currentSlot, true);
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(dt: number, interactHeld: boolean, moveHeld: boolean, fireHeld = false, dropPressed = false): void {
    const g = this.game;
    const rm = this.rm;
    this.core.update(dt);
    const serverNow = this.net.serverTime();
    for (const r of this.remotes.values()) r.update(dt, serverNow);

    // 구매 단계: 스폰 구역 밖으로 못 나감
    this.barrier.visible = rm.state === 'BuyPhase' || rm.state === 'Waiting';
    for (const c of this.barrier.children) c.visible = c.name === this.mySide;
    if (this.barrier.visible) clampToZone(g.player, spawnZoneOf(g.map, this.mySide));

    const p = g.player.position;
    const alive = g.local.alive;
    const c = rm.core;
    const carrying = c.status === 'carried' && c.carrierId === this.myId;
    const holdingCore = g.inventory.current?.def.category === 'core';
    // 설치(공격): Core를 들고 좌클릭 또는 E / 해체(수비): E
    let act: 0 | 1 | 2 = 0;
    if (alive && this.mySide === 'attack') {
      const plantHeld = carrying && (interactHeld || (fireHeld && holdingCore));
      if (plantHeld && !holdingCore && g.inventory.currentSlot !== 4) g.inventory.switchTo(4);
      if ((plantHeld && holdingCore && g.inventory.state === 'ready') || (interactHeld && c.status === 'dropped')) act = 1;
    } else if (alive && this.mySide === 'defense' && interactHeld && c.status === 'planted') act = 2;
    if (alive && dropPressed && holdingCore) this.net.send({ t: 'drop' });
    // G: 손에 든 총 버리기 / 바닥 무기 줍기 (밟으면 서버가 자동으로, E는 바꿔 들기)
    const cur = g.inventory.current;
    if (alive && dropPressed && !holdingCore && cur && (cur.def.slot === 1 || cur.def.slot === 2) && cur.def.id !== 'storm') this.net.send({ t: 'dropWeapon' });
    const interactPressed = interactHeld && !this.prevInteract;
    this.prevInteract = interactHeld;
    this.floor.update(dt);
    this.pickupName = null;
    if (alive) {
      const near = this.floor.nearest(g.player.position, 2);
      if (near) {
        const def = getWeapon(near.weapon);
        if (g.inventory.get(def.slot as 1 | 2)) {
          this.pickupName = def.name;
          if (interactPressed) this.net.send({ t: 'pickup', i: near.id });
        }
      }
    }
    this.plantProgress = carrying && c.planterId === this.myId && c.plantProgress > 0 ? c.plantProgress : -1;

    // Core 모형
    if (c.position && (c.status === 'dropped' || c.status === 'planted' || c.status === 'defused')) {
      this.core.place(new THREE.Vector3(c.position.x, c.position.y, c.position.z), c.status === 'dropped' ? 'dropped' : 'planted');
    } else if (c.status === 'carried') this.core.hide();
    if (c.status === 'planted' && c.position) {
      const urgency = 1 - Math.min(1, c.timer / rm.config.coreTime);
      this.core.urgency = urgency * urgency;
      this.beepTimer -= dt;
      if (this.beepTimer <= 0) {
        this.beepTimer = THREE.MathUtils.lerp(1, 0.12, this.core.urgency);
        g.sound.play('beep', { at: new THREE.Vector3(c.position.x, c.position.y + 0.4, c.position.z), gain: 0.9 });
      }
    }

    // 내 상태 보내기 (30Hz)
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = 1 / CLIENT_SEND_RATE;
      this.net.send({ t: 'state', s: this.myState(act, moveHeld) });
    }

    // HUD
    const label = c.planterId === this.myId && c.plantProgress > 0 && c.status === 'carried' ? 'CORE 설치 중' : c.defuserId === this.myId && c.status === 'planted' ? 'CORE 해체 중' : '';
    const progress = label ? (c.status === 'planted' ? c.defuseProgress : c.plantProgress) : -1;
    const players = this.net.room?.players ?? [];
    this.hud.update({
      state: rm.state,
      timeLeft: rm.timeLeft,
      round: rm.round,
      score: rm.score,
      myTeam: this.myTeam,
      mySide: this.mySide,
      alive: { A: rm.aliveCount('A'), B: rm.aliveCount('B') },
      teamSize: { A: players.filter((x) => x.team === 'A').length, B: players.filter((x) => x.team === 'B').length },
      core: c,
      carrying,
      inSite: this.siteAt(p),
      nearCore: !!c.position && Math.hypot(c.position.x - p.x, c.position.z - p.z) < rm.config.interactRange,
      progress: label ? progress : c.defuseProgress > 0 && this.mySide === 'defense' && c.status === 'planted' ? -2 : -1,
      checkpoint: c.defuseProgress,
      progressLabel: label,
      alivePlayer: alive,
      participants: [...rm.participants.values()],
      winner: rm.winner,
      config: rm.config,
      spectating: this.spectatingName,
      pickup: this.pickupName,
      credits: this.economy.credits,
      rewards: this.economy.lastRewards.get('player') ?? [],
    });
  }

  private myState(act: 0 | 1 | 2, moving: boolean): PlayerState {
    const g = this.game;
    const p = g.player;
    const r = (v: number) => +v.toFixed(3);
    const piloting = g.piloting;
    return {
      p: [r(p.position.x), r(p.position.y), r(p.position.z)],
      yaw: r(p.yaw),
      pitch: r(p.pitch),
      crouch: r(g.crouchLevel()),
      v: [r(p.velocity.x), r(p.velocity.z)],
      grounded: p.grounded,
      weapon: g.inventory.current?.def.id ?? 'blade',
      reload: r(g.inventory.reloadProgress),
      act,
      moving,
      dash: p.dashAmount > 0,
      tp: this.tpSeq,
      drone: piloting ? ([r(piloting.pos.x), r(piloting.pos.y), r(piloting.pos.z)] as V3) : undefined,
    };
  }

  private idleTimer = 0;

  /** 일시정지 중: 가만히 서 있는 상태를 가끔 보낸다 (이동·사격·설치 입력 없음) */
  idleTick(dt: number): void {
    this.idleTimer -= dt;
    if (this.idleTimer > 0) return;
    this.idleTimer = 0.2;
    const s = this.myState(0, false);
    s.v = [0, 0];
    this.net.send({ t: 'state', s });
  }

  /** 지연 보정: 내 화면의 다른 플레이어는 이 서버 시각의 모습 */
  shotTime(): number {
    return this.net.serverTime() - 0.1;
  }

  siteAt(p: THREE.Vector3): SiteId | null {
    for (const id of ['A', 'B'] as SiteId[]) {
      const s = this.game.map.sites[id];
      if (p.x >= s.minX && p.x <= s.maxX && p.z >= s.minZ && p.z <= s.maxZ) return id;
    }
    return null;
  }

  // ───────────────────────── 관전 ─────────────────────────

  private allyViews(): [string, SpectateView][] {
    const out: [string, SpectateView][] = [];
    for (const [id, r] of this.remotes) {
      if (r.teamId !== this.myTeam || !r.alive) continue;
      out.push([id, { name: r.name, eye: (o) => r.eyePos(o), yaw: () => r.ctrl.yaw, pitch: () => r.ctrl.pitch, onSpectate: (on) => (r.model.root.visible = !on) }]);
    }
    return out;
  }

  spectate(camera: THREE.PerspectiveCamera, _dt: number, next = false, prev = false): boolean {
    this.spectatingName = null;
    const L = this.game.local;
    if (L.alive || L.deadTime < 1.5) {
      for (const r of this.remotes.values()) r.model.root.visible = true;
      return false;
    }
    const views = this.allyViews();
    for (const r of this.remotes.values()) r.model.root.visible = true;
    const look = this.game.player;
    const world = this.game.map.collision;
    if (views.length) {
      let i = Math.max(0, views.findIndex(([id]) => id === this.spectateId));
      if (next) i = (i + 1) % views.length;
      if (prev) i = (i - 1 + views.length) % views.length;
      const [id, v] = views[i];
      // 새 대상: 그 아군 뒤에서 시작 (3인칭, 마우스로 돌려 봄)
      if (this.spectateId !== id) {
        look.yaw = v.yaw();
        look.pitch = SPECTATE_PITCH;
      }
      this.spectateId = id;
      const t = v.eye(new THREE.Vector3());
      t.y -= 0.2;
      orbitCamera(camera, world, t, look.yaw, look.pitch, SPECTATE_DIST);
      this.spectatingName = v.name;
      return true;
    }
    if (this.spectateId !== null || this.spectateAngle === 0) {
      look.pitch = SPECTATE_PITCH;
      this.spectateAngle = 1;
    }
    this.spectateId = null;
    // 아군 전멸: 설치된 Core를 보여 준다
    const core = this.rm.core;
    if (core.status === 'planted' && core.position) {
      const t = new THREE.Vector3(core.position.x, core.position.y + 0.4, core.position.z);
      orbitCamera(camera, world, t, look.yaw, look.pitch, CORE_VIEW_DIST);
      this.spectatingName = 'CORE';
      return true;
    }
    const c = this.deathPos;
    orbitCamera(camera, world, new THREE.Vector3(c.x, c.y + 1, c.z), look.yaw, look.pitch, CORE_VIEW_DIST);
    return true;
  }

  get snapshotAge(): number {
    return this.net.serverTime() - this.lastSnapTime;
  }

  dispose(): void {
    const g = this.game;
    this.off();
    g.local.team = 'attack';
    this.hud.dispose();
    this.core.root.removeFromParent();
    this.barrier.removeFromParent();
    this.floor.clear();
    this.floor.group.removeFromParent();
    for (const r of this.remotes.values()) {
      r.dispose();
      const i = g.combat.targets.indexOf(r);
      if (i >= 0) g.combat.targets.splice(i, 1);
    }
    this.remotes.clear();
    for (const d of g.practice?.dummies ?? []) d.resetHome();
    if (g.practice) {
      g.practice.dummies.forEach((d) => d.setEnabled(true));
      g.practice.showcaseVisible = true;
    }
  }
}
