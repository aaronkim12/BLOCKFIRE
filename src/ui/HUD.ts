import * as THREE from 'three';
import { effectIcon } from './icons';
import type { StatusKind } from '../abilities/StatusEffects';
import type { HitPart } from '../combat/ballistics';
import type { Game } from '../core/Game';
import type { WeaponSlot } from '../weapons/weaponData';
import { SLOTS, type AbilitySlot } from '../abilities/abilityData';

interface DamageNumber {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
}

/** 인게임 HUD. 조준점은 저해상도 렌더와 별개로 네이티브 해상도로 그려 조준을 방해하지 않는다. */
export class HUD {
  private root: HTMLDivElement;
  private debug: HTMLPreElement;
  private crosshair: HTMLDivElement;
  private hitmarker: HTMLDivElement;
  private scope: HTMLDivElement;
  private weaponName: HTMLDivElement;
  private ammo: HTMLDivElement;
  private slots: HTMLDivElement;
  private status: HTMLDivElement;
  private health: HTMLDivElement;
  private armor: HTMLDivElement;
  private killfeed: HTMLDivElement;
  private damageDir: HTMLDivElement;
  private death: HTMLDivElement;
  private numbersLayer: HTMLDivElement;
  private numbers: DamageNumber[] = [];
  private hitTimer = 0;
  private damageTimer = 0;
  private damageFrom = new THREE.Vector3();
  private lastDebugUpdate = 0;
  private lastSlotsKey = '';
  private lastFrame = performance.now();

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="smoke-overlay"></div>
      <div class="overdrive-overlay"></div>
      <div class="speed-overlay"></div>
      <div class="concuss-overlay"></div>
      <div class="status-chips"></div>
      <div class="scope-overlay" hidden><div class="scope-ring"></div><i class="scope-h"></i><i class="scope-v"></i></div>
      <div class="damage-dir" hidden></div>
      <div class="damage-numbers"></div>
      <div class="crosshair"><i class="ch-t"></i><i class="ch-b"></i><i class="ch-l"></i><i class="ch-r"></i><i class="ch-dot"></i></div>
      <div class="hitmarker" hidden><i></i><i></i><i></i><i></i></div>
      <pre class="hud-debug"></pre>
      <div class="killfeed"></div>
      <div class="hud-status"></div>
      <div class="hud-vitals">
        <div class="hud-health"><b>100</b><span>HP</span></div>
        <div class="hud-armor"><b>0</b><span>ARMOR</span></div>
      </div>
      <div class="hud-weapon">
        <div class="hud-slots"></div>
        <div class="hud-weapon-name"></div>
        <div class="hud-ammo"></div>
      </div>
      <div class="death-screen" hidden><h2>ELIMINATED</h2><p></p></div>
      <div class="reveal-layer"></div>
      <div class="ally-tags"></div>
      <div class="ability-bar"></div>
      <div class="flash-overlay"></div>
      <div class="hud-hint">WASD 이동 · SHIFT 걷기 · C 앉기 · 1-4 무기 · R 재장전 · Q Z F X 능력 · B 구매 · ESC 메뉴</div>
    `;
    container.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.debug = q('.hud-debug');
    this.crosshair = q('.crosshair');
    this.hitmarker = q('.hitmarker');
    this.scope = q('.scope-overlay');
    this.weaponName = q('.hud-weapon-name');
    this.ammo = q('.hud-ammo');
    this.slots = q('.hud-slots');
    this.status = q('.hud-status');
    this.health = q('.hud-health b');
    this.armor = q('.hud-armor b');
    this.killfeed = q('.killfeed');
    this.damageDir = q('.damage-dir');
    this.death = q('.death-screen');
    this.numbersLayer = q('.damage-numbers');
    this.abilityBar = q('.ability-bar');
    this.flash = q('.flash-overlay');
    this.smokeOverlay = q('.smoke-overlay');
    this.overdriveOverlay = q('.overdrive-overlay');
    this.speedOverlay = q('.speed-overlay');
    this.concussOverlay = q('.concuss-overlay');
    this.statusChips = q('.status-chips');
    this.revealLayer = q('.reveal-layer');
    this.allyTags = q('.ally-tags');
  }

  private abilityBar: HTMLDivElement;
  private flash: HTMLDivElement;
  private smokeOverlay: HTMLDivElement;
  private overdriveOverlay: HTMLDivElement;
  private speedOverlay: HTMLDivElement;
  private concussOverlay: HTMLDivElement;
  private statusChips: HTMLDivElement;
  private statusKey = '';
  private smokeLevel = 0;
  private revealLayer: HTMLDivElement;
  private allyTags: HTMLDivElement;
  private abilityKey = '';

  /** 능력 칸: 키, 이름, 충전 점, 재사용 대기, 궁극기 포인트 */
  private updateAbilities(game: Game): void {
    const ab = game.abilities;
    const keys = game.settings.bindings;
    const key = (s: AbilitySlot) => (keys[s][0] ?? '').replace('Key', '');
    const state = SLOTS.map((s) => `${s}:${ab.charges[s]}:${ab.canUse(s)}:${ab.pendingActivation(s)}:${Math.ceil(ab.cooldownRatio(s) * 10)}:${Math.ceil(ab.rechargeRatio(s) * 20)}:${ab.armed === s}`).join() + ab.ultPoints + ab.agent.id + ab.infinite + game.ribTimer.toFixed(0);
    if (state === this.abilityKey) return;
    this.abilityKey = state;
    this.abilityBar.style.setProperty('--agent', ab.agent.color);
    this.abilityBar.innerHTML = SLOTS.map((s) => {
      const d = ab.def(s);
      let pips: string;
      if (s === 'ultimate') {
        pips = Array.from({ length: ab.ultMax }, (_, i) => `<i class="${i < ab.ultPoints || ab.infinite ? 'on' : ''}"></i>`).join('');
      } else {
        pips = Array.from({ length: d.maxCharges }, (_, i) => `<i class="${i < ab.charges[s] || ab.infinite ? 'on' : ''}"></i>`).join('');
      }
      const ready = ab.canUse(s);
      const pending = ab.pendingActivation(s) || ab.armed === s ? 'pending' : '';
      // 시간 재충전 중이면 남은 초
      const rr = ab.rechargeRatio(s);
      const rech = rr > 0 ? `<em class="ab-rech">${Math.ceil((1 - rr) * (d.recharge ?? 0))}s</em>` : '';
      return `<div class="ab-slot ${s} ${ready ? 'ready' : ''} ${pending}"><kbd>${key(s)}</kbd><b class="ab-icon">${effectIcon(d.effect, 22)}</b><span>${d.name}</span><div class="ab-pips">${pips}</div>${rech}</div>`;
    }).join('') + (game.ribTimer > 0 ? `<div class="ab-buff">REKINDLE ${game.ribTimer.toFixed(0)}s</div>` : '');
  }

  /** 비콘에 드러난 적 위치를 화면에 표시 */
  private updateReveal(game: Game): void {
    const list = game.abilityFx.revealed;
    while (this.revealLayer.children.length < list.length) this.revealLayer.appendChild(document.createElement('i'));
    [...this.revealLayer.children].forEach((el, i) => {
      const t = list[i];
      const e = el as HTMLElement;
      if (!t) {
        e.style.display = 'none';
        return;
      }
      const p = t.center(new THREE.Vector3()).setY(t.center(new THREE.Vector3()).y + 0.9).project(game.camera);
      e.style.display = p.z < 1 ? '' : 'none';
      e.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
      e.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
    });
  }

  /** 내게 걸린 상태 이상 표시 + 충격 화면 효과 */
  private updateStatus(game: Game): void {
    const st = game.abilityFx.status;
    const id = game.local.id;
    const chips: string[] = [];
    const add = (kind: StatusKind, label: string, cls: string) => {
      const t = st.remaining(id, kind);
      if (t > 0) chips.push(`<span class="${cls}">${label} ${t.toFixed(1)}</span>`);
    };
    add('concuss', '충격', 'bad');
    add('suppress', '억제 · 능력 불가', 'bad');
    add('jam', '무력화 · 주무기 불가', 'bad');
    add('slow', '감속', 'bad');
    add('haste', '가속', 'good');
    add('stim', '자극 · 연사/이동 +10%', 'good');
    const decay = st.decayed(id);
    if (decay > 0.5) chips.push(`<span class="bad">쇠약 -${Math.round(decay)}</span>`);
    if (game.repriseTimer > 0) chips.push(`<span class="warn">처치하지 못하면 쓰러짐 ${game.repriseTimer.toFixed(1)}</span>`);
    const ab = game.abilities;
    if (game.reviveChannel > 0) chips.push(`<span class="good">되살아나는 중 ${game.reviveChannel.toFixed(1)}</span>`);
    if (ab.armed) {
      const d = ab.def(ab.armed);
      chips.push(`<span class="good">${d.name} · 좌클릭: ${d.alt?.[0]} · 우클릭: ${d.alt?.[1]}</span>`);
    }
    if (ab.charging) {
      const d = ab.def(ab.charging.slot);
      chips.push(`<span class="good">${d.name} ${ab.faultLength(d, ab.charging.t).toFixed(0)}m · 떼면 발동</span>`);
    }
    if (ab.tailwindArm > 0) chips.push(`<span class="info">바람을 모으는 중 ${ab.tailwindArm.toFixed(1)}</span>`);
    if (game.piloting) chips.push(`<span class="good">드론 조종 중 ${game.piloting.life.toFixed(1)} · 좌클릭/같은 키: 파동</span>`);
    const pending = (['ability1', 'ability2', 'signature'] as const).find((s) => ab.pendingActivation(s));
    if (pending && !game.piloting) {
      const pd = ab.def(pending);
      chips.push(pd.effect === 'tailwind' ? `<span class="good">${pd.name} 준비됨 · 다시 눌러 질주 ${ab.tailwindPrimed.toFixed(1)}</span>` : `<span class="info">${pd.name} 설치됨 · 다시 눌러 발동</span>`);
    }
    if (game.abilities.lastFail) chips.push(`<span class="info">${game.abilities.lastFail}</span>`);
    const key = chips.join('');
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.statusChips.innerHTML = key;
    }
    const c = st.remaining(id, 'concuss');
    this.concussOverlay.style.opacity = c > 0 ? Math.min(1, c).toFixed(2) : '0';
  }

  /** 경기 중 아군 봇 머리 위 이름 (벽 너머로도 보임, 멀면 작게) */
  private updateAllyTags(game: Game): void {
    const allies = game.match && game.bots ? game.bots.allies : [];
    while (this.allyTags.children.length < allies.length) this.allyTags.appendChild(document.createElement('span'));
    const cam = game.camera.position;
    [...this.allyTags.children].forEach((el, i) => {
      const b = allies[i];
      const e = el as HTMLElement;
      if (!b || !b.alive || !b.enabled) {
        e.style.display = 'none';
        return;
      }
      const w = b.eyePos(new THREE.Vector3());
      w.y += 0.45;
      const dist = w.distanceTo(cam);
      const p = w.project(game.camera);
      if (p.z >= 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) {
        e.style.display = 'none';
        return;
      }
      e.style.display = '';
      e.textContent = b.name;
      e.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
      e.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
      e.style.opacity = dist > 40 ? '0.55' : '0.9';
    });
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  setDebugVisible(v: boolean): void {
    this.debug.hidden = !v;
  }

  // ───────────────────────── 이벤트 ─────────────────────────

  showHitmarker(kind: 'body' | 'head' | 'kill'): void {
    this.hitmarker.className = `hitmarker ${kind}`;
    this.hitmarker.hidden = false;
    this.hitTimer = kind === 'kill' ? 0.4 : 0.18;
  }

  addDamageNumber(pos: THREE.Vector3, amount: number, part: HitPart): void {
    const el = document.createElement('div');
    el.className = `dmg-num ${part}`;
    el.textContent = String(amount);
    this.numbersLayer.appendChild(el);
    this.numbers.push({ el, pos: pos.clone(), age: 0 });
    if (this.numbers.length > 20) this.numbers.shift()!.el.remove();
  }

  addKill(killer: string, weapon: string, victim: string, head: boolean, mine: boolean): void {
    const el = document.createElement('div');
    el.className = `kill ${mine ? 'mine' : ''}`;
    el.innerHTML = `<span class="k"></span><i></i><span class="v"></span>`;
    el.querySelector('.k')!.textContent = killer;
    el.querySelector('i')!.textContent = head ? `${weapon} ◎` : weapon;
    el.querySelector('.v')!.textContent = victim;
    this.killfeed.prepend(el);
    while (this.killfeed.children.length > 5) this.killfeed.lastElementChild!.remove();
    setTimeout(() => el.classList.add('fade'), 4500);
    setTimeout(() => el.remove(), 5200);
  }

  /** 피격 방향 표시 (공격자 위치) */
  showDamageFrom(from: THREE.Vector3, _camera: THREE.Camera): void {
    this.damageFrom.copy(from);
    this.damageTimer = 1.2;
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(game: Game, fps: number): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const inv = game.inventory;
    const w = inv.current;
    const local = game.local;

    // ── 조준경 / 조준점 (탄 퍼짐에 따라 벌어짐)
    const scoped = !!w && w.def.category === 'sniper' && inv.aim > 0.95;
    this.scope.hidden = !scoped;
    this.crosshair.hidden = scoped || !local.alive || (inv.aim > 0.5 && w?.def.category !== 'sniper');
    const vfov = THREE.MathUtils.degToRad(game.camera.fov);
    const px = (Math.tan(local.spread) / Math.tan(vfov / 2)) * (window.innerHeight / 2);
    this.crosshair.style.setProperty('--gap', `${Math.min(80, 3 + px).toFixed(1)}px`);

    // ── 히트마커
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarker.hidden = true;
    }

    // ── 체력 / 방어구
    this.health.textContent = String(Math.max(0, Math.round(local.vitals.health)));
    this.health.parentElement!.classList.toggle('low', local.vitals.health <= 30);
    this.armor.textContent = String(Math.round(local.vitals.armor));

    // ── 피격 방향: 화면 중심 기준으로 공격자 쪽에 붉은 호
    if (this.damageTimer > 0) {
      this.damageTimer -= dt;
      const cam = game.camera;
      const to = this.damageFrom.clone().sub(cam.position);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
      const angle = Math.atan2(to.dot(right), to.dot(fwd));
      this.damageDir.hidden = false;
      this.damageDir.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
      this.damageDir.style.opacity = String(Math.min(1, this.damageTimer));
    } else this.damageDir.hidden = true;

    // ── 피해 숫자 (월드 위치를 화면에 투영, 위로 떠오르며 사라짐)
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.age += dt;
      if (n.age > 0.9) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      const p = n.pos.clone().setY(n.pos.y + 0.25 + n.age * 0.6).project(game.camera);
      const visible = p.z < 1;
      n.el.style.display = visible ? '' : 'none';
      n.el.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
      n.el.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
      n.el.style.opacity = String(1 - Math.max(0, n.age - 0.5) / 0.4);
    }

    // ── 능력 / 섬광 / 정찰 표시
    this.updateAbilities(game);
    this.flash.style.opacity = String(Math.min(1, game.abilityFx.playerFlash * 1.2));
    // 연막 안: 화면이 연기로 덮임 (입자는 카메라 가까이에서 흐려지므로 화면 효과로 보완)
    const target = game.abilityFx.smokeDensityAt(game.camera.position);
    this.smokeLevel += (target - this.smokeLevel) * Math.min(1, dt * 6);
    this.smokeOverlay.style.opacity = this.smokeLevel.toFixed(3);
    // 돌진: 화면 가장자리로 뻗는 속도선 (매 프레임 각도를 조금 돌려 흐르는 느낌)
    const dk = game.dashKick;
    this.speedOverlay.style.opacity = (dk * 0.85).toFixed(3);
    if (dk > 0) this.speedOverlay.style.setProperty('--speed-rot', `${(performance.now() / 7) % 360}deg`);
    // REKINDLE: 표식으로 돌아갈 수 있는 동안 화면 가장자리가 주황빛으로 맥동
    const od = game.ribTimer;
    this.overdriveOverlay.style.opacity = od > 0 ? (Math.min(1, od / 0.5) * (0.5 + 0.2 * Math.sin(performance.now() / 160))).toFixed(3) : '0';
    this.updateReveal(game);
    this.updateAllyTags(game);
    this.updateStatus(game);

    // ── 사망 화면
    this.death.hidden = local.alive;
    if (!local.alive) {
      const inMatch = game.mode === 'match';
      this.death.querySelector('p')!.textContent = inMatch ? '다음 라운드에 부활합니다' : `${local.respawnIn.toFixed(1)}초 후 부활`;
      // 경기에서는 1.5초 뒤 관전 화면을 가리지 않도록 작게 위로
      this.death.classList.toggle('compact', inMatch && local.deadTime > 1.5);
    }

    // ── 무기 / 탄약
    if (w) {
      this.weaponName.textContent = w.def.name;
      this.ammo.innerHTML =
        w.def.magazine > 0
          ? `<b class="${w.mag === 0 ? 'empty' : w.mag <= w.def.magazine * 0.25 ? 'low' : ''}">${w.mag}</b><span>/ ${inv.infiniteAmmo ? '∞' : w.reserve}</span>`
          : '<b>—</b>';
    }
    const slotsKey = [1, 2, 3, 4].map((s) => `${s}:${inv.get(s as WeaponSlot)?.def.id ?? ''}`).join() + inv.currentSlot;
    if (slotsKey !== this.lastSlotsKey) {
      this.lastSlotsKey = slotsKey;
      this.slots.innerHTML = ([1, 2, 3, 4] as WeaponSlot[])
        .map((s) => {
          const o = inv.get(s);
          return o ? `<span class="${s === inv.currentSlot ? 'active' : ''}"><i>${s}</i>${o.def.name}</span>` : '';
        })
        .join('');
    }
    this.status.textContent = inv.state === 'reloading' ? 'RELOADING' : '';

    // ── 디버그
    if (this.debug.hidden || now - this.lastDebugUpdate < 100) return;
    this.lastDebugUpdate = now;
    const p = game.player;
    const res = game.psx.internalSize;
    const state = [p.grounded ? 'GROUND' : 'AIR', p.crouching ? 'CROUCH' : p.walking ? 'WALK' : 'RUN'].join(' ');
    this.debug.textContent =
      `FPS   ${fps.toFixed(0)}\n` +
      `RES   ${res.x}x${res.y}\n` +
      `POS   ${p.position.x.toFixed(2)} ${p.position.y.toFixed(2)} ${p.position.z.toFixed(2)}\n` +
      `SPEED ${p.horizontalSpeed.toFixed(2)} m/s\n` +
      `STATE ${state}\n` +
      `WEAP  ${w ? `${w.def.id} ${inv.state}` : '-'}\n` +
      `SPRD  ${THREE.MathUtils.radToDeg(local.spread).toFixed(2)}°  RCL ${THREE.MathUtils.radToDeg(local.recoil.pitch).toFixed(2)}°\n` +
      (game.practice ? `\nSHOWCASE ${game.practice.showcaseLabel}` : '');
  }
}
