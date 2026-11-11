import * as THREE from 'three';

/**
 * 스켈레톤 포즈 유틸리티.
 * 뼈의 국소 축 방향은 에셋마다 다르므로, 모든 연산을 "월드 공간 방향"으로 한다.
 * 덕분에 다른 캐릭터 에셋으로 바꿔도 포즈 코드가 그대로 동작한다.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** 뼈의 월드 회전을 바꾼 뒤 국소 회전으로 되돌려 적용 */
export function setWorldQuaternion(bone: THREE.Object3D, world: THREE.Quaternion): void {
  const parent = bone.parent;
  if (parent) {
    parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq.multiply(world));
  } else {
    bone.quaternion.copy(world);
  }
  bone.updateMatrixWorld(true);
}

/** bone → child 방향이 dir(월드, 정규화)을 향하도록 bone을 최소 회전 */
export function aimBone(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  const bp = bone.getWorldPosition(_a);
  const cp = child.getWorldPosition(_b);
  const cur = cp.sub(bp);
  if (cur.lengthSq() < 1e-10) return;
  cur.normalize();
  _q.setFromUnitVectors(cur, dir);
  bone.getWorldQuaternion(_wq).premultiply(_q);
  setWorldQuaternion(bone, _wq);
}

/** 월드 축 기준으로 뼈를 회전 */
export function rotateBoneWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (angle === 0) return;
  _q.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_wq).premultiply(_q);
  setWorldQuaternion(bone, _wq);
}

/**
 * 2-본 IK (위팔-아래팔-손 / 허벅지-정강이-발).
 * pole은 팔꿈치(무릎)가 향할 방향(월드, 정규화 불필요).
 */
export function solveTwoBone(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  lenA: number,
  lenB: number,
): void {
  const up = upper.getWorldPosition(new THREE.Vector3());
  const d = _c.copy(target).sub(up);
  const dist = THREE.MathUtils.clamp(d.length(), Math.abs(lenA - lenB) + 1e-4, lenA + lenB - 1e-4);
  const dn = d.normalize();
  // 코사인 법칙으로 팔꿈치 위치 계산
  const x = (lenA * lenA - lenB * lenB + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, lenA * lenA - x * x));
  const poleDir = pole.clone().sub(dn.clone().multiplyScalar(pole.dot(dn)));
  if (poleDir.lengthSq() < 1e-8) poleDir.set(0, -1, 0);
  poleDir.normalize();
  const elbow = up.clone().addScaledVector(dn, x).addScaledVector(poleDir, h);
  const reach = up.clone().addScaledVector(dn, dist);

  aimBone(upper, lower, elbow.clone().sub(up).normalize());
  const ep = lower.getWorldPosition(new THREE.Vector3());
  aimBone(lower, end, reach.sub(ep).normalize());
}

export function boneLength(a: THREE.Object3D, b: THREE.Object3D): number {
  return a.getWorldPosition(new THREE.Vector3()).distanceTo(b.getWorldPosition(new THREE.Vector3()));
}
