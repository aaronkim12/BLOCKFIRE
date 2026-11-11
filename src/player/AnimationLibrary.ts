import * as THREE from 'three';
import { loadFBX } from '../core/Assets';

/**
 * Mixamo 애니메이션 클립 로더.
 *
 * - 루트 모션 제거: Mixamo 이동 클립은 엉덩이(Hips)가 실제로 앞으로 나아간다.
 *   게임에서는 물리가 캐릭터를 움직이므로 수평 이동을 지우고(제자리 애니메이션),
 *   원래 이동 속도는 speed로 기록해 재생 속도를 실제 이동 속도에 맞추는 데 쓴다.
 * - 상체/하체 분리: 하체(엉덩이+다리)는 이동, 상체(허리 위)는 조준/사격/재장전을
 *   서로 다른 클립으로 동시에 재생할 수 있도록 트랙을 나눈 클립을 만든다.
 */

export type ClipName =
  | 'idle'
  | 'walk'
  | 'walkBack'
  | 'walkLeft'
  | 'walkRight'
  | 'run'
  | 'runBack'
  | 'runLeft'
  | 'runRight'
  | 'jump'
  | 'fire'
  | 'reload'
  | 'hit'
  | 'grenade'
  | 'turnLeft'
  | 'turnRight';

/** 클립 이름 → 파일 (public/assets/animations, Basic Shooter Pack) */
const FILES: Record<ClipName, string> = {
  idle: 'rifle_aiming_idle',
  walk: 'walking',
  walkBack: 'walking_backwards',
  walkLeft: 'strafe_left',
  walkRight: 'strafe_right',
  run: 'rifle_run',
  runBack: 'run_backwards',
  runLeft: 'strafe_2',
  runRight: 'strafe',
  jump: 'rifle_jump',
  fire: 'firing_rifle',
  reload: 'reloading',
  hit: 'hit_reaction',
  grenade: 'toss_grenade',
  turnLeft: 'turn_left',
  turnRight: 'turning_right_45_degrees',
};

export interface LoadedClip {
  name: ClipName;
  /** 하체 트랙만 (엉덩이 위치/회전 + 다리) */
  lower: THREE.AnimationClip;
  /** 상체 트랙만 (허리 위) */
  upper: THREE.AnimationClip;
  duration: number;
  /** 원래 클립의 수평 이동 속도 (m/s) — 제자리 클립으로 바꾸기 전 */
  speed: number;
}

const HIPS_POS = 'mixamorigHips.position';
const LOWER_BONES = /^mixamorig(Hips|LeftUpLeg|LeftLeg|LeftFoot|LeftToeBase|LeftToe_End|RightUpLeg|RightLeg|RightFoot|RightToeBase|RightToe_End)\./;

let library: Promise<Map<ClipName, LoadedClip>> | null = null;

export function loadAnimationLibrary(): Promise<Map<ClipName, LoadedClip>> {
  if (!library) library = build();
  return library;
}

async function build(): Promise<Map<ClipName, LoadedClip>> {
  const entries = await Promise.all(
    (Object.keys(FILES) as ClipName[]).map(async (name) => {
      const src = await loadFBX(`assets/animations/${FILES[name]}.fbx`);
      const clip = src.animations[0];
      if (!clip) throw new Error(`애니메이션이 없습니다: ${FILES[name]}`);
      return [name, process(name, clip)] as const;
    }),
  );
  return new Map(entries);
}

function process(name: ClipName, clip: THREE.AnimationClip): LoadedClip {
  const tracks = clip.tracks.map((t) => t.clone());
  let speed = 0;
  const hips = tracks.find((t) => t.name === HIPS_POS);
  if (hips) {
    const v = hips.values;
    const n = v.length / 3;
    // 수평 이동 거리 / 시간 (cm → m)
    const dx = v[(n - 1) * 3] - v[0];
    const dz = v[(n - 1) * 3 + 2] - v[2];
    speed = Math.hypot(dx, dz) / 100 / Math.max(1e-3, clip.duration);
    const x0 = v[0];
    const y0 = v[1];
    const z0 = v[2];
    for (let i = 0; i < n; i++) {
      v[i * 3] = x0;
      v[i * 3 + 2] = z0;
      // 점프는 물리가 실제로 몸을 띄우므로 엉덩이 높이 변화도 지운다 (다리 동작만 사용)
      if (name === 'jump') v[i * 3 + 1] = y0;
    }
  }
  const lower = new THREE.AnimationClip(`${name}:lower`, clip.duration, tracks.filter((t) => LOWER_BONES.test(t.name)));
  const upper = new THREE.AnimationClip(`${name}:upper`, clip.duration, tracks.filter((t) => !LOWER_BONES.test(t.name)));
  return { name, lower, upper, duration: clip.duration, speed };
}
