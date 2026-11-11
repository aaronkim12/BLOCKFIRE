import * as THREE from 'three';
import type { TargetRequest } from '../abilities/AbilitySystem';
import type { Game } from '../core/Game';

/**
 * 전술 지도 (미사일·폭격·원거리 연막의 지점 지정).
 *   - 맵을 위에서 내려다본 그림: 벽·바닥·구역·스폰·엄폐물
 *   - 나(방향 화살표), 아군, 지금 드러난 적, 알고 있는 Core 위치
 *   - 사거리 원, 마우스를 따라다니는 효과 범위 미리보기
 *   points: 좌클릭으로 지점 추가(우클릭 취소), 같은 능력 키·Enter로 발사 (최대 개수를 채우면 자동 발사)
 *   line  : 시작점 → 끝점을 찍으면 그 경로로 발동
 *   Esc: 닫기 (충전은 소모되지 않음)
 */
export class TacticalMap {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private req: TargetRequest | null = null;
  private onConfirm: ((p: THREE.Vector3[]) => void) | null = null;
  private points: THREE.Vector3[] = [];
  private cursor: THREE.Vector3 | null = null;
  private raf = 0;
  private readonly size = 640;

  constructor(container: HTMLElement, private game: Game) {
    this.root = document.createElement('div');
    this.root.className = 'tac-map';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="tm-panel">
        <header><b class="tm-title"></b><span class="tm-help"></span></header>
        <canvas width="${this.size}" height="${this.size}"></canvas>
        <footer><span class="tm-count"></span><button data-act="fire">FIRE</button><button data-act="cancel">ESC</button></footer>
      </div>`;
    container.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('mousemove', (e) => (this.cursor = this.toWorld(e)));
    this.canvas.addEventListener('mouseleave', () => (this.cursor = null));
    this.canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button === 2) this.removeLast();
      else if (e.button === 0) this.add(this.toWorld(e));
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'fire') this.confirm();
      if (act === 'cancel') this.cancel();
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.req) return;
        const keys = this.game.settings.bindings[this.req.slot] ?? [];
        if (e.code === 'Escape') this.cancel();
        else if (e.code === 'Enter' || keys.includes(e.code)) this.confirm();
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !!this.req;
  }

  open(req: TargetRequest, onConfirm: (points: THREE.Vector3[]) => void): void {
    this.req = req;
    this.onConfirm = onConfirm;
    this.points = [];
    this.cursor = null;
    this.root.hidden = false;
    this.root.style.setProperty('--tm', req.color);
    this.root.querySelector('.tm-title')!.textContent = req.title;
    this.root.querySelector('.tm-help')!.textContent =
      req.mode === 'line' ? '좌클릭: 시작 지점 → 끝 지점' : `좌클릭: 지점 지정 (최대 ${req.maxPoints}) · 우클릭: 취소 · 같은 키/Enter: 발사`;
    this.updateCount();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.req) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** 닫기 (지정 취소) */
  cancel(): void {
    this.finish([]);
  }

  private confirm(): void {
    if (!this.req) return;
    if (this.req.mode === 'line' && this.points.length < 2) return;
    if (this.points.length === 0) return;
    this.finish(this.points.slice());
  }

  private finish(points: THREE.Vector3[]): void {
    const cb = this.onConfirm;
    this.req = null;
    this.onConfirm = null;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    cb?.(points);
  }

  private add(p: THREE.Vector3): void {
    const req = this.req;
    if (!req || !this.valid(p)) {
      this.game.sound.play('ui', { gain: 0.4, pitch: 0.6 });
      return;
    }
    this.points.push(p);
    this.game.sound.play('ui', { gain: 0.6, pitch: 1.3 });
    this.updateCount();
    // 다 고르면 바로 발동
    if (this.points.length >= req.maxPoints) setTimeout(() => this.confirm(), 160);
  }

  private removeLast(): void {
    if (this.points.length) this.points.pop();
    else this.cancel();
    this.updateCount();
  }

  private updateCount(): void {
    const req = this.req;
    if (!req) return;
    this.root.querySelector('.tm-count')!.textContent = req.mode === 'line' ? (this.points.length === 0 ? '시작 지점' : '끝 지점') : `${this.points.length} / ${req.maxPoints}`;
  }

  // ───────────────────────── 좌표 ─────────────────────────

  private get mapInfo() {
    const def = this.game.map.def;
    const cs = def.cellSize;
    const rows = def.layout.length;
    const cols = def.layout[0].length;
    const scale = this.size / Math.max(cols, rows) / cs;
    // 정사각형이 아닌 맵은 캔버스 가운데에
    const offU = (this.size - cols * cs * scale) / 2;
    const offV = (this.size - rows * cs * scale) / 2;
    return { def, cs, rows, cols, ox: (-cols * cs) / 2, oz: (-rows * cs) / 2, scale, offU, offV };
  }

  private toWorld(e: MouseEvent): THREE.Vector3 {
    const r = this.canvas.getBoundingClientRect();
    const u = ((e.clientX - r.left) / r.width) * this.size;
    const v = ((e.clientY - r.top) / r.height) * this.size;
    const m = this.mapInfo;
    return new THREE.Vector3(m.ox + (u - m.offU) / m.scale, 0, m.oz + (v - m.offV) / m.scale);
  }

  private toMap(p: { x: number; z: number }): [number, number] {
    const m = this.mapInfo;
    return [m.offU + (p.x - m.ox) * m.scale, m.offV + (p.z - m.oz) * m.scale];
  }

  /** 사거리 안이고 벽 칸이 아닌 곳 */
  private valid(p: THREE.Vector3): boolean {
    const req = this.req;
    if (!req) return false;
    const me = this.game.player.position;
    if (Math.hypot(p.x - me.x, p.z - me.z) > req.range) return false;
    const m = this.mapInfo;
    const c = Math.floor((p.x - m.ox) / m.cs);
    const r = Math.floor((p.z - m.oz) / m.cs);
    const ch = m.def.layout[r]?.[c];
    return !!ch && ch !== '#';
  }

  // ───────────────────────── 그리기 ─────────────────────────

  private draw(): void {
    const g = this.ctx;
    const m = this.mapInfo;
    const req = this.req!;
    const px = m.cs * m.scale;
    g.fillStyle = '#07090d';
    g.fillRect(0, 0, this.size, this.size);
    const COLORS: Record<string, string> = {
      '#': '#1b1f27', '.': '#3a3f48', '+': '#33373f', A: '#4a3a2c', B: '#2c3a4a', T: '#4a2c2c', D: '#2c344a',
      c: '#5a4a34', C: '#6a5236', w: '#4c5058', p: '#585c64', h: '#4a4e58', s: '#43474f',
    };
    m.def.layout.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        g.fillStyle = COLORS[row[c]] ?? '#3a3f48';
        g.fillRect(m.offU + c * px, m.offV + r * px, px + 0.5, px + 0.5);
      }
    });
    // 구역 글자
    g.font = `bold ${px * 2.2}px Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const id of ['A', 'B'] as const) {
      const s = this.game.map.sites[id];
      const [u, v] = this.toMap({ x: (s.minX + s.maxX) / 2, z: (s.minZ + s.maxZ) / 2 });
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillText(id, u, v);
    }
    // 사거리 원
    const me = this.game.player.position;
    const [mu, mv] = this.toMap(me);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.setLineDash([6, 6]);
    g.beginPath();
    g.arc(mu, mv, req.range * m.scale, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    // Core
    const core = this.game.match?.rm.core;
    if (core?.position && (core.status === 'planted' || core.status === 'dropped')) {
      const [u, v] = this.toMap(core.position);
      g.fillStyle = core.status === 'planted' ? '#ff4a30' : '#ffd040';
      g.beginPath();
      g.moveTo(u, v - 7);
      g.lineTo(u + 7, v);
      g.lineTo(u, v + 7);
      g.lineTo(u - 7, v);
      g.fill();
    }
    // 아군 / 드러난 적
    for (const b of this.game.match ? this.game.bots?.allies ?? [] : []) {
      if (!b.alive) continue;
      const [u, v] = this.toMap(b.ctrl.position);
      g.fillStyle = '#4fa8ff';
      g.beginPath();
      g.arc(u, v, 5, 0, Math.PI * 2);
      g.fill();
    }
    for (const t of this.game.abilityFx.revealed) {
      const [u, v] = this.toMap(t.center(new THREE.Vector3()));
      g.fillStyle = '#ff4a4a';
      g.beginPath();
      g.arc(u, v, 5, 0, Math.PI * 2);
      g.fill();
    }
    // 나 (바라보는 방향 화살표)
    const yaw = this.game.player.yaw;
    g.save();
    g.translate(mu, mv);
    g.rotate(-yaw);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(6, 7);
    g.lineTo(0, 3);
    g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.restore();

    const color = req.color;
    const circle = (p: THREE.Vector3, alpha: number, ok = true) => {
      const [u, v] = this.toMap(p);
      g.fillStyle = ok ? hexA(color, alpha * 0.35) : 'rgba(255,60,60,0.25)';
      g.strokeStyle = ok ? hexA(color, alpha) : 'rgba(255,60,60,0.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(u, v, Math.max(4, req.radius * m.scale), 0, Math.PI * 2);
      g.fill();
      g.stroke();
    };
    // 폭격 경로 미리보기
    if (req.mode === 'line' && this.points.length >= 1) {
      const a = this.points[0];
      const b = this.points[1] ?? this.cursor;
      if (b) {
        const [au, av] = this.toMap(a);
        const [bu, bv] = this.toMap(b);
        g.strokeStyle = hexA(color, 0.5);
        g.lineWidth = req.radius * m.scale * 2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(au, av);
        g.lineTo(bu, bv);
        g.stroke();
        g.lineWidth = 1;
      }
    }
    for (const p of this.points) circle(p, 1);
    if (this.cursor) circle(this.cursor, 0.6, this.valid(this.cursor));
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
