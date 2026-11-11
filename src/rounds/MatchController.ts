import * as THREE from 'three';
import { applyDamage } from '../combat/ballistics';
import type { Damageable, DamageEvent } from '../combat/CombatSystem';
import { getWeapon } from '../weapons/weaponData';
import type { Game } from '../core/Game';
import type { AABB } from '../physics/CollisionWorld';
import type { BuiltMap } from '../maps/MapBuilder';
import { CoreModel } from '../objective/CoreModel';
import type { Bot } from '../ai/Bot';
import type { BotDifficulty } from '../ai/botConfig';
import { RoundHUD } from '../ui/RoundHUD';
import { Economy } from '../economy/Economy';
import type { MatchConfig } from './matchConfig';
import { CORE_VIEW_DIST, orbitCamera, SPECTATE_DIST, SPECTATE_PITCH } from './SpectateCam';
import { RoundManager, type RoundState, type Side, type SiteId, type TeamId, type Vec3 } from './RoundManager';

/**
 * 경기 진행: RoundManager(규칙)를 실제 게임 세계에 연결한다.
 *   - 라운드마다 참가자 재배치/부활, Core 지급
 *   - 구매 단계 스폰 구역 차단, 라운드 시작 대기 중 이동 금지
 *   - E 길게 누르기: Core 설치(공격) / 해체(수비), 떨어진 Core 줍기
 *   - Core 신호음, 폭발 피해, 사망 후 관전 카메라
 *
 * 5대5: 플레이어 + 아군 봇 4명(팀 A) 대 적 봇 5명(팀 B). 봇의 판단은 src/ai (BotManager).
 */

const PLAYER_ID = 'player';

/** 관전할 수 있는 아군의 시점 */
export interface SpectateView {
  name: string;
  eye(out: THREE.Vector3): THREE.Vector3;
  yaw(): number;
  pitch(): number;
  /** 관전 시작/끝 (자기 몸이 카메라를 가리지 않게 숨김) */
  onSpectate?(active: boolean): void;
}

export class MatchController {
  readonly rm: RoundManager;
  readonly core = new CoreModel();
  readonly economy = new Economy();
  /** 플레이어가 이번 라운드에 죽었는지 (죽으면 다음 라운드에 장비를 잃는다) */
  private playerDied = true;
  private sideSwapped = false;
  private hud: RoundHUD;
  private bots: Bot[];
  /** 이번 라운드에 죽은 봇 (다음 라운드에 장비를 잃음) */
  private botDied = new Set<string>();
  private barrier = new THREE.Group();
  /** 설치/해체 진행 중 (이동 금지) */
  private interacting: 'plant' | 'defuse' | null = null;
  private beepTimer = 0;
  private deathPos = new THREE.Vector3();
  private pickupLock = false;
  private dropCooldown = 0;
  private allies = new Map<string, SpectateView>();
  private spectateId: string | null = null;
  private spectateAngle = 0;

  constructor(
    private game: Game,
    container: HTMLElement,
    config: MatchConfig,
    difficulty: BotDifficulty = 'normal',
  ) {
    this.bots = game.bots!.bots;
    this.hud = new RoundHUD(container);
    this.rm = new RoundManager(config, {
      onState: (s, prev) => this.onState(s, prev),
      onRoundSetup: (r) => this.setupRound(r),
      onRoundEnd: (r) => {
        // 보상: 승리 3000 / 연패 보너스 1900·2400·2900. 진 팀에서 살아남은 사람은 1000만
        const survivors = new Set<string>();
        for (const p of this.rm.participants.values()) if (p.alive && p.team !== r.winner) survivors.add(p.id);
        this.economy.onRoundEnd(r.winner, survivors);
        game.abilityFx.clear();
        const mine = r.winner === this.myTeam;
        this.hud.banner(mine ? 'ROUND WIN' : 'ROUND LOSS', REASON_TEXT[r.reason](mine), mine ? 'win' : 'loss');
        game.sound.play(mine ? 'round_win' : 'round_lose', { gain: 0.8 });
      },
      onSideSwap: () => {
        this.hud.banner('SIDE SWAP', '공격과 수비가 바뀝니다', 'info');
        this.economy.resetHalf();
        this.sideSwapped = true;
      },
      onMatchEnd: (w) => {
        this.hud.matchEnd(w === this.myTeam, this.rm.score[this.myTeam], this.rm.score[w === 'A' ? 'B' : 'A'] ?? 0);
        game.sound.play(w === this.myTeam ? 'round_win' : 'round_lose');
      },
      onPlantStart: () => game.sound.play('plant_start', { gain: 0.6 }),
      onPlanted: (id, site) => {
        this.economy.onPlant(this.rm.teamOn('attack'));
        if (id === PLAYER_ID) game.abilities.addUlt(1);
        else this.botById(id)?.abilities.addUlt(1);
        const p = this.rm.core.position!;
        this.core.place(new THREE.Vector3(p.x, p.y, p.z), 'planted');
        this.core.resetBlink();
        this.beepTimer = 0;
        this.hud.banner('CORE PLANTED', `${site} 구역에 Core가 설치되었습니다`, 'alert');
        game.sound.play('planted', { at: new THREE.Vector3(p.x, p.y, p.z), gain: 1.2 });
      },
      onDefused: (id) => {
        if (id === PLAYER_ID) game.abilities.addUlt(1);
        else this.botById(id)?.abilities.addUlt(1);
        this.core.disarm();
        game.sound.play('defused', { gain: 1 });
      },
      onDetonated: () => this.detonate(),
      onCoreDropped: (pos) => this.core.place(new THREE.Vector3(pos.x, pos.y, pos.z), 'dropped'),
      onCorePicked: () => {
        this.core.hide();
        game.sound.play('ui', { gain: 0.6 });
      },
    });

    this.rm.addParticipant({ id: PLAYER_ID, name: 'YOU', team: 'A' });
    this.economy.add(PLAYER_ID, 'A');
    for (const b of this.bots) {
      this.rm.addParticipant({ id: b.id, name: b.name, team: b.teamId });
      this.economy.add(b.id, b.teamId);
      b.onDeath = (bb, e) => this.onDeath(bb.id, e);
      // 아군 봇은 사망 후 관전 대상
      if (b.teamId === this.myTeam)
        this.registerAlly(b.id, {
          name: b.name,
          eye: (o) => b.eyePos(o),
          yaw: () => b.aimYaw,
          pitch: () => b.aimPitch,
          onSpectate: (on) => (b.model.root.visible = !on && b.enabled),
        });
    }
    const match = this;
    game.bots!.attach(
      {
        rm: this.rm,
        economy: this.economy,
        playerId: PLAYER_ID,
        playerTeam: 'A',
        siteAt: (p) => this.siteAt(p),
        get weaponsLocked() {
          return match.weaponsLocked;
        },
      },
      difficulty,
      game.agentId,
    );
    // 연습장 더미/쇼케이스는 숨긴다
    game.practice?.dummies.forEach((d) => d.setEnabled(false));
    if (game.practice) game.practice.showcaseVisible = false;
    game.local.onDeath = (e) => this.onDeath(PLAYER_ID, e);

    game.scene.add(this.core.root, this.barrier);
    this.buildBarrier();
  }

  get myTeam(): TeamId {
    return 'A';
  }

  get mySide(): Side {
    return this.rm.sideOf(this.myTeam);
  }

  start(): void {
    this.rm.start();
  }

  // ───────────────────────── 게임 루프에서 호출 ─────────────────────────

  /** 이동 금지 (라운드 시작 대기, 설치/해체 중) */
  get movementLocked(): boolean {
    return !this.rm.canMove || this.interacting !== null;
  }

  /** 사격 금지 (구매 단계/라운드 시작 대기) */
  get weaponsLocked(): boolean {
    return this.rm.state === 'BuyPhase' || this.rm.state === 'RoundStart' || this.rm.state === 'Waiting';
  }

  setScoreboard(on: boolean): void {
    this.hud.setScoreboard(on);
  }

  get combatActive(): boolean {
    return this.rm.combatActive;
  }

  /** 지금 Core 설치 진행도 (뷰모델 설치 동작용, 설치 중이 아니면 -1) */
  plantProgress = -1;

  /**
   * @param interactHeld E (설치/해체/줍기)
   * @param fireHeld 좌클릭 — Core를 든 상태면 설치
   * @param dropPressed G — 들고 있는 Core 버리기
   */
  update(dt: number, interactHeld: boolean, moveHeld: boolean, fireHeld = false, dropPressed = false): void {
    const g = this.game;
    const rm = this.rm;
    rm.update(dt);
    this.core.update(dt);
    g.bots!.update(dt);

    // ── 구매 단계: 스폰 구역 밖으로 못 나감
    this.barrier.visible = rm.state === 'BuyPhase' || rm.state === 'Waiting';
    this.syncBarrier();
    if (this.barrier.visible) this.clampToSpawn();

    const p = g.player.position;
    const at: Vec3 = { x: p.x, y: p.y, z: p.z };
    const alive = g.local.alive;
    const c = rm.core;

    // ── 바닥의 Core 줍기 (공격팀): 밟고 지나가면 자동, 근처에서 E를 누르면 줍기
    if (alive && c.status === 'dropped' && c.position && this.mySide === 'attack') {
      const d = Math.hypot(c.position.x - p.x, c.position.z - p.z);
      // 직접 버린 직후 1.5초는 밟아도 다시 줍지 않는다 (E로는 바로 주울 수 있음)
      const walkOver = d < 0.9 && this.dropCooldown <= 0;
      if ((walkOver || (interactHeld && !this.pickupLock && d < rm.config.interactRange)) && rm.tryPickup(PLAYER_ID, at)) {
        g.setCoreWeapon(true);
        this.pickupLock = true; // 줍자마자 같은 E 입력으로 설치가 시작되지 않게
      }
    }
    if (!interactHeld) this.pickupLock = false;
    this.dropCooldown = Math.max(0, this.dropCooldown - dt);

    // ── G: 들고 있는 Core 버리기 (발 앞에 떨어뜨림)
    const holdingCore = g.inventory.current?.def.category === 'core';
    if (alive && dropPressed && holdingCore) {
      const f = new THREE.Vector3(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
      if (rm.dropCore(PLAYER_ID, { x: p.x + f.x * 1.2, y: p.y, z: p.z + f.z * 1.2 })) {
        g.setCoreWeapon(false);
        this.dropCooldown = 1.5;
      }
    }

    // ── 설치 (공격): Core를 든 채 좌클릭 유지, 또는 E 유지(자동으로 Core를 꺼냄)
    // ── 해체 (수비): E 유지. 둘 다 이동 키를 누르면 취소
    this.interacting = null;
    let progress = -1;
    let label = '';
    const carrying = c.status === 'carried' && c.carrierId === PLAYER_ID;
    const plantHeld = carrying && !this.pickupLock && (interactHeld || (fireHeld && holdingCore));
    if (plantHeld && !holdingCore && g.inventory.currentSlot !== 4) g.inventory.switchTo(4);
    const coreReady = holdingCore && g.inventory.state === 'ready' && g.player.grounded;
    if (alive && !moveHeld && (plantHeld || interactHeld)) {
      if (this.mySide === 'attack' && carrying && plantHeld && coreReady) {
        progress = rm.holdPlant(PLAYER_ID, this.siteAt(p), at, dt);
        if (progress >= 0 && rm.core.status === 'carried') {
          this.interacting = 'plant';
          label = 'CORE 설치 중';
        } else if (rm.core.status === 'planted') {
          // 설치 완료: Core가 손을 떠나 바닥에 남는다
          g.setCoreWeapon(false);
        }
      } else if (this.mySide === 'defense' && (c.status === 'planted')) {
        progress = rm.holdDefuse(PLAYER_ID, at, dt);
        if (progress >= 0 && rm.core.status === 'planted') {
          this.interacting = 'defuse';
          label = 'CORE 해체 중';
        }
      }
    } else {
      rm.cancelPlant(PLAYER_ID);
      rm.cancelDefuse(PLAYER_ID);
    }

    this.plantProgress = this.interacting === 'plant' ? progress : -1;

    // ── Core 신호음 (남은 시간이 줄수록 빨라짐)
    if (c.status === 'planted' && c.position) {
      const urgency = 1 - Math.min(1, c.timer / rm.config.coreTime);
      this.core.urgency = urgency * urgency;
      this.beepTimer -= dt;
      if (this.beepTimer <= 0) {
        this.beepTimer = THREE.MathUtils.lerp(1, 0.12, this.core.urgency);
        g.sound.play('beep', { at: new THREE.Vector3(c.position.x, c.position.y + 0.4, c.position.z), gain: 0.9 });
      }
    }

    // ── HUD
    this.hud.update({
      state: rm.state,
      timeLeft: rm.timeLeft,
      round: rm.round,
      score: rm.score,
      myTeam: this.myTeam,
      mySide: this.mySide,
      alive: { A: rm.aliveCount('A'), B: rm.aliveCount('B') },
      teamSize: { A: 1 + this.bots.filter((b) => b.teamId === 'A').length, B: this.bots.filter((b) => b.teamId === 'B').length },
      core: c,
      carrying: c.status === 'carried' && c.carrierId === PLAYER_ID,
      inSite: this.siteAt(p),
      nearCore: !!c.position && Math.hypot(c.position.x - p.x, c.position.z - p.z) < rm.config.interactRange,
      progress: this.interacting ? progress : c.defuseProgress > 0 && this.mySide === 'defense' && c.status === 'planted' ? -2 : -1,
      checkpoint: c.defuseProgress,
      progressLabel: label,
      alivePlayer: alive,
      participants: [...rm.participants.values()],
      winner: rm.winner,
      config: rm.config,
      spectating: this.spectatingName,
      credits: this.economy.get(PLAYER_ID),
      rewards: this.economy.lastRewards.get(PLAYER_ID) ?? [],
    });
  }

  /**
   * 관전 대상(아군)을 등록한다. 아군 봇/원격 플레이어가 생기면(Phase 7·8) 여기에 연결한다.
   * 참가자 목록(RoundManager)에 같은 id로 등록되어 있어야 생존 여부가 반영된다.
   */
  registerAlly(id: string, view: SpectateView): void {
    this.allies.set(id, view);
  }

  unregisterAlly(id: string): void {
    this.allies.delete(id);
  }

  /** 지금 관전 중인 아군 이름 (없으면 null) */
  spectatingName: string | null = null;

  /**
   * 사망 후 관전 카메라 (3인칭).
   * 살아 있는 아군이 있으면 그 아군 주위를 마우스로 돌려 보고, 좌클릭/우클릭으로 대상을 바꾼다.
   * 아군이 모두 죽었는데 Core가 설치되어 있으면 Core 주위를, 아니면 사망 지점 주위를 본다.
   */
  spectate(camera: THREE.PerspectiveCamera, dt: number, next = false, prev = false): boolean {
    const prevId = this.spectateId;
    const r = this.spectateInner(camera, dt, next, prev);
    const now = r ? this.spectateId : null;
    // 3인칭 관전이라 대상의 몸은 숨기지 않는다 (예전 1인칭 관전에서 숨긴 것만 되돌림)
    if (prevId !== now && prevId) this.allies.get(prevId)?.onSpectate?.(false);
    if (!r) this.spectateId = null;
    return r;
  }

  private spectateInner(camera: THREE.PerspectiveCamera, _dt: number, next: boolean, prev: boolean): boolean {
    this.spectatingName = null;
    if (this.game.local.alive || this.game.local.deadTime < 1.5) return false;
    const look = this.game.player;
    const world = this.game.map.collision;
    const alive = [...this.allies.keys()].filter((id) => this.rm.participants.get(id)?.alive && id !== PLAYER_ID);
    if (alive.length > 0) {
      let i = Math.max(0, alive.indexOf(this.spectateId ?? ''));
      if (!this.spectateId || !alive.includes(this.spectateId)) i = 0;
      if (next) i = (i + 1) % alive.length;
      if (prev) i = (i - 1 + alive.length) % alive.length;
      const v = this.allies.get(alive[i])!;
      // 새 대상: 그 아군 뒤에서 시작
      if (this.spectateId !== alive[i]) {
        look.yaw = v.yaw();
        look.pitch = SPECTATE_PITCH;
      }
      this.spectateId = alive[i];
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

  // ───────────────────────── 이벤트 처리 ─────────────────────────

  private onDeath(id: string, e: DamageEvent): void {
    const pos = id === PLAYER_ID ? this.game.player.position : e.target.center(new THREE.Vector3()).setY(e.target.center(new THREE.Vector3()).y - 1);
    if (id === PLAYER_ID) {
      this.deathPos.copy(pos);
      this.game.setCoreWeapon(false);
      this.playerDied = true;
    }
    const victim = this.rm.participants.get(id);
    if (victim) this.economy.onKill(e.shooter.id, victim.team);
    // 궁극기 포인트: 봇의 처치/사망 (플레이어 몫은 Game이 처리)
    const killer = this.botById(e.shooter.id);
    if (killer && victim && this.rm.participants.get(killer.id)?.team !== victim.team) {
      killer.abilities.addUlt(1);
      this.game.bots?.onKill(killer.id);
    }
    this.botById(id)?.abilities.addUlt(1);
    if (id !== PLAYER_ID) this.botDied.add(id);
    this.rm.notifyDeath(id, e.shooter.id, { x: pos.x, y: Math.max(0, pos.y), z: pos.z });
  }

  private onState(s: RoundState, prev: RoundState): void {
    const g = this.game;
    if (s === 'BuyPhase') this.hud.banner(`ROUND ${this.rm.round}`, this.mySide === 'attack' ? '공격 — Core를 설치하라' : '수비 — Core 설치를 막아라', 'info');
    if (s === 'ActiveRound' && prev === 'RoundStart') g.sound.play('round_start', { gain: 0.7 });
    // 구매 단계가 끝나면 환불 불가
    if (prev === 'BuyPhase') g.shop.lockIn();
  }

  /** 새 라운드: 모두 부활, 진영별 스폰 위치로 이동, Core 지급 */
  private setupRound(round: number): void {
    const g = this.game;
    const map = g.map;
    const mySide = this.mySide;
    const pistolRound = round === 1 || this.sideSwapped;

    // 플레이어: 지난 라운드에 살아남았으면 무기·방어구 유지, 죽었으면(또는 첫 라운드/진영 교체) 기본 장비
    const mine = mySide === 'attack' ? map.spawns.attackers : map.spawns.defenders;
    const sp = mine[Math.floor(mine.length / 2)];
    const keep = !this.playerDied && !this.sideSwapped;
    const armor = keep ? g.local.vitals.armor : 0;
    g.local.team = mySide;
    g.respawn(sp.position.x, sp.position.z, sp.yaw, armor);
    if (!keep) void g.equipDefaultLoadout();
    if (this.sideSwapped || round === 1) g.abilities.resetAll();
    else g.abilities.roundStart();
    g.abilityFx.clear();
    g.shop.lockIn();
    this.economy.clearRewards();
    this.playerDied = false;
    this.sideSwapped = false;

    // 봇: 살아남은 봇은 장비 유지, 스폰 배치, 구매, 팀 계획
    const botKeep = new Set(this.bots.filter((b) => !this.botDied.has(b.id)).map((b) => b.id));
    if (round === 1) botKeep.clear();
    this.botDied.clear();
    g.bots!.setupRound(botKeep, pistolRound, sp.position);

    // Core: 우리 팀이 공격이면 스폰 앞 바닥에 놓여 있다 (플레이어나 아군 봇이 주워 간다). 수비면 적 봇 한 명이 들고 시작
    this.core.hide();
    g.setCoreWeapon(false);
    if (mySide === 'attack') this.rm.placeCoreOnGround({ x: sp.position.x, y: 0, z: sp.position.z - 4.5 });
    else this.rm.giveCore(g.bots!.carrierFor(this.rm.teamOn('attack')) ?? PLAYER_ID);
    this.deathPos.copy(g.player.position);
  }

  private detonate(): void {
    const g = this.game;
    const c = this.rm.core;
    if (!c.position) return;
    const center = new THREE.Vector3(c.position.x, c.position.y + 0.5, c.position.z);
    this.core.explode();
    g.sound.play('explosion', { at: center, size: 'large', intensity: 1 });
    const { explosionRadius: R, explosionDamage: D } = this.rm.config;
    g.effects.explosion(center, R);
    // 반경 안의 모두에게 거리 비례 피해 (벽 무시). 죽으면 일반 사망과 같은 경로(킬 피드, 라운드 집계)로 처리
    const weapon = { ...getWeapon('blade'), name: 'EXPLOSION' };
    const shooter = { id: 'core', name: 'CORE', team: 'attack' as const };
    const targets: Damageable[] = g.combat.targets.filter((t) => t.alive);
    for (const t of targets) {
      if (!t.alive) continue;
      const pos = t.center(new THREE.Vector3());
      const dist = pos.distanceTo(center);
      if (dist > R) continue;
      const damage = Math.round(D * (1 - dist / R));
      const dealt = applyDamage(t.vitals, damage);
      if (t.vitals.health > 0) continue;
      t.alive = false;
      const e: DamageEvent = {
        shooter, target: t, weapon, part: 'body', damage, dealt: dealt.health + dealt.armor,
        point: pos, from: center.clone(), killed: true, distance: dist,
      };
      t.onKilled?.(e);
      g.combat.events.onKill?.(e);
    }
    g.shake(0.6);
  }

  // ───────────────────────── 구역 ─────────────────────────

  /** 능력으로 되살아남 (참가자 생존 처리) */
  reviveParticipant(id: string): boolean {
    return this.rm.revive(id);
  }

  private botById(id: string): Bot | undefined {
    return this.bots.find((b) => b.id === id);
  }

  siteAt(p: THREE.Vector3): SiteId | null {
    for (const id of ['A', 'B'] as SiteId[]) {
      const s = this.game.map.sites[id];
      if (p.x >= s.minX && p.x <= s.maxX && p.z >= s.minZ && p.z <= s.maxZ) return id;
    }
    return null;
  }

  private spawnZone(side: Side): AABB {
    return spawnZoneOf(this.game.map, side);
  }

  private clampToSpawn(): void {
    clampToZone(this.game.player, this.spawnZone(this.mySide));
  }

  /** 구매 단계 동안 스폰 구역 경계에 보이는 반투명 벽 */
  private buildBarrier(): void {
    this.barrier.add(...buildSpawnBarrier(this.game.map).children);
  }

  /** 매 프레임: 내 진영 스폰 벽만 보이게 */
  syncBarrier(): void {
    for (const c of this.barrier.children) c.visible = c.name === this.mySide;
  }

  dispose(): void {
    const g = this.game;
    g.local.team = 'attack';
    this.hud.dispose();
    this.core.root.removeFromParent();
    this.barrier.removeFromParent();
    g.local.onDeath = undefined;
    g.bots?.detach();
    for (const b of this.bots) b.onDeath = undefined;
    for (const d of g.practice?.dummies ?? []) {
      d.onDeath = undefined;
      d.resetHome();
    }
    if (g.practice) g.practice.showcaseVisible = true;
  }
}

const REASON_TEXT: Record<string, (mine: boolean) => string> = {
  elimination: (m) => (m ? '적 전멸' : '아군 전멸'),
  timeout: (m) => (m ? '시간 종료 — 방어 성공' : '시간 종료'),
  detonated: (m) => (m ? 'Core 폭발' : 'Core가 폭발했습니다'),
  defused: (m) => (m ? 'Core 해체 성공' : 'Core가 해체되었습니다'),
};

export function spawnZoneOf(map: Pick<BuiltMap, 'spawns' | 'def'>, side: Side): AABB {
  const pts = side === 'attack' ? map.spawns.attackers : map.spawns.defenders;
  const half = map.def.cellSize / 2 - 0.35;
  const b: AABB = { minX: Infinity, minY: 0, minZ: Infinity, maxX: -Infinity, maxY: 6, maxZ: -Infinity };
  for (const s of pts) {
    b.minX = Math.min(b.minX, s.position.x - half);
    b.maxX = Math.max(b.maxX, s.position.x + half);
    b.minZ = Math.min(b.minZ, s.position.z - half);
    b.maxZ = Math.max(b.maxZ, s.position.z + half);
  }
  return b;
}

/** 플레이어를 구역 안으로 */
export function clampToZone(p: { position: THREE.Vector3; prevPosition: THREE.Vector3 }, z: AABB): void {
  for (const v of [p.position, p.prevPosition]) {
    v.x = THREE.MathUtils.clamp(v.x, z.minX, z.maxX);
    v.z = THREE.MathUtils.clamp(v.z, z.minZ, z.maxZ);
  }
}

/** 구매 단계 동안 스폰 구역 경계에 보이는 반투명 벽 (진영별 그룹, 이름 = 진영) */
export function buildSpawnBarrier(map: Pick<BuiltMap, 'spawns' | 'def'>): THREE.Group {
  const root = new THREE.Group();
  // 격자선만 또렷하고 면은 거의 투명한 에너지 벽 (시야를 가리지 않도록)
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const line = x === 0 || y === 0;
      data[i] = 90;
      data[i + 1] = 210;
      data[i + 2] = 255;
      data[i + 3] = line ? 90 : 8;
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false });
  for (const side of ['attack', 'defense'] as Side[]) {
    const z = spawnZoneOf(map, side);
    const g = new THREE.Group();
    g.name = side;
    const w = z.maxX - z.minX + 0.7;
    const d = z.maxZ - z.minZ + 0.7;
    const cx = (z.minX + z.maxX) / 2;
    const cz = (z.minZ + z.maxZ) / 2;
    const wall = (sx: number, sz: number, x: number, zz: number) => {
      // 격자 한 칸 = 1m
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 3, sz), mat.clone());
      const t = (m.material as THREE.MeshBasicMaterial).map!.clone();
      t.repeat.set(Math.max(sx, sz), 3);
      t.needsUpdate = true;
      (m.material as THREE.MeshBasicMaterial).map = t;
      m.position.set(x, 1.5, zz);
      g.add(m);
    };
    wall(w, 0.05, cx, cz - d / 2);
    wall(w, 0.05, cx, cz + d / 2);
    wall(0.05, d, cx - w / 2, cz);
    wall(0.05, d, cx + w / 2, cz);
    root.add(g);
  }
  return root;
}

