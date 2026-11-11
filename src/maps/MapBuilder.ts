import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPSXMaterial } from '../graphics/PSXMaterial';
import { getTexture, type TextureName } from '../graphics/textures';
import { CollisionWorld, type AABB } from '../physics/CollisionWorld';
import { FLOOR_CELLS, PROP_CELLS, SOLID_CELLS, type MapDefinition } from './MapData';

export interface SpawnPoint {
  position: THREE.Vector3;
  yaw: number;
}

export interface BuiltMap {
  def: MapDefinition;
  root: THREE.Group;
  collision: CollisionWorld;
  sun: THREE.DirectionalLight;
  spawns: { attackers: SpawnPoint[]; defenders: SpawnPoint[] };
  /** 설치 가능 구역 (Phase 5에서 Core 설치 판정에 사용) */
  sites: Record<'A' | 'B', AABB>;
  bounds: AABB;
  /** 이 위치에서 밟고 있는 표면의 재질 (발소리) */
  surfaceAt(x: number, y: number, z: number): string;
}

type UVMode = 'world' | 'box';

interface PendingGeo {
  geo: THREE.BufferGeometry;
  castShadow: boolean;
}

/** 텍스처 → 효과음 재질 */
const TEX_MATERIAL: Partial<Record<TextureName, string>> = {
  concrete: 'concrete', plaster: 'concrete', brick: 'stone', metal: 'steel', crate: 'wood', ground: 'dirt',
  tile: 'stone', siteA: 'concrete', siteB: 'concrete', hazard: 'concrete', spawnAtk: 'concrete', spawnDef: 'concrete',
  roof: 'iron', stair: 'concrete', trim: 'iron',
};

/** 텍스처 1장이 덮는 월드 크기 (m) — 텍셀 밀도를 맵 전체에서 일정하게 유지 */
const TEX_WORLD_SIZE = 2;

/**
 * MapDefinition(ASCII 격자)을 Three.js 기본 도형으로 변환한다.
 * 같은 텍스처를 쓰는 지오메트리는 하나로 병합해서 드로우 콜을 줄인다.
 */
export class MapBuilder {
  private pending = new Map<TextureName, PendingGeo[]>();
  private collision = new CollisionWorld();
  private root = new THREE.Group();
  private rows: number;
  private cols: number;
  private originX: number;
  private originZ: number;
  /** 서버: 충돌·스폰·구역만 만들고 메시는 만들지 않는다 */
  private headless = false;

  constructor(private def: MapDefinition) {
    this.rows = def.layout.length;
    this.cols = def.layout[0].length;
    def.layout.forEach((row, r) => {
      if (row.length !== this.cols)
        throw new Error(`[${def.id}] ${r}번째 줄의 길이가 ${row.length}입니다 (기대값 ${this.cols})`);
    });
    this.originX = (-this.cols * def.cellSize) / 2;
    this.originZ = (-this.rows * def.cellSize) / 2;
    this.root.name = `map:${def.id}`;
  }

  build(): BuiltMap {
    const { def } = this;
    const cs = def.cellSize;

    this.buildFloors();
    this.buildSiteBorders();
    this.buildWalls();
    this.buildRoofs();
    this.buildProps();
    this.flush();

    // 맵 전체 바닥 충돌 (시각 바닥과 별도로 하나의 큰 박스)
    const bounds: AABB = {
      minX: this.originX, maxX: this.originX + this.cols * cs,
      minY: 0, maxY: def.wallHeight,
      minZ: this.originZ, maxZ: this.originZ + this.rows * cs,
    };
    this.collision.add({ ...bounds, minY: -2, maxY: 0 });

    const sites = {
      A: this.cellBounds('A', 0, 3),
      B: this.cellBounds('B', 0, 3),
    };
    this.addSiteDecal('A', sites.A);
    this.addSiteDecal('B', sites.B);
    this.addIndoorLights();
    this.addSky();
    const sun = this.addLights(bounds);

    return {
      def,
      root: this.root,
      collision: this.collision,
      sun,
      spawns: {
        attackers: this.spawnPoints('T', 0),
        defenders: this.spawnPoints('D', Math.PI),
      },
      sites,
      bounds,
      surfaceAt: (x, y, z) => this.surfaceAt(x, y, z),
    };
  }

  /**
   * 서버용: 충돌 박스·스폰·구역만 (텍스처·메시·조명 없음). 클라이언트 build()와 같은 충돌을 만든다.
   */
  buildCollision(): Pick<BuiltMap, 'def' | 'collision' | 'spawns' | 'sites' | 'bounds'> {
    this.headless = true;
    const { def } = this;
    const cs = def.cellSize;
    this.buildFloors();
    this.buildSiteBorders();
    this.buildWalls();
    this.buildRoofs();
    this.buildProps();
    this.pending.clear();
    const bounds: AABB = {
      minX: this.originX, maxX: this.originX + this.cols * cs,
      minY: 0, maxY: def.wallHeight,
      minZ: this.originZ, maxZ: this.originZ + this.rows * cs,
    };
    this.collision.add({ ...bounds, minY: -2, maxY: 0 });
    return {
      def,
      collision: this.collision,
      spawns: { attackers: this.spawnPoints('T', 0), defenders: this.spawnPoints('D', Math.PI) },
      sites: { A: this.cellBounds('A', 0, 3), B: this.cellBounds('B', 0, 3) },
      bounds,
    };
  }

  // ───────────────────────── 격자 유틸 ─────────────────────────

  private at(r: number, c: number): string {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return '#';
    return this.def.layout[r][c];
  }

  private cellMinX(c: number): number {
    return this.originX + c * this.def.cellSize;
  }

  private cellMinZ(r: number): number {
    return this.originZ + r * this.def.cellSize;
  }

  /** 같은 key를 가진 칸들을 큰 직사각형으로 탐욕적으로 병합한다 */
  private rects(keyOf: (r: number, c: number) => string | null) {
    const used: boolean[][] = this.def.layout.map((row) => Array.from(row, () => false));
    const out: { r0: number; c0: number; r1: number; c1: number; key: string }[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const key = keyOf(r, c);
        if (key === null || used[r][c]) continue;
        let c1 = c;
        while (c1 + 1 < this.cols && !used[r][c1 + 1] && keyOf(r, c1 + 1) === key) c1++;
        let r1 = r;
        outer: while (r1 + 1 < this.rows) {
          for (let cc = c; cc <= c1; cc++)
            if (used[r1 + 1][cc] || keyOf(r1 + 1, cc) !== key) break outer;
          r1++;
        }
        for (let rr = r; rr <= r1; rr++) for (let cc = c; cc <= c1; cc++) used[rr][cc] = true;
        out.push({ r0: r, c0: c, r1, c1, key });
      }
    }
    return out;
  }

  /** 소품 칸의 바닥은 인접한 특수 바닥(구역/스폰/실내)을 따른다 */
  /** 바닥 재질: 받침(상자·발판·계단) 위면 그 재질, 아니면 바닥 칸의 재질 */
  private surfaceAt(x: number, y: number, z: number): string {
    if (y > 0.05) {
      const probe = { minX: x - 0.05, maxX: x + 0.05, minY: y - 0.1, maxY: y + 0.02, minZ: z - 0.05, maxZ: z + 0.05 };
      for (const b of this.collision.query(probe)) {
        if (b.material && Math.abs(b.maxY - y) < 0.08 && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return b.material;
      }
    }
    const c = Math.floor((x - this.originX) / this.def.cellSize);
    const r = Math.floor((z - this.originZ) / this.def.cellSize);
    const kind = this.floorKind(r, c);
    return (kind && TEX_MATERIAL[kind]) || 'concrete';
  }

  private floorKind(r: number, c: number): TextureName | null {
    const ch = this.at(r, c);
    if (SOLID_CELLS.has(ch)) return null;
    const kind = (x: string): TextureName | null =>
      ({ A: 'siteA', B: 'siteB', T: 'spawnAtk', D: 'spawnDef', '+': 'tile', '.': 'ground' } as const)[
        x as 'A'
      ] ?? null;
    if (FLOOR_CELLS.has(ch)) return kind(ch);
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const k = kind(this.at(r + dr, c + dc));
      if (k && k !== 'ground') return k;
    }
    return 'ground';
  }

  // ───────────────────────── 지오메트리 ─────────────────────────

  private addBox(
    b: AABB,
    tex: TextureName,
    opts: { collide?: boolean; uv?: UVMode; castShadow?: boolean } = {},
  ): void {
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const d = b.maxZ - b.minZ;
    // 아핀 왜곡이 과하지 않도록 큰 면은 잘게 나눈다 (PS1 게임들도 같은 방법을 썼다)
    const seg = (s: number) => Math.min(40, Math.max(1, Math.ceil(s / 1.5)));
    const geo = new THREE.BoxGeometry(w, h, d, seg(w), seg(h), seg(d));
    geo.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    if ((opts.uv ?? 'world') === 'world') applyWorldUVs(geo);
    this.queue(tex, geo, opts.castShadow ?? true);
    if (opts.collide ?? true) this.collision.add({ ...b, material: TEX_MATERIAL[tex] });
  }

  private queue(tex: TextureName, geo: THREE.BufferGeometry, castShadow: boolean): void {
    if (this.headless) {
      geo.dispose();
      return;
    }
    let list = this.pending.get(tex);
    if (!list) this.pending.set(tex, (list = []));
    list.push({ geo, castShadow });
  }

  /** 텍스처별로 병합하여 메시 생성 */
  private flush(): void {
    for (const [tex, list] of this.pending) {
      for (const cast of [true, false]) {
        const geos = list.filter((p) => p.castShadow === cast).map((p) => p.geo);
        if (geos.length === 0) continue;
        const merged = mergeGeometries(geos, false);
        if (!merged) throw new Error(`지오메트리 병합 실패: ${tex}`);
        geos.forEach((g) => g.dispose());
        const mesh = new THREE.Mesh(merged, createPSXMaterial({ map: getTexture(tex) }));
        mesh.name = `${tex}${cast ? '' : ':noshadow'}`;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        this.root.add(mesh);
      }
    }
    this.pending.clear();
  }

  // ───────────────────────── 맵 요소 ─────────────────────────

  private buildFloors(): void {
    const { cellSize: cs } = this.def;
    // 맵 전체를 덮는 받침판: 바닥 조각 사이 이음새가 벌어져도 아래가 비어 보이지 않게 한다
    this.addBox(
      {
        minX: this.originX, maxX: this.originX + this.cols * cs,
        minY: -0.8, maxY: -0.02,
        minZ: this.originZ, maxZ: this.originZ + this.rows * cs,
      },
      'ground',
      { collide: false, castShadow: false },
    );
    for (const rc of this.rects((r, c) => this.floorKind(r, c))) {
      this.addBox(
        {
          minX: this.cellMinX(rc.c0), maxX: this.cellMinX(rc.c1) + cs,
          minY: -0.5, maxY: 0,
          minZ: this.cellMinZ(rc.r0), maxZ: this.cellMinZ(rc.r1) + cs,
        },
        rc.key as TextureName,
        { collide: false, castShadow: false },
      );
    }
  }

  /** 설치 구역의 외곽(벽이 아닌 쪽)에만 경고 줄무늬를 깐다 */
  private buildSiteBorders(): void {
    const { cellSize: cs } = this.def;
    const W = 0.45;
    const siteOf = (r: number, c: number): string | null => {
      const k = this.floorKind(r, c);
      return k === 'siteA' || k === 'siteB' ? k : null;
    };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const site = siteOf(r, c);
        if (!site) continue;
        const x0 = this.cellMinX(c);
        const z0 = this.cellMinZ(r);
        const edges: [number, number, AABB][] = [
          [-1, 0, { minX: x0, maxX: x0 + cs, minY: 0, maxY: 0.012, minZ: z0, maxZ: z0 + W }],
          [1, 0, { minX: x0, maxX: x0 + cs, minY: 0, maxY: 0.012, minZ: z0 + cs - W, maxZ: z0 + cs }],
          [0, -1, { minX: x0, maxX: x0 + W, minY: 0, maxY: 0.012, minZ: z0, maxZ: z0 + cs }],
          [0, 1, { minX: x0 + cs - W, maxX: x0 + cs, minY: 0, maxY: 0.012, minZ: z0, maxZ: z0 + cs }],
        ];
        for (const [dr, dc, box] of edges) {
          const n = this.at(r + dr, c + dc);
          if (SOLID_CELLS.has(n) || siteOf(r + dr, c + dc) === site) continue;
          this.addBox(box, 'hazard', { collide: false, castShadow: false });
        }
      }
    }
  }

  private buildWalls(): void {
    const { cellSize: cs, wallHeight } = this.def;
    const isBorder = (r: number, c: number) =>
      r === 0 || c === 0 || r === this.rows - 1 || c === this.cols - 1;
    const nextToIndoor = (r: number, c: number) =>
      [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dr, dc]) => this.at(r + dr, c + dc) === '+');

    const wallKey = (r: number, c: number): string | null => {
      if (!SOLID_CELLS.has(this.at(r, c))) return null;
      if (isBorder(r, c)) return 'concrete';
      if (nextToIndoor(r, c)) return 'brick';
      return 'plaster';
    };
    for (const rc of this.rects(wallKey)) {
      // 벽은 바닥면 아래까지 내려 둔다. 버텍스 지터로 모서리 정점이 어긋나도
      // 벽과 바닥 사이로 하늘이 비치는 틈이 생기지 않는다.
      this.addBox(
        {
          minX: this.cellMinX(rc.c0), maxX: this.cellMinX(rc.c1) + cs,
          minY: -0.5, maxY: wallHeight,
          minZ: this.cellMinZ(rc.r0), maxZ: this.cellMinZ(rc.r1) + cs,
        },
        rc.key as TextureName,
      );
      // 벽 위쪽 테두리 장식 (실루엣을 또렷하게)
      this.addBox(
        {
          minX: this.cellMinX(rc.c0) - 0.08, maxX: this.cellMinX(rc.c1) + cs + 0.08,
          minY: wallHeight, maxY: wallHeight + 0.25,
          minZ: this.cellMinZ(rc.r0) - 0.08, maxZ: this.cellMinZ(rc.r1) + cs + 0.08,
        },
        'trim',
        { collide: false },
      );
    }
  }

  private buildRoofs(): void {
    const { cellSize: cs, roofHeight } = this.def;
    for (const rc of this.rects((r, c) => (this.at(r, c) === '+' ? 'roof' : null))) {
      this.addBox(
        {
          minX: this.cellMinX(rc.c0), maxX: this.cellMinX(rc.c1) + cs,
          minY: roofHeight, maxY: roofHeight + 0.4,
          minZ: this.cellMinZ(rc.r0), maxZ: this.cellMinZ(rc.r1) + cs,
        },
        'roof',
      );
    }
  }

  private buildProps(): void {
    const { cellSize: cs, platformHeight, roofHeight } = this.def;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ch = this.at(r, c);
        if (!PROP_CELLS.has(ch)) continue;
        const x0 = this.cellMinX(c);
        const z0 = this.cellMinZ(r);
        const cx = x0 + cs / 2;
        const cz = z0 + cs / 2;

        switch (ch) {
          case 'c': {
            const s = 1.4;
            this.addBox(
              { minX: cx - s / 2, maxX: cx + s / 2, minY: 0, maxY: 1.1, minZ: cz - s / 2, maxZ: cz + s / 2 },
              'crate',
              { uv: 'box' },
            );
            break;
          }
          case 'C': {
            // 큰 상자 + 옆의 작은 상자 (작은 상자를 밟고 올라갈 수 있다)
            this.addBox(
              { minX: x0 + 0.2, maxX: x0 + 2.2, minY: 0, maxY: 2.0, minZ: z0 + 0.2, maxZ: z0 + 2.2 },
              'crate',
              { uv: 'box' },
            );
            this.addBox(
              { minX: x0 + 2.2, maxX: x0 + 3.0, minY: 0, maxY: 1.0, minZ: z0 + 1.4, maxZ: z0 + 2.2 },
              'crate',
              { uv: 'box' },
            );
            break;
          }
          case 'w':
            this.addBox(
              { minX: x0, maxX: x0 + cs, minY: 0, maxY: 1.0, minZ: cz - 0.3, maxZ: cz + 0.3 },
              'concrete',
            );
            break;
          case 'p': {
            const h = this.isIndoorish(r, c) ? roofHeight : 4.5;
            const geo = new THREE.CylinderGeometry(0.55, 0.55, h, 8, Math.ceil(h / 2.5));
            geo.translate(cx, h / 2, cz);
            applyWorldUVs(geo);
            this.queue('concrete', geo, true);
            this.collision.add({ minX: cx - 0.5, maxX: cx + 0.5, minY: 0, maxY: h, minZ: cz - 0.5, maxZ: cz + 0.5, material: 'concrete' });
            break;
          }
          case 'h':
            this.addBox(
              { minX: x0, maxX: x0 + cs, minY: 0, maxY: platformHeight, minZ: z0, maxZ: z0 + cs },
              'metal',
            );
            break;
          case 's':
            this.buildStairs(r, c);
            break;
        }
      }
    }
  }

  private isIndoorish(r: number, c: number): boolean {
    return [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dr, dc]) => this.at(r + dr, c + dc) === '+');
  }

  private buildStairs(r: number, c: number): void {
    const { cellSize: cs, platformHeight } = this.def;
    const dir = ([[-1, 0], [1, 0], [0, -1], [0, 1]] as const).find(([dr, dc]) => this.at(r + dr, c + dc) === 'h');
    if (!dir) throw new Error(`[${this.def.id}] (${r},${c}) 계단 옆에 발판(h)이 없습니다`);
    const steps = Math.max(1, Math.round(platformHeight / 0.4) - 1);
    const rise = platformHeight / (steps + 1);
    const depth = cs / steps;
    const x0 = this.cellMinX(c);
    const z0 = this.cellMinZ(r);
    const [dr, dc] = dir;
    for (let i = 0; i < steps; i++) {
      const h = rise * (i + 1);
      // i=0이 발판에서 가장 먼 칸
      const a = i * depth;
      const b = a + depth;
      let box: AABB;
      if (dr !== 0) {
        // 남북 방향: dr=-1이면 북쪽(작은 z)으로 올라감
        const zs = dr < 0 ? [z0 + cs - b, z0 + cs - a] : [z0 + a, z0 + b];
        box = { minX: x0, maxX: x0 + cs, minY: 0, maxY: h, minZ: zs[0], maxZ: zs[1] };
      } else {
        const xs = dc < 0 ? [x0 + cs - b, x0 + cs - a] : [x0 + a, x0 + b];
        box = { minX: xs[0], maxX: xs[1], minY: 0, maxY: h, minZ: z0, maxZ: z0 + cs };
      }
      this.addBox(box, 'stair');
    }
  }

  private cellBounds(ch: string, minY: number, maxY: number): AABB {
    const { cellSize: cs } = this.def;
    const b: AABB = { minX: Infinity, minY, minZ: Infinity, maxX: -Infinity, maxY, maxZ: -Infinity };
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.at(r, c) === ch) {
          b.minX = Math.min(b.minX, this.cellMinX(c));
          b.maxX = Math.max(b.maxX, this.cellMinX(c) + cs);
          b.minZ = Math.min(b.minZ, this.cellMinZ(r));
          b.maxZ = Math.max(b.maxZ, this.cellMinZ(r) + cs);
        }
    if (!isFinite(b.minX)) throw new Error(`[${this.def.id}] '${ch}' 칸이 없습니다`);
    return b;
  }

  private spawnPoints(ch: string, yaw: number): SpawnPoint[] {
    const { cellSize: cs } = this.def;
    const out: SpawnPoint[] = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.at(r, c) === ch)
          out.push({ position: new THREE.Vector3(this.cellMinX(c) + cs / 2, 0, this.cellMinZ(r) + cs / 2), yaw });
    return out;
  }

  private addSiteDecal(letter: 'A' | 'B', site: AABB): void {
    // 구역 중앙에서 가장 가까우면서 주변 8칸도 비어 있는 칸에 큰 글자를 그린다
    const { cellSize: cs } = this.def;
    const mx = (site.minX + site.maxX) / 2;
    const mz = (site.minZ + site.maxZ) / 2;
    let cx = mx;
    let cz = mz;
    let best = Infinity;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        let clear = true;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) if (this.at(r + dr, c + dc) !== letter) clear = false;
        if (!clear) continue;
        const x = this.cellMinX(c) + cs / 2;
        const z = this.cellMinZ(r) + cs / 2;
        const d = (x - mx) ** 2 + (z - mz) ** 2;
        if (d < best) {
          best = d;
          cx = x;
          cz = z;
        }
      }
    const geo = new THREE.PlaneGeometry(4, 4);
    geo.rotateX(-Math.PI / 2);
    const mat = createPSXMaterial({ map: letterTexture(letter), transparent: true });
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, 0.01, cz);
    mesh.receiveShadow = true;
    mesh.name = `site-${letter}`;
    this.root.add(mesh);
  }

  private addIndoorLights(): void {
    const { cellSize: cs, roofHeight } = this.def;
    const seen = new Set<string>();
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.at(r, c) !== '+' || seen.has(`${r},${c}`)) continue;
        // 연결된 실내 영역마다 조명 하나
        const cells: [number, number][] = [];
        const stack: [number, number][] = [[r, c]];
        seen.add(`${r},${c}`);
        while (stack.length) {
          const [cr, cc] = stack.pop()!;
          cells.push([cr, cc]);
          for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const k = `${cr + dr},${cc + dc}`;
            if (this.at(cr + dr, cc + dc) === '+' && !seen.has(k)) {
              seen.add(k);
              stack.push([cr + dr, cc + dc]);
            }
          }
        }
        const mr = cells.reduce((s, p) => s + p[0], 0) / cells.length;
        const mc = cells.reduce((s, p) => s + p[1], 0) / cells.length;
        const x = this.originX + (mc + 0.5) * cs;
        const z = this.originZ + (mr + 0.5) * cs;
        const light = new THREE.PointLight(0xffc888, 6 + cells.length * 1.5, 18, 1.4);
        light.position.set(x, roofHeight - 0.5, z);
        this.root.add(light);
        // 램프 기구
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.12, 0.8),
          createPSXMaterial({ color: 0x222222, emissive: 0xffd8a0 }),
        );
        lamp.position.set(x, roofHeight - 0.06, z);
        this.root.add(lamp);
      }
    }
  }

  private addSky(): void {
    const env = this.def.environment;
    const geo = new THREE.SphereGeometry(300, 16, 10);
    const top = new THREE.Color(env.skyTop);
    const horizon = new THREE.Color(env.skyHorizon);
    const colors: number[] = [];
    const pos = geo.attributes.position;
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / 300);
      tmp.copy(horizon).lerp(top, Math.pow(t, 0.6));
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    sky.name = 'sky';
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.root.add(sky);
  }

  private addLights(bounds: AABB): THREE.DirectionalLight {
    const env = this.def.environment;
    this.root.add(new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity));

    const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
    const dir = new THREE.Vector3(...env.sunDirection).normalize();
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    sun.position.set(cx + dir.x * 100, dir.y * 100, cz + dir.z * 100);
    sun.target.position.set(cx, 0, cz);
    sun.castShadow = true;
    // 필터링 없는 그림자 (가장자리 계단 현상이 보이는 PSX풍, 형태는 읽을 수 있는 해상도)
    sun.shadow.mapSize.set(2048, 2048);
    const half = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.75;
    const cam = sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 260;
    sun.shadow.bias = -0.0015;
    sun.shadow.normalBias = 0.05;
    this.root.add(sun, sun.target);
    return sun;
  }
}

/** 박스 투영 방식으로 월드 좌표 기반 UV를 계산 (인접한 면의 텍스처가 자연스럽게 이어진다) */
function applyWorldUVs(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x;
      v = -z;
    } else if (nx >= nz) {
      u = z * Math.sign(nor.getX(i) || 1) * -1;
      v = y;
    } else {
      u = x * Math.sign(nor.getZ(i) || 1);
      v = y;
    }
    uv.setXY(i, u / TEX_WORLD_SIZE, v / TEX_WORLD_SIZE);
  }
  uv.needsUpdate = true;
}

function letterTexture(letter: string): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  g.imageSmoothingEnabled = false;
  g.fillStyle = 'rgba(214, 176, 56, 0.9)';
  g.font = 'bold 30px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, size / 2, size / 2 + 2);
  // 안티앨리어싱된 가장자리를 이진화 (픽셀 느낌)
  const img = g.getImageData(0, 0, size, size);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 100 ? 230 : 0;
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}
