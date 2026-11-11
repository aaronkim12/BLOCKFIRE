import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';

/**
 * 관전용 3인칭 궤도 카메라.
 * 대상 주위를 마우스(플레이어 yaw·pitch)로 돌려 보고, 뒤에 벽이 있으면 그만큼 가까이 붙는다.
 */
export function orbitCamera(
  camera: THREE.PerspectiveCamera,
  world: CollisionWorld,
  target: THREE.Vector3,
  yaw: number,
  pitch: number,
  dist: number,
): void {
  const back = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  let d = dist;
  const hit = world.raycast(target.x, target.y, target.z, back.x, back.y, back.z, dist + 0.3);
  if (hit) d = Math.max(0.5, hit.distance - 0.3);
  camera.position.copy(target).addScaledVector(back, d);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

/** 관전 시작 시 시점 각도 (대상 뒤에서 약간 내려다봄) */
export const SPECTATE_PITCH = -0.3;
/** 아군과의 거리 / Core와의 거리 (m) */
export const SPECTATE_DIST = 3.2;
export const CORE_VIEW_DIST = 4.5;
