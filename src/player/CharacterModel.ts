import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { loadFBX } from '../core/Assets';
import { createPSXMaterial } from '../graphics/PSXMaterial';
import { instantiateWeapon, type WeaponInstance, type WeaponTemplate } from '../weapons/WeaponModels';
import type { Capsule } from '../combat/Hitbox';
import { loadAnimationLibrary, type ClipName, type LoadedClip } from './AnimationLibrary';
import { aimBone, boneLength, rotateBoneWorld, setWorldQuaternion, solveTwoBone } from './boneMath';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { JOINTS, Ragdoll, type Joint } from './Ragdoll';

/** 래그돌 입자 → 뼈 */
const JOINT_BONE: Record<Joint, BoneKey> = {
  hips: 'hips', chest: 'chest', head: 'head', headTop: 'headTop',
  shL: 'upperArmL', elL: 'forearmL', haL: 'handL', shR: 'upperArmR', elR: 'forearmR', haR: 'handR',
  thL: 'thighL', knL: 'shinL', ftL: 'footL', thR: 'thighR', knR: 'shinR', ftR: 'footR',
};
/**
 * 래그돌이 방향을 정하는 뼈 (부모 먼저): [뼈, 시작 입자, 끝 입자, 비틀림 기준]
 * 비틀림 기준: 'side' = 어깨/엉덩이 좌우 방향, 'up' = 몸통 위 방향
 */
const RAG_BONES: [BoneKey, Joint, Joint, 'side' | 'hipSide' | 'up'][] = [
  ['hips', 'hips', 'chest', 'hipSide'],
  ['chest', 'chest', 'head', 'side'],
  ['neck', 'head', 'headTop', 'side'],
  ['upperArmL', 'shL', 'elL', 'up'], ['forearmL', 'elL', 'haL', 'up'],
  ['upperArmR', 'shR', 'elR', 'up'], ['forearmR', 'elR', 'haR', 'up'],
  ['thighL', 'thL', 'knL', 'hipSide'], ['shinL', 'knL', 'ftL', 'hipSide'],
  ['thighR', 'thR', 'knR', 'hipSide'], ['shinR', 'knR', 'ftR', 'hipSide'],
];

/**
 * 사람 캐릭터 모델 (Mixamo Y Bot).
 *
 * 3인칭: Mixamo 애니메이션(Basic Shooter Pack)을 AnimationMixer로 재생한다.
 *   - 하체: 이동 방향/속도에 따라 대기/걷기/달리기/뒤로/좌우 이동 클립을 섞음 (위상 동기화)
 *   - 상체: 조준 대기 / 사격 / 재장전 클립
 *   - 그 위에 절차적 보정: 조준 각도 허리 굽힘, 앉기, 무기 꺼내기, 왼손 IK, 사망
 *   - 무기는 오른손 뼈에 붙어 애니메이션을 따라 움직인다
 * 1인칭: 애니메이션 없이 팔을 IK로 무기에 맞춘다 (무기 위치는 ViewModel이 정함).
 *
 * 좌표 규칙: root의 원점은 발바닥, 앞은 -Z (플레이어 yaw와 같은 규칙).
 */

export type Team = 'attack' | 'defense';

export interface CharacterPose {
  /** 캐릭터 기준 이동 속도 (m/s). x = 오른쪽, z = 앞 */
  moveX: number;
  moveZ: number;
  grounded: boolean;
  /** 0 = 서기, 1 = 앉기 */
  crouch: number;
  /** 조준 상하 각도 (라디안, 위가 +) */
  aimPitch: number;
  /** 사격 반동 0..1 (사격 직후 1에서 감소) */
  fire: number;
  /** 재장전 진행도 0..1, 재장전 중이 아니면 -1 */
  reload: number;
  /** 무기 꺼내기 진행도 0..1 (1 = 준비 완료) */
  equip: number;
  /** 사망 후 경과 시간(초), 살아 있으면 -1 */
  dead: number;
  /** 피격 반응 진행도 0..1, 반응 중이 아니면 -1 */
  hit: number;
  /** Core 설치 진행도 0..1 (무릎 꿇고 바닥의 장치를 조작), 설치 중이 아니면 -1 */
  plant: number;
}

export const DEFAULT_POSE: CharacterPose = {
  moveX: 0, moveZ: 0, grounded: true, crouch: 0, aimPitch: 0, fire: 0, reload: -1, equip: 1, dead: -1, hit: -1, plant: -1,
};

/** 몸통 색 (관절 색은 공통) */
const BODY_COLOR: Record<Team | 'white', number> = {
  attack: 0xd8735c,
  defense: 0x4f86d0,
  white: 0xf0eee8,
};
const JOINT_COLOR = 0x33363c;

/** Mixamo 뼈대 이름 */
const RIG = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  chest: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  headTop: 'mixamorigHeadTop_End',
  upperArmL: 'mixamorigLeftArm',
  forearmL: 'mixamorigLeftForeArm',
  handL: 'mixamorigLeftHand',
  upperArmR: 'mixamorigRightArm',
  forearmR: 'mixamorigRightForeArm',
  handR: 'mixamorigRightHand',
  thighL: 'mixamorigLeftUpLeg',
  shinL: 'mixamorigLeftLeg',
  footL: 'mixamorigLeftFoot',
  toeL: 'mixamorigLeftToeBase',
  thighR: 'mixamorigRightUpLeg',
  shinR: 'mixamorigRightLeg',
  footR: 'mixamorigRightFoot',
  toeR: 'mixamorigRightToeBase',
} as const;
type BoneKey = keyof typeof RIG;
type Side = 'L' | 'R';
type Finger = 'Index' | 'Middle' | 'Ring' | 'Pinky' | 'Thumb';
const fingerBone = (side: Side, f: Finger, n: number) => `mixamorig${side === 'L' ? 'Left' : 'Right'}Hand${f}${n}`;

/** 하체 이동 클립: [이름, 방향(x 오른쪽, z 앞), 달리기 여부] */
const LOCOMOTION: [ClipName, number, number, boolean][] = [
  ['walk', 0, 1, false],
  ['walkBack', 0, -1, false],
  ['walkLeft', -1, 0, false],
  ['walkRight', 1, 0, false],
  ['run', 0, 1, true],
  ['runBack', 0, -1, true],
  ['runLeft', -1, 0, true],
  ['runRight', 1, 0, true],
];

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

/**
 * Y Bot 형상 최적화 (원본 1회 → 캐시)
 *   fp: 같은 위치·속성의 정점을 합쳐 인덱스 형상으로 (모양은 그대로, 정점 수 크게 감소)
 *   tp: 거기에 더해 정점의 약 80%를 줄인 단순화 형상 (PSX 해상도에서는 차이가 거의 안 보임)
 */
const geoCache = new Map<string, Promise<Map<THREE.BufferGeometry, THREE.BufferGeometry>>>();
function optimizedGeometries(src: THREE.Object3D, kind: 'fp' | 'tp'): Promise<Map<THREE.BufferGeometry, THREE.BufferGeometry>> {
  let p = geoCache.get(kind);
  if (!p) {
    p = (async () => {
      const out = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
      const meshes: THREE.Mesh[] = [];
      src.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
      for (const m of meshes) {
        let g = mergeVertices(m.geometry, 1e-4);
        if (kind === 'tp') g = await new SimplifyModifier().modify(g, Math.floor(g.attributes.position.count * 0.8));
        g.computeBoundingSphere();
        g.computeBoundingBox();
        out.set(m.geometry, g);
      }
      return out;
    })();
    geoCache.set(kind, p);
  }
  return p;
}

export class CharacterModel {
  /** 발바닥 원점, rotation.y = yaw */
  readonly root = new THREE.Group();
  /** 사망 시 넘어지는 회전 */
  private fall = new THREE.Group();
  /** 앞 방향 보정 + 발 접지 높이 보정 */
  private pivot = new THREE.Group();
  /** 1인칭: 무기 위치를 카메라 공간으로 지정하는 마운트 (root 자식) */
  readonly weaponMount = new THREE.Group();
  /** 3인칭: 오른손 뼈에 붙은 무기 마운트 */
  private handMount = new THREE.Group();
  /** 1인칭: 던지는 능력 물건을 쥐는 오른손 손바닥 위치 (calibrateItemMount 후 사용) */
  readonly itemMount = new THREE.Group();
  weapon: WeaponInstance | null = null;

  private bones = {} as Record<BoneKey, THREE.Bone>;
  private boneMap = new Map<string, THREE.Bone>();
  private handCalib!: Record<Side, { finger: THREE.Vector3; palm: THREE.Vector3 }>;
  private rest = new Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  private len = { upperArm: 0, forearm: 0, thigh: 0, shin: 0 };
  private footRestY = 0;
  private walkPhase = 0;
  private smoothMove = new THREE.Vector2();
  private materials: THREE.Material[] = [];
  private bodyMaterial: THREE.MeshLambertMaterial | null = null;

  // ── 애니메이션 (3인칭)
  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<ClipName, LoadedClip>();
  private lowerActions = new Map<ClipName, THREE.AnimationAction>();
  private upperActions = new Map<ClipName, THREE.AnimationAction>();
  private weights = new Map<THREE.AnimationAction, number>();
  private gaitPhase = 0;
  private airTime = 0;
  private leftIK = 1;

  /**
   * 화면 밖이거나 먼 캐릭터는 자세(애니메이션·IK)를 몇 프레임에 한 번만 계산한다 (Game이 매 프레임 지정).
   * low = 성능 모드 (더 드물게)
   */
  static lod: { frustum: THREE.Frustum; cam: THREE.Vector3; low: boolean } | null = null;
  private lodAcc = 0;
  private lodTick = 0;
  private static _sphere = new THREE.Sphere();

  /** 래그돌이 부딪힐 맵 충돌 (클라이언트에서 Game이 지정) */
  static ragdollWorld: CollisionWorld | null = null;
  private ragdoll: Ragdoll | null = null;
  /** 죽는 순간 (입자 기준 회전)⁻¹ × 뼈 월드 회전 */
  private ragOffset = new Map<BoneKey, THREE.Quaternion>();
  /** 마지막으로 맞은 방향 (래그돌이 그쪽으로 넘어짐) */
  private lastHit: { dir: THREE.Vector3; point: THREE.Vector3; at: number; head: boolean } | null = null;

  private constructor(
    body: THREE.Object3D,
    readonly firstPerson: boolean,
  ) {
    this.root.add(this.fall);
    this.fall.add(this.pivot);
    this.pivot.add(body);
    this.root.add(this.weaponMount);

    body.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      this.rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
      // FBXLoader는 메시마다 같은 이름의 보조 뼈를 실제 뼈의 자식으로 만든다.
      // 보조 뼈는 아래로 이어진 뼈가 없으므로, 포즈를 줄 때는 부모(실제 뼈)를 써야 한다.
      if (b.parent?.name === b.name) return;
      this.boneMap.set(b.name, b);
    });
    for (const k of Object.keys(RIG) as BoneKey[]) {
      const b = this.boneMap.get(RIG[k]);
      if (!b) throw new Error(`캐릭터 뼈를 찾을 수 없음: ${RIG[k]}`);
      this.bones[k] = b;
    }

    // 모델이 바라보는 방향을 발끝 위치로 판별해 -Z를 보도록 보정
    this.root.updateMatrixWorld(true);
    const foot = this.bones.footL.getWorldPosition(new THREE.Vector3());
    const toe = this.bones.toeL.getWorldPosition(new THREE.Vector3());
    if (toe.z > foot.z) this.pivot.rotation.y = Math.PI;
    this.root.updateMatrixWorld(true);

    this.measure();
    this.footRestY = this.bones.footL.getWorldPosition(new THREE.Vector3()).y;
    this.handCalib = { L: this.calibrateHand('L'), R: this.calibrateHand('R') };
    this.bones.handR.add(this.handMount);

    if (firstPerson) {
      // 1인칭 팔 모델: 목(머리 포함)과 다리는 뼈 크기를 0으로 만들어 숨긴다
      for (const k of ['neck', 'thighL', 'thighR'] as const) this.bones[k].scale.setScalar(1e-4);
      this.hideTorso();
    }
  }

  /**
   * @param team 팀 색 (null이면 기본 색)
   * @param white true면 흰색 몸통 (플레이어 본인 모델)
   */
  static async create(opts: { team: Team | null; firstPerson?: boolean; white?: boolean }): Promise<CharacterModel> {
    const src = await loadFBX('assets/characters/YBot.fbx');
    const geos = await optimizedGeometries(src, opts.firstPerson ? 'fp' : 'tp');
    const body = cloneSkinned(src);
    // 가벼운 형상으로 교체 (원본은 삼각형마다 정점이 따로라 캐릭터 하나에 정점 16만 개)
    body.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) m.geometry = geos.get(m.geometry) ?? m.geometry;
    });
    body.scale.multiplyScalar(0.01); // cm → m
    const bodyMat = createPSXMaterial({ color: BODY_COLOR[opts.white ? 'white' : opts.team ?? 'white'] });
    const jointMat = createPSXMaterial({ color: JOINT_COLOR });
    body.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.material = /joint/i.test(m.name) ? jointMat : bodyMat;
      m.castShadow = !opts.firstPerson;
      m.receiveShadow = !opts.firstPerson;
      // 포즈에 따라 바운딩이 바뀌므로 컬링 오판 방지
      m.frustumCulled = false;
    });
    const model = new CharacterModel(body, opts.firstPerson ?? false);
    model.materials.push(bodyMat, jointMat);
    model.bodyMaterial = bodyMat;
    const lib = await loadAnimationLibrary();
    if (model.firstPerson) model.initFirstPersonAnimation(body, lib);
    else model.initAnimation(body, lib);
    return model;
  }

  /**
   * 1인칭: 몸통(허리~가슴)을 보이지 않게 한다. 시선을 아래로 내리면(설치, 장전) 몸통이 화면을 가리기 때문.
   * 척추 뼈 세 마디를 거의 0 크기로 줄여 그 뼈에 붙은 정점을 한 점으로 모으고,
   * 자식 뼈(다음 척추·어깨·목)는 위치와 크기를 반대로 보정해 팔은 원래 자리·크기 그대로 남긴다.
   */
  private hideTorso(): void {
    const s = 1e-3;
    const spine = this.bones.spine;
    const spine1 = this.boneMap.get('mixamorigSpine1')!;
    const spine2 = this.bones.chest;
    const fix = (b: THREE.Bone, posScale: number, scaleMul: number) => {
      b.position.multiplyScalar(posScale);
      this.rest.get(b)!.p.multiplyScalar(posScale);
      b.scale.multiplyScalar(scaleMul);
    };
    // 실효 크기: spine, spine1, spine2 = s  /  어깨·목 = 원래대로
    spine.scale.multiplyScalar(s);
    fix(spine1, 1 / s, 1);
    fix(spine2, 1 / s, 1);
    for (const n of ['mixamorigLeftShoulder', 'mixamorigRightShoulder', 'mixamorigNeck']) fix(this.boneMap.get(n)!, 1 / s, 1 / s);
    this.root.updateMatrixWorld(true);
  }

  /** 몸 재질에 잘라내기 평면을 건다 (1인칭: 카메라 바로 앞의 어깨·윗팔을 숨김) */
  setClipPlanes(planes: THREE.Plane[]): void {
    for (const m of this.materials) m.clippingPlanes = planes;
  }

  /** 팀 색 변경 (진영 교체 시) */
  setTeam(team: Team): void {
    this.bodyMaterial?.color.setHex(BODY_COLOR[team]);
  }

  setWeapon(template: WeaponTemplate | null): void {
    this.weapon?.root.removeFromParent();
    this.weapon = template ? instantiateWeapon(template) : null;
    if (!this.weapon) return;
    (this.firstPerson ? this.weaponMount : this.handMount).add(this.weapon.root);
    this.weapon.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = !this.firstPerson;
    });
  }

  // ───────────────────────── 애니메이션 준비 ─────────────────────────

  private initAnimation(body: THREE.Object3D, lib: Map<ClipName, LoadedClip>): void {
    this.clips = lib;
    const mixer = new THREE.AnimationMixer(body);
    this.mixer = mixer;
    const add = (map: Map<ClipName, THREE.AnimationAction>, name: ClipName, clip: THREE.AnimationClip) => {
      const a = mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.weights.set(a, 0);
      map.set(name, a);
      return a;
    };
    for (const name of ['idle', 'jump', ...LOCOMOTION.map((l) => l[0])] as ClipName[]) {
      const a = add(this.lowerActions, name, lib.get(name)!.lower);
      // 이동 클립은 위상을 직접 지정하므로 자동 진행을 멈춘다
      if (name !== 'idle') a.timeScale = 0;
    }
    for (const name of ['idle', 'fire', 'reload', 'hit'] as ClipName[]) add(this.upperActions, name, lib.get(name)!.upper);
    this.upperActions.get('reload')!.timeScale = 0;
    this.upperActions.get('hit')!.timeScale = 0;
    this.calibrateWeaponHold();
  }

  /** 1인칭: 3인칭과 같은 장전 클립을 재생하기 위한 최소 구성 (상체 대기/장전) */
  private initFirstPersonAnimation(body: THREE.Object3D, lib: Map<ClipName, LoadedClip>): void {
    this.clips = lib;
    const mixer = new THREE.AnimationMixer(body);
    this.mixer = mixer;
    for (const name of ['idle', 'reload', 'grenade'] as ClipName[]) {
      const a = mixer.clipAction(lib.get(name)!.upper);
      a.play();
      a.setEffectiveWeight(0);
      a.timeScale = 0;
      this.weights.set(a, 0);
      this.upperActions.set(name, a);
    }
  }

  /**
   * 1인칭: 오른손 손바닥 안쪽(손가락 뿌리 앞, 손바닥 쪽으로 조금)에 물건 마운트를 둔다.
   * 마운트는 월드 크기 1 (물건 크기를 m 단위로 지정). 팔 크기를 바꾼 뒤 호출.
   */
  calibrateItemMount(): void {
    this.resetPose();
    this.root.updateMatrixWorld(true);
    const hand = this.bones.handR;
    const hq = hand.getWorldQuaternion(new THREE.Quaternion());
    const f = this.handCalib.R.finger.clone().applyQuaternion(hq);
    const p = this.handCalib.R.palm.clone().applyQuaternion(hq);
    const pos = hand.getWorldPosition(new THREE.Vector3()).addScaledVector(f, 0.075).addScaledVector(p, 0.05);
    const desired = new THREE.Matrix4().compose(pos, hq, new THREE.Vector3(1, 1, 1));
    const local = hand.matrixWorld.clone().invert().multiply(desired);
    local.decompose(this.itemMount.position, this.itemMount.quaternion, this.itemMount.scale);
    hand.add(this.itemMount);
  }

  /**
   * 1인칭: 지금 자세(무기 IK)를 클립 자세 쪽으로 weight만큼 섞는다.
   * updateFirstPerson() 다음에 호출한다 (던지는 능력 — Toss Grenade).
   */
  blendFirstPersonClip(name: ClipName, time: number, weight: number): void {
    if (!this.mixer || weight <= 0.001) return;
    const act = this.upperActions.get(name);
    if (!act) return;
    const ik = new Map<THREE.Bone, THREE.Quaternion>();
    for (const b of this.rest.keys()) ik.set(b, b.quaternion.clone());
    this.resetPose();
    for (const a of this.weights.keys()) a.setEffectiveWeight(a === act ? 1 : 0);
    this.applyClipAt(act, Math.min(time, this.clips.get(name)!.duration - 0.001));
    for (const [b, q] of ik) {
      const target = b.quaternion.clone();
      b.quaternion.copy(q).slerp(target, weight);
    }
    act.setEffectiveWeight(0);
  }

  /**
   * 클립의 한 시점 자세를 뼈에 확실히 적용한다.
   * AnimationMixer는 직전 프레임과 같은 값이면 뼈에 쓰지 않는데, resetPose()가 뼈를 바꿔 놓으므로
   * 같은 시점을 연속으로 적용하면(멈춘 화면, 일시정지) 기본 자세로 남는다 → 살짝 다른 시점을 먼저 적용.
   */
  private applyClipAt(act: THREE.AnimationAction, time: number): void {
    act.time = time + 1e-3;
    this.mixer!.update(0);
    act.time = time;
    this.mixer!.update(0);
  }

  /** 크기를 바꾼 뒤 손에 쥐는 무기 위치를 다시 계산 (1인칭) */
  calibrateHold(): void {
    this.resetPose();
    this.calibrateWeaponHold();
    this.resetPose();
  }

  /**
   * 조준 대기 자세에서 무기가 손에 놓일 위치를 계산해 오른손 마운트에 저장한다.
   * 손잡이(무기 원점)는 오른손 주먹 안, 총구 방향은 오른손 → 왼손 방향.
   */
  private calibrateWeaponHold(): void {
    const idleL = this.lowerActions.get('idle');
    const idleU = this.upperActions.get('idle')!;
    idleL?.setEffectiveWeight(1);
    idleU.setEffectiveWeight(1);
    this.mixer!.setTime(0);
    this.root.updateMatrixWorld(true);

    const B = this.bones;
    const hand = B.handR.getWorldPosition(new THREE.Vector3());
    const fingers = this.boneMap.get(fingerBone('R', 'Middle', 1))!.getWorldPosition(new THREE.Vector3());
    const palm = this.handCalib.R.palm.clone().applyQuaternion(B.handR.getWorldQuaternion(new THREE.Quaternion()));
    const grip = hand.clone().lerp(fingers, 0.6).addScaledVector(palm, 0.03);
    const leftHand = B.handL.getWorldPosition(new THREE.Vector3());
    const forward = leftHand.sub(grip).normalize();
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    // 무기 공간: 앞 -Z, 위 +Y, 오른쪽 +X
    const desired = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()).setPosition(grip);
    const local = B.handR.matrixWorld.clone().invert().multiply(desired);
    local.decompose(this.handMount.position, this.handMount.quaternion, this.handMount.scale);

    idleL?.setEffectiveWeight(0);
    idleU.setEffectiveWeight(0);
  }

  // ───────────────────────── 래그돌 ─────────────────────────

  /** 맞음 기록 (쓰러질 때 이 방향으로 날아감) */
  noteHit(from: THREE.Vector3, point: THREE.Vector3, head = false): void {
    const dir = point.clone().sub(from).setY(0);
    if (dir.lengthSq() < 1e-6) return;
    this.lastHit = { dir: dir.normalize(), point: point.clone(), at: performance.now(), head };
  }

  private jointPositions(): THREE.Vector3[] {
    return JOINTS.map((j) => this.bones[JOINT_BONE[j]].getWorldPosition(new THREE.Vector3()));
  }

  /** 입자 위치로 만든 뼈 방향 기준 회전 */
  private ragFrame(pts: THREE.Vector3[], a: Joint, b: Joint, ref: 'side' | 'hipSide' | 'up'): THREE.Quaternion {
    const I = (j: Joint) => pts[JOINTS.indexOf(j)];
    const x = I(b).clone().sub(I(a)).normalize();
    const side = I('shR').clone().sub(I('shL'));
    const hipSide = I('thR').clone().sub(I('thL'));
    const up = I('chest').clone().sub(I('hips'));
    const tryRef = (v: THREE.Vector3) => new THREE.Vector3().crossVectors(x, v);
    let z = tryRef(ref === 'side' ? side : ref === 'hipSide' ? hipSide : up);
    if (z.lengthSq() < 1e-4) z = tryRef(ref === 'up' ? side : up);
    if (z.lengthSq() < 1e-8) z = tryRef(new THREE.Vector3(0, 0, 1));
    z.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  private startRagdoll(F: THREE.Vector3, R: THREE.Vector3): void {
    this.fall.rotation.x = 0;
    this.fall.position.y = 0;
    this.root.updateMatrixWorld(true);
    const pts = this.jointPositions();
    this.ragOffset.clear();
    for (const [bone, a, b, ref] of RAG_BONES) {
      const f0 = this.ragFrame(pts, a, b, ref);
      const q0 = this.bones[bone].getWorldQuaternion(new THREE.Quaternion());
      this.ragOffset.set(bone, f0.invert().multiply(q0));
    }
    // 이동 중이던 속도 + 맞은 방향으로 밀기 (최근에 맞은 게 없으면 뒤로 넘어짐)
    const vel = new THREE.Vector3().addScaledVector(R, this.smoothMove.x).addScaledVector(F, this.smoothMove.y).multiplyScalar(0.8);
    const hit = this.lastHit && performance.now() - this.lastHit.at < 600 ? this.lastHit : null;
    const dir = hit ? hit.dir.clone().multiplyScalar(hit.head ? 3.2 : 2.4) : F.clone().multiplyScalar(-1.6);
    dir.y += 0.6;
    this.ragdoll = new Ragdoll(pts, vel, { dir, point: hit?.point ?? null }, CharacterModel.ragdollWorld);
    this.lastHit = null;
  }

  private applyRagdoll(): void {
    const rd = this.ragdoll!;
    const pts = rd.pos;
    // 엉덩이 위치
    const hips = this.bones.hips;
    if (hips.parent) hips.position.copy(hips.parent.worldToLocal(pts[0].clone()));
    for (const [bone, a, b, ref] of RAG_BONES) {
      const q = this.ragFrame(pts, a, b, ref).multiply(this.ragOffset.get(bone)!);
      setWorldQuaternion(this.bones[bone], q);
    }
  }

  // ───────────────────────── 3인칭 포즈 ─────────────────────────

  update(dt: number, pose: CharacterPose): void {
    if (!this.mixer) return;
    const lod = CharacterModel.lod;
    if (lod) {
      this.lodAcc += dt;
      const p = this.root.position;
      const sph = CharacterModel._sphere;
      sph.center.set(p.x, p.y + 1, p.z);
      sph.radius = 1.6;
      const onScreen = lod.frustum.intersectsSphere(sph);
      const d2 = lod.cam.distanceToSquared(p);
      const every = !onScreen ? (lod.low ? 6 : 4) : d2 > 35 * 35 ? (lod.low ? 3 : 2) : d2 > 18 * 18 && lod.low ? 2 : 1;
      this.lodTick = (this.lodTick + 1) % every;
      if (this.lodTick !== 0) return;
      dt = Math.min(this.lodAcc, 0.2);
      this.lodAcc = 0;
    }
    const B = this.bones;
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion);
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    const dead = pose.dead >= 0;
    this.pivot.position.y = 0;

    // ── 이동 속도 (급격한 변화 완화)
    const k = Math.min(1, dt * 10);
    this.smoothMove.x += (pose.moveX - this.smoothMove.x) * k;
    this.smoothMove.y += (pose.moveZ - this.smoothMove.y) * k;
    const speed = this.smoothMove.length();
    this.airTime = pose.grounded ? 0 : this.airTime + dt;

    this.updateLowerBody(dt, pose, speed);
    this.updateUpperBody(pose);
    // 가중치를 부드럽게 따라가게 한 뒤 믹서 진행
    const blend = Math.min(1, dt * 12);
    for (const [a, target] of this.weights) {
      const w = a.getEffectiveWeight() + (target - a.getEffectiveWeight()) * blend;
      a.setEffectiveWeight(w);
    }
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);

    // ── 앉기 (애니메이션이 없어 절차적으로 다리를 접고 몸을 낮춤)
    if (pose.crouch > 0.01 && pose.grounded && !dead) this.applyCrouch(dt, pose.crouch, F, R, speed);

    // ── 조준 각도: 허리 세 마디에 나눠서 굽힘
    const pitch = dead ? 0 : pose.aimPitch;
    for (const b of [B.spine, B.spine1, B.chest]) rotateBoneWorld(b, R, pitch / 3);

    // ── Core 설치: 무릎 꿇고 상체를 숙여 바닥의 장치 키패드를 누른다
    if (pose.plant >= 0 && !dead) {
      this.fall.rotation.x = 0;
      this.fall.position.y = 0;
      if (this.weapon) this.weapon.root.visible = false;
      rotateBoneWorld(B.spine, R, -0.35);
      rotateBoneWorld(B.chest, R, -0.25);
      rotateBoneWorld(B.neck, R, -0.3);
      this.root.updateMatrixWorld(true);
      const ground = this.root.position.clone().addScaledVector(F, 0.5).setY(this.root.position.y + 0.32);
      const tap = Math.max(0, Math.sin(pose.plant * 60)) * 0.04 * (pose.plant > 0.15 ? 1 : 0);
      const tR = ground.clone().addScaledVector(R, 0.07).addScaledVector(UP, tap);
      const tL = ground.clone().addScaledVector(R, -0.16).addScaledVector(UP, -0.05);
      solveTwoBone(B.upperArmR, B.forearmR, B.handR, tR, R.clone().addScaledVector(UP, -0.5), this.len.upperArm, this.len.forearm);
      solveTwoBone(B.upperArmL, B.forearmL, B.handL, tL, R.clone().negate().addScaledVector(UP, -0.5), this.len.upperArm, this.len.forearm);
      return;
    }

    // ── 무기 꺼내기: 오른팔을 내렸다가 올림
    const eq = 1 - pose.equip;
    if (eq > 0) rotateBoneWorld(B.upperArmR, R, -eq * 1.1);

    // ── 사망: 래그돌 (맞은 방향으로 쓰러져 바닥·벽에 부딪힘)
    if (dead) {
      if (!this.ragdoll) this.startRagdoll(F, R);
      this.ragdoll!.update(dt);
      if (this.weapon) this.weapon.root.visible = false;
      this.applyRagdoll();
      return;
    }
    this.ragdoll = null;
    this.fall.rotation.x = 0;
    this.fall.position.y = 0;
    if (this.weapon) this.weapon.root.visible = true;

    // ── 왼손 IK: 재장전/꺼내기 중에는 애니메이션의 왼손을 그대로 쓴다
    const ikTarget = pose.reload >= 0 || pose.equip < 1 ? 0 : 1;
    this.leftIK += (ikTarget - this.leftIK) * Math.min(1, dt * 10);
    this.root.updateMatrixWorld(true);
    if (this.weapon && this.leftIK > 0.01) this.leftHandOnWeapon(this.leftIK);
  }

  private setTarget(a: THREE.AnimationAction | undefined, w: number): void {
    if (a) this.weights.set(a, w);
  }

  private updateLowerBody(dt: number, pose: CharacterPose, speed: number): void {
    const L = this.lowerActions;
    if (pose.dead >= 0 || !pose.grounded) {
      // 공중: 점프 클립 (도약 → 공중 자세에서 멈춤)
      for (const [n] of L) this.setTarget(L.get(n), n === 'jump' ? (pose.dead >= 0 ? 0 : 1) : 0);
      if (pose.dead >= 0) this.setTarget(L.get('idle'), 1);
      const jump = L.get('jump')!;
      jump.time = Math.min(this.airTime + 0.12, this.clips.get('jump')!.duration * 0.55);
      return;
    }
    this.setTarget(L.get('jump'), 0);

    // 이동량 (0이면 대기)
    const move = THREE.MathUtils.clamp(speed / 0.6, 0, 1);
    this.setTarget(L.get('idle'), 1 - move);
    // 방향 가중치 (앞/뒤/좌/우) — 대각선은 두 방향을 섞음
    const nx = speed > 1e-3 ? this.smoothMove.x / speed : 0;
    const nz = speed > 1e-3 ? this.smoothMove.y / speed : 1;
    const dirW = (x: number, z: number) => Math.max(0, x * nx + z * nz);
    let sum = 0;
    for (const [, x, z] of LOCOMOTION) sum += dirW(x, z);
    sum = Math.max(1e-4, sum / 2); // 걷기/달리기 두 세트
    // 걷기 ↔ 달리기 (플레이어 걷기 3m/s부터는 달리기 클립을 천천히)
    const run = THREE.MathUtils.clamp((speed - 1.2) / 1.4, 0, 1);

    // 위상 동기화: 클립마다 한 주기에 이동하는 거리가 다르므로 가중 평균 보폭으로 위상을 진행
    let stride = 0;
    let wsum = 0;
    for (const [name, x, z, isRun] of LOCOMOTION) {
      const w = (dirW(x, z) / sum / 2) * (isRun ? run : 1 - run) * 2;
      const c = this.clips.get(name)!;
      stride += w * c.speed * c.duration;
      wsum += w;
      this.setTarget(L.get(name), w * move);
    }
    stride = wsum > 0 ? stride / wsum : 1;
    this.gaitPhase = (this.gaitPhase + (dt * speed) / Math.max(0.3, stride)) % 1;
    for (const [name] of LOCOMOTION) L.get(name)!.time = this.gaitPhase * this.clips.get(name)!.duration;
  }

  private updateUpperBody(pose: CharacterPose): void {
    const U = this.upperActions;
    const reloading = pose.reload >= 0;
    const firing = !reloading && pose.fire > 0.05 && this.weapon?.template.def.category !== 'melee';
    const hit = pose.hit >= 0 && pose.dead < 0;
    this.setTarget(U.get('reload'), reloading ? 1 : 0);
    this.setTarget(U.get('fire'), firing && !hit ? 1 : 0);
    this.setTarget(U.get('hit'), hit ? 1 : 0);
    this.setTarget(U.get('idle'), reloading || firing || hit ? 0 : 1);
    if (reloading) U.get('reload')!.time = Math.min(1, pose.reload) * this.clips.get('reload')!.duration * 0.98;
    if (hit) U.get('hit')!.time = Math.min(1, pose.hit) * this.clips.get('hit')!.duration * 0.98;
  }

  /** 앉기: 애니메이션 다리 자세와 절차적 앉은 자세를 crouch 비율로 섞고 몸을 낮춘다 */
  private applyCrouch(dt: number, crouch: number, F: THREE.Vector3, R: THREE.Vector3, speed: number): void {
    const B = this.bones;
    const legBones = [B.thighL, B.shinL, B.footL, B.thighR, B.shinR, B.footR];
    const animated = legBones.map((b) => b.quaternion.clone());
    this.walkPhase += dt * speed * (Math.PI * 2) / 1.1;
    const moveDir = new THREE.Vector3().addScaledVector(R, this.smoothMove.x).addScaledVector(F, this.smoothMove.y);
    if (speed > 0.05) moveDir.normalize();
    else moveDir.copy(F);
    this.poseCrouchLegs(F, R, moveDir, speed);
    // 주의: slerpQuaternions(a, b)의 b가 결과 객체와 같으면 a로 먼저 덮어써지므로 복사본을 쓴다
    legBones.forEach((b, i) => b.quaternion.slerpQuaternions(animated[i], b.quaternion.clone(), crouch));
    rotateBoneWorld(B.spine, R, -crouch * 0.2);
    this.root.updateMatrixWorld(true);
    // 가장 낮은 발이 바닥에 닿도록 몸 전체를 내린다
    const yL = this.root.worldToLocal(B.footL.getWorldPosition(_v1)).y;
    const yR = this.root.worldToLocal(B.footR.getWorldPosition(_v2)).y;
    this.pivot.position.y = (this.footRestY - Math.min(yL, yR)) * crouch;
    this.root.updateMatrixWorld(true);
  }

  private poseCrouchLegs(F: THREE.Vector3, R: THREE.Vector3, moveDir: THREE.Vector3, speed: number): void {
    const B = this.bones;
    const amp = Math.min(1, speed / 2.2) * 0.35;
    for (const side of ['L', 'R'] as const) {
      const phase = this.walkPhase + (side === 'L' ? 0 : Math.PI);
      const swing = Math.sin(phase) * amp;
      const sideSign = side === 'L' ? -1 : 1;
      const thigh = new THREE.Vector3()
        .addScaledVector(UP, -0.5)
        .addScaledVector(F, 0.85)
        .addScaledVector(R, sideSign * 0.18)
        .addScaledVector(moveDir, swing)
        .normalize();
      // R축 양의 회전은 앞으로 드는 방향이므로, 무릎(뒤로 꺾임)은 음의 각도
      const shin = thigh.clone().applyAxisAngle(R, -2.0).normalize();
      aimBone(B[`thigh${side}`], B[`shin${side}`], thigh);
      aimBone(B[`shin${side}`], B[`foot${side}`], shin);
      aimBone(B[`foot${side}`], B[`toe${side}`], _v1.copy(F).addScaledVector(UP, -0.25).normalize());
    }
  }

  /** 3인칭 왼손: 애니메이션 자세에서 무기의 핸드가드로 IK (weight로 섞음) */
  private leftHandOnWeapon(weight: number): void {
    const B = this.bones;
    const chain = [B.upperArmL, B.forearmL, B.handL];
    const animated = chain.map((b) => b.quaternion.clone());
    this.poseLeftHand(this.weapon!);
    chain.forEach((b, i) => b.quaternion.slerpQuaternions(animated[i], b.quaternion.clone(), weight));
    this.root.updateMatrixWorld(true);
  }

  // ───────────────────────── 피격 판정 ─────────────────────────

  /**
   * 현재 자세의 피격 판정 도형 (월드 좌표).
   * 머리는 구, 몸통·팔은 몸통 판정, 다리는 다리 판정 캡슐.
   */
  hitboxes(): Capsule[] {
    const B = this.bones;
    const p = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    const head = p(B.head);
    const top = p(B.headTop);
    const headCenter = head.clone().lerp(top, 0.55);
    const headR = Math.max(0.09, head.distanceTo(top) * 0.55);
    const cap = (part: Capsule['part'], a: THREE.Vector3, b: THREE.Vector3, radius: number): Capsule => ({ part, a, b, radius });
    return [
      cap('head', headCenter, headCenter.clone(), headR),
      cap('body', p(B.hips), p(B.chest), 0.16),
      cap('body', p(B.chest), p(B.neck), 0.15),
      cap('body', p(B.upperArmL), p(B.forearmL), 0.055),
      cap('body', p(B.forearmL), p(B.handL), 0.045),
      cap('body', p(B.upperArmR), p(B.forearmR), 0.055),
      cap('body', p(B.forearmR), p(B.handR), 0.045),
      cap('leg', p(B.thighL), p(B.shinL), 0.085),
      cap('leg', p(B.shinL), p(B.footL), 0.06),
      cap('leg', p(B.thighR), p(B.shinR), 0.085),
      cap('leg', p(B.shinR), p(B.footR), 0.06),
    ];
  }

  /** 총구 월드 위치 (예광탄 시작점) */
  muzzlePosition(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.weapon) return this.weapon.muzzle.getWorldPosition(out);
    return this.bones.handR.getWorldPosition(out);
  }

  /** 머리 월드 위치 (시야 판정) */
  headPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones.head.getWorldPosition(out);
  }

  // ───────────────────────── 1인칭 ─────────────────────────

  /**
   * 1인칭 팔 포즈. weaponMount의 위치/회전은 호출하는 쪽(ViewModel)이 이미 정해 둔다.
   * 팔은 그 무기를 IK로 잡기만 한다.
   */
  updateFirstPerson(reload: number, animWeight = 0, coreTap = -1): void {
    const w = this.weapon;
    // ── 장전: 3인칭과 같은 Mixamo 장전 클립 자세를 구한다
    let anim: Map<THREE.Bone, THREE.Quaternion> | null = null;
    if (w && reload >= 0 && animWeight > 0.001 && this.mixer) {
      this.resetPose();
      const act = this.upperActions.get('reload')!;
      for (const a of this.weights.keys()) a.setEffectiveWeight(a === act ? 1 : 0);
      this.applyClipAt(act, Math.min(1, reload) * this.clips.get('reload')!.duration * 0.98);
      this.root.updateMatrixWorld(true);
      anim = new Map();
      for (const b of this.rest.keys()) anim.set(b, b.quaternion.clone());
      // 애니메이션 속 오른손에 들린 무기 위치 (weaponMount 공간)로 무기를 옮긴다
      const m = this.weaponMount.matrixWorld.clone().invert().multiply(this.handMount.matrixWorld);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      m.decompose(p, q, new THREE.Vector3());
      w.root.position.lerp(p, animWeight);
      w.root.quaternion.slerp(q, animWeight);
      w.root.updateMatrixWorld(true);
    }

    // ── 기본: 팔을 무기에 IK로 맞춤
    this.resetPose();
    this.root.updateMatrixWorld(true);
    // 사격 자세: 상체를 오른쪽으로 비틀어 왼쪽 어깨를 앞으로 (핸드가드까지 손이 닿도록)
    rotateBoneWorld(this.bones.chest, UP, -0.3);
    if (!w) return;
    if (w.template.def.category === 'core') {
      this.poseCoreHands(w, coreTap);
      return;
    }
    this.poseRightHand(w);
    this.poseLeftHand(w, reload);

    // ── 장전 애니메이션 자세로 섞기
    if (anim) for (const [b, q] of anim) b.quaternion.slerp(q, animWeight);
  }

  /**
   * Core를 두 손으로 든다. coreTap >= 0이면 오른손으로 앞면 키패드를 누른다 (설치 중).
   * 무기 공간: 원점 = 장치 중심, 키패드는 플레이어 쪽(+Z) 위.
   */
  private poseCoreHands(w: WeaponInstance, coreTap: number): void {
    const B = this.bones;
    const { wF, wU, wR } = this.weaponAxes(w);
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion);
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    const c = w.root.localToWorld(new THREE.Vector3(0, 0, 0));
    const poleR = new THREE.Vector3().addScaledVector(UP, -1).addScaledVector(R, 0.8).addScaledVector(F, -0.3);
    const poleL = new THREE.Vector3().addScaledVector(UP, -1).addScaledVector(R, -0.8).addScaledVector(F, -0.3);

    // 왼손: 장치 왼쪽 옆면을 감싼다 (손바닥이 오른쪽을 봄)
    const lF = wF.clone().multiplyScalar(0.7).addScaledVector(wU, 0.3).normalize();
    const lWrist = c.clone().addScaledVector(wR, -0.15).addScaledVector(wU, -0.03).addScaledVector(lF, -0.06);
    solveTwoBone(B.upperArmL, B.forearmL, B.handL, lWrist, poleL, this.len.upperArm, this.len.forearm);
    this.setHandFrame('L', lF, wR);
    this.curlFingers('L', lF, wR, [0.5, 0.7, 0.5], 0.3);

    if (coreTap >= 0) {
      // 오른손: 키패드를 위에서 누른다
      const keypad = w.root.localToWorld(new THREE.Vector3(0, 0.04, 0.1));
      const rF = wF.clone().multiplyScalar(0.55).addScaledVector(wU, -0.85).normalize();
      const rWrist = keypad.clone().addScaledVector(rF, -0.14).addScaledVector(wU, coreTap * 0.035).addScaledVector(wR, 0.02);
      solveTwoBone(B.upperArmR, B.forearmR, B.handR, rWrist, poleR, this.len.upperArm, this.len.forearm);
      this.setHandFrame('R', rF, wF);
      this.curlFingers('R', rF, wF, [0.25, 0.35, 0.25], 0.2);
      return;
    }
    // 오른손: 오른쪽 옆면을 감싼다
    const rF = lF.clone();
    const rWrist = c.clone().addScaledVector(wR, 0.15).addScaledVector(wU, -0.03).addScaledVector(rF, -0.06);
    solveTwoBone(B.upperArmR, B.forearmR, B.handR, rWrist, poleR, this.len.upperArm, this.len.forearm);
    this.setHandFrame('R', rF, wR.clone().negate());
    this.curlFingers('R', rF, wR.clone().negate(), [0.5, 0.7, 0.5], 0.3);
  }

  /** 손 크기 배율 (1인칭에서 팔만 키우고 손은 원래 크기로 유지할 때 사용) */
  setHandScale(s: number): void {
    this.bones.handR.scale.setScalar(s);
    this.bones.handL.scale.setScalar(s);
  }

  /** root 크기를 바꾼 뒤 IK용 뼈 길이(월드 단위)를 다시 잰다 */
  recalibrate(): void {
    this.resetPose();
    this.root.updateMatrixWorld(true);
    this.measure();
  }

  private measure(): void {
    const B = this.bones;
    this.len.upperArm = boneLength(B.upperArmR, B.forearmR);
    this.len.forearm = boneLength(B.forearmR, B.handR);
    this.len.thigh = boneLength(B.thighR, B.shinR);
    this.len.shin = boneLength(B.shinR, B.footR);
  }

  /** 어깨 중심 위치 (root 공간) — 1인칭 카메라 배치에 사용 */
  shoulderCenter(out = new THREE.Vector3()): THREE.Vector3 {
    this.resetPose();
    this.root.updateMatrixWorld(true);
    const sL = this.root.worldToLocal(this.bones.upperArmL.getWorldPosition(_v1));
    const sR = this.root.worldToLocal(this.bones.upperArmR.getWorldPosition(_v2));
    return out.copy(sL).add(sR).multiplyScalar(0.5);
  }

  private resetPose(): void {
    for (const [bone, r] of this.rest) {
      bone.quaternion.copy(r.q);
      bone.position.copy(r.p);
    }
    this.pivot.position.y = 0;
  }

  // ───────────────────────── 손 (IK + 손 모양) ─────────────────────────

  /** 오른손: 손잡이를 감싸 쥔다 (1인칭) */
  private poseRightHand(w: WeaponInstance): void {
    const B = this.bones;
    const { wF, wU, wR } = this.weaponAxes(w);
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion);
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    //   손바닥은 손잡이 오른쪽 면(-wR 방향을 봄), 손가락은 앞으로 뻗어 손잡이 앞을 감싸고,
    //   검지→새끼 방향은 손잡이를 따라 아래로 내려간다.
    const g = w.root.localToWorld(new THREE.Vector3(0, 0, 0));
    const rF = wF.clone().addScaledVector(wU, -0.35).normalize();
    const rP = wR.clone().negate();
    // IK 끝점은 손목: 손바닥 중심이 손잡이 옆면에 오도록 손목을 뒤·오른쪽에 둔다
    const rWrist = g.clone().addScaledVector(wU, -0.03).addScaledVector(wR, 0.03).addScaledVector(rF, -0.065);
    const poleR = new THREE.Vector3().addScaledVector(UP, -1).addScaledVector(R, 0.8).addScaledVector(F, -0.3);
    solveTwoBone(B.upperArmR, B.forearmR, B.handR, rWrist, poleR, this.len.upperArm, this.len.forearm);
    this.setHandFrame('R', rF, rP);
    this.curlFingers('R', rF, rP, [0.85, 1.15, 0.8], 0.5);
  }

  /** 왼손: 긴 총은 핸드가드를 아래에서 받치고, 권총은 오른손을 감싼다 */
  private poseLeftHand(w: WeaponInstance, reload = -1): void {
    const B = this.bones;
    const { wF, wU, wR } = this.weaponAxes(w);
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion);
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    const def = w.template.def;
    const melee = def.category === 'melee';
    const oneHanded = def.hold.support === undefined;
    const g = w.root.localToWorld(new THREE.Vector3(0, 0, 0));
    const rF = wF.clone().addScaledVector(wU, -0.35).normalize();

    let lF: THREE.Vector3;
    let lP: THREE.Vector3;
    let lWrist: THREE.Vector3;
    if (melee) {
      // 칼: 왼팔은 앞쪽에서 균형을 잡는 자세 (손바닥은 아래, 가볍게 쥠)
      lF = F.clone().addScaledVector(R, 0.3).normalize();
      lP = UP.clone().negate();
      lWrist = B.upperArmL.getWorldPosition(new THREE.Vector3()).addScaledVector(F, 0.3).addScaledVector(UP, -0.3).addScaledVector(R, 0.05);
    } else if (oneHanded) {
      // 권총: 왼손이 오른손을 왼쪽 아래에서 감싼다 (손바닥은 오른쪽을 봄)
      lF = rF.clone();
      lP = wR.clone();
      lWrist = g.clone().addScaledVector(wU, -0.055).addScaledVector(wR, -0.03).addScaledVector(lF, -0.06);
    } else {
      // 긴 총: 손바닥을 위로 해서 핸드가드를 아래에서 받치고, 손가락은 오른쪽으로 감싸 올라간다
      const support = w.template.support.clone();
      if (reload >= 0) {
        // 재장전: 탄창 쪽으로 손이 이동
        const r = Math.sin(Math.min(1, reload) * Math.PI);
        support.lerp(new THREE.Vector3(0, -0.12, support.z * 0.35), r);
      }
      lF = wF.clone().multiplyScalar(0.6).addScaledVector(wR, 0.8).normalize();
      lP = wU.clone();
      // 손가락 뿌리(손목에서 약 8cm)가 핸드가드 오른쪽 아래 모서리에 오도록 손목 위치를 잡는다
      const below = w.root.localToWorld(support).addScaledVector(wU, -0.03);
      lWrist = below.addScaledVector(lF, -0.075);
    }
    const poleL = new THREE.Vector3().addScaledVector(UP, -1).addScaledVector(R, -0.8).addScaledVector(F, -0.2);
    solveTwoBone(B.upperArmL, B.forearmL, B.handL, lWrist, poleL, this.len.upperArm, this.len.forearm);
    this.setHandFrame('L', lF, lP);
    this.curlFingers('L', lF, lP, melee ? [0.3, 0.4, 0.3] : oneHanded ? [0.6, 0.9, 0.7] : [0.5, 0.8, 0.6], 0.4);
  }

  private weaponAxes(w: WeaponInstance) {
    w.root.updateMatrixWorld(true);
    const wq = w.root.getWorldQuaternion(_q1);
    return {
      wF: new THREE.Vector3(0, 0, -1).applyQuaternion(wq),
      wU: new THREE.Vector3(0, 1, 0).applyQuaternion(wq),
      wR: new THREE.Vector3(1, 0, 0).applyQuaternion(wq),
    };
  }

  /**
   * 손의 방향을 두 축으로 완전히 지정한다.
   * @param fingerDir 손목 → 가운뎃손가락 뿌리 방향 (월드)
   * @param palmDir 손바닥이 바라보는 방향 (월드)
   */
  private setHandFrame(side: Side, fingerDir: THREE.Vector3, palmDir: THREE.Vector3): void {
    const c = this.handCalib[side];
    const f = fingerDir.clone().normalize();
    const p = palmDir.clone().addScaledVector(f, -palmDir.dot(f)).normalize();
    const world = new THREE.Matrix4().makeBasis(f, p, new THREE.Vector3().crossVectors(f, p));
    const local = new THREE.Matrix4().makeBasis(c.finger, c.palm, new THREE.Vector3().crossVectors(c.finger, c.palm));
    // world = R · local  →  R = world · localᵀ
    const rot = world.multiply(local.transpose());
    setWorldQuaternion(this.bones[`hand${side}`], new THREE.Quaternion().setFromRotationMatrix(rot));
  }

  /** 손가락(과 엄지)을 손바닥 쪽으로 구부려 쥐는 모양을 만든다 */
  private curlFingers(side: Side, fingerDir: THREE.Vector3, palmDir: THREE.Vector3, angles: [number, number, number], thumb: number): void {
    const f = fingerDir.clone().normalize();
    const p = palmDir.clone().addScaledVector(f, -palmDir.dot(f)).normalize();
    // 이 축으로 양의 회전을 하면 손가락 방향이 손바닥 쪽으로 돈다
    const axis = new THREE.Vector3().crossVectors(f, p);
    for (const name of ['Index', 'Middle', 'Ring', 'Pinky'] as Finger[]) {
      for (let j = 0; j < 3; j++) {
        const b = this.boneMap.get(fingerBone(side, name, j + 1));
        if (b) rotateBoneWorld(b, axis, angles[j]);
      }
    }
    for (let j = 2; j <= 3; j++) {
      const b = this.boneMap.get(fingerBone(side, 'Thumb', j));
      if (b) rotateBoneWorld(b, axis, thumb);
    }
  }

  /**
   * 손 뼈의 국소 공간에서 손가락 방향과 손바닥 방향을 구해 둔다 (기본 자세에서 1회).
   * 손바닥 방향은 손의 좌우성으로 결정된다:
   *   오른손: 손가락 방향 × (검지→새끼 방향) = 손바닥,  왼손은 부호 반대.
   */
  private calibrateHand(side: Side): { finger: THREE.Vector3; palm: THREE.Vector3 } {
    const hand = this.bones[`hand${side}`];
    const pos = (n: string) => {
      const b = this.boneMap.get(n);
      if (!b) throw new Error(`손 뼈를 찾을 수 없음: ${n}`);
      return b.getWorldPosition(new THREE.Vector3());
    };
    const hp = hand.getWorldPosition(new THREE.Vector3());
    const finger = pos(fingerBone(side, 'Middle', 1)).sub(hp).normalize();
    const lateral = pos(fingerBone(side, 'Pinky', 1)).sub(pos(fingerBone(side, 'Index', 1))).normalize();
    const palm = new THREE.Vector3().crossVectors(finger, lateral).multiplyScalar(side === 'R' ? 1 : -1);
    palm.addScaledVector(finger, -palm.dot(finger)).normalize();
    const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    return { finger: finger.applyQuaternion(inv), palm: palm.applyQuaternion(inv) };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mixer?.stopAllAction();
    this.materials.forEach((m) => m.dispose());
  }
}
