// 게임 전역 튜닝 값. 밸런스 조정은 이 파일에서 한다.

export const PHYSICS = {
  /** 고정 물리 틱 (Hz). 렌더 프레임과 분리되어 있다. */
  tickRate: 128,
  gravity: 20,
  /** 한 프레임에서 처리할 최대 물리 스텝 (스파이크 시 죽음의 나선 방지) */
  maxStepsPerFrame: 16,
};

export const MOVEMENT = {
  runSpeed: 5.4,
  walkSpeed: 3.0,
  crouchSpeed: 2.2,
  groundAccel: 70,
  groundFriction: 9,
  /** 이 속도 이하로 떨어지면 즉시 정지 (전술 FPS 특유의 빠른 정지감) */
  stopSpeed: 1.2,
  airAccel: 12,
  airMaxSpeed: 5.4,
  /** 최고점 약 1.16m — 1.1m 상자에 올라설 수 있는 높이 */
  jumpVelocity: 6.8,
  /** 이 높이 이하의 턱은 자동으로 올라간다 (계단) */
  stepHeight: 0.45,
  /** 착지 직후 점프 연타 방지 쿨다운 (초) */
  jumpCooldown: 0.12,
};

export const PLAYER_SHAPE = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.2,
  standEye: 1.62,
  crouchEye: 1.05,
  /** 앉기/일어서기 시 카메라 높이 보간 속도 */
  crouchLerp: 14,
};

export const CAMERA = {
  near: 0.05,
  far: 400,
};
