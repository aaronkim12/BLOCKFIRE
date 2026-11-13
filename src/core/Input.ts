import type { Action, KeyBindings } from './settings';

/**
 * 키보드/마우스 입력을 액션 단위로 추상화한다.
 * 게임 코드는 키 코드가 아니라 액션 이름으로만 입력을 조회한다.
 */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  /** 포인터 락 상태가 아닐 때도 입력을 받을지 (자동 테스트용) */
  forceActive = false;
  /** 구매 메뉴 등 UI가 열려 있는 동안 게임 입력을 막는다 */
  suspended = false;

  constructor(
    private target: HTMLElement,
    private bindings: KeyBindings,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.clear);
    window.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });
  }

  setBindings(b: KeyBindings): void {
    this.bindings = b;
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  get active(): boolean {
    return (this.locked || this.forceActive) && !this.suspended;
  }

  /** 원시 마우스 입력(unadjustedMovement)을 쓸 수 있는지 — 거부되면 다음부터 일반 포인터 락 */
  private rawOk = true;
  /** 포인터 락 직후 몇 번의 이동은 버린다 (브라우저가 큰 값을 한 번에 보내는 경우가 있음) */
  private skipMoves = 0;

  /**
   * 포인터 락 요청. 잠기면 true, 브라우저가 거부하면 false.
   * (예전에는 거부돼도 알 수 없어서, 게임은 진행 중인데 마우스가 풀린 채 아무 키도 안 먹는 상태가 됐다)
   */
  requestLock(): Promise<boolean> {
    if (this.locked) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        clearTimeout(timer);
        resolve(ok);
      };
      const onChange = () => {
        if (this.locked) finish(true);
      };
      const onError = () => finish(this.locked);
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
      const timer = setTimeout(() => finish(this.locked), 1500);
      try {
        const p = (this.rawOk ? this.target.requestPointerLock({ unadjustedMovement: true }) : this.target.requestPointerLock()) as unknown as
          | Promise<void>
          | undefined;
        p?.catch?.((e: DOMException) => {
          // 원시 입력을 지원하지 않는 기기(일부 크롬북 등): 다음 클릭부터 일반 포인터 락
          if (e?.name === 'NotSupportedError') this.rawOk = false;
          finish(this.locked);
        });
      } catch {
        this.rawOk = false;
        finish(false);
      }
    });
  }

  /** 포인터 락이 새로 걸렸을 때 (Game이 호출) */
  onLocked(): void {
    this.skipMoves = 2;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  isDown(action: Action): boolean {
    if (!this.active) return false;
    return this.bindings[action].some((c) => this.down.has(c));
  }

  /** 이번 프레임에 새로 눌렸는지 */
  wasPressed(action: Action): boolean {
    if (!this.active) return false;
    return this.bindings[action].some((c) => this.pressedThisFrame.has(c));
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  /** 프레임 끝에 호출 */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  /** 자동 테스트에서 마우스 이동을 흉내낸다 */
  injectMouse(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  private press(code: string): void {
    if (!this.down.has(code)) this.pressedThisFrame.add(code);
    this.down.add(code);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    // 게임 중 브라우저 기본 동작(스페이스 스크롤, Tab 포커스 이동 등) 차단
    if (e.code === 'Tab' || e.code === 'Space' || e.ctrlKey) e.preventDefault();
    this.press(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return;
    this.press(`Mouse${e.button}`);
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.down.delete(`Mouse${e.button}`);
  };

  /** 휠은 '누른 순간'만 있고 누르고 있는 상태는 없다 */
  private onWheel = (e: WheelEvent): void => {
    if (!this.active || e.deltaY === 0) return;
    this.pressedThisFrame.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (this.skipMoves > 0) {
      this.skipMoves--;
      return;
    }
    // 한 번에 터무니없이 큰 이동(포인터 락이 풀리거나 다시 걸릴 때 브라우저가 보내는 값)은 무시
    // — 이 값 때문에 시선이 한 바퀴 돌아 다른 사람 화면에서 캐릭터가 빙글 도는 일이 있었다
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  clear = (): void => {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  };
}
