import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { psxUniforms } from '../graphics/PSXMaterial';
import { MapBuilder } from '../maps/MapBuilder';
import type { MapDefinition } from '../maps/MapData';

/**
 * 맵 에디터의 3D 화면.
 *   - 게임과 똑같은 MapBuilder로 맵을 그대로 지어서 보여 준다 (보이는 그대로가 게임 맵)
 *   - 마우스가 가리키는 칸을 계산: 벽 꼭대기(높이 6m) 면을 먼저 보고, 벽이 아니면 바닥 면
 *   - 카메라: 휠 확대, 가운데 버튼 또는 Space/Alt + 왼쪽 드래그로 회전, Shift까지 누르면 이동
 *   - "벽 낮게 보기": 벽을 1.5m로 낮추고 지붕을 숨겨 안쪽까지 보며 칠할 수 있다
 */
export class Editor3D {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.5, 900);
  private controls: OrbitControls;
  private mapRoot: THREE.Object3D | null = null;
  private def: MapDefinition | null = null;
  private hover: THREE.LineSegments;
  private mirrorHover: THREE.LineSegments;
  private grid: THREE.LineSegments | null = null;
  private raf = 0;
  private running = false;
  /** 벽 낮게 보기 */
  cutaway = true;
  /** Space / Alt를 누르고 있으면 왼쪽 드래그가 카메라 회전 */
  private viewKey = false;
  private pending: { def: MapDefinition; fit: boolean } | null = null;
  private lastBuild = 0;

  constructor(host: HTMLElement) {
    this.canvas.className = 'me-3d';
    host.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.scene.background = new THREE.Color(0x0b0e14);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 260;
    this.controls.screenSpacePanning = false;
    this.setLeftAction(false);
    // 왼쪽 버튼 동작은 누르는 순간 정한다 (Space/Alt면 회전, 아니면 칠하기) — OrbitControls보다 먼저 받도록 capture
    host.addEventListener('pointerdown', (e) => this.setLeftAction(this.viewKey || e.altKey), true);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.running && !(e.target as HTMLElement).matches('input, textarea')) {
        this.viewKey = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.viewKey = false;
    });

    const box = (color: number) => {
      const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      l.renderOrder = 10;
      l.visible = false;
      return l;
    };
    this.hover = box(0x9fe3ff);
    this.mirrorHover = box(0xffd479);
    this.scene.add(this.hover, this.mirrorHover);
  }

  /** 지금 왼쪽 드래그가 카메라 조작인지 (칠하기를 막을 때 씀) */
  isViewGesture(e: MouseEvent): boolean {
    return e.button === 1 || ((this.viewKey || e.altKey) && e.button === 0);
  }

  private setLeftAction(view: boolean): void {
    this.controls.mouseButtons = {
      LEFT: view ? THREE.MOUSE.ROTATE : (null as unknown as THREE.MOUSE),
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: null as unknown as THREE.MOUSE,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** 맵을 다시 짓는다 (칠하는 동안은 0.15초에 한 번까지) */
  setMap(def: MapDefinition, fit = false, immediate = false): void {
    this.pending = { def, fit: fit || this.pending?.fit === true };
    if (immediate) this.flush();
  }

  private flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.lastBuild = performance.now();
    const def = p.def;
    // 벽 낮게 보기: 높이만 바꾼 사본으로 짓는다
    const view: MapDefinition = this.cutaway ? { ...def, wallHeight: 1.5, roofHeight: 1.3 } : def;
    let built: { root: THREE.Group } | null = null;
    try {
      built = new MapBuilder(view).build();
    } catch {
      // 계단 옆에 발판이 없는 등 아직 지을 수 없는 상태 — 이전 모습 유지
      return;
    }
    if (this.mapRoot) {
      this.scene.remove(this.mapRoot);
      disposeTree(this.mapRoot);
    }
    this.mapRoot = built.root;
    if (this.cutaway) {
      const roof = this.mapRoot.getObjectByName('roof');
      if (roof) roof.visible = false;
    }
    this.scene.add(this.mapRoot);
    const sameSize = this.def && this.def.layout.length === def.layout.length && this.def.layout[0].length === def.layout[0].length;
    this.def = def;
    if (!sameSize || !this.grid) this.buildGrid();
    if (p.fit || !sameSize) this.viewIso();
  }

  /** 칸 경계선 */
  private buildGrid(): void {
    const def = this.def!;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
    }
    const cs = def.cellSize;
    const rows = def.layout.length;
    const cols = def.layout[0].length;
    const ox = (-cols * cs) / 2;
    const oz = (-rows * cs) / 2;
    const pts: number[] = [];
    for (let c = 0; c <= cols; c++) pts.push(ox + c * cs, 0.03, oz, ox + c * cs, 0.03, oz + rows * cs);
    for (let r = 0; r <= rows; r++) pts.push(ox, 0.03, oz + r * cs, ox + cols * cs, 0.03, oz + r * cs);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }));
    this.scene.add(this.grid);
  }

  /** 비스듬히 내려다보기 */
  viewIso(): void {
    if (!this.def) return;
    const size = Math.max(this.def.layout.length, this.def.layout[0].length) * this.def.cellSize;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(size * 0.05, size * 0.75, size * 0.62);
    this.controls.update();
  }

  /** 바로 위에서 */
  viewTop(): void {
    if (!this.def) return;
    const size = Math.max(this.def.layout.length, this.def.layout[0].length) * this.def.cellSize;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, size * 1.05, size * 0.02);
    this.controls.update();
  }

  /** 화면 좌표 → 칸 [행, 열] */
  pick(e: MouseEvent): [number, number] | null {
    const def = this.def;
    if (!def) return null;
    const r = this.canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return null;
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const cs = def.cellSize;
    const rows = def.layout.length;
    const cols = def.layout[0].length;
    const toCell = (p: THREE.Vector3): [number, number] | null => {
      const c = Math.floor((p.x + (cols * cs) / 2) / cs);
      const row = Math.floor((p.z + (rows * cs) / 2) / cs);
      return c >= 0 && row >= 0 && c < cols && row < rows ? [row, c] : null;
    };
    // 벽 꼭대기 면 → 그 칸이 벽이면 그 칸
    const top = this.cutaway ? 1.5 : def.wallHeight;
    const hitTop = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -top), new THREE.Vector3());
    if (hitTop) {
      const cell = toCell(hitTop);
      if (cell && def.layout[cell[0]][cell[1]] === '#') return cell;
    }
    const hitFloor = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hitFloor ? toCell(hitFloor) : null;
  }

  /** 붓 위치 표시 (brush칸 크기), 대칭이면 반대쪽도 */
  setHover(cell: [number, number] | null, brush: number, mirror: boolean, rect?: [[number, number], [number, number]]): void {
    const def = this.def;
    if (!def || !cell) {
      this.hover.visible = false;
      this.mirrorHover.visible = false;
      return;
    }
    const cs = def.cellSize;
    const rows = def.layout.length;
    const cols = def.layout[0].length;
    let r0: number, c0: number, r1: number, c1: number;
    if (rect) {
      r0 = Math.min(rect[0][0], rect[1][0]);
      r1 = Math.max(rect[0][0], rect[1][0]);
      c0 = Math.min(rect[0][1], rect[1][1]);
      c1 = Math.max(rect[0][1], rect[1][1]);
    } else {
      const h = Math.floor(brush / 2);
      r0 = cell[0] - h;
      c0 = cell[1] - h;
      r1 = r0 + brush - 1;
      c1 = c0 + brush - 1;
    }
    const height = this.cutaway ? 1.6 : def.wallHeight + 0.1;
    const place = (box: THREE.LineSegments, ca: number, cb: number) => {
      box.visible = true;
      box.scale.set((cb - ca + 1) * cs, height, (r1 - r0 + 1) * cs);
      box.position.set((-cols * cs) / 2 + ((ca + cb + 1) / 2) * cs, height / 2, (-rows * cs) / 2 + ((r0 + r1 + 1) / 2) * cs);
    };
    place(this.hover, c0, c1);
    if (mirror) place(this.mirrorHover, cols - 1 - c1, cols - 1 - c0);
    else this.mirrorHover.visible = false;
  }

  private frame(): void {
    // 칠하는 동안 다시 짓기는 0.15초에 한 번까지
    if (this.pending && performance.now() - this.lastBuild > 150) this.flush();
    const host = this.canvas.parentElement!;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.floor(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    // 에디터 화면은 선명하게: PS1 흔들림·왜곡을 잠시 끈다
    const j = psxUniforms.uJitter.value;
    const a = psxUniforms.uAffine.value;
    psxUniforms.uJitter.value = 0;
    psxUniforms.uAffine.value = 0;
    this.renderer.render(this.scene, this.camera);
    psxUniforms.uJitter.value = j;
    psxUniforms.uAffine.value = a;
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    // 텍스처는 맵끼리 공유하므로 재질만
    for (const mat of mats) {
      // 구역 글자(A/B)는 지을 때마다 새로 만든 텍스처
      if (o.name.startsWith('site-')) (mat as THREE.MeshLambertMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
