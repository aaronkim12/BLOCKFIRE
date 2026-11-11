import * as THREE from 'three';
import type { Damageable, Shooter } from '../combat/CombatSystem';
import type { PlayerController } from '../player/PlayerController';
import type { Team } from '../player/CharacterModel';
import { AGENTS, SLOTS, getAgent, type AbilityDef, type AbilityEffect, type AbilitySlot, type AgentDef } from './abilityData';
import type { AbilityEffects } from './AbilityEffects';
import type { DronePilot } from './AdvancedEffects';

/** 능력 사용에 필요한 세계 정보 */
export interface AbilityHost {
  effects: AbilityEffects;
  player: PlayerController;
  camera: THREE.Camera;
  shooter(): Shooter;
  team(): Team;
  /** 이동 입력 방향 (월드, 수평) — 돌진 방향 */
  moveDir(): THREE.Vector3;
  /** 발동 알림 (kind 'dash' = 질주) */
  onCast?(def: AbilityDef, kind?: 'dash'): void;
  /** 자기 자신 (흡수: 추가 체력) */
  self?(): Damageable;
  /** 마지막으로 처치(또는 피해를 준 적이 쓰러짐)한 뒤 경과 시간 (초) — 흡수 능력 조건 */
  lastKillAge?(): number;
  /** 투척 단검 꺼내기 */
  equipBladeStorm?(count: number): void;
  /** 쓰러진 뒤 되살아나기 (성공하면 true) */
  revive?(hp: number, duration: number): boolean;
  /** 표식을 남기고 duration초 안에 쓰러지거나 시간이 끝나면 표식으로 돌아옴 */
  runItBack?(duration: number): boolean;
  /** 드론 조종 (플레이어). 없으면 드론은 혼자 난다 */
  pilotDrone?(): DronePilot | null;
  alive?(): boolean;
  /** 봇: 설치형 능력을 스스로 발동, 드론은 직진 */
  autonomous?: boolean;
  /** 플레이어: alt 능력은 키를 누르면 꺼내 들고 좌클릭/우클릭으로 사용 */
  armable?: boolean;
  /**
   * 전술 지도로 지점 지정 (플레이어). 없으면(봇) 목표·조준 지점을 그대로 쓴다.
   * onConfirm에 월드 좌표 목록을 넘기면 그때 능력이 발동한다.
   */
  requestTargets?(req: TargetRequest, onConfirm: (points: THREE.Vector3[]) => void): void;
  /** 이 슬롯 키를 누르고 있는지 (휘는 연막탄·불길 벽, 누르고 있다 떼는 충격파) */
  held?(slot: AbilitySlot): boolean;
  /** 온라인: 능력을 실제로 썼을 때 (서버에 같은 사용을 보낸다) */
  onUse?(slot: AbilitySlot, info: { variant?: 0 | 1; points?: THREE.Vector3[]; held?: number }): void;
}

/** 전술 지도 지정 요청 */
export interface TargetRequest {
  slot: AbilitySlot;
  title: string;
  /** points: 여러 지점 / line: 시작점과 끝점 */
  mode: 'points' | 'line';
  maxPoints: number;
  /** 기준 위치에서 최대 거리 (m) */
  range: number;
  /** 지점 하나의 효과 반경 (미리보기 원) */
  radius: number;
  color: string;
}

/** 지도에서 지점을 고르는 능력 */
const MAP_TARGETED: AbilityEffect[] = ['salvo', 'armageddon', 'ruse', 'skysmoke', 'orbital'];

/** 쓰러진 상태에서도 쓸 수 있는 능력 */
const WHILE_DEAD: AbilityEffect[] = ['ruse', 'notdeadyet'];

/** 충격파 누르기: 최소·최대 거리에 닿는 데 걸리는 시간 */
const FAULT_MIN = 8;
const FAULT_CHARGE = 1.6;

/**
 * 한 참가자의 능력 상태: 충전 수, 재사용 대기, 궁극기 포인트, 재충전.
 * 충전 구매는 Shop이 buyCharge()로 처리한다.
 *   설치형(가시덤불·섬광 꽃·드론)은 처음 누르면 설치, 다시 누르면 발동 (충전은 설치할 때만 소모)
 *   alt 능력(휘는 섬광·화염구·충격탄·섬광 꽃): 플레이어는 키로 꺼내 들고 좌클릭/우클릭으로 사용
 *   hold 능력(충격파): 누르고 있다가 떼면 발동
 */
export class AbilitySystem {
  agent: AgentDef = AGENTS[0];
  readonly charges: Record<AbilitySlot, number> = { ability1: 0, ability2: 0, signature: 0, ultimate: 0 };
  private cooldowns: Record<AbilitySlot, number> = { ability1: 0, ability2: 0, signature: 0, ultimate: 0 };
  /** 시간 재충전 진행 (초) */
  private rechargeT: Record<AbilitySlot, number> = { ability1: 0, ability2: 0, signature: 0, ultimate: 0 };
  /** 처치 재충전 카운트 */
  private kills: Record<AbilitySlot, number> = { ability1: 0, ability2: 0, signature: 0, ultimate: 0 };
  ultPoints = 0;
  /** 연습 모드: 사용해도 줄지 않음 */
  infinite = false;
  /** 질주(tailwind) 준비 남은 시간 / 준비가 끝나기까지 */
  tailwindPrimed = 0;
  tailwindArm = 0;
  /** 꺼내 든 능력 (좌클릭/우클릭 대기) */
  armed: AbilitySlot | null = null;
  /** 누르고 있는 능력 (충격파 거리 늘리기) */
  charging: { slot: AbilitySlot; t: number } | null = null;
  /** 전술 지도를 열어 둔 상태 */
  targeting: AbilitySlot | null = null;
  /** 마지막으로 실패한 이유 (HUD 안내, 1.5초 표시) */
  lastFail = '';
  private failTimer = 0;

  constructor(private host: AbilityHost) {}

  setAgent(id: string): void {
    this.agent = getAgent(id);
    this.resetAll();
  }

  def(slot: AbilitySlot): AbilityDef {
    return this.agent.abilities[slot];
  }

  get ultMax(): number {
    return this.def('ultimate').ultPoints ?? 7;
  }

  get ultReady(): boolean {
    return this.ultPoints >= this.ultMax;
  }

  /** 진영 교체 / 경기 시작: 전부 초기화 */
  resetAll(): void {
    for (const s of SLOTS) {
      this.charges[s] = 0;
      this.cooldowns[s] = 0;
    }
    this.ultPoints = 0;
    this.roundStart();
  }

  /** 내가 적을 처치함: 처치 재충전 능력 (질주·휘는 섬광은 2킬마다) */
  onKill(): void {
    for (const s of SLOTS) {
      const d = this.def(s);
      if (!d.killRecharge) continue;
      if (++this.kills[s] >= d.killRecharge) {
        this.kills[s] = 0;
        this.charges[s] = Math.min(d.maxCharges, this.charges[s] + 1);
      }
    }
  }

  /** 라운드 시작: 고유 능력(signature) 무료 충전 (구매한 충전은 유지) */
  roundStart(): void {
    for (const s of SLOTS) {
      const d = this.def(s);
      this.charges[s] = Math.max(this.charges[s], d.freeCharges);
      this.rechargeT[s] = 0;
      this.kills[s] = 0;
    }
    this.tailwindPrimed = 0;
    this.tailwindArm = 0;
    this.armed = null;
    this.charging = null;
    this.targeting = null;
  }

  /** 연습 모드: 모든 능력을 가득 채움 */
  fill(): void {
    for (const s of SLOTS) this.charges[s] = this.def(s).maxCharges;
    this.ultPoints = this.ultMax;
  }

  addUlt(n: number): void {
    this.ultPoints = Math.min(this.ultMax, this.ultPoints + n);
  }

  canBuy(slot: AbilitySlot): boolean {
    const d = this.def(slot);
    return d.cost > 0 && this.charges[slot] < d.maxCharges;
  }

  buyCharge(slot: AbilitySlot): void {
    this.charges[slot] = Math.min(this.def(slot).maxCharges, this.charges[slot] + 1);
  }

  sellCharge(slot: AbilitySlot): void {
    this.charges[slot] = Math.max(0, this.charges[slot] - 1);
  }

  get suppressed(): boolean {
    return this.host.effects.status.has(this.host.shooter().id, 'suppress');
  }

  /** 쓰러진 상태에서 쓸 수 있는 능력인지 */
  usableWhileDead(slot: AbilitySlot): boolean {
    return WHILE_DEAD.includes(this.def(slot).effect);
  }

  canUse(slot: AbilitySlot): boolean {
    if (this.cooldowns[slot] > 0 || this.suppressed) return false;
    if (this.pendingActivation(slot)) return true;
    if (slot === 'ultimate') return this.infinite || this.ultReady;
    return this.infinite || this.charges[slot] > 0;
  }

  cooldownRatio(slot: AbilitySlot): number {
    const d = this.def(slot).cooldown;
    return d > 0 ? this.cooldowns[slot] / d : 0;
  }

  /** 시간 재충전 진행 0..1 (재충전 중이 아니면 0) */
  rechargeRatio(slot: AbilitySlot): number {
    const r = this.def(slot).recharge;
    return r ? this.rechargeT[slot] / r : 0;
  }

  /** 질주 준비 남은 시간 표시용: 준비 중(1초)이면 음수 */
  /** 설치해 둔 덤불/꽃/조종 중인 드론/모아 둔 바람이 있으면 다음 사용은 발동 */
  pendingActivation(slot: AbilitySlot): boolean {
    const e = this.def(slot).effect;
    const id = this.host.shooter().id;
    const adv = this.host.effects.adv;
    if (e === 'razorvine') return adv.pendingVines(id).length > 0;
    if (e === 'arcrose') return !!adv.pendingRose(id);
    if (e === 'tailwind') return this.tailwindPrimed > 0 && this.tailwindArm <= 0;
    if (e === 'drone') return !!adv.pilotedDrone(id);
    return false;
  }

  update(dt: number): void {
    for (const s of SLOTS) this.cooldowns[s] = Math.max(0, this.cooldowns[s] - dt);
    // 모아 둔 바람: 1초 뒤부터 7.5초 안에 써야 한다
    if (this.tailwindArm > 0) this.tailwindArm = Math.max(0, this.tailwindArm - dt);
    else if (this.tailwindPrimed > 0) this.tailwindPrimed = Math.max(0, this.tailwindPrimed - dt);
    // 시간 재충전 (섬광 꽃은 설치해 둔 동안 멈춤)
    const id = this.host.shooter().id;
    for (const s of SLOTS) {
      const d = this.def(s);
      const paused = d.effect === 'arcrose' && !!this.host.effects.adv.pendingRose(id);
      if (!d.recharge || this.charges[s] >= d.maxCharges || paused) {
        if (!paused) this.rechargeT[s] = 0;
        continue;
      }
      this.rechargeT[s] += dt;
      if (this.rechargeT[s] >= d.recharge) {
        this.rechargeT[s] = 0;
        this.charges[s]++;
      }
    }
    // 억제되거나 쓰러지면 꺼내 든 능력·누르던 능력 취소
    const alive = this.host.alive?.() ?? true;
    if (this.suppressed || !alive) {
      this.armed = null;
      this.charging = null;
    }
    // 누르고 있던 충격파: 떼면 발동
    if (this.charging) {
      this.charging.t += dt;
      const slot = this.charging.slot;
      const d = this.def(slot);
      const len = this.faultLength(d, this.charging.t);
      const eye = this.host.camera.getWorldPosition(new THREE.Vector3());
      const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(this.host.camera.getWorldQuaternion(new THREE.Quaternion()));
      const flat = new THREE.Vector3(aim.x, 0, aim.z).normalize();
      const end = this.host.effects.adv.groundAt(eye.x + flat.x * len, eye.z + flat.z * len);
      if (Math.random() < dt * 20) this.host.effects.adv.vfx.ring(end.setY(end.y + 0.05), d.radius, 0.12, 0xff8a3c, new THREE.Vector3(0, 1, 0), 0.05, 0.5);
      if (!(this.host.held?.(slot) ?? false)) {
        this.charging = null;
        // 서버·다른 사람은 누른 시간으로 같은 길이를 다시 계산한다
        const held = ((len - FAULT_MIN) / (d.power - FAULT_MIN)) * FAULT_CHARGE;
        this.consume(slot, d, () => {
          this.host.effects.adv.seismicLine(this.host.player.position.clone(), aim, len, d.radius, d.duration, this.host.shooter());
          return true;
        }, { held });
      }
    }
    if (this.failTimer > 0) {
      this.failTimer -= dt;
      if (this.failTimer <= 0) this.lastFail = '';
    }
  }

  /** 충격파 거리: 누른 시간에 따라 8m → 최대 */
  faultLength(d: AbilityDef, held: number): number {
    return FAULT_MIN + Math.min(1, held / FAULT_CHARGE) * (d.power - FAULT_MIN);
  }

  /**
   * 능력 사용. 성공하면 true
   * @param variant alt 능력: 0 좌클릭 / 1 우클릭 (생략하면 플레이어는 꺼내 들기)
   * @param target 봇: 목표 지점 (지도 능력·충격파 거리에 사용)
   */
  use(slot: AbilitySlot, variant?: 0 | 1, target?: THREE.Vector3): boolean {
    const ok = this.tryUse(slot, variant, target);
    this.failTimer = this.lastFail ? 1.5 : 0;
    return ok;
  }

  /**
   * 지도 능력을 정해진 지점들에 바로 (서버: 클라이언트가 고른 지점, 원격 플레이어 재현).
   * 충전은 지점 수만큼, 궁극기는 포인트를 쓴다.
   */
  useAt(slot: AbilitySlot, points: THREE.Vector3[]): boolean {
    const d = this.def(slot);
    if (!MAP_TARGETED.includes(d.effect) || !points.length) return false;
    const alive = this.host.alive?.() ?? true;
    if (!alive && !WHILE_DEAD.includes(d.effect)) return false;
    if (this.suppressed || this.cooldowns[slot] > 0 || !this.canUse(slot)) return false;
    const max = this.infinite ? points.length : slot === 'ultimate' ? points.length : this.charges[slot];
    const pts = points.slice(0, Math.max(1, max));
    this.castAt(d, pts, alive);
    this.cooldowns[slot] = d.cooldown;
    if (!this.infinite) {
      if (slot === 'ultimate') this.ultPoints = 0;
      else this.charges[slot] = Math.max(0, this.charges[slot] - pts.length);
    }
    this.host.onCast?.(d);
    return true;
  }

  /** 지도에서 지점을 고르는 능력인지 */
  isMapTargeted(slot: AbilitySlot): boolean {
    return MAP_TARGETED.includes(this.def(slot).effect);
  }

  /** 꺼내 든 능력을 좌클릭(0)/우클릭(1)으로 사용 */
  fireArmed(variant: 0 | 1): boolean {
    const slot = this.armed;
    if (!slot) return false;
    this.armed = null;
    return this.use(slot, variant);
  }

  private tryUse(slot: AbilitySlot, variant: 0 | 1 | undefined, target?: THREE.Vector3): boolean {
    this.lastFail = '';
    if (this.suppressed) {
      this.lastFail = '억제됨';
      return false;
    }
    const d = this.def(slot);
    // 꺼내 든 능력을 같은 키로 다시 누르면 집어넣기
    if (this.armed === slot && variant === undefined) {
      this.armed = null;
      return true;
    }
    const alive = this.host.alive?.() ?? true;
    // 두 번째 누름: 설치형 발동 (재사용 대기·충전과 무관)
    if (this.pendingActivation(slot) && alive) {
      this.activatePending(d);
      this.host.onUse?.(slot, {});
      return true;
    }
    if (this.cooldowns[slot] > 0) return false;
    if (!alive && !WHILE_DEAD.includes(d.effect)) return false;
    if (alive && d.effect === 'notdeadyet') {
      this.lastFail = '쓰러진 뒤에 사용';
      return false;
    }
    if (d.effect === 'tailwind' && this.tailwindArm > 0) return false;
    if (!this.canUse(slot)) return false;
    if (this.targeting || this.charging) return false;
    // 꺼내 들기 (플레이어)
    if ((d.alt || d.throwItem) && this.host.armable && variant === undefined) {
      this.armed = slot;
      return true;
    }
    this.armed = null;
    // 누르고 있다가 떼면 발동 (플레이어)
    if (d.hold && this.host.held && !this.host.autonomous) {
      this.charging = { slot, t: 0 };
      return true;
    }
    // 전술 지도: 지점을 고른 뒤에 발동·충전 소모
    if (MAP_TARGETED.includes(d.effect) && this.host.requestTargets) {
      const req = this.targetRequest(slot, d, alive);
      this.targeting = slot;
      this.host.requestTargets(req, (points) => {
        this.targeting = null;
        if (!points.length) return;
        this.castAt(d, points, this.host.alive?.() ?? true);
        this.host.onUse?.(slot, { points });
        this.cooldowns[slot] = d.cooldown;
        if (!this.infinite) {
          if (slot === 'ultimate') this.ultPoints = 0;
          else this.charges[slot] = Math.max(0, this.charges[slot] - points.length);
        }
        this.host.onCast?.(d);
      });
      return true;
    }
    return this.consume(slot, d, () => this.cast(d, variant ?? 0, target), { variant });
  }

  /** 발동에 성공하면 재사용 대기 + 충전/궁극기 소모 */
  private consume(slot: AbilitySlot, d: AbilityDef, run: () => boolean, info: { variant?: 0 | 1; held?: number } = {}): boolean {
    if (!run()) return false;
    this.host.onUse?.(slot, info);
    this.cooldowns[slot] = d.cooldown;
    if (!this.infinite) {
      if (slot === 'ultimate') this.ultPoints = 0;
      else this.charges[slot] = Math.max(0, this.charges[slot] - 1);
    }
    this.host.onCast?.(d);
    return true;
  }

  private activatePending(d: AbilityDef): void {
    const adv = this.host.effects.adv;
    const id = this.host.shooter().id;
    if (d.effect === 'razorvine') {
      for (const v of adv.pendingVines(id)) adv.activateVine(v, d.duration);
    } else if (d.effect === 'arcrose') {
      const r = adv.pendingRose(id);
      if (r) adv.fireRose(r);
    } else if (d.effect === 'drone') {
      const dr = adv.pilotedDrone(id);
      if (dr) dr.pulseNow = true;
    } else if (d.effect === 'tailwind') {
      // 모아 둔 바람으로 질주: 이동 방향(입력이 없으면 바라보는 방향)
      this.tailwindPrimed = 0;
      const h = this.host;
      let dir = h.moveDir();
      if (dir.lengthSq() < 1e-4) dir = new THREE.Vector3(0, 0, -1).applyQuaternion(h.camera.getWorldQuaternion(new THREE.Quaternion())).setY(0);
      dir.normalize();
      h.player.dash(dir.x, dir.z, d.power, d.duration);
      h.effects.adv.vfx.dash(h.player.position, dir, 0x9fe3ff);
      h.onCast?.(d, 'dash');
    }
  }

  private targetRequest(slot: AbilitySlot, d: AbilityDef, alive: boolean): TargetRequest {
    const left = this.infinite ? d.maxCharges : this.charges[slot];
    const base = { slot, title: d.name, radius: d.radius, color: this.agent.color };
    switch (d.effect) {
      case 'armageddon':
        return { ...base, mode: 'line', maxPoints: 2, range: 70 };
      case 'orbital':
        return { ...base, mode: 'points', maxPoints: 1, range: 999 };
      case 'skysmoke':
        return { ...base, mode: 'points', maxPoints: Math.max(1, Math.min(3, left)), range: d.power };
      case 'salvo':
        return { ...base, mode: 'points', maxPoints: Math.max(1, Math.min(2, left)), range: 45 };
      default:
        // 원거리 연막: 쓰러진 뒤에는 내 몸 근처에 1개
        return { ...base, title: alive ? d.name : `${d.name} (쓰러짐)`, mode: 'points', maxPoints: alive ? Math.max(1, Math.min(2, left)) : 1, range: alive ? d.power : 20 };
    }
  }

  /** 지도·목표로 정한 지점에 발동 (미사일·폭격·투하 연막·레이저) */
  private castAt(d: AbilityDef, points: THREE.Vector3[], alive: boolean): void {
    const h = this.host;
    const fx = h.effects;
    const adv = fx.adv;
    const owner = h.shooter();
    const pts = points.map((p) => adv.groundAt(p.x, p.z));
    const UP = new THREE.Vector3(0, 1, 0);
    switch (d.effect) {
      case 'salvo':
        // 1.25초 날아가 0.8초 간격 3연속 폭발
        pts.forEach((t, i) => {
          adv.vfx.ring(t.clone().setY(t.y + 0.05), d.radius, 1.25 + 2 * d.duration + i * 0.2, 0xff6020, UP, 0.04, 0.7);
          adv.schedule(i * 0.2, () =>
            adv.missile(t, h.player.position.clone(), () => {
              for (let k = 0; k < 3; k++) adv.schedule(k * d.duration, () => adv.explode(t.clone().setY(t.y + 0.5), d.radius, d.power, owner, d.name, true, 0xffa040, 50 / 65));
            }, 1.25),
          );
        });
        adv.sound.play('ability', { at: h.player.position, gain: 0.9, pitch: 0.7 });
        break;
      case 'skysmoke':
        // 하늘에서 연막 통이 떨어진다
        for (const p of pts) {
          adv.vfx.ring(p.clone().setY(p.y + 0.05), d.radius, 0.9, 0x4fe0c0, UP, 0.04, 0.6);
          adv.drop(p, 0.9, 0x4fe0c0, () => fx.spawnSmoke(p, d.radius, d.duration));
        }
        adv.sound.play('ability', { at: h.player.position, gain: 0.7, pitch: 0.8 });
        break;
      case 'ruse':
        for (const p of pts) fx.spawnSmoke(p, d.radius, alive ? d.duration : 6);
        break;
      case 'orbital':
        adv.orbital(pts[0], d.radius, 2, d.duration, d.power, owner, (p, r, dur) => fx.addBlocker(p, r, dur));
        break;
      case 'armageddon': {
        // 3초 뒤 경로를 따라 16구간이 0.25초 간격으로, 구간마다 1초 동안 네 번 폭발
        const start = pts[0];
        const end = pts[1] ?? start.clone().add(new THREE.Vector3(0, 0, -20));
        const dir = end.clone().sub(start).setY(0);
        const len = THREE.MathUtils.clamp(dir.length(), 8, 40);
        dir.normalize();
        const n = 16;
        for (let i = 0; i < n; i++) {
          const p = adv.groundAt(start.x + dir.x * (i / (n - 1)) * len, start.z + dir.z * (i / (n - 1)) * len);
          const at = 3 + i * 0.25;
          adv.vfx.ring(p.clone().setY(p.y + 0.05), d.radius, at, 0xff4010, UP, 0.03, 0.45);
          for (let k = 0; k < 4; k++) adv.schedule(at + k * 0.25, () => adv.explode(p.clone().setY(p.y + 0.6), d.radius, d.power, owner, d.name, true, 0xff7020, 0.7));
        }
        adv.sound.play('explosion', { at: h.player.position, size: 'small', intensity: 0.3 });
        break;
      }
    }
  }

  private cast(d: AbilityDef, variant: 0 | 1, target?: THREE.Vector3): boolean {
    const h = this.host;
    const fx = h.effects;
    const adv = fx.adv;
    const cam = h.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    const flat = new THREE.Vector3(aim.x, 0, aim.z).normalize();
    // 던질 때는 약간 위로 (포물선). 손에 드는 능력의 우클릭은 아래로 짧게 (언더핸드)
    const under = variant === 1 && !!d.throwItem && !d.alt;
    const throwDir = aim.clone().add(new THREE.Vector3(0, under ? 0.28 : 0.12, 0)).normalize();
    const speedK = under ? 0.5 : 1;
    const from = eye.clone().addScaledVector(aim, 0.4).add(new THREE.Vector3(0, -0.15, 0));
    const owner = h.shooter();
    const team = h.team();
    const feet = h.player.position.clone();
    const viewer = { camera: cam, id: owner.id };
    const innerfire = this.agent.passive === 'innerfire';
    const UP = new THREE.Vector3(0, 1, 0);
    const steerAim = (slot: AbilitySlot) =>
      h.held && !h.autonomous ? () => (h.held!(slot) ? new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())) : null) : null;

    switch (d.effect) {
      // ── WARDEN
      case 'stim':
        fx.throwProjectile(from, throwDir, d.throwSpeed * speedK, 0xffa040, (p) => fx.spawnBeacon(adv.ground(p), d.radius, d.duration, team, 'stim'));
        return true;
      case 'incendiary':
        // 발사기: 빠르게 날아가 바닥에서 한 번 튕긴 뒤 터진다
        fx.throwProjectile(from, under ? throwDir : aim.clone().add(new THREE.Vector3(0, 0.08, 0)).normalize(), d.throwSpeed * speedK, 0xff6020, (p) => fx.spawnZone(adv.ground(p), d.radius, d.duration, d.power, owner, d.name, 0xff6020), 0, { bounces: 1, life: 3 });
        return true;

      // ── VOLT
      case 'blaze':
        adv.fireWall(feet.clone().addScaledVector(flat, 1), flat, d.radius, d.duration, d.power, owner, innerfire, steerAim(d.slot), (p, r, dur) => fx.addBlocker(p, r, dur));
        return true;
      case 'hothands': {
        // 좌클릭: 멀리 / 우클릭: 짧게 아래로. 1.5초 안에 떨어지지 않으면 그 자리에서 떨어진다
        const dir = variant === 1 ? aim.clone().add(new THREE.Vector3(0, -0.15, 0)).normalize() : throwDir;
        fx.throwProjectile(from, dir, variant === 1 ? 11 : d.throwSpeed, 0xff6020, (p) => fx.spawnZone(adv.ground(p), d.radius, d.duration, d.power, owner, d.name, 0xff6020, innerfire ? 6.25 : 0), 0, { life: 1.5 });
        return true;
      }
      case 'curveball': {
        // 좌클릭은 왼쪽, 우클릭은 오른쪽으로 휘어 0.6초 뒤 터진다. 봇은 휘어 들어가 조준 지점 근처에서 터지게 반대로 틀어 던진다
        const sign = variant === 1 ? -1 : 1;
        const curve = 2.6 * sign;
        const dir = aim.clone().add(new THREE.Vector3(0, 0.05, 0)).normalize();
        if (h.autonomous) dir.applyAxisAngle(UP, -curve * 0.3);
        fx.throwProjectile(eye.clone().addScaledVector(aim, 0.5), dir, d.throwSpeed, 0xfff0a0, (p) => fx.flare(p, owner, d.duration, d.radius, viewer), 0.6, { curve, gravity: 3 });
        return true;
      }
      case 'runitback':
        return h.runItBack?.(d.duration) ?? false;

      // ── GALE
      case 'cloudburst': {
        // 낮게 깔려 날아가며, 키를 누르고 있는 동안 조준 방향으로 휜다
        const steer = steerAim(d.slot);
        fx.throwProjectile(eye.clone().addScaledVector(aim, 0.6), aim, d.throwSpeed * speedK, 0xcfe8ff, (p) => fx.spawnSmoke(p, d.radius, d.duration), 0, {
          gravity: 4,
          life: 2.2,
          steer: steer ?? undefined,
        });
        return true;
      }
      case 'tailwind':
        // 1초 동안 바람을 모은다 (그 뒤 7.5초 안에 다시 누르면 질주)
        this.tailwindArm = 1;
        this.tailwindPrimed = d.radius;
        fx.adv.vfx.dash(h.player.position.clone().setY(h.player.position.y + 0.8), flat, 0x9fe3ff);
        return true;
      case 'updraft':
        h.player.velocity.y = d.power;
        h.player.grounded = false;
        return true;
      case 'bladestorm':
        if (!h.equipBladeStorm) return false;
        h.equipBladeStorm(d.power);
        return true;

      // ── TREMOR
      case 'aftershock':
        adv.rivetCharge(eye, aim, owner, d.radius, d.power, d.duration);
        return true;
      case 'flashpoint':
        adv.glareCharge(eye, aim, (p) => fx.flare(p, owner, d.duration, d.radius, viewer));
        return true;
      case 'faultline': {
        // 봇: 목표까지 닿는 길이 (없으면 중간 길이)
        const len = target ? THREE.MathUtils.clamp(Math.hypot(target.x - feet.x, target.z - feet.z) + 2, FAULT_MIN, d.power) : (FAULT_MIN + d.power) / 2;
        const dir = target ? new THREE.Vector3(target.x - feet.x, 0, target.z - feet.z).normalize() : flat;
        adv.seismicLine(feet, dir, len, d.radius, d.duration, owner);
        return true;
      }
      case 'quake':
        adv.groundSurge(feet, aim, 8, d.radius, d.duration, owner);
        return true;

      // ── MARSHAL
      case 'drone':
        adv.drone(eye.clone().addScaledVector(aim, 0.7), aim, owner, d.duration, d.radius, d.power, h.autonomous ? null : (h.pilotDrone?.() ?? null));
        return true;
      case 'sticky':
        // 좌클릭: 닿는 곳에 바로 붙음 / 우클릭: 한 번 튕긴 뒤. 1초 뒤 폭발 (가운데 35·2.5초 → 가장자리 20·1.5초)
        fx.throwProjectile(from, throwDir, d.throwSpeed, 0xd9c25a, (p) =>
          adv.schedule(1, () => {
            const c = p.clone().setY(p.y + 0.4);
            fx.adv.vfx.shockwave(p, d.radius, 0xd9c25a);
            fx.adv.vfx.blast(c, 1.2, 0xd9c25a);
            adv.sound.play('explosion', { at: c, size: 'small', intensity: 0.4 });
            for (const t of adv.enemiesNear(c, d.radius, team, true)) {
              const f = Math.min(1, t.center(new THREE.Vector3()).distanceTo(c) / d.radius);
              fx.status.apply(t.id, 'concuss', d.duration - f);
              adv.damage(owner, t, Math.round(d.power - 15 * f), d.name);
            }
          }),
          0, { stick: true, bounces: variant === 1 ? 1 : 0 },
        );
        return true;
      case 'salvo':
      case 'ruse':
      case 'skysmoke':
      case 'orbital': {
        // 봇: 목표 지점(없으면 조준 지점)에 바로
        const p = target ?? adv.aimPoint(eye, aim, d.effect === 'salvo' ? 45 : 50).point.clone().addScaledVector(aim, -0.5);
        this.castAt(d, [p], h.alive?.() ?? true);
        return true;
      }
      case 'armageddon': {
        const start = target ?? adv.aimPoint(eye, aim, 45).point.clone().addScaledVector(aim, -0.5);
        this.castAt(d, [start.clone().addScaledVector(flat, -6), start.clone().addScaledVector(flat, 18)], true);
        return true;
      }

      // ── THORN
      case 'razorvine':
        fx.throwProjectile(from, throwDir, d.throwSpeed * speedK, 0xb48cff, (p) => adv.vine(adv.ground(p), d.radius, owner, d.power, !!h.autonomous));
        return true;
      case 'shear': {
        // 벽면에 붙여 벽에서 뻗어 나가는 줄. 적이 넘어가면 줄을 따라 벽이 솟는다
        const a = adv.aimPoint(eye, aim, 10);
        if (!a.hit || Math.abs(a.normal.y) > 0.5) {
          this.lastFail = '벽면을 조준';
          return false;
        }
        const n = a.normal.clone().setY(0).normalize();
        const base = adv.ground(a.point.clone().addScaledVector(n, 0.05).setY(feet.y + 0.5));
        adv.shear(base, n, d.radius, owner, () => {
          const center = base.clone().addScaledVector(n, d.radius / 2);
          fx.spawnWall(center, new THREE.Vector3(-n.z, 0, n.x), d.radius, d.power, d.duration);
        });
        return true;
      }
      case 'arcrose': {
        const a = adv.aimPoint(eye, aim, 12);
        if (!a.hit) {
          this.lastFail = '벽이나 바닥을 조준';
          return false;
        }
        let pos = a.point;
        let normal = a.normal;
        if (variant === 1 && Math.abs(a.normal.y) < 0.5) {
          // 벽 너머: 뒤쪽 4m에서 거꾸로 쏴 벽 뒷면을 찾는다
          const back = a.point.clone().addScaledVector(flat, 4);
          const b = adv.aimPoint(back, flat.clone().negate(), 4);
          if (!b.hit || b.point.distanceTo(back) < 0.05) {
            this.lastFail = '벽 너머에 공간이 없음';
            return false;
          }
          pos = b.point;
          normal = flat.clone();
        }
        adv.rose(pos, normal, owner, !!h.autonomous, (p) => fx.flare(p, owner, d.duration, d.radius, viewer));
        return true;
      }
      case 'steelgarden':
        fx.adv.vfx.ring(feet.clone().setY(feet.y + 0.06), 2, d.power, 0xb48cff, UP, 0.2, 0.9);
        adv.schedule(d.power, () => {
          const c = h.player.position.clone();
          fx.adv.vfx.thicket(c, d.radius, 0xb48cff);
          for (const t of adv.enemiesNear(c.clone().setY(c.y + 1), d.radius, team)) fx.status.apply(t.id, 'jam', d.duration);
        });
        return true;

      // ── ECHO
      case 'pickmeup': {
        if ((h.lastKillAge?.() ?? Infinity) > 6) {
          this.lastFail = '6초 안에 쓰러뜨린 적이 없음';
          return false;
        }
        const me = h.self?.();
        if (me) fx.status.addOverheal(me, d.power, 10);
        fx.status.apply(owner.id, 'haste', d.duration);
        fx.adv.vfx.witherBurst(feet, 1.2, 0xff7ad1);
        return true;
      }
      case 'meddle':
        // 바닥에 닿으면 0.75초 뒤 터져 범위 안 모두(나 포함)를 쇠약
        fx.throwProjectile(from, throwDir, d.throwSpeed * speedK, 0xff7ad1, (p) =>
          adv.schedule(0.75, () => {
            fx.adv.vfx.witherBurst(p, d.radius, 0xff7ad1);
            for (const t of adv.targetsNear(p.clone().setY(p.y + 1), d.radius, true, () => true)) fx.status.decay(t, d.power, d.duration);
          }),
        );
        return true;
      case 'notdeadyet':
        return h.revive?.(d.power, d.duration) ?? false;
    }
  }
}
