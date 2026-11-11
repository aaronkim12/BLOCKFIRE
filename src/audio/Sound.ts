import * as THREE from 'three';
import { track } from '../core/LoadProgress';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { AudioEngine, type PlayOptions as EngineOptions } from './engine';
import { GAME_SET } from './soundSet';
import { SAMPLE_FILES, WEAPON_SFX, type WeaponSfx } from './weaponSfx';

/**
 * 게임 ↔ 오디오 엔진 연결 (Three.js 카메라·충돌 월드를 엔진의 순수 데이터로 바꿔 전달).
 *
 * 소리 출처
 *  - 녹음 샘플 (사용자 제공 사운드 팩): 총소리·탄창·노리쇠·펌프·빈 탄창
 *  - 절차적 합성 (src/audio/engine): 재질별 착탄·발소리, 피격, 칼, 능력, Core, 폭발, UI
 *  - 샘플을 불러오지 못하면 같은 역할의 절차적 소리로 자동 대체
 */

export interface PlayOptions {
  at?: THREE.Vector3;
  pitch?: number;
  /** 선형 음량 배율 */
  gain?: number;
  material?: string;
  intensity?: number;
  size?: 'small' | 'medium' | 'large';
  duration?: number;
}

/** 녹음 샘플이 없을 때 대체할 절차적 소리 */
const SAMPLE_FALLBACK: Record<string, [string, EngineOptions]> = {
  shot_556: ['gunshot', { caliber: 'rifle556' }],
  shot_762: ['gunshot', { caliber: 'rifle762' }],
  shot_762r: ['gunshot', { caliber: 'sniper' }],
  shot_308: ['gunshot', { caliber: 'sniper' }],
  shot_9mm: ['gunshot', { caliber: 'pistol9' }],
  shot_20g: ['gunshot', { caliber: 'shotgun' }],
  ar_mag_out: ['mechanism', { kind: 'mag_out' }],
  ak_mag_out: ['mechanism', { kind: 'mag_out' }],
  bolt_mag_out: ['mechanism', { kind: 'mag_out' }],
  pistol_mag_out: ['mechanism', { kind: 'mag_out' }],
  ar_mag_in: ['mechanism', { kind: 'mag_in' }],
  ak_mag_in: ['mechanism', { kind: 'mag_in' }],
  bolt_mag_in: ['mechanism', { kind: 'mag_in' }],
  pistol_mag_in: ['mechanism', { kind: 'mag_in' }],
  ar_charge: ['mechanism', { kind: 'charge' }],
  ak_rack: ['mechanism', { kind: 'charge' }],
  bolt_cycle: ['mechanism', { kind: 'bolt' }],
  pump_rack: ['mechanism', { kind: 'pump' }],
  shell_load: ['mechanism', { kind: 'shell_load' }],
  pistol_slide: ['mechanism', { kind: 'slide' }],
  revolver_open: ['mechanism', { kind: 'revolver_open' }],
  revolver_close: ['mechanism', { kind: 'revolver_close' }],
  revolver_cock: ['mechanism', { kind: 'revolver_cock' }],
  dry_fire: ['mechanism', { kind: 'dry_fire' }],
  ui: ['ui', {}],
  equip: ['mechanism', { kind: 'equip' }],
};

export class Sound {
  readonly engine = new AudioEngine();
  private samples = new Set<string>();
  private world: CollisionWorld | null = null;
  private envTimer = 0;

  /** 효과음 준비: 녹음 샘플 디코딩 + 자주 쓰는 절차적 소리 렌더링 (로딩 화면) */
  async load(): Promise<void> {
    const e = this.engine;
    await Promise.all(SAMPLE_FILES.map((name) => track(`${name}.mp3`, this.loadSample(name)).catch((err) => console.warn('샘플 로드 실패 → 절차적 소리로 대체', name, err))));
    // 절차적 소리: 녹음 샘플이 대신하는 총소리·장비 동작을 빼고 로딩 중에 렌더링
    const essential = GAME_SET.filter(([, n]) => n !== 'gunshot' && n !== 'mechanism');
    await Promise.all(essential.map(([label, n, p]) => track(`sfx ${label}`, e.generator.ensure(n, p))));
    // 대체용 총소리·장비 동작은 게임 중 뒤에서 렌더링
    void e.prewarm(GAME_SET.filter(([, n]) => n === 'gunshot' || n === 'mechanism').map(([, n, p]) => [n, p]));
  }

  private async loadSample(name: string): Promise<void> {
    const r = await fetch(`assets/sounds/${name}.mp3`);
    if (!r.ok) throw new Error(`${r.status} ${name}`);
    const buf = await this.engine.decode(await r.arrayBuffer());
    const shot = name.startsWith('shot_');
    this.engine.registerSample(`rec:${name}`, [buf], shot
      ? { bus: 'weapons', peakDb: -1.5, maxVoices: 10, priority: 9, variation: { pitchCents: 30, gainDb: 1 } }
      : { bus: 'foley', peakDb: -9, maxVoices: 4, priority: 5, variation: { pitchCents: 25 } });
    this.samples.add(name);
  }

  /** 브라우저 정책상 사용자 입력(클릭) 뒤에 호출해야 소리가 난다 */
  unlock(): void {
    void this.engine.unlock();
  }

  setVolume(v: number): void {
    this.engine.setVolume(v);
  }

  /** 가림·환경 판정에 쓸 충돌 월드 */
  setWorld(world: CollisionWorld): void {
    this.world = world;
    const listener = this.engine.listener;
    // 청취자 → 음원 사이가 벽에 막혀 있으면 가림 (저역 통과 + 감쇠)
    this.engine.occlusionFn = (p) => {
      const l = listener.pos;
      const dx = p.x - l.x, dy = p.y - l.y, dz = p.z - l.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.5) return 0;
      const hit = world.raycast(l.x, l.y, l.z, dx / d, dy / d, dz / d, d - 0.3);
      return hit ? 0.85 : 0;
    };
  }

  /** 듣는 위치/방향 (카메라). 머리 위가 막혀 있으면 실내 잔향 */
  setListener(cam: THREE.Camera, dt = 0.016): void {
    const p = cam.getWorldPosition(new THREE.Vector3());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    this.engine.listener.set(p, f);
    this.envTimer -= dt;
    if (this.world && this.envTimer <= 0) {
      this.envTimer = 0.3;
      const roof = this.world.raycast(p.x, p.y, p.z, 0, 1, 0, 8);
      this.engine.setEnvironment(roof ? 'indoor' : 'outdoor');
    }
  }

  private opts(o: PlayOptions): EngineOptions {
    return {
      position: o.at ? { x: o.at.x, y: o.at.y, z: o.at.z } : undefined,
      pitch: o.pitch,
      gainDb: o.gain !== undefined ? 20 * Math.log10(Math.max(1e-4, o.gain)) : undefined,
      material: o.material,
      intensity: o.intensity,
      size: o.size,
      duration: o.duration,
    };
  }

  /** 녹음 샘플이 있으면 샘플, 없으면 대체 절차적 소리 */
  private playSample(file: string, o: PlayOptions): void {
    if (this.samples.has(file)) {
      this.engine.play(`rec:${file}`, this.opts(o));
      return;
    }
    const fb = SAMPLE_FALLBACK[file];
    if (fb) this.engine.play(fb[0], { ...fb[1], ...this.opts(o) });
  }

  /** 무기 소리 (shot / magOut / magIn / equip / cycle) */
  weapon(weaponId: string, event: keyof Omit<WeaponSfx, 'pitch'>, at?: THREE.Vector3): void {
    const s = WEAPON_SFX[weaponId] ?? WEAPON_SFX.falcon;
    const file = s[event];
    if (!file) return;
    if (file === 'knife') {
      this.engine.play('knife', this.opts({ at }));
      return;
    }
    if (file === 'ui' || file === 'equip') {
      this.engine.play('mechanism', { kind: 'equip', ...this.opts({ at }) });
      return;
    }
    const isShot = event === 'shot';
    this.playSample(file, { at, pitch: isShot ? s.pitch ?? 1 : 1, gain: isShot ? (at ? 1 : 0.85) : 0.9 });
  }

  /** 이름으로 재생 (절차적 소리 또는 녹음 샘플 이름) */
  play(name: string, o: PlayOptions = {}): void {
    if (SAMPLE_FILES.includes(name) || name in SAMPLE_FALLBACK) this.playSample(name, o);
    else this.engine.play(name, this.opts(o));
  }

  /** 발소리 (재질·속도 반영) */
  footstep(material: string, speed: number, at?: THREE.Vector3, weight: 'light' | 'normal' | 'heavy' = 'normal'): void {
    this.engine.play('footstep', { ...this.opts({ at }), material, weight, intensity: Math.min(1, speed / 5.4), velocity: speed });
  }
}
