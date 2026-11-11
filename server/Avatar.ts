import * as THREE from 'three';
import { AbilitySystem } from '../src/abilities/AbilitySystem';
import type { AbilityEffects } from '../src/abilities/AbilityEffects';
import type { DronePilot } from '../src/abilities/AdvancedEffects';
import type { Damageable, DamageEvent, Shooter } from '../src/combat/CombatSystem';
import type { Capsule } from '../src/combat/Hitbox';
import { PLAYER_SHAPE } from '../src/core/config';
import type { CollisionWorld } from '../src/physics/CollisionWorld';
import { PlayerController } from '../src/player/PlayerController';
import type { Side, TeamId } from '../src/rounds/RoundManager';
import type { PlayerState, V3 } from '../src/net/protocol';

/** 지연 보정용 위치 기록 (1초) */
interface Sample {
  t: number;
  p: V3;
  crouch: number;
}

/**
 * 서버 쪽 플레이어 몸: 위치(클라이언트가 보낸 상태를 검사해 반영), 체력, 피격 판정, 능력 시스템.
 * 사격 판정 때는 rewind(t)로 그 시각의 위치로 되감는다.
 */
export class Avatar implements Damageable {
  team: Side = 'attack';
  alive = true;
  vitals = { health: 100, armor: 0 };
  invulnerable = false;
  s: PlayerState = {
    p: [0, 0, 0], yaw: 0, pitch: 0, crouch: 0, v: [0, 0], grounded: true, weapon: 'tack', reload: -1, act: 0, moving: false,
  };
  /** 장비 (서버가 정함) */
  primary: string | null = null;
  secondary = 'tack';
  /** 이번 라운드 구매 기록 (환불) */
  purchases: { item: string; paid: number; prevWeapon?: string | null; prevArmor?: number }[] = [];
  /** 투척 단검 남은 수 */
  storm = 0;
  /** 이번 라운드에 죽었는지 (다음 라운드 장비) */
  died = false;
  lastFire = new Map<string, number>();
  lastKillAt = -1e9;
  /** 되살아난 뒤 처치해야 하는 시간 */
  reprise = 0;
  reviveIn = 0;
  invulnFor = 0;
  /** REKINDLE 표식 */
  rib: { p: V3; yaw: number; armor: number; t: number } | null = null;
  readonly ctrl: PlayerController;
  readonly cam = new THREE.PerspectiveCamera();
  readonly abilities: AbilitySystem;
  private history: Sample[] = [];
  private rewound: Sample | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    public teamId: TeamId,
    public agent: string,
    world: CollisionWorld,
    fx: AbilityEffects,
    hooks: {
      revive(a: Avatar, hp: number, dur: number): boolean;
      runItBack(a: Avatar, dur: number): boolean;
      onKilled(a: Avatar, e: DamageEvent): void;
      onDeathAvoided(a: Avatar): void;
    },
  ) {
    this.hooks = hooks;
    this.ctrl = new PlayerController(world);
    const self = this;
    const pilot: DronePilot = {
      yaw: () => self.s.yaw,
      pitch: () => self.s.pitch,
      move: () => ({ f: 0, s: 0, jump: false }),
      onEnd: () => {},
      pos: () => (self.s.drone ? new THREE.Vector3(...self.s.drone) : null),
    };
    this.abilities = new AbilitySystem({
      effects: fx,
      player: this.ctrl,
      camera: this.cam,
      shooter: () => this.shooter,
      team: () => this.team,
      moveDir: () => new THREE.Vector3(this.s.v[0], 0, this.s.v[1]),
      self: () => this,
      alive: () => this.alive,
      lastKillAge: () => (performance.now() - this.lastKillAt) / 1000,
      equipBladeStorm: (n) => {
        this.storm = n;
      },
      revive: (hp, dur) => hooks.revive(this, hp, dur),
      runItBack: (dur) => hooks.runItBack(this, dur),
      pilotDrone: () => pilot,
    });
    this.abilities.setAgent(agent);
  }

  private hooks: { onKilled(a: Avatar, e: DamageEvent): void; onDeathAvoided(a: Avatar): void };

  get shooter(): Shooter {
    return { id: this.id, name: this.name, team: this.team };
  }

  get pos(): THREE.Vector3 {
    const p = this.rewound?.p ?? this.s.p;
    return new THREE.Vector3(p[0], p[1], p[2]);
  }

  private get crouch(): number {
    return this.rewound?.crouch ?? this.s.crouch;
  }

  get eyeHeight(): number {
    return THREE.MathUtils.lerp(PLAYER_SHAPE.standEye, PLAYER_SHAPE.crouchEye, this.crouch);
  }

  /** 클라이언트 상태 반영 + 기록 */
  setState(s: PlayerState, now: number): void {
    this.s = s;
    this.ctrl.position.set(s.p[0], s.p[1], s.p[2]);
    this.ctrl.yaw = s.yaw;
    this.ctrl.pitch = s.pitch;
    this.history.push({ t: now, p: [...s.p], crouch: s.crouch });
    while (this.history.length && this.history[0].t < now - 1) this.history.shift();
  }

  /** 순간이동 (스폰·되돌아오기): 기록도 새로 */
  place(p: V3, yaw: number): void {
    this.s = { ...this.s, p: [...p], yaw, pitch: 0, v: [0, 0], act: 0, moving: false, drone: undefined };
    this.ctrl.position.set(p[0], p[1], p[2]);
    this.history = [];
  }

  /** 사격 판정용: t 시각 위치로 되감기 (null이면 현재) */
  rewind(t: number | null): void {
    if (t === null || !this.history.length) {
      this.rewound = null;
      return;
    }
    let best = this.history[this.history.length - 1];
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].t <= t) {
        const a = this.history[i];
        const b = this.history[i + 1];
        if (!b) best = a;
        else {
          const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
          best = { t, p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k], crouch: a.crouch + (b.crouch - a.crouch) * k };
        }
        break;
      }
      best = this.history[i];
    }
    this.rewound = best;
  }

  /** 능력 시선 카메라를 클라이언트가 보낸 눈·조준으로 */
  aim(eye: V3, aim: V3): void {
    this.cam.position.set(eye[0], eye[1], eye[2]);
    this.cam.lookAt(eye[0] + aim[0], eye[1] + aim[1], eye[2] + aim[2]);
    this.cam.updateMatrixWorld(true);
  }

  // ── Damageable / 섬광 판정
  center(out: THREE.Vector3): THREE.Vector3 {
    const p = this.pos;
    const h = THREE.MathUtils.lerp(PLAYER_SHAPE.standHeight, PLAYER_SHAPE.crouchHeight, this.crouch);
    return out.set(p.x, p.y + h * 0.55, p.z);
  }

  /** 로컬 플레이어(LocalPlayer)와 같은 캡슐 */
  hitboxes(): Capsule[] {
    const p = this.pos;
    const eye = p.y + this.eyeHeight;
    const v = (y: number) => new THREE.Vector3(p.x, y, p.z);
    const hip = p.y + (this.crouch > 0.5 ? 0.55 : 0.85);
    return [
      { part: 'head', a: v(eye + 0.03), b: v(eye + 0.03), radius: 0.13 },
      { part: 'body', a: v(hip), b: v(eye - 0.28), radius: 0.24 },
      { part: 'leg', a: v(p.y + 0.12), b: v(hip), radius: 0.16 },
    ];
  }

  facing(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyEuler(new THREE.Euler(this.s.pitch, this.s.yaw, 0, 'YXZ'));
  }

  eyePos(out: THREE.Vector3): THREE.Vector3 {
    const p = this.pos;
    return out.set(p.x, p.y + this.eyeHeight, p.z);
  }

  onKilled(e: DamageEvent): void {
    this.hooks.onKilled(this, e);
  }

  /** REKINDLE: 쓰러질 피해면 표식으로 돌아간다 */
  cheatDeath(): boolean {
    if (!this.rib) return false;
    this.hooks.onDeathAvoided(this);
    return true;
  }
}
