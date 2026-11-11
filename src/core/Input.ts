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

  requestLock(): void {
    const p = this.target.requestPointerLock({ unadjustedMovement: true }) as unknown as
      | Promise<void>
      | undefined;
    // unadjustedMovement(원시 입력)를 지원하지 않는 환경이면 일반 포인터 락으로 재시도
    p?.catch?.(() => this.target.requestPointerLock());
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
