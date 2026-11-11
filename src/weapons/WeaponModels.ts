import * as THREE from 'three';
import { loadFBX } from '../core/Assets';
import { createPSXMaterial } from '../graphics/PSXMaterial';
import { createCoreDevice } from '../objective/CoreModel';
import type { WeaponDef } from './weaponData';

/**
 * Quaternius 총기 모델을 게임에서 쓰기 좋은 형태로 변환한다.
 *
 * 변환 후 무기 공간 규칙
 *   - 단위: m
 *   - 앞(총구 방향): -Z, 위: +Y  (Three.js 카메라와 같은 방향)
 *   - 원점: 오른손이 쥐는 손잡이 위치
 */

/** 재질 이름 → PSX 팔레트 (에셋 미리보기의 색감을 기준으로 함) */
const PALETTE: Record<string, number> = {
  Main: 0x7c7a70,
  MainDark: 0x5a5852,
  MainLight: 0xa4a092,
  Metal: 0x6e7074,
  DarkMetal: 0x4c4e52,
  LightMetal: 0xa0a2a4,
  Black: 0x343538,
  Black2: 0x28292c,
  Wood: 0xb4865e,
  DarkWood: 0x8a6244,
  Grey: 0x8c8c86,
  Green: 0x86966a,
  Glass: 0x5a7c92,
};

export interface WeaponTemplate {
  def: WeaponDef;
  /** 변환이 끝난 원본. instantiate()로 복제해서 쓴다 */
  object: THREE.Group;
  /** 총구 끝 (무기 공간) */
  muzzle: THREE.Vector3;
  /** 왼손 지지 위치 (무기 공간) */
  support: THREE.Vector3;
  /** 바운딩 박스 (무기 공간) */
  bounds: THREE.Box3;
}

export interface WeaponInstance {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  template: WeaponTemplate;
}

const templateCache = new Map<string, Promise<WeaponTemplate>>();

export function loadWeaponTemplate(def: WeaponDef): Promise<WeaponTemplate> {
  let p = templateCache.get(def.id);
  if (!p) {
    p = buildTemplate(def);
    templateCache.set(def.id, p);
  }
  return p;
}

/**
 * Core(목표물)는 FBX가 아니라 기본 도형 모델이다.
 * 무기 공간 원점 = 장치 중심, 키패드가 플레이어 쪽(+Z)을 향한다.
 */
function buildCoreTemplate(def: WeaponDef): WeaponTemplate {
  const dev = createCoreDevice();
  const s = 0.58;
  dev.group.scale.setScalar(s);
  dev.group.position.y = -0.23 * s;
  dev.group.rotation.y = Math.PI;
  const object = new THREE.Group();
  object.name = `weapon:${def.id}`;
  object.add(dev.group);
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  return {
    def,
    object,
    muzzle: new THREE.Vector3(0, bounds.max.y, 0),
    support: new THREE.Vector3(-0.2, 0, 0),
    bounds,
  };
}

/** 손에 아무것도 들지 않는 무기 (투척 단검: 단검은 따로 떠다님) */
function buildEmptyTemplate(def: WeaponDef): WeaponTemplate {
  const object = new THREE.Group();
  object.name = `weapon:${def.id}`;
  const bounds = new THREE.Box3(new THREE.Vector3(-0.02, -0.02, -0.15), new THREE.Vector3(0.02, 0.02, 0.15));
  return { def, object, muzzle: new THREE.Vector3(0, 0, -0.15), support: new THREE.Vector3(-0.1, 0, 0), bounds };
}

async function buildTemplate(def: WeaponDef): Promise<WeaponTemplate> {
  if (def.category === 'core') return buildCoreTemplate(def);
  if (def.id === 'storm') return buildEmptyTemplate(def);
  const src = await loadFBX(def.model);
  const model = src.clone(true);

  // 재질을 PSX 머티리얼로 교체 (같은 이름은 하나의 머티리얼을 공유)
  const mats = new Map<string, THREE.Material>();
  const psx = (m: THREE.Material) => {
    let out = mats.get(m.name);
    if (!out) {
      out = createPSXMaterial({ color: PALETTE[m.name] ?? 0x808080 });
      out.name = m.name;
      mats.set(m.name, out);
    }
    return out;
  };
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(psx) : psx(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
  });

  // 원본: 총구가 +X, 위가 +Y. → 총구가 -Z가 되도록 Y축 +90° 회전
  model.rotation.set(0, Math.PI / 2, 0);
  model.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(model);
  const size = raw.getSize(new THREE.Vector3());
  const scale = def.length / Math.max(1e-6, size.z);
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  // 손 위치 계산 → 오른손 손잡이를 원점으로 이동
  const box = new THREE.Box3().setFromObject(model);
  const grip = holdPoint(box, def.hold.grip);
  const support =
    def.hold.support !== undefined
      ? holdPoint(box, def.hold.support)
      : // 권총/칼: 왼손은 오른손 바로 아래에서 감싸 쥔다
        grip.clone().add(new THREE.Vector3(-0.015, -0.035, 0.005));
  model.position.sub(grip);
  support.sub(grip);
  const object = new THREE.Group();
  object.name = `weapon:${def.id}`;
  object.add(model);
  object.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(object);
  const muzzle = findMuzzle(object, bounds);
  return { def, object, muzzle, support, bounds };
}

/** 모든 정점을 무기 공간 좌표로 순회 */
function forEachVertex(root: THREE.Object3D, fn: (v: THREE.Vector3) => void): void {
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      fn(v);
    }
  });
}

/** 손 위치: 바운딩 박스 기준 비율 [앞뒤(뒤끝 0 → 총구 1), 높이(바닥 0 → 윗면 1)] */
function holdPoint(box: THREE.Box3, [fz, fy]: [number, number]): THREE.Vector3 {
  return new THREE.Vector3(
    0,
    box.min.y + (box.max.y - box.min.y) * fy,
    box.max.z - (box.max.z - box.min.z) * fz,
  );
}

function findMuzzle(root: THREE.Object3D, bounds: THREE.Box3): THREE.Vector3 {
  // 가장 앞쪽 정점들의 평균 높이
  const front = bounds.min.z;
  let n = 0;
  let y = 0;
  forEachVertex(root, (v) => {
    if (v.z < front + 0.015) {
      n++;
      y += v.y;
    }
  });
  return new THREE.Vector3(0, n ? y / n : 0, front);
}

export function instantiateWeapon(template: WeaponTemplate): WeaponInstance {
  const root = template.object.clone(true);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.copy(template.muzzle);
  root.add(muzzle);
  return { root, muzzle, template };
}
