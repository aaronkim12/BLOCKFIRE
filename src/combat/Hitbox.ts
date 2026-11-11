import * as THREE from 'three';
import type { HitPart } from './ballistics';

/**
 * 피격 판정 도형. 캐릭터 뼈 위치에서 매 사격마다 만들기 때문에
 * 애니메이션 자세(앉기, 달리기, 쓰러짐)가 그대로 반영된다.
 */
export interface Capsule {
  part: HitPart;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

const _ab = new THREE.Vector3();
const _ao = new THREE.Vector3();

/**
 * 레이와 캡슐(선분 + 반지름)의 교차 거리. 없으면 null.
 * 선분을 따라 촘촘히 구를 놓는 대신, 레이와 선분의 최근접점을 구해 판정한다.
 */
export function rayCapsule(origin: THREE.Vector3, dir: THREE.Vector3, c: Capsule): number | null {
  // 레이 o + t·d 와 선분 a + s·(b-a) 의 최근접점
  _ab.subVectors(c.b, c.a);
  _ao.subVectors(origin, c.a);
  const abab = _ab.dot(_ab);
  const abd = _ab.dot(dir);
  const abao = _ab.dot(_ao);
  const dao = dir.dot(_ao);
  const denom = abab - abd * abd;
  let s = denom > 1e-8 ? (abao - abd * dao) / denom : 0;
  s = Math.max(0, Math.min(1, s));
  // 선분 위의 점에서 가장 가까운 구와의 교차로 판정
  const center = new THREE.Vector3().copy(c.a).addScaledVector(_ab, s);
  return raySphere(origin, dir, center, c.radius);
}

export function raySphere(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, r: number): number | null {
  const ocx = origin.x - center.x;
  const ocy = origin.y - center.y;
  const ocz = origin.z - center.z;
  const b = ocx * dir.x + ocy * dir.y + ocz * dir.z;
  const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 >= 0) return t0;
  const t1 = -b + sq;
  return t1 >= 0 ? 0 : null; // 시작점이 안에 있으면 0
}

export interface RayHitResult {
  distance: number;
  part: HitPart;
}

/** 여러 캡슐 중 가장 가까운 교차 (머리가 겹치면 머리 우선) */
export function rayHitboxes(origin: THREE.Vector3, dir: THREE.Vector3, boxes: Capsule[], maxDist: number): RayHitResult | null {
  let best: RayHitResult | null = null;
  for (const c of boxes) {
    const t = rayCapsule(origin, dir, c);
    if (t === null || t > maxDist) continue;
    if (!best || t < best.distance - 1e-3 || (Math.abs(t - best.distance) <= 1e-3 && c.part === 'head')) {
      best = { distance: t, part: c.part };
    }
  }
  return best;
}
