import * as THREE from 'three';
import { ParticleSystem, type Emit } from './ParticleSystem';
import { createRingMaterial, sceneDepth, vfxTime } from './VfxMaterials';
import { DECAL, decalAtlas, FRAME } from './VfxTextures';

/**
 * 게임 시각 효과 라이브러리.
 * 각 효과는 여러 층을 겹친다: 섬광(glow) → 몸체(불꽃/연기) → 파편·불똥(줄무늬, 중력·튕김) → 잔여 연기 → 충격파/조명.
 * 입자는 반투명 풀 1개 + 더하기 풀 1개(각각 드로우 콜 1회)를 공유하고,
 * 고리·조명·그을음 자국도 미리 만들어 둔 풀을 돌려쓴다 (게임 중 셰이더 재컴파일·할당 없음).
 */

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0];
const colors = new Map<number, THREE.Color>();
/** 캐시된 색 (읽기 전용: 바꿀 때는 _c1/_c2에 복사) */
const col = (hex: number): THREE.Color => {
  let c = colors.get(hex);
  if (!c) colors.set(hex, (c = new THREE.Color(hex)));
  return c;
};
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/** 반구 방향 무작위 벡터 (법선 주변으로 spread만큼 퍼짐) */
function coneDir(n: THREE.Vector3, spread: number, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(spread).add(n).normalize();
  return out;
}

/** 재질별 착탄 성격 */
interface ImpactProfile {
  dust: number;
  dustCol: number;
  chips: number;
  chipCol: number;
  sparks: number;
  splinters: number;
  decal: number;
  decalSize: number;
}

const PROFILES: Record<string, ImpactProfile> = {
  concrete: { dust: 4, dustCol: 0xa49e94, chips: 5, chipCol: 0x8a857c, sparks: 2, splinters: 0, decal: DECAL.concrete, decalSize: 0.11 },
  stone: { dust: 4, dustCol: 0x9c8a78, chips: 6, chipCol: 0x7c6650, sparks: 2, splinters: 0, decal: DECAL.concrete, decalSize: 0.1 },
  steel: { dust: 1, dustCol: 0x6c7074, chips: 0, chipCol: 0x555555, sparks: 10, splinters: 0, decal: DECAL.metal, decalSize: 0.08 },
  iron: { dust: 1, dustCol: 0x6c6660, chips: 0, chipCol: 0x555555, sparks: 9, splinters: 0, decal: DECAL.metal, decalSize: 0.08 },
  wood: { dust: 3, dustCol: 0x9a7a52, chips: 3, chipCol: 0x8a6438, sparks: 0, splinters: 7, decal: DECAL.wood, decalSize: 0.1 },
  dirt: { dust: 6, dustCol: 0x8a7458, chips: 7, chipCol: 0x4e3e2c, sparks: 0, splinters: 0, decal: DECAL.dirt, decalSize: 0.16 },
};

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  age: number;
  life: number;
  size: number;
  billboard: boolean;
}

interface Flash {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

const RINGS = 16;
const LIGHTS = 3;
const DECALS = 128;

export class Vfx {
  readonly group = new THREE.Group();
  /** 반투명: 연기·먼지·파편 */
  readonly smoke = new ParticleSystem(2400, false, 0.9);
  /** 더하기: 불꽃·불똥·섬광·예광탄 */
  readonly glow = new ParticleSystem(2000, true, 0.35);
  private rings: Ring[] = [];
  private flashes: Flash[] = [];
  private decals: THREE.Mesh[] = [];
  private decalGeos: THREE.PlaneGeometry[] = [];
  private decalIndex = 0;
  private scorch: THREE.Mesh;
  private camera: THREE.Camera | null = null;
  /** 바닥 높이 질의 (파편이 바닥을 뚫지 않게) */
  floorAt: (x: number, y: number, z: number) => number = (_x, y) => y - 50;

  constructor() {
    this.group.add(this.smoke.mesh, this.glow.mesh);
    for (let i = 0; i < RINGS; i++) {
      const mat = createRingMaterial();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, age: 0, life: 0, size: 1, billboard: false });
    }
    // 조명은 처음부터 장면에 두고 세기만 바꾼다 (조명 수가 바뀌면 모든 셰이더가 다시 컴파일됨)
    for (let i = 0; i < LIGHTS; i++) {
      const light = new THREE.PointLight(0xffc080, 0, 20, 1.6);
      this.group.add(light);
      this.flashes.push({ light, age: 0, life: 0, peak: 0 });
    }
    // 탄흔: 재질별 아틀라스 칸마다 UV가 다른 지오메트리
    const tex = decalAtlas();
    for (let c = 0; c < 4; c++) {
      const g = new THREE.PlaneGeometry(1, 1);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const ox = (c % 2) * 0.5;
      const oy = c < 2 ? 0.5 : 0; // 캔버스 위쪽 줄 = v 위쪽
      for (let i = 0; i < uv.count; i++) uv.setXY(i, ox + uv.getX(i) * 0.5, oy + uv.getY(i) * 0.5);
      this.decalGeos.push(g);
    }
    const decalMat = new THREE.MeshLambertMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    for (let i = 0; i < DECALS; i++) {
      const m = new THREE.Mesh(this.decalGeos[0], decalMat);
      m.visible = false;
      m.renderOrder = 1;
      this.decals.push(m);
      this.group.add(m);
    }
    // 폭발 그을음 자국
    this.scorch = new THREE.Mesh(
      this.decalGeos[DECAL.dirt],
      new THREE.MeshLambertMaterial({ map: tex, color: 0x302820, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }),
    );
    this.scorch.rotation.x = -Math.PI / 2;
    this.scorch.visible = false;
    this.group.add(this.scorch);
  }

  get stats() {
    return { smoke: this.smoke.active, glow: this.glow.active, rings: this.rings.filter((r) => r.mesh.visible).length, decals: this.decals.filter((d) => d.visible).length };
  }

  /** 부드러운 입자용 장면 깊이 연결 (res는 렌더러가 크기 변경 때 갱신하는 같은 객체) */
  setSceneDepth(tex: THREE.Texture, res: THREE.Vector2): void {
    sceneDepth.tex.value = tex;
    sceneDepth.res.value = res;
    sceneDepth.on.value = 1;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.camera = camera;
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) {
      sceneDepth.near.value = pc.near;
      sceneDepth.far.value = pc.far;
    }
    vfxTime.value += dt;
    this.smoke.update(dt, camera);
    this.glow.update(dt, camera);
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      if (r.age >= r.life) {
        r.mesh.visible = false;
        continue;
      }
      r.mat.uniforms.uProgress.value = r.age / r.life;
      if (r.billboard) r.mesh.quaternion.copy(camera.quaternion);
    }
    for (const f of this.flashes) {
      if (f.age >= f.life) continue;
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      f.light.intensity = f.peak * (1 - t) * (1 - t);
    }
  }

  clear(): void {
    this.smoke.clear();
    this.glow.clear();
    for (const r of this.rings) r.mesh.visible = false;
    for (const f of this.flashes) {
      f.age = f.life;
      f.light.intensity = 0;
    }
    this.scorch.visible = false;
  }

  /** 탄흔은 라운드가 바뀌어도 남겨 두다가, 맵을 새로 시작할 때만 지운다 */
  clearDecals(): void {
    for (const d of this.decals) d.visible = false;
  }

  // ───────────────────────── 기본 요소 ─────────────────────────

  private emit(pool: ParticleSystem, e: Emit): void {
    pool.emit(e);
  }

  /** 순간 조명 (가장 오래된 슬롯 재사용) */
  light(pos: THREE.Vector3, color: number, peak: number, life: number, distance = 20): void {
    let f = this.flashes[0];
    for (const x of this.flashes) if (x.age >= x.life || x.age / x.life > f.age / f.life) f = x;
    f.light.position.copy(pos);
    f.light.color.setHex(color);
    f.light.distance = distance;
    f.age = 0;
    f.life = life;
    f.peak = peak;
    f.light.intensity = peak;
  }

  /** 충격파 고리. normal이 없으면 카메라를 향함 */
  ring(pos: THREE.Vector3, size: number, life: number, color: number, normal?: THREE.Vector3, width = 0.15, alpha = 1): void {
    const r = this.rings.find((x) => !x.mesh.visible) ?? this.rings.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    r.mesh.visible = true;
    r.mesh.position.copy(pos);
    r.mesh.scale.setScalar(size);
    r.billboard = !normal;
    if (normal) r.mesh.quaternion.setFromUnitVectors(_v.set(0, 0, 1), normal);
    else if (this.camera) r.mesh.quaternion.copy(this.camera.quaternion);
    r.age = 0;
    r.life = life;
    r.mat.uniforms.uColor.value.setHex(color);
    r.mat.uniforms.uProgress.value = 0;
    r.mat.uniforms.uWidth.value = width;
    r.mat.uniforms.uAlpha.value = alpha;
    r.mat.uniforms.uSeed.value = Math.random() * 50;
  }

  private decal(point: THREE.Vector3, normal: THREE.Vector3, cell: number, size: number): void {
    const d = this.decals[this.decalIndex];
    this.decalIndex = (this.decalIndex + 1) % DECALS;
    d.geometry = this.decalGeos[cell];
    d.position.copy(point).addScaledVector(normal, 0.006);
    d.lookAt(_v.copy(point).add(normal));
    d.rotateZ(Math.random() * Math.PI * 2);
    d.scale.setScalar(size * rand(0.85, 1.2));
    d.visible = true;
  }

  // ───────────────────────── 사격 ─────────────────────────

  /** 벽·바닥 착탄: 탄흔 + 재질별 먼지/파편/불똥/나뭇조각 */
  impact(point: THREE.Vector3, normal: THREE.Vector3, material = 'concrete'): void {
    const p = PROFILES[material] ?? PROFILES.concrete;
    this.decal(point, normal, p.decal, p.decalSize);
    const floor = normal.y > 0.7 ? point.y : this.floorAt(point.x, point.y, point.z);
    const base = _t1.copy(point).addScaledVector(normal, 0.03);
    // 먼지: 법선 방향으로 뿜어져 나와 퍼지며 천천히 가라앉음
    for (let i = 0; i < p.dust; i++) {
      const dir = coneDir(normal, 0.6, _w);
      this.emit(this.smoke, {
        pos: base, vel: dir.multiplyScalar(rand(0.6, 2.2)), life: rand(0.8, 1.5), size: rand(0.1, 0.18), sizeEnd: rand(0.5, 0.85),
        color: col(p.dustCol), alpha: rand(0.45, 0.7), fadeIn: 0.03, fadeOut: 0.7, rotVel: rand(-1, 1), drag: 3.2, gravity: 0.25, frame: pick(FRAME.dust), grow: 0.9,
      });
    }
    // 중심의 밀도 높은 먼지 한 덩이
    if (p.dust > 0)
      this.emit(this.smoke, {
        pos: base, vel: _w.copy(normal).multiplyScalar(0.5), life: 0.55, size: 0.08, sizeEnd: 0.4, color: col(p.dustCol), alpha: 0.85, fadeOut: 0.35, drag: 3, frame: pick(FRAME.smoke),
      });
    // 파편 조각: 회전하며 튀고 바닥에서 튕김
    for (let i = 0; i < p.chips; i++) {
      const dir = coneDir(normal, 0.9, _w);
      this.emit(this.smoke, {
        pos: base, vel: dir.multiplyScalar(rand(2, 4.5)), life: rand(0.5, 0.9), size: rand(0.015, 0.035), color: _c1.copy(col(p.chipCol)).multiplyScalar(rand(0.7, 1.2)),
        fadeOut: 0.2, rotVel: rand(-20, 20), gravity: 11, frame: pick(FRAME.chunk), floor, bounce: 0.35,
      });
    }
    // 나뭇조각: 길쭉한 줄무늬
    for (let i = 0; i < p.splinters; i++) {
      const dir = coneDir(normal, 0.8, _w);
      this.emit(this.smoke, {
        pos: base, vel: dir.multiplyScalar(rand(2.5, 5)), life: rand(0.4, 0.8), size: rand(0.02, 0.032), color: col(0xb08a58), fadeOut: 0.2,
        gravity: 10, frame: FRAME.streak, stretch: 0.025, floor, bounce: 0.2,
      });
    }
    // 불똥: 금속은 많이, 콘크리트는 조금. 속도 방향으로 늘어난 줄무늬
    for (let i = 0; i < p.sparks; i++) {
      const dir = coneDir(normal, 0.85, _w);
      this.emit(this.glow, {
        pos: base, vel: dir.multiplyScalar(rand(3, 8)), life: rand(0.2, 0.5), size: rand(0.025, 0.04), color: col(0xffe0a0), colorEnd: col(0xff5010),
        fadeOut: 0.12, gravity: 9, drag: 1.5, frame: FRAME.streak, stretch: 0.02, floor, bounce: 0.45,
      });
    }
    if (p.sparks > 0) {
      const big = p.sparks > 4;
      this.emit(this.glow, { pos: base, life: big ? 0.08 : 0.05, size: big ? 0.4 : 0.22, sizeEnd: 0.12, color: col(0xffd890), alpha: big ? 0.9 : 0.5, fadeOut: 0.05, frame: FRAME.glow });
    }
  }

  /** 캐릭터 피격 (몸: 붉은 파편 + 옅은 안개 / 머리: 밝은 섬광 + 고리 + 노란 불똥) */
  hit(point: THREE.Vector3, normal: THREE.Vector3, head: boolean): void {
    const base = _t1.copy(point);
    if (head) {
      this.emit(this.glow, { pos: base, life: 0.12, size: 0.5, sizeEnd: 0.2, color: col(0xfff4c0), fadeOut: 0.1, frame: FRAME.glow });
      this.ring(base, 0.2, 0.18, 0xffe070, undefined, 0.07, 0.8);
      for (let i = 0; i < 12; i++) {
        const dir = coneDir(normal, 1.1, _w);
        this.emit(this.glow, {
          pos: base, vel: dir.multiplyScalar(rand(3, 7)), life: rand(0.15, 0.35), size: rand(0.022, 0.035), color: col(0xfff0a0), colorEnd: col(0xff9020),
          fadeOut: 0.1, gravity: 6, drag: 2, frame: FRAME.streak, stretch: 0.02,
        });
      }
    } else {
      this.emit(this.glow, { pos: base, life: 0.08, size: 0.28, sizeEnd: 0.12, color: col(0xff8060), alpha: 0.8, fadeOut: 0.07, frame: FRAME.glow });
      for (let i = 0; i < 7; i++) {
        const dir = coneDir(normal, 1.0, _w);
        this.emit(this.glow, {
          pos: base, vel: dir.multiplyScalar(rand(2, 5)), life: rand(0.12, 0.3), size: rand(0.02, 0.032), color: col(0xff7a50), colorEnd: col(0xa01808),
          fadeOut: 0.1, gravity: 8, drag: 2, frame: FRAME.streak, stretch: 0.018,
        });
      }
    }
    // 피격 안개 (둘 다)
    for (let i = 0; i < 2; i++) {
      const dir = coneDir(normal, 0.8, _w);
      this.emit(this.smoke, {
        pos: base, vel: dir.multiplyScalar(rand(0.4, 1.2)), life: rand(0.3, 0.5), size: 0.06, sizeEnd: rand(0.18, 0.28),
        color: col(head ? 0xd0b080 : 0xb04030), alpha: 0.28, fadeOut: 0.3, drag: 3, frame: pick(FRAME.dust),
      });
    }
  }

  /** 예광탄: 총구에서 착탄점까지 실제로 날아가는 빛줄기 (꼬리 길이 고정, 착탄점에서 멈춤) */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffe6a0): void {
    const dir = _w.copy(to).sub(from);
    const dist = dir.length();
    if (dist < 0.5) return;
    dir.divideScalar(dist);
    const speed = 320;
    const len = Math.min(4, dist * 0.6);
    // 총구 바로 앞은 건너뜀 (화면 아래쪽을 덮지 않게)
    const start = _t2.copy(from).addScaledVector(dir, 0.4);
    const lim = dist - 0.4;
    this.emit(this.glow, {
      pos: start, vel: _v.copy(dir).multiplyScalar(speed), life: (lim + len) / speed, size: color === 0xffe6a0 ? 0.018 : 0.03, color: col(color), colorEnd: col(color === 0xffe6a0 ? 0xffb050 : color),
      alpha: 0.95, fadeOut: 0, frame: FRAME.streak, stretch: -len, limit: lim,
    });
  }

  /** 총구 연기: 사격 직후 피어오르는 옅은 연기 */
  muzzleSmoke(pos: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 2; i++) {
      this.emit(this.smoke, {
        pos, vel: _w.copy(dir).multiplyScalar(rand(0.6, 1.4)).add(_v.set(rand(-0.15, 0.15), rand(0.1, 0.35), rand(-0.15, 0.15))),
        life: rand(0.6, 1.1), size: 0.05, sizeEnd: rand(0.22, 0.35), color: col(0xb0b0b0), alpha: 0.22, fadeIn: 0.05, fadeOut: 0.6,
        rotVel: rand(-1.5, 1.5), drag: 2.5, gravity: -0.35, frame: pick(FRAME.dust), grow: 0.8,
      });
    }
  }

  // ───────────────────────── 능력 ─────────────────────────

  /** 투척물 꼬리 (매 프레임) */
  trail(pos: THREE.Vector3, color: number): void {
    this.emit(this.glow, { pos, life: 0.28, size: 0.12, sizeEnd: 0.03, color: col(color), alpha: 0.75, fadeOut: 0.25, frame: FRAME.glow });
    if (Math.random() < 0.5)
      this.emit(this.smoke, { pos, vel: _v.set(rand(-0.2, 0.2), rand(0, 0.3), rand(-0.2, 0.2)), life: 0.5, size: 0.05, sizeEnd: 0.14, color: col(0x9a9a9a), alpha: 0.2, fadeOut: 0.4, frame: pick(FRAME.dust) });
  }

  /**
   * 연막: 깡통에서 연기가 뿜어져 나와(분사) 반구 모양으로 부풀고, 지속 중에는 천천히 소용돌이치며,
   * 끝날 때 옅어지며 흩어진다. 위쪽은 밝고 아래쪽은 어두워 부피감이 생긴다.
   */
  smokeCloud(pos: THREE.Vector3, radius: number, duration: number, tint = 0x8f9aa0): void {
    const tintC = col(tint);
    const ground = pos.y;
    // 1) 분사: 바닥에서 빠르게 뿜어져 나오는 작은 연기
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const out = _w.set(Math.cos(a), rand(0.3, 1.1), Math.sin(a)).normalize().multiplyScalar(rand(4, 8));
      this.emit(this.smoke, {
        pos: _v.set(pos.x, ground + 0.15, pos.z), vel: out, life: rand(1.2, 2.2), size: 0.3, sizeEnd: rand(1.4, 2.2), grow: 1,
        color: col(0xc8cccf), alpha: 0.75, fadeIn: 0.05, fadeOut: 0.9, rotVel: rand(-0.6, 0.6), drag: 2.6, frame: pick(FRAME.smoke),
      });
    }
    // 2) 몸체: 반구 안의 목표점으로 퍼져 나가 자리 잡는 큰 덩어리
    const N = 34;
    for (let i = 0; i < N; i++) {
      // 반구 안 균일 분포 (아래쪽이 넓도록 높이를 약간 눌러 줌)
      const u = Math.random();
      const th = rand(0, Math.PI * 2);
      const ph = Math.acos(rand(0, 1));
      const rr = radius * Math.cbrt(u) * 0.78;
      const tx = Math.cos(th) * Math.sin(ph) * rr;
      const tz = Math.sin(th) * Math.sin(ph) * rr;
      const ty = Math.cos(ph) * rr * 0.85 + radius * 0.25;
      const drag = rand(1.8, 2.6);
      const h = THREE.MathUtils.clamp(ty / (radius * 1.1), 0, 1);
      // 높이에 따른 음영: 위는 밝고 아래는 어둡다
      const shade = 0.72 + 0.4 * h;
      const c = tintC.clone().multiplyScalar(shade);
      this.emit(this.smoke, {
        pos: _v.set(pos.x, ground + 0.4, pos.z), vel: _w.set(tx, ty - 0.4, tz).multiplyScalar(drag), life: duration + rand(-0.4, 0.6),
        size: 0.8, sizeEnd: radius * rand(0.62, 0.85), grow: rand(1.2, 2.0), color: c, colorEnd: c.clone().multiplyScalar(1.08),
        alpha: 0.93, fadeIn: 0.12, fadeOut: rand(1.4, 2.0), rotVel: rand(-0.12, 0.12), drag, gravity: -0.015, wobble: 0.1, frame: pick(FRAME.smoke),
      });
    }
    // 3) 가장자리 옅은 연기: 실루엣이 매끈한 공처럼 보이지 않도록
    for (let i = 0; i < 16; i++) {
      const th = rand(0, Math.PI * 2);
      const tx = Math.cos(th) * radius * rand(0.75, 1.0);
      const tz = Math.sin(th) * radius * rand(0.75, 1.0);
      const ty = rand(0.2, radius * 0.9);
      const drag = 1.6;
      this.emit(this.smoke, {
        pos: _v.set(pos.x, ground + 0.4, pos.z), vel: _w.set(tx, ty, tz).multiplyScalar(drag), life: duration + rand(-1, 0.8),
        size: 0.6, sizeEnd: radius * rand(0.45, 0.65), grow: 2.4, color: tintC.clone().multiplyScalar(0.95), alpha: 0.42, fadeIn: 0.4, fadeOut: 2.2,
        rotVel: rand(-0.2, 0.2), drag, gravity: -0.03, wobble: 0.18, frame: pick(FRAME.dust),
      });
    }
  }

  /** 방벽 파괴: 결정 조각이 흩어지고 빛 가루가 남는다 */
  shatter(center: THREE.Vector3, size: THREE.Vector3, color: number): void {
    const c = col(color);
    const floor = center.y - size.y / 2;
    for (let i = 0; i < 46; i++) {
      const p = _v.set(center.x + rand(-0.5, 0.5) * size.x, center.y + rand(-0.5, 0.5) * size.y, center.z + rand(-0.5, 0.5) * size.z);
      const out = _w.set(rand(-1, 1), rand(0, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(1, 3.2));
      this.emit(this.smoke, {
        pos: p, vel: out, life: rand(0.8, 1.5), size: rand(0.06, 0.16), color: _c1.copy(c).multiplyScalar(rand(0.8, 1.6)), fadeOut: 0.5,
        rotVel: rand(-12, 12), gravity: 9, frame: pick(FRAME.chunk), floor, bounce: 0.3,
      });
      if (i % 2 === 0)
        this.emit(this.glow, {
          pos: p, vel: out.multiplyScalar(0.4), life: rand(0.5, 1.1), size: rand(0.05, 0.12), color: c, alpha: 0.9, fadeOut: 0.5, drag: 2, gravity: -0.5, frame: FRAME.glow,
        });
    }
    this.emit(this.glow, { pos: center, life: 0.25, size: Math.max(size.x, size.z) * 1.2, sizeEnd: Math.max(size.x, size.z) * 0.5, color: c, alpha: 0.6, fadeOut: 0.2, frame: FRAME.glow });
    this.light(center, color, 10, 0.35, 10);
  }

  /** 방벽이 솟아오를 때 바닥 선을 따라 튀는 불꽃 */
  wallRiseSparks(center: THREE.Vector3, size: THREE.Vector3, y: number, color: number): void {
    const c = col(color);
    for (let i = 0; i < 3; i++) {
      const p = _v.set(center.x + rand(-0.5, 0.5) * size.x, y, center.z + rand(-0.5, 0.5) * size.z);
      this.emit(this.glow, {
        pos: p, vel: _w.set(rand(-1, 1), rand(1, 3), rand(-1, 1)), life: rand(0.25, 0.5), size: 0.02, color: col(0xe8fffa), colorEnd: c,
        fadeOut: 0.2, gravity: 6, frame: FRAME.streak, stretch: 0.03,
      });
    }
  }

  /** 섬광탄 폭발: 강한 빛 → 방사형 광선 → 남는 열기와 연기 */
  flare(pos: THREE.Vector3): void {
    this.emit(this.glow, { pos, life: 0.35, size: 8, sizeEnd: 3, color: col(0xffffff), alpha: 0.55, fadeOut: 0.3, frame: FRAME.glow });
    this.emit(this.glow, { pos, life: 1.0, size: 1.8, sizeEnd: 0.6, color: col(0xfff0c0), colorEnd: col(0xff9040), alpha: 0.6, fadeOut: 0.8, frame: FRAME.glow });
    for (let i = 0; i < 14; i++) {
      const dir = _w.set(rand(-1, 1), rand(-0.6, 1), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos, vel: dir.multiplyScalar(rand(6, 12)), life: rand(0.3, 0.6), size: 0.04, color: col(0xffffff), colorEnd: col(0xffd080),
        fadeOut: 0.25, drag: 4, gravity: 3, frame: FRAME.streak, stretch: 0.05,
      });
    }
    this.ring(pos, 2.2, 0.35, 0xfff6d0, undefined, 0.1, 0.8);
    for (let i = 0; i < 5; i++)
      this.emit(this.smoke, {
        pos, vel: _w.set(rand(-0.6, 0.6), rand(0.2, 0.8), rand(-0.6, 0.6)), life: rand(1.5, 2.5), size: 0.2, sizeEnd: rand(0.8, 1.2),
        color: col(0xd8d4cc), alpha: 0.35, fadeIn: 0.2, fadeOut: 1.2, drag: 1.5, gravity: -0.2, frame: pick(FRAME.dust),
      });
    this.light(pos, 0xfff4e0, 60, 0.45, 30);
  }

  /** 비콘 신호: 바닥을 따라 퍼지는 음파 고리 + 섬광 */
  beaconPulse(pos: THREE.Vector3, radius: number): void {
    this.ring(_v.copy(pos).setY(pos.y + 0.05), radius, 1.1, 0x40c8ff, _w.set(0, 1, 0), 0.03, 0.7);
    this.ring(pos, 0.6, 0.3, 0x9ae8ff, undefined, 0.2, 0.9);
    this.emit(this.glow, { pos, life: 0.3, size: 0.9, sizeEnd: 0.3, color: col(0x60d8ff), fadeOut: 0.25, frame: FRAME.glow });
  }

  /** 지역 효과가 펼쳐질 때 */
  zoneBurst(pos: THREE.Vector3, radius: number, color: number): void {
    this.ring(_v.copy(pos).setY(pos.y + 0.06), radius * 1.05, 0.6, color, _w.set(0, 1, 0), 0.06, 1);
    this.emit(this.glow, { pos, life: 0.3, size: radius * 0.8, sizeEnd: radius * 0.3, color: col(color), alpha: 0.6, fadeOut: 0.25, frame: FRAME.glow });
    this.light(_v.copy(pos).setY(pos.y + 1), color, 12, 0.6, radius * 3);
  }

  /** 지역 효과 지속 입자 (매 프레임, 면적에 비례) */
  zoneTick(dt: number, pos: THREE.Vector3, radius: number, color: number, kind: 0 | 1, strength: number): void {
    const area = radius * radius;
    const c = col(color);
    const sample = (out: THREE.Vector3, edge = false) => {
      const a = rand(0, Math.PI * 2);
      const r = edge ? radius * rand(0.92, 1) : radius * Math.sqrt(Math.random()) * 0.95;
      return out.set(pos.x + Math.cos(a) * r, pos.y + 0.05, pos.z + Math.sin(a) * r);
    };
    const chance = (rate: number) => {
      const n = rate * dt * strength;
      return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    };
    if (kind === 0) {
      // 불꽃 혀: 바닥에서 솟아 흔들리며 사그라짐
      for (let i = chance(area * 3.2); i > 0; i--)
        this.emit(this.glow, {
          pos: sample(_v).setY(pos.y + 0.25), vel: _w.set(rand(-0.2, 0.2), rand(1.2, 2.4), rand(-0.2, 0.2)), life: rand(0.45, 0.85), size: rand(0.6, 1.1), sizeEnd: 0.25,
          color: col(0xffd070), colorEnd: _c1.copy(c).multiplyScalar(0.6), alpha: 0.85, fadeIn: 0.08, fadeOut: 0.35, rot: rand(-0.25, 0.25), drag: 1, wobble: 0.3, frame: pick(FRAME.flame),
        });
      // 불씨: 떠오르며 흔들림
      for (let i = chance(area * 1.4); i > 0; i--)
        this.emit(this.glow, {
          pos: sample(_v), vel: _w.set(rand(-0.4, 0.4), rand(1.5, 3.5), rand(-0.4, 0.4)), life: rand(0.8, 1.6), size: rand(0.012, 0.025), color: col(0xffc060), colorEnd: col(0xff3000),
          fadeOut: 0.4, drag: 0.6, wobble: 0.6, frame: FRAME.streak, stretch: 0.03,
        });
      // 검은 연기
      for (let i = chance(area * 0.35); i > 0; i--)
        this.emit(this.smoke, {
          pos: sample(_v).setY(pos.y + 0.8), vel: _w.set(rand(-0.2, 0.2), rand(0.8, 1.6), rand(-0.2, 0.2)), life: rand(1.2, 2), size: 0.3, sizeEnd: rand(1, 1.6),
          color: col(0x2a2420), alpha: 0.4, fadeIn: 0.3, fadeOut: 0.9, rotVel: rand(-0.6, 0.6), drag: 0.6, wobble: 0.3, frame: pick(FRAME.smoke),
        });
    } else {
      // 봉쇄장: 떠오르는 빛 입자 + 가장자리의 세로 빛줄기
      for (let i = chance(area * 0.6); i > 0; i--)
        this.emit(this.glow, {
          pos: sample(_v), vel: _w.set(0, rand(0.6, 1.4), 0), life: rand(1.2, 2.2), size: rand(0.05, 0.1), color: _c1.copy(c).lerp(col(0xffffff), 0.4), colorEnd: c,
          alpha: 0.9, fadeIn: 0.3, fadeOut: 0.6, wobble: 0.15, frame: FRAME.glow,
        });
      for (let i = chance(radius * 3); i > 0; i--)
        this.emit(this.glow, {
          pos: sample(_v, true), vel: _w.set(0, rand(2, 3.5), 0), life: rand(0.5, 0.9), size: 0.03, color: _c2.copy(c).lerp(col(0xffffff), 0.3),
          alpha: 0.85, fadeOut: 0.3, frame: FRAME.streak, stretch: 0.25,
        });
    }
  }

  /** 돌진: 발밑 흙먼지 + 몸을 스쳐 지나가는 바람 줄기 */
  dash(pos: THREE.Vector3, dir: THREE.Vector3, color: number): void {
    for (let i = 0; i < 8; i++)
      this.emit(this.smoke, {
        pos: _v.set(pos.x + rand(-0.3, 0.3), pos.y + 0.1, pos.z + rand(-0.3, 0.3)),
        vel: _w.copy(dir).multiplyScalar(-rand(1, 3)).add(_t2.set(rand(-1, 1), rand(0.2, 0.8), rand(-1, 1))),
        life: rand(0.6, 1), size: 0.15, sizeEnd: rand(0.6, 0.9), color: col(0x9a9080), alpha: 0.45, fadeOut: 0.5, drag: 2.5, frame: pick(FRAME.dust),
      });
    const side = _t1.set(-dir.z, 0, dir.x);
    for (let i = 0; i < 14; i++) {
      const s = rand(-1, 1) > 0 ? rand(0.5, 1.2) : -rand(0.5, 1.2);
      const p = _v.copy(pos).addScaledVector(dir, rand(1, 5)).addScaledVector(side, s).setY(pos.y + rand(0.3, 2));
      this.emit(this.smoke, {
        pos: p, vel: _w.copy(dir).multiplyScalar(0.6), life: rand(0.2, 0.32), size: 0.022, color: _c1.setHex(0xffffff).lerp(col(color), 0.3),
        alpha: 0.6, fadeIn: 0.04, fadeOut: 0.12, frame: FRAME.streak, stretch: 2.8,
      });
    }
  }

  /**
   * 폭발 (Core): 섬광 → 불덩이 → 충격파 → 파편·불똥 → 바닥을 쓰는 먼지 → 피어오르는 연기 기둥 → 그을음.
   */
  /** 작은 폭발 (능력 폭약·미사일·폭격): 섬광 → 불덩이 → 파편 → 연기 + 바닥 고리 */
  blast(pos: THREE.Vector3, radius: number, color = 0xffb060): void {
    const s = radius / 4;
    this.emit(this.glow, { pos, life: 0.16, size: 4 * s, sizeEnd: 2 * s, color: col(0xfff4d0), fadeOut: 0.14, frame: FRAME.glow });
    for (let i = 0; i < 12; i++) {
      const dir = _w.set(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos: _v.copy(pos).addScaledVector(dir, rand(0, 0.4)), vel: dir.multiplyScalar(rand(3, 7) * s), life: rand(0.4, 0.7), size: 0.8 * s, sizeEnd: rand(1.8, 2.6) * s,
        color: col(color), colorEnd: col(0x701400), alpha: 0.6, fadeOut: 0.35, rotVel: rand(-1, 1), drag: 3.5, gravity: -2, frame: pick(FRAME.smoke), grow: 0.4,
      });
    }
    for (let i = 0; i < 18; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.3, 1.3), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos, vel: dir.multiplyScalar(rand(5, 12)), life: rand(0.5, 1), size: 0.03, color: col(0xffe0a0), colorEnd: col(0xff3a00),
        fadeOut: 0.3, gravity: 12, frame: FRAME.streak, stretch: 0.03, floor: pos.y - 0.3, bounce: 0.3,
      });
    }
    for (let i = 0; i < 8; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.3, 1), rand(-1, 1)).normalize();
      this.emit(this.smoke, {
        pos, vel: dir.multiplyScalar(rand(1, 3) * s), life: rand(1.5, 2.5), size: 0.8 * s, sizeEnd: rand(2, 3) * s, grow: 1.4,
        color: col(0x3a332c), colorEnd: col(0x6a645c), alpha: 0.6, fadeIn: 0.2, fadeOut: 1, drag: 1.4, gravity: -0.6, frame: pick(FRAME.smoke),
      });
    }
    this.ring(_v.set(pos.x, pos.y - 0.25, pos.z), radius * 1.1, 0.4, 0xffc890, _w.set(0, 1, 0), 0.08, 0.9);
    this.light(pos, 0xffb060, 25, 0.35, radius * 4);
  }

  /** 충격파 (기절/충격): 땅이 들썩이는 먼지 고리 + 흔들리는 빛 */
  shockwave(pos: THREE.Vector3, radius: number, color = 0xffa040): void {
    this.ring(_v.set(pos.x, pos.y + 0.06, pos.z), radius, 0.55, color, _w.set(0, 1, 0), 0.07, 0.9);
    this.ring(_v.set(pos.x, pos.y + 0.8, pos.z), radius * 0.6, 0.35, 0xfff0d0, undefined, 0.06, 0.5);
    const n = Math.round(6 + radius * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.emit(this.smoke, {
        pos: _v.set(pos.x + Math.cos(a) * radius * 0.3, pos.y + 0.2, pos.z + Math.sin(a) * radius * 0.3), vel: _w.set(Math.cos(a), rand(0.2, 0.6), Math.sin(a)).multiplyScalar(rand(4, 7)),
        life: rand(0.8, 1.3), size: 0.4, sizeEnd: rand(1.2, 1.8), color: col(0x9a8a70), alpha: 0.55, fadeOut: 0.7, drag: 3, frame: pick(FRAME.dust),
      });
    }
  }

  /** 금속 가시가 퍼지는 고리 (무력화 궁극기) */
  thicket(pos: THREE.Vector3, radius: number, color: number): void {
    this.ring(_v.set(pos.x, pos.y + 0.08, pos.z), radius, 1.2, color, _w.set(0, 1, 0), 0.03, 1);
    this.ring(_v.set(pos.x, pos.y + 0.08, pos.z), radius * 0.5, 0.9, 0xe8e0ff, _w.set(0, 1, 0), 0.05, 0.8);
    for (let i = 0; i < 60; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(1, radius);
      this.emit(this.glow, {
        pos: _v.set(pos.x + Math.cos(a) * r, pos.y + 0.05, pos.z + Math.sin(a) * r), vel: _w.set(0, rand(2, 5), 0), life: rand(0.4, 0.8), size: 0.035,
        color: col(0xf0e8ff), colorEnd: col(color), fadeOut: 0.3, drag: 3, frame: FRAME.streak, stretch: 0.12,
      });
    }
    this.light(_v.copy(pos).setY(pos.y + 1), color, 6, 0.6, radius * 0.6);
  }

  /** 쇠약 폭발: 분홍빛 나비 같은 입자가 흩어짐 */
  witherBurst(pos: THREE.Vector3, radius: number, color: number): void {
    this.ring(_v.set(pos.x, pos.y + 0.06, pos.z), radius, 0.5, color, _w.set(0, 1, 0), 0.1, 0.9);
    for (let i = 0; i < 40; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos: _v.copy(pos).setY(pos.y + 0.5), vel: dir.multiplyScalar(rand(2, 6)), life: rand(0.8, 1.6), size: rand(0.06, 0.12), color: col(0xffd0f0), colorEnd: col(color),
        alpha: 0.9, fadeOut: 0.6, drag: 2.5, gravity: -0.6, wobble: 0.6, frame: FRAME.glow,
      });
    }
    for (let i = 0; i < 6; i++)
      this.emit(this.smoke, {
        pos: _v.copy(pos).setY(pos.y + 0.6), vel: _w.set(rand(-1, 1), rand(0, 0.6), rand(-1, 1)).multiplyScalar(2), life: rand(1.2, 2), size: 0.6, sizeEnd: radius * 0.6,
        color: col(0x8a4a7a), alpha: 0.35, fadeIn: 0.1, fadeOut: 1, drag: 2, frame: pick(FRAME.dust),
      });
  }

  explosion(pos: THREE.Vector3, radius: number): void {
    const ground = pos.y - 0.5;
    const s = radius / 12;
    // 섬광
    this.emit(this.glow, { pos, life: 0.22, size: 16 * s, sizeEnd: 8 * s, color: col(0xfff8e0), fadeOut: 0.2, frame: FRAME.glow });
    for (let i = 0; i < 6; i++)
      this.emit(this.glow, {
        pos, vel: _w.set(rand(-1, 1), rand(0, 1), rand(-1, 1)).multiplyScalar(2), life: rand(0.4, 0.7), size: 5 * s, sizeEnd: 9 * s,
        color: col(0xffc060), colorEnd: col(0xa02000), alpha: 0.7, fadeOut: 0.4, drag: 3, frame: FRAME.glow,
      });
    // 불덩이: 뭉게진 불 덩어리가 사방으로 부풀며 위로 말려 올라가고, 노랑 → 주황 → 검붉게 식는다
    for (let i = 0; i < 30; i++) {
      const dir = _w.set(rand(-1, 1), rand(-0.1, 1), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos: _v.copy(pos).addScaledVector(dir, rand(0, 0.8)), vel: dir.multiplyScalar(rand(6, 13) * s), life: rand(0.7, 1.3), size: 1.6 * s, sizeEnd: rand(3.8, 5.8) * s,
        color: col(0xffd890), colorEnd: col(0x801800), alpha: 0.6, fadeOut: 0.6, rotVel: rand(-1.2, 1.2), drag: 3.2, gravity: -2.5, frame: pick(FRAME.smoke), grow: 0.6,
      });
    }
    // 불꽃 혀: 불덩이 위로 솟는 혀
    for (let i = 0; i < 10; i++)
      this.emit(this.glow, {
        pos: _v.copy(pos).add(_w.set(rand(-1, 1), rand(0, 1), rand(-1, 1)).multiplyScalar(2 * s)), vel: _t2.set(rand(-2, 2), rand(5, 9), rand(-2, 2)).multiplyScalar(s),
        life: rand(0.5, 0.9), size: 2.5 * s, sizeEnd: 4 * s, color: col(0xffe0a0), colorEnd: col(0xa02000), alpha: 0.7, fadeOut: 0.4, rot: rand(-0.3, 0.3), drag: 2, frame: pick(FRAME.flame),
      });
    // 충격파: 바닥 고리 + 공중 고리
    this.ring(_v.set(pos.x, ground + 0.08, pos.z), radius * 1.3, 0.7, 0xffd0a0, _w.set(0, 1, 0), 0.08, 1);
    this.ring(pos, radius * 0.7, 0.45, 0xfff0d0, undefined, 0.05, 0.6);
    // 불똥: 높이 솟구쳤다 떨어지며 바닥에서 튕김
    for (let i = 0; i < 60; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize();
      this.emit(this.glow, {
        pos, vel: dir.multiplyScalar(rand(8, 24)), life: rand(1, 2.4), size: rand(0.025, 0.05), color: col(0xffe0a0), colorEnd: col(0xff3a00),
        fadeOut: 0.5, gravity: 12, drag: 0.6, frame: FRAME.streak, stretch: 0.03, floor: ground, bounce: 0.3,
      });
    }
    // 파편
    for (let i = 0; i < 28; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.3, 1.2), rand(-1, 1)).normalize();
      this.emit(this.smoke, {
        pos, vel: dir.multiplyScalar(rand(6, 16)), life: rand(1.6, 2.8), size: rand(0.08, 0.2), color: col(0x2c2a28), fadeOut: 0.6,
        rotVel: rand(-15, 15), gravity: 15, frame: pick(FRAME.chunk), floor: ground, bounce: 0.3,
      });
    }
    // 바닥을 쓸고 나가는 먼지 고리
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + rand(-0.1, 0.1);
      this.emit(this.smoke, {
        pos: _v.set(pos.x, ground + 0.4, pos.z), vel: _w.set(Math.cos(a), rand(0.02, 0.12), Math.sin(a)).multiplyScalar(rand(14, 22) * s),
        life: rand(1.8, 2.8), size: 1, sizeEnd: rand(3, 4.5) * s, grow: 1.2, color: col(0x8a7c68), alpha: 0.6, fadeIn: 0.05, fadeOut: 1.4,
        rotVel: rand(-0.8, 0.8), drag: 2.4, frame: pick(FRAME.smoke),
      });
    }
    // 연기 기둥: 불덩이 뒤에 나타나 위로 피어오름 (어두운 아래 → 밝은 위)
    for (let i = 0; i < 42; i++) {
      const dir = _w.set(rand(-1, 1), rand(0.2, 1.3), rand(-1, 1)).normalize();
      const h = Math.random();
      this.emit(this.smoke, {
        pos: _v.copy(pos).addScaledVector(dir, rand(0, 1.5)), vel: dir.multiplyScalar(rand(3, 9) * s).add(_t2.set(0, h * 3, 0)),
        life: rand(3.5, 6), size: 1.5 * s, sizeEnd: rand(4.5, 7) * s, grow: 2.5, color: col(0x2a2420), colorEnd: col(0x5a544c),
        alpha: 0.85, fadeIn: 0.3, fadeOut: 2.2, rotVel: rand(-0.4, 0.4), drag: 1.4, gravity: -0.9, wobble: 0.4, frame: pick(FRAME.smoke),
      });
    }
    // 그을음
    this.scorch.position.set(pos.x, ground + 0.02, pos.z);
    this.scorch.scale.setScalar(radius * 0.7);
    this.scorch.rotation.z = Math.random() * Math.PI;
    this.scorch.visible = true;
  }
}
