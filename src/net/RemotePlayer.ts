import * as THREE from 'three';
import { AbilitySystem } from '../abilities/AbilitySystem';
import type { DronePilot } from '../abilities/AdvancedEffects';
import type { Damageable } from '../combat/CombatSystem';
import type { Capsule } from '../combat/Hitbox';
import { createBotModel } from '../ai/Bot';
import type { Game } from '../core/Game';
import { DEFAULT_POSE, type CharacterModel, type CharacterPose, type Team } from '../player/CharacterModel';
import { PlayerController } from '../player/PlayerController';
import type { Side, TeamId } from '../rounds/RoundManager';
import { getWeapon } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';
import { INTERP_DELAY, type PlayerState, type V3 } from './protocol';

interface Sample {
  t: number;
  s: PlayerState;
}

/**
 * 다른 플레이어 (온라인). 서버 스냅샷을 INTERP_DELAY만큼 늦게 보간해서 그린다.
 * 내 화면의 예광탄이 몸에서 멈추도록 피격 캡슐을 가지고 있지만, 피해는 서버가 정한다.
 * 능력은 서버가 알려 준 사용을 그대로 재현한다 (화면 효과만).
 */
export class RemotePlayer implements Damageable {
  team: Side = 'attack';
  alive = true;
  vitals = { health: 100, armor: 0 };
  readonly ctrl: PlayerController;
  readonly eyeCam = new THREE.PerspectiveCamera();
  readonly abilities: AbilitySystem;
  private buffer: Sample[] = [];
  private cur: PlayerState | null = null;
  private pose: CharacterPose = { ...DEFAULT_POSE };
  private weaponId = '';
  private deadTime = -1;
  private loadingWeapon = '';

  private constructor(
    readonly id: string,
    readonly name: string,
    public teamId: TeamId,
    readonly agent: string,
    readonly model: CharacterModel,
    game: Game,
  ) {
    this.ctrl = new PlayerController(game.map.collision);
    const self = this;
    const pilot: DronePilot = {
      yaw: () => self.cur?.yaw ?? 0,
      pitch: () => self.cur?.pitch ?? 0,
      move: () => ({ f: 0, s: 0, jump: false }),
      onEnd: () => {},
      pos: () => (self.cur?.drone ? new THREE.Vector3(...self.cur.drone) : null),
    };
    this.abilities = new AbilitySystem({
      effects: game.abilityFx,
      player: this.ctrl,
      camera: this.eyeCam,
      shooter: () => ({ id: this.id, name: this.name, team: this.team }),
      team: () => this.team,
      moveDir: () => new THREE.Vector3(this.cur?.v[0] ?? 0, 0, this.cur?.v[1] ?? 0),
      self: () => this,
      alive: () => this.alive,
      lastKillAge: () => 0,
      pilotDrone: () => pilot,
    });
    this.abilities.setAgent(agent);
    this.abilities.infinite = true;
    game.scene.add(model.root);
  }

  static async create(game: Game, id: string, name: string, teamId: TeamId, agent: string, colorTeam: Team): Promise<RemotePlayer> {
    const m = await createBotModel(colorTeam);
    return new RemotePlayer(id, name, teamId, agent, m, game);
  }

  /** 스냅샷 하나 (t = 서버 시각) */
  push(t: number, s: PlayerState, alive: boolean, hp: number, armor: number): void {
    if (this.alive && !alive) this.deadTime = 0;
    if (!this.alive && alive) {
      this.deadTime = -1;
      this.buffer = [];
    }
    this.alive = alive;
    this.vitals.health = hp;
    this.vitals.armor = armor;
    this.buffer.push({ t, s });
    while (this.buffer.length > 30) this.buffer.shift();
  }

  /** 순간이동 (스폰): 보간 없이 */
  snapTo(s: PlayerState, t: number): void {
    this.buffer = [{ t, s }];
    this.dispYaw = null;
  }

  /** 화면에 보이는 몸 방향 */
  private dispYaw: number | null = null;

  update(dt: number, serverNow: number): void {
    const rt = serverNow - INTERP_DELAY;
    const b = this.buffer;
    let s: PlayerState | null = null;
    if (b.length) {
      let i = b.length - 1;
      while (i > 0 && b[i].t > rt) i--;
      const a = b[i];
      const n = b[i + 1];
      if (!n || a.t >= rt) s = a.s;
      else {
        const k = THREE.MathUtils.clamp((rt - a.t) / Math.max(1e-4, n.t - a.t), 0, 1);
        s = {
          ...n.s,
          p: [a.s.p[0] + (n.s.p[0] - a.s.p[0]) * k, a.s.p[1] + (n.s.p[1] - a.s.p[1]) * k, a.s.p[2] + (n.s.p[2] - a.s.p[2]) * k],
          yaw: lerpAngle(a.s.yaw, n.s.yaw, k),
          pitch: a.s.pitch + (n.s.pitch - a.s.pitch) * k,
          crouch: a.s.crouch + (n.s.crouch - a.s.crouch) * k,
        };
      }
    }
    if (s) this.cur = s;
    const c = this.cur;
    if (!c) return;
    this.ctrl.position.set(c.p[0], c.p[1], c.p[2]);
    this.ctrl.yaw = c.yaw;
    this.ctrl.pitch = c.pitch;
    this.model.root.position.set(c.p[0], c.p[1], c.p[2]);
    // 보이는 몸 방향은 초당 최대 30라디안까지만 돈다 (값이 튀어도 몸이 빙글 돌지 않게)
    if (this.dispYaw === null) this.dispYaw = c.yaw;
    else {
      let d = c.yaw - this.dispYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const max = 30 * dt;
      this.dispYaw += Math.max(-max, Math.min(max, d));
    }
    this.model.root.rotation.y = this.dispYaw;
    // 손에 든 무기
    if (c.weapon !== this.weaponId && c.weapon !== this.loadingWeapon) {
      this.loadingWeapon = c.weapon;
      const def = getWeapon(c.weapon);
      void loadWeaponTemplate(def).then((t) => {
        this.weaponId = c.weapon;
        this.loadingWeapon = '';
        this.model.setWeapon(def.category === 'core' ? null : t);
      });
    }
    // 이동 속도를 캐릭터 기준으로 (오른쪽/앞)
    const sin = Math.sin(this.dispYaw ?? c.yaw);
    const cos = Math.cos(this.dispYaw ?? c.yaw);
    const p = this.pose;
    p.moveX = cos * c.v[0] - sin * c.v[1];
    p.moveZ = -sin * c.v[0] - cos * c.v[1];
    p.grounded = c.grounded;
    p.crouch = c.crouch;
    p.aimPitch = c.pitch;
    p.reload = c.reload;
    p.fire = Math.max(0, p.fire - dt * 8);
    p.plant = c.act === 1 && !c.moving && c.weapon === 'core' ? 0.5 : -1;
    if (!this.alive) this.deadTime += dt;
    p.dead = this.alive ? -1 : this.deadTime;
    this.model.update(dt, p);
    this.abilities.update(dt);
  }

  /** 총을 쐈다 (예광탄 시작점 = 총구) */
  onShot(): THREE.Vector3 {
    this.pose.fire = 1;
    return this.model.muzzlePosition();
  }

  /** 능력 재현: 서버가 알려 준 시선으로 */
  replayCast(m: { slot: import('../abilities/abilityData').AbilitySlot; eye: V3; aim: V3; variant?: 0 | 1; points?: V3[]; held?: number }): void {
    this.eyeCam.position.set(...m.eye);
    this.eyeCam.lookAt(m.eye[0] + m.aim[0], m.eye[1] + m.aim[1], m.eye[2] + m.aim[2]);
    this.eyeCam.updateMatrixWorld(true);
    const ab = this.abilities;
    const d = ab.def(m.slot);
    if (m.points?.length && ab.isMapTargeted(m.slot)) ab.useAt(m.slot, m.points.map((p) => new THREE.Vector3(...p)));
    else if (d.effect === 'faultline' && m.held !== undefined && !ab.pendingActivation(m.slot)) {
      const len = ab.faultLength(d, m.held);
      const flat = new THREE.Vector3(m.aim[0], 0, m.aim[2]).normalize();
      ab.use(m.slot, undefined, this.ctrl.position.clone().addScaledVector(flat, Math.max(1, len - 2)));
    } else ab.use(m.slot, m.variant);
  }

  // ── Damageable (내 화면의 예광탄·능력 판정용)
  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.ctrl.position).setY(this.ctrl.position.y + 1);
  }

  hitboxes(): Capsule[] {
    return this.model.hitboxes();
  }

  eyePos(out: THREE.Vector3): THREE.Vector3 {
    const c = this.cur;
    return out.copy(this.ctrl.position).setY(this.ctrl.position.y + THREE.MathUtils.lerp(1.62, 1.05, c?.crouch ?? 0));
  }

  facing(out: THREE.Vector3): THREE.Vector3 {
    const c = this.cur;
    return out.set(0, 0, -1).applyEuler(new THREE.Euler(c?.pitch ?? 0, c?.yaw ?? 0, 0, 'YXZ'));
  }

  dispose(): void {
    this.model.root.removeFromParent();
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
