/**
 * 공간 오디오 (게임 엔진과 무관한 순수 Web Audio).
 *   3D 위치 · 거리 감쇠 · 방향성 · 패닝(HRTF) · 도플러 · 가림(occlusion) · 환경 리버브 센드
 *
 * 도플러: Web Audio PannerNode에서 도플러가 제거되었으므로
 *   음원/청취자 속도의 시선 방향 성분으로 재생 속도를 직접 바꾼다.
 * 가림: 게임이 0..1 값을 주면 저역 통과 + 감쇠로 벽 너머 소리를 만든다.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const SPEED_OF_SOUND = 343;

export class Listener {
  pos: Vec3 = { x: 0, y: 0, z: 0 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private ctx: AudioContext) {}

  set(pos: Vec3, forward: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }, vel?: Vec3): void {
    this.pos = { ...pos };
    if (vel) this.vel = { ...vel };
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.01);
      l.positionY.setTargetAtTime(pos.y, t, 0.01);
      l.positionZ.setTargetAtTime(pos.z, t, 0.01);
      l.forwardX.setTargetAtTime(forward.x, t, 0.01);
      l.forwardY.setTargetAtTime(forward.y, t, 0.01);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }
}

export interface SpatialOptions {
  position: Vec3;
  /** 음원 속도 (도플러) */
  velocity?: Vec3;
  /** 0 = 그대로, 1 = 완전히 벽 너머 */
  occlusion?: number;
  /** 소리가 크게 들리는 기준 거리 (m) */
  refDistance?: number;
  maxDistance?: number;
  /** 방향성 원뿔 (음원이 바라보는 방향, 예: 확성기) */
  direction?: Vec3;
}

/** 한 음성의 공간 처리 체인: 입력 → 가림 필터 → 패너 → 출력 (+ 리버브 센드) */
export class SpatialChain {
  readonly input: GainNode;
  private occl: BiquadFilterNode;
  private panner: PannerNode;
  readonly send: GainNode;

  constructor(ctx: AudioContext, out: AudioNode, sendTo: (n: AudioNode) => void, o: SpatialOptions, sendLevel: number) {
    this.input = ctx.createGain();
    this.occl = ctx.createBiquadFilter();
    this.occl.type = 'lowpass';
    this.panner = ctx.createPanner();
    const p = this.panner;
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = o.refDistance ?? 3;
    p.maxDistance = o.maxDistance ?? 150;
    p.rolloffFactor = 1.1;
    if (o.direction) {
      p.coneInnerAngle = 90;
      p.coneOuterAngle = 220;
      p.coneOuterGain = 0.35;
      p.orientationX.value = o.direction.x;
      p.orientationY.value = o.direction.y;
      p.orientationZ.value = o.direction.z;
    }
    p.positionX.value = o.position.x;
    p.positionY.value = o.position.y;
    p.positionZ.value = o.position.z;
    const occ = Math.max(0, Math.min(1, o.occlusion ?? 0));
    this.occl.frequency.value = 20000 * Math.pow(800 / 20000, occ);
    this.input.gain.value = 1 - 0.45 * occ;
    this.input.connect(this.occl).connect(p).connect(out);
    // 리버브 센드: 가려진 소리일수록 잔향 비중이 커진다 (직접음은 막혀도 반사음은 들림)
    this.send = ctx.createGain();
    this.send.gain.value = sendLevel * (1 + occ);
    this.occl.connect(this.send);
    sendTo(this.send);
  }

  disconnect(): void {
    this.input.disconnect();
    this.occl.disconnect();
    this.panner.disconnect();
    this.send.disconnect();
  }
}

/** 도플러 재생 속도 배율 */
export function dopplerRate(listener: Listener, pos: Vec3, vel: Vec3 | undefined): number {
  if (!vel) return 1;
  const dx = pos.x - listener.pos.x;
  const dy = pos.y - listener.pos.y;
  const dz = pos.z - listener.pos.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  // 청취자 → 음원 방향 단위 벡터에 대한 시선 속도 (다가오면 음수)
  const vs = (vel.x * dx + vel.y * dy + vel.z * dz) / d;
  const vl = (listener.vel.x * dx + listener.vel.y * dy + listener.vel.z * dz) / d;
  const rate = (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND + vs);
  return Math.max(0.5, Math.min(2, rate));
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
