import * as THREE from 'three';
import { CharacterModel, DEFAULT_POSE } from '../player/CharacterModel';
import { getWeapon } from '../weapons/weaponData';
import { loadWeaponTemplate } from '../weapons/WeaponModels';

/**
 * 캐릭터 선택 화면의 3D 미리보기.
 * 별도의 작은 WebGL 캔버스에 낮은 해상도로 그리고 CSS로 확대해 PSX 픽셀 느낌을 낸다.
 * 캐릭터는 대표 색으로 칠하고, 발밑에 대표 색 빛 고리, 뒤쪽 테두리 조명을 둔다. 드래그로 돌려 볼 수 있다.
 */
export class AgentPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 3 / 4, 0.1, 50);
  private model: CharacterModel | null = null;
  private rim = new THREE.DirectionalLight(0xffffff, 2.2);
  private ring: THREE.Mesh;
  private running = false;
  private last = 0;
  private yaw = -0.5;
  private spin = 0.35;
  private drag: number | null = null;
  private appear = 0;
  private color = new THREE.Color(0xffffff);

  constructor() {
    this.canvas.className = 'as-preview-canvas';
    this.camera.position.set(0, 1.05, 5.2);
    this.camera.lookAt(0, 0.95, 0);
    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x302820, 1.6));
    const key = new THREE.DirectionalLight(0xfff0e0, 2.4);
    key.position.set(2, 3, 3);
    this.rim.position.set(-2, 2.5, -3);
    this.scene.add(key, this.rim);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.9, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.01;
    this.scene.add(this.ring);
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      this.yaw += (e.clientX - this.drag) * 0.012;
      this.drag = e.clientX;
    });
    this.canvas.addEventListener('pointerup', () => (this.drag = null));
  }

  private async ensure(): Promise<void> {
    if (this.renderer) return;
    // 낮은 해상도로 그린 뒤 CSS로 키운다 (PSX 픽셀)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(240, 320, false);
    this.model = await CharacterModel.create({ team: null, white: true });
    this.model.setWeapon(await loadWeaponTemplate(getWeapon('falcon')));
    this.scene.add(this.model.root);
    this.applyColor();
  }

  /** 캐릭터 대표 색 적용 (흰색과 섞어 몸이 너무 탁하지 않게) */
  setAgentColor(hex: string): void {
    this.color.set(hex);
    this.appear = 0;
    this.applyColor();
  }

  private applyColor(): void {
    if (!this.model) return;
    const body = new THREE.Color(0xf0eee8).lerp(this.color, 0.55);
    (this.model as unknown as { bodyMaterial?: THREE.MeshLambertMaterial }).bodyMaterial?.color.copy(body);
    this.rim.color.copy(this.color);
    (this.ring.material as THREE.MeshBasicMaterial).color.copy(this.color);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.ensure().then(() => {
      this.last = performance.now();
      requestAnimationFrame(this.frame);
    });
  }

  stop(): void {
    this.running = false;
  }

  private frame = (now: number): void => {
    if (!this.running || !this.renderer || !this.model) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.drag === null) this.yaw += this.spin * dt;
    // 캐릭터를 바꾸면 아래에서 살짝 솟아오르며 나타남
    this.appear = Math.min(1, this.appear + dt * 3);
    const e = 1 - Math.pow(1 - this.appear, 3);
    this.model.root.rotation.y = this.yaw;
    this.model.root.position.y = (1 - e) * -0.25;
    this.model.update(dt, { ...DEFAULT_POSE, aimPitch: -0.05 });
    const pulse = 0.4 + 0.2 * Math.sin(now / 400);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = pulse * e;
    this.ring.scale.setScalar(0.9 + 0.1 * e);
    this.renderer.render(this.scene, this.camera);
  };
}
