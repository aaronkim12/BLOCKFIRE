import * as THREE from 'three';
import { MOVEMENT, PHYSICS, PLAYER_SHAPE } from '../core/config';
import type { Input } from '../core/Input';
import type { AABB, CollisionWorld } from '../physics/CollisionWorld';

export interface MoveIntent {
  forward: number; // -1..1
  strafe: number; // -1..1 (오른쪽이 +)
  jump: boolean;
  walk: boolean;
  crouch: boolean;
}

/**
 * 1인칭 플레이어의 이동과 충돌을 담당한다.
 * position은 발 바닥 중심 좌표다. 물리는 고정 틱으로 진행하고,
 * 렌더링은 이전/현재 틱 사이를 보간한다.
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly prevPosition = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  crouching = false;
  walking = false;
  /** 렌더링용으로 부드럽게 보간된 눈 높이 */
  eyeHeight: number = PLAYER_SHAPE.standEye;
  private jumpCooldown = 0;
  private jumpHeld = false;

  /** 이동 속도 배율 (능력 버프 등) */
  speedMul = 1;
  /** 패시브 활강: 공중에서 점프를 누르고 있으면 천천히 내려온다 */
  glide = false;
  /** 지금 활강 중 (화면 효과용) */
  gliding = false;
  private dashTime = 0;
  private dashDuration = 1;
  private dashVel = new THREE.Vector3();

  /** 돌진 진행 중 1 → 0 (화면 효과용) */
  get dashAmount(): number {
    return this.dashTime > 0 ? this.dashTime / this.dashDuration : 0;
  }

  constructor(readonly world: CollisionWorld) {}

  /** 돌진: time초 동안 지정 방향으로 speed(m/s) 고정 이동. 끝나면 달리기 속도로 감속 */
  dash(dx: number, dz: number, speed: number, time: number): void {
    const l = Math.hypot(dx, dz) || 1;
    this.dashVel.set((dx / l) * speed, 0, (dz / l) * speed);
    this.dashTime = time;
    this.dashDuration = Math.max(1e-3, time);
  }

  get height(): number {
    return this.crouching ? PLAYER_SHAPE.crouchHeight : PLAYER_SHAPE.standHeight;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  spawn(x: number, y: number, z: number, yaw = 0): void {
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.crouching = false;
    this.eyeHeight = PLAYER_SHAPE.standEye;
  }

  /**
   * 마우스 시점. 렌더 프레임마다 호출 (입력 지연 최소화)
   * @param zoom 조준 배율 — 확대 중에는 감도를 같은 비율로 낮춘다
   * @returns 이번 프레임의 마우스 이동량 (뷰모델 흔들림에 사용)
   */
  applyLook(input: Input, sensitivity: number, invertY: boolean, zoom = 1): { dx: number; dy: number } {
    const delta = input.consumeMouseDelta();
    const dx = delta.dx / zoom;
    const dy = delta.dy / zoom;
    const k = 0.0022 * sensitivity;
    this.yaw -= dx * k;
    // -π..π 로 유지 (값이 끝없이 커지지 않게)
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.pitch -= dy * k * (invertY ? -1 : 1);
    const lim = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    return { dx, dy };
  }

  readIntent(input: Input): MoveIntent {
    return {
      forward: (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0),
      strafe: (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0),
      // 아주 짧게 톡 친 점프도 놓치지 않도록 이번 프레임에 눌린 적이 있으면 인정
      jump: input.isDown('jump') || input.wasPressed('jump'),
      walk: input.isDown('walk'),
      crouch: input.isDown('crouch'),
    };
  }

  /** 고정 틱 물리 업데이트 */
  tick(intent: MoveIntent, dt: number): void {
    this.prevPosition.copy(this.position);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this.updateCrouch(intent.crouch);
    this.walking = intent.walk && !this.crouching;

    // 바라보는 방향 기준 이동 방향 (수평)
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * intent.forward + cos * intent.strafe;
    let wz = -cos * intent.forward - sin * intent.strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx /= len;
      wz /= len;
    }

    const maxSpeed = (this.crouching
      ? MOVEMENT.crouchSpeed
      : this.walking
        ? MOVEMENT.walkSpeed
        : MOVEMENT.runSpeed) * this.speedMul;

    if (this.dashTime > 0) {
      this.dashTime -= dt;
      this.velocity.x = this.dashVel.x;
      this.velocity.z = this.dashVel.z;
      if (this.dashTime <= 0) {
        // 돌진이 끝나면 최고 이동 속도로 줄인다
        const sp = this.horizontalSpeed;
        if (sp > maxSpeed) {
          this.velocity.x *= maxSpeed / sp;
          this.velocity.z *= maxSpeed / sp;
        }
      }
    } else if (this.grounded) {
      this.applyFriction(dt, len === 0);
      if (len > 0) this.accelerate(wx, wz, maxSpeed, MOVEMENT.groundAccel, dt);
      // 점프는 키를 새로 누를 때만 (버니합 자동 연타 방지)
      if (intent.jump && !this.jumpHeld && this.jumpCooldown === 0 && !this.crouching) {
        this.velocity.y = MOVEMENT.jumpVelocity;
        this.grounded = false;
      }
    } else if (len > 0) {
      this.accelerate(wx, wz, Math.min(maxSpeed, MOVEMENT.airMaxSpeed), MOVEMENT.airAccel, dt);
    }
    this.jumpHeld = intent.jump;

    this.velocity.y -= PHYSICS.gravity * dt;
    // 활강: 떨어지는 속도를 2.2m/s로 제한
    this.gliding = this.glide && !this.grounded && intent.jump && this.velocity.y < -2.2;
    if (this.gliding) this.velocity.y = -2.2;

    const wasGrounded = this.grounded;
    this.moveHorizontal(this.velocity.x * dt, this.velocity.z * dt);
    this.moveVertical(this.velocity.y * dt);

    // 계단을 내려갈 때 공중에 뜨지 않도록 바닥에 붙인다
    if (wasGrounded && !this.grounded && this.velocity.y <= 0) this.snapToGround();
    if (!wasGrounded && this.grounded) this.jumpCooldown = MOVEMENT.jumpCooldown;

    // 렌더링용 눈 높이
    const targetEye = this.crouching ? PLAYER_SHAPE.crouchEye : PLAYER_SHAPE.standEye;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, PLAYER_SHAPE.crouchLerp * dt);
  }

  private box(pos = this.position, height = this.height): AABB {
    const r = PLAYER_SHAPE.radius;
    return {
      minX: pos.x - r, maxX: pos.x + r,
      minY: pos.y, maxY: pos.y + height,
      minZ: pos.z - r, maxZ: pos.z + r,
    };
  }

  private setFromBox(b: AABB): void {
    this.position.set((b.minX + b.maxX) / 2, b.minY, (b.minZ + b.maxZ) / 2);
  }

  private updateCrouch(wantCrouch: boolean): void {
    if (wantCrouch) {
      this.crouching = true;
    } else if (this.crouching) {
      // 머리 위에 공간이 있을 때만 일어선다
      const standBox = this.box(this.position, PLAYER_SHAPE.standHeight);
      if (!this.world.overlapsAny(standBox)) this.crouching = false;
    }
  }

  private applyFriction(dt: number, noInput: boolean): void {
    const speed = this.horizontalSpeed;
    if (speed < 1e-4) return;
    if (noInput && speed < MOVEMENT.stopSpeed) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const drop = Math.max(speed, MOVEMENT.stopSpeed) * MOVEMENT.groundFriction * dt;
    const k = Math.max(0, speed - drop) / speed;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  private accelerate(wx: number, wz: number, maxSpeed: number, accel: number, dt: number): void {
    const current = this.velocity.x * wx + this.velocity.z * wz;
    const add = maxSpeed - current;
    if (add <= 0) return;
    const a = Math.min(accel * maxSpeed * dt, add);
    this.velocity.x += wx * a;
    this.velocity.z += wz * a;
  }

  private moveHorizontal(dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return;
    const start = this.box();

    const flat = { ...start };
    const rx = this.world.moveAxis(flat, 0, dx);
    const rz = this.world.moveAxis(flat, 2, dz);
    let result = flat;
    let hitX = rx.blocked;
    let hitZ = rz.blocked;

    // 막혔으면 계단 오르기 시도: 올라가서 이동한 뒤 다시 내려온다
    if ((hitX || hitZ) && this.grounded) {
      const step = { ...start };
      const up = this.world.moveAxis(step, 1, MOVEMENT.stepHeight);
      const sx = this.world.moveAxis(step, 0, dx);
      const sz = this.world.moveAxis(step, 2, dz);
      const down = this.world.moveAxis(step, 1, -up.moved);
      const flatDist = horizDist2(start, flat);
      const stepDist = horizDist2(start, step);
      if (down.blocked && stepDist > flatDist + 1e-6) {
        result = step;
        hitX = sx.blocked;
        hitZ = sz.blocked;
      }
    }

    this.setFromBox(result);
    if (hitX) this.velocity.x = 0;
    if (hitZ) this.velocity.z = 0;
  }

  private moveVertical(dy: number): void {
    const b = this.box();
    const r = this.world.moveAxis(b, 1, dy);
    this.setFromBox(b);
    if (r.blocked) {
      if (dy < 0) this.grounded = true;
      this.velocity.y = 0;
    } else {
      this.grounded = false;
    }
  }

  private snapToGround(): void {
    const b = this.box();
    const probe = { ...b };
    const r = this.world.moveAxis(probe, 1, -MOVEMENT.stepHeight);
    if (r.blocked) {
      this.setFromBox(probe);
      this.grounded = true;
      this.velocity.y = 0;
    }
  }
}

function horizDist2(a: AABB, b: AABB): number {
  const dx = b.minX - a.minX;
  const dz = b.minZ - a.minZ;
  return dx * dx + dz * dz;
}
