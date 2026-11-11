import * as THREE from 'three';
import type { AbilitySlot } from '../abilities/abilityData';
import { AbilityEffects } from '../abilities/AbilityEffects';
import { AbilitySystem } from '../abilities/AbilitySystem';
import { Sound } from '../audio/Sound';
import { Shop } from '../economy/Shop';
import { AgentSelect } from '../ui/AgentSelect';
import { OnlineLobby } from '../ui/OnlineLobby';
import { BuyMenu } from '../ui/BuyMenu';
import { WEAPON_SFX } from '../audio/weaponSfx';
import { CombatSystem, type DamageEvent } from '../combat/CombatSystem';
import { LocalPlayer } from '../combat/LocalPlayer';
import { Vfx } from '../effects/vfx/Vfx';
import { TacticalMap } from '../ui/TacticalMap';
import type { TargetRequest } from '../abilities/AbilitySystem';
import type { Drone, DronePilot } from '../abilities/AdvancedEffects';
import { BotManager } from '../ai/BotManager';
import type { NetClient } from '../net/NetClient';
import { OnlineMatch } from '../net/OnlineMatch';
import { BlindGlow } from '../effects/BlindGlow';
import { THROW_RELEASE } from '../effects/AbilityHand';
import type { BotDifficulty } from '../ai/botConfig';
import { PSXRenderer } from '../graphics/PSXRenderer';
import { DEFAULT_MATCH, type MatchConfig } from '../rounds/matchConfig';
import { MatchController } from '../rounds/MatchController';
import { MapBuilder, type BuiltMap } from '../maps/MapBuilder';
import type { MapDefinition } from '../maps/MapData';
import { getMap, MAPS, RANDOM_MAP, resolveMap } from '../maps';

/** 지난번에 고른 맵 (없거나 사라진 맵이면 null) */
function savedMapChoice(): string | null {
  try {
    const v = localStorage.getItem('blockfire.map');
    return v && (v === RANDOM_MAP || MAPS.some((m) => m.id === v)) ? v : null;
  } catch {
    return null;
  }
}
import { DEFAULT_POSE, type CharacterPose } from '../player/CharacterModel';
import { PlayerController } from '../player/PlayerController';
import { PracticeDummies } from '../player/PracticeDummies';
import { HUD } from '../ui/HUD';
import { LoadingScreen } from '../ui/LoadingScreen';
import { Menu } from '../ui/Menu';
import { PLANT_EYE, PLANT_LOOK, ViewModel } from '../weapons/ViewModel';
import { getWeapon, WEAPONS, type WeaponSlot } from '../weapons/weaponData';
import { WeaponInventory, type WeaponControls } from '../weapons/WeaponInventory';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import { CAMERA, PHYSICS, PLAYER_SHAPE } from './config';
import { Input } from './Input';
import { loadSettings, saveSettings, type Settings } from './settings';

export type GameState = 'loading' | 'menu' | 'playing' | 'paused';

export class Game {
  readonly settings: Settings;
  readonly input: Input;
  readonly psx: PSXRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly player: PlayerController;
  map: BuiltMap;
  readonly inventory: WeaponInventory;
  readonly viewModel = new ViewModel();
  practice: PracticeDummies | null = null;
  /** 연습 모드 무기 구성 */
  readonly practiceLoadout = { primary: 'falcon', secondary: 'tack' };
  /** 연습 모드: 더미가 플레이어에게 반격 */
  dummiesShoot = false;
  readonly combat: CombatSystem;
  readonly local: LocalPlayer;
  readonly sound = new Sound();
  /** 시각 효과 (착탄·피격·예광탄·폭발·능력) */
  readonly effects = new Vfx();
  readonly abilityFx: AbilityEffects;
  /** 봇 (경기에서만 활성) */
  bots: BotManager | null = null;
  /** 다음 경기의 봇 난이도 */
  botDifficulty: BotDifficulty = 'normal';
  /** 봇 대전 경기 방식 (고르면 matchConfig의 승리 라운드·교체 주기가 바뀐다) */
  matchMode: import('../rounds/matchConfig').MatchMode = 'standard';
  private botsReady: Promise<void> | null = null;
  private starting = false;
  readonly abilities: AbilitySystem;
  readonly shop: Shop;
  /** 선택한 캐릭터 */
  agentId = 'warden';
  /** 연습 모드: 능력 무제한 */
  infiniteAbilities = true;
  readonly buyMenu: BuyMenu;
  readonly agentSelect: AgentSelect;
  /** 온라인 대기실 */
  onlineLobby!: OnlineLobby;
  readonly hud: HUD;
  private menu: Menu;
  state: GameState = 'loading';
  readonly ready: Promise<void>;
  /** 게임 모드: 연습 / 경기 */
  mode: 'practice' | 'match' | 'online' = 'practice';
  /** 온라인: 서버 연결 (대기실·경기) */
  net: NetClient | null = null;
  match: MatchController | OnlineMatch | null = null;
  /** 경기 규칙 (테스트에서 시간 단축 등으로 바꿀 수 있음) */
  matchConfig: MatchConfig = { ...DEFAULT_MATCH };
  private container: HTMLElement;
  private shakeAmount = 0;
  /** 연습·봇 경기에서 고른 맵 (맵 id 또는 'random') */
  mapChoice: string;

  private accumulator = 0;
  private lastTime = performance.now();
  private menuTime = 0;
  private fog: THREE.Fog;
  private sky: THREE.Object3D | undefined;
  private frameTimes: number[] = [];
  private zoom = 1;
  private fireKick = 0;
  private muzzleLight = new THREE.PointLight(0xffd090, 0, 9, 1.6);
  private muzzleLightTimer = 0;
  /** 돌진 화면 효과 세기 0..1 (HUD 속도선·FOV) */
  dashKick = 0;
  /** 전술 지도 (지점 지정 능력) */
  tacMap!: TacticalMap;
  /** 마지막 처치 시각 (흡수 능력) */
  private lastKillAt = -1e9;
  /** 투척 단검 궁극기 중 */
  stormActive = false;
  /** 되살아난 뒤 처치해야 하는 남은 시간 (0이면 아님) */
  repriseTimer = 0;
  /** 되살아나는 중 (남은 시간) / 되살아난 직후 무적 */
  reviveChannel = 0;
  private reviveInvuln = 0;
  private reviveArgs: [number, number] = [100, 10];
  /** REKINDLE: 남은 시간, 표식 위치·방향·방어구 */
  ribTimer = 0;
  private ribMarker: { pos: THREE.Vector3; yaw: number; armor: number; mesh: THREE.Object3D } | null = null;
  /** 조종 중인 드론 */
  piloting: Drone | null = null;
  /** 내가 피해를 준 적: id → 시각 (처치 관여 판정) */
  private damagedAt = new Map<string, number>();
  /** 투척 단검 우클릭 연속 투척 중 (처치해도 다시 채워지지 않음) */
  private stormFanning = false;
  /** 섬광에 눈이 먼 캐릭터의 얼굴 빛 */
  private blindGlow = new BlindGlow();
  /** 던지는 동작 중: 손을 떠나는 시점에 발동 */
  private pendingThrow: { slot: AbilitySlot; variant: 0 | 1; t: number } | null = null;
  /** 막 던진 능력 (좌클릭을 누르고 있는 동안 휘게 조종) */
  private steerSlot: AbilitySlot | null = null;
  /** 꺼내 든 능력을 클릭으로 쓴 뒤, 버튼을 뗄 때까지 사격하지 않음 */
  private holdFire = false;
  private sunDir: THREE.Vector3;
  private inShadow = false;
  private shadowCheckTimer = 0;
  private eye = new THREE.Vector3();
  private lastReload = -1;
  /** 발소리: 다음 걸음까지 남은 거리 (m) */
  private stepDistance = 0;

  constructor(container: HTMLElement, mapDef: MapDefinition) {
    this.container = container;
    this.settings = loadSettings();

    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    container.appendChild(canvas);
    this.psx = new PSXRenderer(canvas, this.settings.psx);
    this.effects.setSceneDepth(this.psx.depthTexture, this.psx.internalSize);
    this.input = new Input(canvas, this.settings.bindings);

    this.camera = new THREE.PerspectiveCamera(this.verticalFov(), 1, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';

    this.map = new MapBuilder(mapDef).build();
    this.scene.add(this.map.root);
    this.sky = this.map.root.getObjectByName('sky');
    const env = mapDef.environment;
    this.scene.background = new THREE.Color(env.fogColor);
    this.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
    this.scene.fog = this.fog;
    this.sunDir = new THREE.Vector3(...env.sunDirection).normalize();
    this.mapChoice = savedMapChoice() ?? RANDOM_MAP;
    this.scene.add(this.muzzleLight, this.blindGlow.group);

    this.player = new PlayerController(this.map.collision);
    this.inventory = new WeaponInventory({
      onFire: () => this.onFire(),
      onDryFire: () => this.sound.play('dry_fire', { gain: 0.8 }),
      onSwitch: (w) => {
        this.viewModel.setWeapon(w.template);
        this.sound.weapon(w.def.id, 'equip');
      },
    });
    this.scene.add(this.effects.group);
    this.sound.setWorld(this.map.collision);
    // 파편·불똥이 바닥에서 튕기도록 아래쪽 바닥 높이
    this.effects.floorAt = (x, y, z) => {
      const hit = this.map.collision.raycast(x, y + 0.05, z, 0, -1, 0, 30);
      return hit ? y + 0.05 - hit.distance : y - 30;
    };

    this.hud = new HUD(container);
    this.local = new LocalPlayer(this.player);
    this.local.onHurt = (e) => {
      this.sound.play('hurt', { gain: 0.9 });
      this.hud.showDamageFrom(e.from, this.camera);
    };
    this.combat = new CombatSystem(this.map.collision, {
      onImpact: (point, normal, material) => {
        // 맞은 표면의 재질로 착탄 효과·착탄음 (바닥은 칸별 재질)
        const mat = material ?? this.map.surfaceAt(point.x, point.y, point.z);
        this.effects.impact(point, normal, mat);
        this.sound.play('impact', { at: point, material: mat, intensity: 0.9 });
      },
      onHit: (e) => {
        this.effects.hit(e.point, e.from.clone().sub(e.point).normalize(), e.part === 'head');
        if (e.shooter.id === this.local.id) this.damagedAt.set(e.target.id, performance.now());
      },
      onTracer: (from, to, shooter) => {
        const knife = shooter.id === this.local.id ? this.stormActive : (this.bots?.bots.find((b) => b.id === shooter.id)?.stormKnives ?? 0) > 0;
        if (knife) {
          this.effects.tracer(from, to, 0x9fe3ff);
          return;
        }
        this.effects.tracer(from, to);
        this.effects.muzzleSmoke(from, to.clone().sub(from).normalize());
      },
      onShotResult: (shooter, results) => this.onShotResult(shooter.id, results),
      onKill: (e) =>
        this.hud.addKill(
          e.shooter.name,
          e.weapon.name,
          e.target.name,
          e.part === 'head',
          e.shooter.id === this.local.id || e.target.id === this.local.id,
        ),
    });
    this.combat.addTarget(this.local);
    // REKINDLE: 쓰러질 피해를 받으면 표식으로 돌아간다
    this.local.cheatDeath = () => {
      if (this.ribTimer <= 0) return false;
      this.returnToMarker();
      return true;
    };

    // ── 능력 / 경제
    this.abilityFx = new AbilityEffects(this.map.collision, this.combat, this.sound, this.effects);
    this.abilityFx.attachTo(this.scene);
    // 섬광에 내 화면이 번쩍이는지는 누가 던졌든 내 카메라 기준
    this.abilityFx.localViewer = { camera: this.camera, id: this.local.id, team: () => this.local.team };
    this.bots = new BotManager(this);
    this.abilities = new AbilitySystem({
      effects: this.abilityFx,
      player: this.player,
      camera: this.camera,
      shooter: () => ({ id: this.local.id, name: this.local.name, team: this.local.team }),
      team: () => this.local.team,
      self: () => this.local,
      alive: () => this.local.alive,
      lastKillAge: () => (performance.now() - this.lastKillAt) / 1000,
      equipBladeStorm: (n) => this.equipBladeStorm(n),
      revive: (hp, dur) => this.reprise(hp, dur),
      runItBack: (dur) => this.runItBack(dur),
      pilotDrone: () => this.makePilot(),
      armable: true,
      requestTargets: (req, cb) => this.openTacticalMap(req, cb),
      held: (slot) => this.input.isDown(slot) || (this.steerSlot === slot && this.input.isDown('fire')),
      onUse: (slot, info) => this.sendCast(slot, info),
      moveDir: () => this.moveDir(),
      onCast: (_d, kind) => {
        this.viewModel.onFire();
        if (kind === 'dash') {
          this.sound.play('dash');
          // 질주 뒤에는 주무기로 (단검 궁극기 중이면 그대로)
          if (!this.stormActive && this.inventory.get(1) && !this.abilityFx.status.has(this.local.id, 'jam')) this.inventory.switchTo(1);
        }
      },
    });
    this.abilities.infinite = true;
    this.shop = new Shop(this);
    // 총알이 방벽에 맞으면 방벽 내구도 감소
    const baseImpact = this.combat.events.onImpact!;
    this.combat.events.onImpact = (point, normal, material) => {
      baseImpact(point, normal, material);
      this.abilityFx.onImpact(point, this.inventory.current?.def.damage.body ?? 30);
    };
    // 처치/사망으로 궁극기 포인트
    const baseKill = this.combat.events.onKill!;
    this.combat.events.onKill = (e) => {
      baseKill(e);
      const mine = e.shooter.id === this.local.id && e.target.id !== this.local.id;
      // 처치 관여: 내가 쓰러뜨렸거나, 10초 안에 피해를 준 적이 쓰러짐 (흡수·되살아나기 조건)
      const assisted = e.target.team !== this.local.team && performance.now() - (this.damagedAt.get(e.target.id) ?? -1e9) < 10000;
      if (mine || assisted) {
        this.lastKillAt = performance.now();
        this.repriseTimer = 0;
      }
      if (mine) {
        this.abilities.addUlt(1);
        this.abilities.onKill();
        // 투척 단검: 좌클릭으로 처치하면 다시 채워짐
        const st = this.inventory.get(3);
        if (this.stormActive && !this.stormFanning && st?.def.id === 'storm') st.mag = st.def.magazine;
      }
      if (e.target.id === this.local.id) this.abilities.addUlt(1);
    };
    this.menu = new Menu(container, this);
    this.buyMenu = new BuyMenu(container, this);
    this.agentSelect = new AgentSelect(container, this);
    this.onlineLobby = new OnlineLobby(container, this);
    this.tacMap = new TacticalMap(container, this);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    // 게임 중 Ctrl+W 등으로 실수로 탭을 닫지 않도록 확인
    window.addEventListener('beforeunload', (e) => {
      if (this.state === 'playing' || this.state === 'paused') e.preventDefault();
    });

    this.applySettings();
    this.onResize();
    this.setState('loading');
    const loading = new LoadingScreen(container);
    this.ready = this.loadAssets().then(
      async () => {
        await loading.finish();
        this.setState('menu');
      },
      (err) => {
        console.error(err);
        loading.fail(`에셋을 불러오지 못했습니다: ${String(err)}`);
        throw err;
      },
    );
    requestAnimationFrame(this.frame);
  }

  private async loadAssets(): Promise<void> {
    // 모든 무기 모델을 먼저 요청해 둔다 (로딩 진행률의 전체 개수 확정 + 무기 교체 시 끊김 방지)
    const weapons = Promise.all(WEAPONS.map(loadWeaponTemplate));
    const [, , practice] = await Promise.all([this.viewModel.init('attack'), this.sound.load(), PracticeDummies.create()]);
    this.practice = practice;
    this.scene.add(practice.group);
    for (const d of practice.dummies) this.combat.addTarget(d);
    await weapons;
    await this.equipPracticeLoadout();
    // 봇 모델은 로딩 화면 뒤에서 미리 만들어 둔다 (경기 시작 시 끊김 방지)
    this.botsReady = this.bots!.ensureBots();
  }

  /** 연습 모드 무기 지급 (주무기/보조무기/칼) */
  async equipPracticeLoadout(): Promise<void> {
    const ids = [this.practiceLoadout.primary, this.practiceLoadout.secondary, 'blade'];
    const defs = ids.map(getWeapon);
    const templates = await Promise.all(defs.map(loadWeaponTemplate));
    defs.forEach((d, i) => this.inventory.give(d, templates[i]));
    this.inventory.switchTo(1, true);
  }

  async setPracticeWeapon(slot: 'primary' | 'secondary', id: string): Promise<void> {
    this.practiceLoadout[slot] = id;
    const def = getWeapon(id);
    this.inventory.give(def, await loadWeaponTemplate(def), true);
  }

  // ───────────────────────── 상태 전환 ─────────────────────────

  /**
   * 맵 교체 (연습·경기 시작 전). 충돌 세계는 같은 객체를 비우고 다시 채우므로
   * 플레이어·사격·능력·소리가 들고 있는 참조가 그대로 유효하다.
   */
  setMap(def: MapDefinition): void {
    if (this.map.def.id === def.id) return;
    this.abilityFx.clear();
    this.scene.remove(this.map.root);
    this.map.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) mat.dispose();
    });
    this.map = new MapBuilder(def, this.map.collision).build();
    this.scene.add(this.map.root);
    this.sky = this.map.root.getObjectByName('sky');
    const env = def.environment;
    (this.scene.background as THREE.Color).set(env.fogColor);
    this.fog.color.set(env.fogColor);
    this.sunDir.set(...env.sunDirection).normalize();
    this.applySettings();
    this.bots?.setMap();
    this.practice?.layout(def);
    this.menu.refresh();
  }

  /** 연습·봇 경기: 고른 맵으로 (무작위면 매번 새로 뽑음) */
  private applyMapChoice(): void {
    this.setMap(resolveMap(this.mapChoice, this.map.def.id));
  }

  startPractice(): void {
    if (this.state === 'loading') return;
    this.endMatch();
    this.applyMapChoice();
    this.mode = 'practice';
    this.sound.unlock();
    this.abilities.setAgent(this.agentId);
    this.abilities.infinite = this.infiniteAbilities;
    this.abilities.fill();
    this.respawn();
    this.setState('playing');
    if (!this.input.forceActive) this.input.requestLock();
  }

  resume(): void {
    this.sound.unlock();
    this.setState('playing');
    if (!this.input.forceActive) this.input.requestLock();
  }

  /** 경기 시작: 플레이어 + 아군 봇 4 대 적 봇 5 */
  startMatch(): void {
    if (this.state === 'loading' || !this.practice || this.starting) return;
    this.starting = true;
    void (this.botsReady ?? (this.botsReady = this.bots!.ensureBots())).then(() => {
      this.starting = false;
      this.beginMatch();
    });
  }

  private beginMatch(): void {
    this.endMatch();
    this.applyMapChoice();
    this.mode = 'match';
    this.sound.unlock();
    this.inventory.infiniteAmmo = false;
    this.abilities.setAgent(this.agentId);
    this.abilities.infinite = false;
    this.match = new MatchController(this, this.container, { ...this.matchConfig }, this.botDifficulty);
    this.match.start();
    this.setState('playing');
    if (!this.input.forceActive) this.input.requestLock();
  }

  /** 온라인 경기 시작 (서버가 start를 보냈을 때) */
  startOnline(net: NetClient, config: import('../rounds/matchConfig').MatchConfig, mapId?: string): void {
    if (this.state === 'loading') return;
    this.endMatch();
    // 맵은 서버가 정한다
    this.setMap(getMap(mapId ?? 'foundry'));
    this.net = net;
    this.mode = 'online';
    this.sound.unlock();
    this.inventory.infiniteAmmo = false;
    const me = net.room?.players.find((p) => p.id === net.id);
    this.agentId = me?.agent ?? this.agentId;
    this.abilities.setAgent(this.agentId);
    this.abilities.infinite = false;
    // 피해·처치는 서버가 정한다
    this.combat.authority = false;
    this.local.alive = true;
    this.local.deadTime = -1;
    this.local.vitals.health = 100;
    this.local.vitals.armor = 0;
    this.inventory.clear();
    this.match = new OnlineMatch(this, this.container, net, config);
    this.setState('playing');
    if (!this.input.forceActive) this.input.requestLock();
  }

  /** 온라인: 내 사격을 서버로 (서버가 그 시각으로 되감아 판정) */
  private sendFire(weapon: string, eye: THREE.Vector3, dirs: THREE.Vector3[]): void {
    const m = this.match;
    if (!(m instanceof OnlineMatch) || !this.net) return;
    const r = (v: number) => +v.toFixed(4);
    this.net.send({ t: 'fire', weapon, eye: [r(eye.x), r(eye.y), r(eye.z)], dirs: dirs.map((d) => [r(d.x), r(d.y), r(d.z)]), at: m.shotTime() });
  }

  /** 온라인: 능력 사용을 서버로 */
  private sendCast(slot: AbilitySlot, info: { variant?: 0 | 1; points?: THREE.Vector3[]; held?: number }): void {
    if (!(this.match instanceof OnlineMatch) || !this.net) return;
    const r = (v: number) => +v.toFixed(3);
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    this.net.send({
      t: 'cast', slot, eye: [r(eye.x), r(eye.y), r(eye.z)], aim: [r(aim.x), r(aim.y), r(aim.z)], variant: info.variant,
      points: info.points?.map((q) => [r(q.x), r(q.y), r(q.z)]), held: info.held,
    });
  }

  /** 온라인: 서버가 내 처치를 알려 줌 */
  onlineKill(): void {
    this.lastKillAt = performance.now();
    this.repriseTimer = 0;
    const st = this.inventory.get(3);
    if (this.stormActive && !this.stormFanning && st?.def.id === 'storm') st.mag = st.def.magazine;
  }

  /** 온라인: 내가 쓰러짐 (서버 판정) */
  onlineDeath(): void {
    this.setCoreWeapon(false);
    if (this.stormActive) this.endBladeStorm();
    this.clearRunItBack();
    this.sound.play('hurt', { gain: 1 });
  }

  /** 온라인 경기가 끝나 대기실로 (방에는 남아 있음) */
  endOnline(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.endMatch();
    this.setState('menu');
  }

  /** 눈이 먼 다른 캐릭터(봇·더미·온라인 상대)의 얼굴을 빛나게 */
  private updateBlindGlow(dt: number): void {
    const list: { id: string; eye: THREE.Vector3; left: number }[] = [];
    for (const t of this.combat.targets as (import('../abilities/AbilityEffects').FacingTarget & { enabled?: boolean; model?: { root: THREE.Object3D } })[]) {
      if (!t.alive || t.id === this.local.id || !t.eyePos) continue;
      if (t.enabled === false || (t.model && !t.model.root.visible)) continue;
      const left = this.abilityFx.blindLeft(t.id);
      if (left > 0) list.push({ id: t.id, eye: t.eyePos(new THREE.Vector3()), left });
    }
    this.blindGlow.update(dt, this.camera, list);
  }

  resetAccumulator(): void {
    this.accumulator = 0;
  }

  /** 앉은 정도 0..1 */
  crouchLevel(): number {
    return this.crouchAmount();
  }

  private endMatch(): void {
    const wasMatch = !!this.match;
    this.combat.authority = true;
    if (this.tacMap?.isOpen) this.tacMap.cancel();
    this.match?.dispose();
    this.match = null;
    this.mode = 'practice';
    this.buyMenu.close();
    this.abilityFx.clear();
    this.resetBuffs();
    // 경기에서 쓰던 무기 구성 대신 연습 무기로
    if (wasMatch) {
      this.inventory.clear();
      void this.equipPracticeLoadout();
    }
  }

  /** 경기용 기본 무기 (권총 + 칼) */
  async equipDefaultLoadout(): Promise<void> {
    this.inventory.clear();
    for (const id of ['tack', 'blade']) {
      const d = getWeapon(id);
      this.inventory.give(d, await loadWeaponTemplate(d));
    }
    this.inventory.switchTo(2, true);
  }

  private resetBuffs(): void {
    this.inventory.fireRateMul = 1;
    this.player.speedMul = 1;
    this.local.noMoveSpread = false;
    this.local.invulnerable = false;
    this.clearRunItBack();
    this.reviveChannel = 0;
    this.reviveInvuln = 0;
    this.piloting = null;
  }

  /** Core를 무기 슬롯 4에 넣거나 뺀다 */
  setCoreWeapon(has: boolean): void {
    const def = getWeapon('core');
    if (has) {
      if (!this.inventory.get(4)) void loadWeaponTemplate(def).then((t) => this.inventory.give(def, t));
    } else if (this.inventory.get(4)) {
      this.inventory.remove(4);
    }
  }

  /** 화면 흔들림 (폭발 등) */
  shake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  toMainMenu(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.mode === 'online') this.net?.send({ t: 'leave' });
    this.endMatch();
    this.setState('menu');
  }

  setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.input.clear();
    this.menu.show(s);
    this.hud.setVisible(s === 'playing' || s === 'paused');
  }

  /** 부활 (위치를 생략하면 공격 스폰 중앙) */
  respawn(x?: number, z?: number, yaw?: number, armor?: number): void {
    const spawns = this.map.spawns.attackers;
    const sp = spawns[Math.floor(spawns.length / 2)];
    this.player.spawn(x ?? sp.position.x, 0, z ?? sp.position.z, yaw ?? sp.yaw);
    this.accumulator = 0;
    this.local.revive(armor);
    this.abilityFx.status.clear();
    this.repriseTimer = 0;
    this.reviveChannel = 0;
    this.reviveInvuln = 0;
    this.local.invulnerable = false;
    this.clearRunItBack();
    this.piloting = null;
    if (this.stormActive) this.endBladeStorm();
    if (this.mode === 'practice') this.abilities.fill();
    this.inventory.refill();
    if (this.inventory.current) this.inventory.switchTo(this.inventory.currentSlot, true);
  }

  applySettings(): void {
    saveSettings(this.settings);
    this.psx.applySettings(this.settings.psx);
    this.input.setBindings(this.settings.bindings);
    this.updateProjection();
    const env = this.map.def.environment;
    // fog를 null로 바꾸면 셰이더가 다시 컴파일되므로 거리만 늘린다
    this.fog.near = this.settings.psx.fog ? env.fogNear : 1e5;
    this.fog.far = this.settings.psx.fog ? env.fogFar : 2e5;
    this.hud.setDebugVisible(this.settings.showDebug);
    this.sound.setVolume(this.settings.volume);
  }

  /** 설정의 FOV는 수평 시야각(전술 FPS 관례). 화면 비율과 조준 배율을 반영해 수직 FOV로 변환 */
  private verticalFov(zoom = 1): number {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const h = THREE.MathUtils.degToRad(this.settings.fov);
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect / zoom));
  }

  private updateProjection(): void {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.aspect = aspect;
    this.camera.fov = this.verticalFov(this.zoom);
    this.camera.updateProjectionMatrix();
    this.viewModel.setAspect(aspect);
  }

  private onResize = (): void => {
    this.updateProjection();
    this.psx.resize();
  };

  private onPointerLockChange = (): void => {
    // 구매 메뉴를 열면 마우스를 쓰기 위해 포인터 락을 푼다 → 일시정지로 보지 않음
    if (!this.input.locked && this.state === 'playing' && !this.input.forceActive && !this.buyMenu.isOpen && !this.tacMap?.isOpen) this.setState('paused');
  };

  private onFire(): void {
    const w = this.inventory.current;
    if (!w || !this.local.alive) return;
    this.viewModel.onFire();
    this.fireKick = 1;
    const def = w.def;
    const origin = this.local.eyePosition();
    const shooter = { id: this.local.id, name: this.local.name, team: this.local.team };
    if (def.category === 'melee') {
      this.combat.melee(shooter, def, origin, this.local.aimDirection());
      if (this.match instanceof OnlineMatch) this.sendFire(def.id, origin, [this.local.aimDirection()]);
      this.sound.play('knife');
      return;
    }
    this.muzzleLightTimer = 0.05;
    this.muzzleLight.intensity = 6;
    // 예광탄 시작점: 화면 오른쪽 아래의 총구 근처
    const tracerFrom = new THREE.Vector3(0.14, -0.12, -0.6).applyQuaternion(this.camera.quaternion).add(this.camera.position);
    const dirs = this.local.shotDirections(def);
    this.combat.fire(shooter, def, origin, dirs, tracerFrom);
    if (this.match instanceof OnlineMatch) this.sendFire(def.id, origin, dirs);
    else if (this.match) this.bots?.noise('A', origin, 40);
    this.local.recoil.onShot(def);
    this.sound.weapon(def.id, 'shot');
    // 볼트액션/펌프액션: 사격 직후 노리쇠·펌프 조작음
    if (WEAPON_SFX[def.id]?.cycle) setTimeout(() => this.sound.weapon(def.id, 'cycle'), 320);
  }

  /** 입력 기준 이동 방향 (수평, 정규화 안 됨) */
  private moveDir(): THREE.Vector3 {
    const i = this.input;
    const f = (i.isDown('forward') ? 1 : 0) - (i.isDown('back') ? 1 : 0);
    const s = (i.isDown('right') ? 1 : 0) - (i.isDown('left') ? 1 : 0);
    const y = this.player.yaw;
    return new THREE.Vector3(-Math.sin(y) * f + Math.cos(y) * s, 0, -Math.cos(y) * f - Math.sin(y) * s);
  }

  /** 내가 쏜 결과: 히트마커, 피해 숫자, 명중음 */
  private onShotResult(shooterId: string, results: DamageEvent[]): void {
    if (shooterId !== this.local.id || results.length === 0) return;
    const killed = results.some((r) => r.killed);
    const head = results.some((r) => r.part === 'head');
    this.hud.showHitmarker(killed ? 'kill' : head ? 'head' : 'body');
    for (const r of results) this.hud.addDamageNumber(r.point, r.damage, r.part);
    this.sound.play(killed ? 'kill' : head ? 'hit_head' : 'hit_body', { gain: 0.7 });
  }

  // ───────────────────────── 메인 루프 ─────────────────────────

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.trackFps(dt);

    if (this.state === 'playing') this.updatePlaying(dt);
    else if (this.state === 'menu' || this.state === 'loading') this.updateMenuCamera(dt);
    if (this.state !== 'paused') {
      this.practice?.update(
        Math.min(dt, 0.05),
        this.state === 'playing'
          ? {
              shootBack: this.match ? this.match.combatActive : this.dummiesShoot,
              player: this.local,
              combat: this.combat,
              world: this.map.collision,
              sound: this.sound,
              visionBlocked: (a, b) => this.abilityFx.blocksLine(a, b),
              isBlinded: (id) => this.abilityFx.isBlinded(id),
            }
          : undefined,
      );
      this.abilityFx.update(dt, this.local.team);
    }
    this.sound.setListener(this.camera, dt);

    if (this.sky) this.sky.position.copy(this.camera.position);
    if (this.state === 'playing' || this.state === 'paused') {
      this.effects.update(this.state === 'paused' ? 0 : dt, this.camera);
      this.updateBlindGlow(this.state === 'paused' ? 0 : dt);
    }
    const showViewModel = (this.state === 'playing' || this.state === 'paused') && this.local.alive && !this.piloting;
    // 드론 시점: 화면을 드론 카메라처럼
    document.body.classList.toggle('drone-view', !!this.piloting);
    // 깊이 사전 패스(입자·능력 효과 제외) → 본 패스. 입자가 벽·바닥과 만나는 곳이 부드럽게 흐려짐
    // (입자가 하나도 없으면 사전 패스를 건너뜀)
    const fx = this.effects;
    this.psx.render(
      this.scene,
      this.camera,
      showViewModel ? this.viewModel : undefined,
      fx.smoke.active + fx.glow.active > 0 ? { hide: [fx.group, this.abilityFx.group] } : undefined,
    );

    if (this.state === 'playing' || this.state === 'paused') this.hud.update(this, this.averageFps());
    this.input.endFrame();
  };

  private readWeaponControls(): WeaponControls {
    const i = this.input;
    if (this.holdFire && !i.isDown('fire') && !i.isDown('aim')) this.holdFire = false;
    const block = !!this.abilities.armed || !!this.piloting || this.holdFire;
    const slot: WeaponSlot | null = i.wasPressed('slot1') ? 1 : i.wasPressed('slot2') ? 2 : i.wasPressed('slot3') ? 3 : i.wasPressed('slot4') ? 4 : null;
    return {
      // 경기의 구매 단계/라운드 시작 대기 중에는 사격 불가
      fireHeld: i.isDown('fire') && !this.match?.weaponsLocked && !block,
      firePressed: i.wasPressed('fire') && !this.match?.weaponsLocked && !block,
      reloadPressed: i.wasPressed('reload'),
      aimHeld: i.isDown('aim') && !block,
      // 무력화: 주무기를 꺼낼 수 없다
      selectSlot: slot === 1 && this.abilityFx.status.has(this.local.id, 'jam') ? null : slot,
      cycle: i.wasPressed('nextWeapon') ? 1 : i.wasPressed('prevWeapon') ? -1 : 0,
      lastWeapon: i.wasPressed('lastWeapon'),
    };
  }

  private updatePlaying(dt: number): void {
    const p = this.player;
    const look = p.applyLook(this.input, this.settings.sensitivity, this.settings.invertY, this.zoom);

    const step = 1 / PHYSICS.tickRate;
    this.accumulator += dt;
    let steps = 0;
    const alive = this.local.alive;
    while (this.accumulator >= step && steps < PHYSICS.maxStepsPerFrame) {
      // 사망 중에는 조작 불가 (관성으로 멈춤)
      // 사망·라운드 시작 대기·설치/해체 중에는 이동 불가 (앉기는 유지)
      const locked = !alive || this.match?.movementLocked || !!this.piloting;
      const intent = p.readIntent(this.input);
      p.tick(locked ? { forward: 0, strafe: 0, jump: false, walk: false, crouch: alive && intent.crouch } : intent, step);
      this.accumulator -= step;
      steps++;
    }
    if (steps === PHYSICS.maxStepsPerFrame) this.accumulator = 0;
    if (p.position.y < -20) this.respawn();

    // ── 무기 / 전투
    if (alive) this.inventory.update(dt, this.readWeaponControls());
    // 투척 단검: 우클릭 = 남은 단검을 0.33초 간격으로 모두
    if (alive && this.stormActive && !this.abilities.armed && this.input.wasPressed('aim') && !this.match?.weaponsLocked) this.stormFan();
    const w = this.inventory.current;
    // 연습 모드는 3초 뒤 자동 부활, 경기에서는 다음 라운드에 부활
    if (this.local.update(dt, w?.def, this.inventory.aim) && this.mode === 'practice') this.respawn();
    // ── 능력 / 구매 메뉴
    this.updateAbilities(dt, alive);
    if (this.input.wasPressed('buy')) this.buyMenu.toggle();
    this.buyMenu.update();
    if (this.match) {
      const i = this.input;
      const moving = i.isDown('forward') || i.isDown('back') || i.isDown('left') || i.isDown('right') || i.isDown('jump');
      this.match.update(dt, i.isDown('interact'), moving, i.isDown('fire'), i.wasPressed('drop'));
      this.match.setScoreboard(i.isDown('scoreboard'));
    }
    this.playWeaponSounds();
    this.playFootsteps(dt);
    // 돌진: 순간 시야가 넓어졌다가 돌아옴
    this.dashKick = this.player.dashAmount > 0 ? 1 : Math.max(0, this.dashKick - dt * 5);
    const targetZoom = (1 + ((w?.def.adsZoom ?? 1) - 1) * this.inventory.aim) / (1 + 0.12 * this.dashKick);
    if (Math.abs(targetZoom - this.zoom) > 1e-4) {
      this.zoom = targetZoom;
      this.updateProjection();
    }
    this.fireKick = Math.max(0, this.fireKick - dt * 8);
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      if (this.muzzleLightTimer <= 0) this.muzzleLight.intensity = 0;
    }

    // ── 카메라 (이전/현재 틱 사이 보간)
    const alpha = this.accumulator / step;
    const eye = this.eye.lerpVectors(p.prevPosition, p.position, alpha);
    eye.y += p.eyeHeight;
    // 반동: 총알은 반동 오프셋 전부를 따라가고, 화면은 그 일부만 따라간다 (조준점 위로 탄이 튐)
    const r = this.local.recoil;
    this.camera.rotation.set(p.pitch + r.pitch * 0.55, p.yaw + r.yaw * 0.55, 0);
    // Core 설치: 무릎 꿇고(시점 낮춤) 바닥을 내려다본다 (발로란트의 설치 동작)
    const plantLook = this.viewModel.plantLook;
    if (plantLook > 0) {
      this.camera.rotation.x -= plantLook;
      eye.y -= (p.eyeHeight - PLANT_EYE) * (plantLook / PLANT_LOOK);
    }
    if (!alive) {
      // 사망: 시점이 바닥으로 떨어지며 기울어짐
      const t = Math.min(1, this.local.deadTime / 0.6);
      eye.y -= t * (p.eyeHeight - 0.3);
      this.camera.rotation.z = t * 0.6;
    }
    if (this.piloting && alive) {
      // 드론 3인칭: 드론 뒤쪽 위에서 드론을 바라본다 (벽에 막히면 그만큼 가까이)
      const d = this.piloting.pos;
      const back = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(p.pitch * 0.6 - 0.25, p.yaw, 0, 'YXZ'));
      let dist = 2.8;
      const hit = this.map.collision.raycast(d.x, d.y, d.z, back.x, back.y, back.z, dist + 0.3);
      if (hit) dist = Math.max(0.6, hit.distance - 0.3);
      this.camera.position.copy(d).addScaledVector(back, dist);
      this.camera.rotation.set(p.pitch * 0.6 - 0.25, p.yaw, 0);
    } else if (this.match?.spectate(this.camera, dt, this.input.wasPressed('fire'), this.input.wasPressed('aim'))) {
      // 관전 카메라가 위치/방향을 정함
    } else this.camera.position.copy(eye);
    // 충격: 시야가 출렁인다
    const conc = this.abilityFx.status.remaining(this.local.id, 'concuss');
    if (conc > 0 && alive) {
      const t = performance.now() / 1000;
      const k = Math.min(1, conc);
      this.camera.rotation.z += Math.sin(t * 6.3) * 0.035 * k;
      this.camera.rotation.x += Math.sin(t * 4.1) * 0.02 * k;
      this.camera.rotation.y += Math.sin(t * 3.3) * 0.02 * k;
    }
    // 화면 흔들림
    if (this.shakeAmount > 0) {
      const s = this.shakeAmount;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s).multiplyScalar(0.3));
      this.camera.rotation.z += (Math.random() - 0.5) * s * 0.05;
      this.shakeAmount = Math.max(0, s - dt * 1.2);
    }
    this.muzzleLight.position.copy(eye);

    // ── 1인칭 뷰모델
    this.shadowCheckTimer -= dt;
    if (this.shadowCheckTimer <= 0) {
      // 해를 향해 레이를 쏴서 막히면 그늘 → 무기도 어둡게
      this.shadowCheckTimer = 0.1;
      const hit = this.map.collision.raycast(eye.x, eye.y, eye.z, this.sunDir.x, this.sunDir.y, this.sunDir.z, 150);
      this.inShadow = hit !== null;
    }
    this.viewModel.setLighting(this.inShadow, dt);
    this.viewModel.update(this.inventory, {
      dt,
      speed: p.horizontalSpeed,
      grounded: p.grounded,
      crouch: this.crouchAmount(),
      lookDX: look.dx,
      lookDY: look.dy,
      verticalVelocity: p.velocity.y,
      plant: this.match?.plantProgress ?? -1,
    });

  }

  private updateAbilities(dt: number, alive: boolean): void {
    const ab = this.abilities;
    ab.update(dt);
    const st = this.abilityFx.status;
    const id = this.local.id;
    // 상태 이상 (자극·충격·감속·가속·무력화)
    this.inventory.fireRateMul = st.fireRateMul(id);
    this.player.speedMul = st.speedMul(id);
    this.local.spreadMul = st.has(id, 'concuss') ? 2.4 : 1;
    // 활강: 억제·감속 중에는 불가
    this.player.glide = ab.agent.passive === 'drift' && !st.has(id, 'suppress') && !st.has(id, 'slow');
    // 무적: 되살아난 직후 2초, 질주 중
    if (this.reviveInvuln > 0) this.reviveInvuln -= dt;
    this.local.invulnerable = this.reviveInvuln > 0 || (ab.agent.id === 'gale' && this.player.dashAmount > 0);
    this.updateRunItBack(dt);
    this.updateReviveChannel(dt);
    if (st.has(id, 'jam') && this.inventory.currentSlot === 1) this.inventory.switchTo(2);
    this.updateBladeStorm();
    // 되살아난 뒤 시간 안에 처치하지 못하면 다시 쓰러짐
    if (this.repriseTimer > 0 && alive) {
      this.repriseTimer -= dt;
      if (this.repriseTimer <= 0) {
        this.repriseTimer = 0;
        this.local.vitals.armor = 0;
        this.combat.applyDirectDamage({ id: id, name: this.local.name, team: this.local.team }, { ...getWeapon('blade'), name: 'REPRISE' }, this.local, 9999, this.player.position.clone());
      }
    }
    // 지도를 연 채 쓰러지면 (쓰러져서도 쓸 수 있는 능력이 아니면) 닫는다
    if (this.tacMap.isOpen && ab.targeting && !alive && !ab.usableWhileDead(ab.targeting)) this.tacMap.cancel();
    if (this.match?.weaponsLocked) return;
    // 꺼내 든 능력: 좌클릭/우클릭으로 사용. 무기를 바꾸면 집어넣음
    // 손에 드는 능력은 던지는 동작(THROW_RELEASE초) 끝에 손을 떠난다
    const hand = this.viewModel.abilityHand;
    if (this.pendingThrow) {
      const pt = this.pendingThrow;
      pt.t -= dt;
      if (!alive || ab.armed !== pt.slot) this.pendingThrow = null;
      else if (pt.t <= 0) {
        this.pendingThrow = null;
        ab.fireArmed(pt.variant);
        this.steerSlot = pt.slot;
      }
    } else if (ab.armed && alive) {
      const i = this.input;
      const d = ab.def(ab.armed);
      const press: 0 | 1 | null = i.wasPressed('fire') ? 0 : i.wasPressed('aim') ? 1 : null;
      if (press !== null) {
        this.holdFire = true;
        if (d.throwItem) {
          // 우클릭 짧게 던지기(화염구 포함)는 언더핸드, 나머지는 오버핸드
          hand.throw();
          this.pendingThrow = { slot: ab.armed, variant: press, t: THROW_RELEASE };
        } else ab.fireArmed(press);
      } else if (i.wasPressed('slot1') || i.wasPressed('slot2') || i.wasPressed('slot3') || i.wasPressed('nextWeapon') || i.wasPressed('prevWeapon')) ab.armed = null;
    }
    if (this.steerSlot && !this.input.isDown('fire')) this.steerSlot = null;
    // 손에 들고 있는 모습
    const heldDef = ab.armed && alive ? ab.def(ab.armed) : null;
    if (!hand.throwing) hand.setHeld(heldDef?.throwItem ?? null, heldDef?.itemColor ?? parseInt(ab.agent.color.slice(1), 16));
    if (this.piloting && !alive) this.piloting.life = 0;
    // 드론 조종 중: 좌클릭으로 파동
    if (this.piloting && alive && this.input.wasPressed('fire')) {
      this.piloting.pulseNow = true;
      this.holdFire = true;
    }
    for (const slot of ['ability1', 'ability2', 'signature', 'ultimate'] as AbilitySlot[]) {
      if (!this.input.wasPressed(slot)) continue;
      // 쓰러진 상태에서는 일부 능력만 (원거리 연막, 되살아나기)
      if (!alive && !ab.usableWhileDead(slot)) continue;
      // 드론 조종 중에는 드론 능력(파동)만
      if (this.piloting && ab.def(slot).effect !== 'drone') continue;
      if (!ab.use(slot)) this.sound.play('ui', { gain: 0.4, pitch: 0.6 });
    }
  }

  /** 전술 지도 열기: 지도를 보는 동안 다른 조작은 멈추고 마우스로 지점을 고른다 */
  private openTacticalMap(req: TargetRequest, cb: (points: THREE.Vector3[]) => void): void {
    this.input.suspended = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.tacMap.open(req, (points) => {
      this.input.suspended = false;
      this.input.clear();
      if (this.state === 'playing' && !this.input.forceActive) this.input.requestLock();
      cb(points);
    });
  }

  /** 궁극기: 투척 단검을 칼 자리(3번)에 꺼낸다 */
  private equipBladeStorm(count: number): void {
    const def = getWeapon('storm');
    this.stormActive = true;
    void loadWeaponTemplate(def).then((t) => {
      if (!this.stormActive) return;
      this.inventory.give(def, t, true);
      const w = this.inventory.get(3);
      if (w) w.mag = count;
    });
  }

  /** 단검을 다 던지면 원래 칼로 */
  private updateBladeStorm(): void {
    if (!this.stormActive) return;
    const w = this.inventory.get(3);
    if (!w || w.def.id !== 'storm') {
      if (w && w.def.id !== 'storm') this.stormActive = false;
      return;
    }
    if (w.mag <= 0 && this.inventory.state === 'ready') this.endBladeStorm();
  }

  /** 남은 단검 전부를 수평 부채꼴로 던진다 */
  private stormFan(): void {
    const w = this.inventory.get(3);
    if (!w || w.def.id !== 'storm' || this.inventory.current !== w || w.mag <= 0) return;
    if (this.stormFanning) return;
    // 남은 단검을 0.33초 간격으로, 조준 방향 둘레로 조금씩 퍼지게 (재충전 없음)
    this.stormFanning = true;
    const throwNext = () => {
      const cur = this.inventory.get(3);
      if (!this.stormActive || !this.local.alive || !cur || cur.def.id !== 'storm' || cur.mag <= 0) {
        this.stormFanning = false;
        return;
      }
      const dir = this.local.aimDirection().applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.12);
      dir.y += (Math.random() - 0.5) * 0.04;
      const shooter = { id: this.local.id, name: this.local.name, team: this.local.team };
      const from = new THREE.Vector3(0.14, -0.12, -0.6).applyQuaternion(this.camera.quaternion).add(this.camera.position);
      this.viewModel.storm.throwOne();
      cur.mag--;
      this.combat.fire(shooter, cur.def, this.local.eyePosition(), [dir.normalize()], from);
      this.sound.play('knife', { gain: 0.8 });
      if (cur.mag > 0) setTimeout(throwNext, 330);
      else this.stormFanning = false;
    };
    throwNext();
  }

  endBladeStorm(): void {
    if (!this.stormActive) return;
    this.stormActive = false;
    const blade = getWeapon('blade');
    void loadWeaponTemplate(blade).then((t) => {
      this.inventory.give(blade, t, this.inventory.currentSlot === 3);
    });
  }

  /** 궁극기 REPRISE: 1.5초 동안 되살아나는 중 → 그 자리에서 되살아남 (2초 무적) */
  private reprise(hp: number, duration: number): boolean {
    if (this.local.alive || this.reviveChannel > 0) return false;
    if (this.match && this.match.rm.state === 'RoundEnd') return false;
    this.reviveChannel = 1.5;
    this.reviveArgs = [hp, duration];
    this.abilityFx.adv.vfx.witherBurst(this.player.position, 1.5, 0xff7ad1);
    this.sound.play('magic_charge', { duration: 1.5, intensity: 1 });
    return true;
  }

  private updateReviveChannel(dt: number): void {
    if (this.reviveChannel <= 0) return;
    this.reviveChannel -= dt;
    if (this.reviveChannel > 0) return;
    this.reviveChannel = 0;
    if (this.local.alive || (this.match && !this.match.reviveParticipant(this.local.id))) return;
    const [hp, duration] = this.reviveArgs;
    this.local.revive(0);
    this.local.vitals.health = hp;
    this.repriseTimer = duration;
    this.reviveInvuln = 2;
    this.player.velocity.set(0, 0, 0);
    this.abilityFx.adv.vfx.witherBurst(this.player.position, 2.5, 0xff7ad1);
    void this.equipDefaultLoadoutIfEmpty();
  }

  /** 궁극기 REKINDLE: 지금 자리에 표식 */
  private runItBack(duration: number): boolean {
    if (!this.local.alive) return false;
    this.clearRunItBack();
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.06, 4, 20), new THREE.MeshBasicMaterial({ color: 0xffb43c }));
    mesh.rotation.x = Math.PI / 2;
    mesh.position.copy(this.player.position).setY(this.player.position.y + 0.05);
    this.abilityFx.adv.group.add(mesh);
    this.ribMarker = { pos: this.player.position.clone(), yaw: this.player.yaw, armor: this.local.vitals.armor, mesh };
    this.ribTimer = duration;
    this.sound.play('magic_charge', { duration: 0.9, intensity: 1 });
    this.abilityFx.adv.vfx.zoneBurst(this.player.position, 1.2, 0xffb43c);
    return true;
  }

  private updateRunItBack(dt: number): void {
    if (this.ribTimer <= 0) return;
    this.ribTimer -= dt;
    if (this.ribMarker) this.ribMarker.mesh.rotation.z += dt * 2;
    if (this.ribTimer <= 0) this.returnToMarker();
  }

  /** 표식으로 돌아온다: 체력 100, 방어구는 사용할 때만큼, 탄창 가득 */
  private returnToMarker(): void {
    const m = this.ribMarker;
    this.ribTimer = 0;
    if (!m) return;
    this.player.spawn(m.pos.x, m.pos.y, m.pos.z, m.yaw);
    this.accumulator = 0;
    this.local.vitals.health = 100;
    this.local.vitals.armor = m.armor;
    this.inventory.refill();
    this.abilityFx.adv.vfx.zoneBurst(m.pos, 1.6, 0xffb43c);
    this.sound.play('magic_charge', { duration: 0.6, intensity: 1 });
    this.clearRunItBack();
  }

  private clearRunItBack(): void {
    this.ribTimer = 0;
    this.ribMarker?.mesh.removeFromParent();
    this.ribMarker = null;
  }

  /** 드론 조종: 마우스로 방향, 이동 키·점프. 끝나면 다시 내 몸 */
  private makePilot(): DronePilot {
    const p = this.player;
    const i = this.input;
    const pilot: DronePilot = {
      yaw: () => p.yaw,
      pitch: () => p.pitch,
      move: () => ({ f: (i.isDown('forward') ? 1 : 0) - (i.isDown('back') ? 1 : 0), s: (i.isDown('right') ? 1 : 0) - (i.isDown('left') ? 1 : 0), jump: i.isDown('jump') }),
      onEnd: () => {
        this.piloting = null;
      },
    };
    // 드론이 만들어진 직후 찾아 둔다
    queueMicrotask(() => (this.piloting = this.abilityFx.adv.pilotedDrone(this.local.id)));
    return pilot;
  }

  private async equipDefaultLoadoutIfEmpty(): Promise<void> {
    if (!this.inventory.current) await this.equipDefaultLoadout();
  }

  /** 재장전 소리: 탄창 빼기(25%) / 끼우기(70%) */
  private playWeaponSounds(): void {
    const r = this.inventory.reloadProgress;
    if (r >= 0) {
      const id = this.inventory.current?.def.id ?? 'falcon';
      if (this.lastReload < 0.25 && r >= 0.25) this.sound.weapon(id, 'magOut');
      if (this.lastReload < 0.7 && r >= 0.7) this.sound.weapon(id, 'magIn');
    }
    this.lastReload = r;
  }

  /** 발소리: 달릴 때만 난다 (걷기·앉기는 조용히 — 전술 FPS 규칙) */
  private playFootsteps(dt: number): void {
    const p = this.player;
    const running = this.local.alive && p.grounded && !p.walking && !p.crouching && p.horizontalSpeed > 3.5;
    if (!running) {
      this.stepDistance = 0.4;
      return;
    }
    // 보폭 약 1.9m마다 한 걸음, 밟고 있는 표면 재질로
    this.stepDistance -= p.horizontalSpeed * dt;
    if (this.stepDistance <= 0) {
      this.stepDistance += 1.9;
      const at = p.position;
      this.sound.footstep(this.map.surfaceAt(at.x, at.y, at.z), p.horizontalSpeed);
      // 달리는 발소리는 주변 적 봇이 듣는다
      if (this.match instanceof MatchController) this.bots?.noise('A', at, 14);
    }
  }

  private crouchAmount(): number {
    const p = this.player;
    return THREE.MathUtils.clamp(
      (PLAYER_SHAPE.standEye - p.eyeHeight) / (PLAYER_SHAPE.standEye - PLAYER_SHAPE.crouchEye),
      0,
      1,
    );
  }

  /** 플레이어 상태 → 캐릭터 포즈 (Phase 8에서 네트워크 동기화에도 같은 구조를 쓴다) */
  localPose(): CharacterPose {
    const p = this.player;
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    // 월드 속도를 캐릭터 기준(오른쪽/앞)으로 변환
    const fwd = -sin * p.velocity.x - cos * p.velocity.z;
    const right = cos * p.velocity.x - sin * p.velocity.z;
    return {
      ...DEFAULT_POSE,
      moveX: right,
      moveZ: fwd,
      grounded: p.grounded,
      crouch: this.crouchAmount(),
      aimPitch: p.pitch,
      fire: this.fireKick,
      reload: this.inventory.reloadProgress,
      equip: this.inventory.equipProgress,
      dead: this.local.alive ? -1 : this.local.deadTime,
    };
  }

  /** 메인 메뉴 배경: 맵 위를 천천히 도는 카메라 */
  private updateMenuCamera(dt: number): void {
    this.menuTime += dt;
    const t = this.menuTime * 0.05;
    const r = 34;
    this.camera.position.set(Math.sin(t) * r, 22, Math.cos(t) * r);
    this.camera.lookAt(0, 0, 0);
  }

  private trackFps(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  averageFps(): number {
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return sum > 0 ? this.frameTimes.length / sum : 0;
  }
}
