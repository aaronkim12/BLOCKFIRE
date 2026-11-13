// 플레이어가 변경할 수 있는 설정. localStorage에 저장된다.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'walk'
  | 'crouch'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'interact'
  | 'buy'
  | 'scoreboard'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'nextWeapon'
  | 'prevWeapon'
  | 'lastWeapon'
  | 'slot4'
  | 'drop'
  | 'ability1'
  | 'ability2'
  | 'signature'
  | 'ultimate'
  | 'map';

/** 액션 -> KeyboardEvent.code / 'Mouse0'(좌클릭) / 'Mouse2'(우클릭) / 'WheelUp' / 'WheelDown' */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  walk: ['ShiftLeft'],
  // 브라우저에서 Ctrl+W는 탭 닫기이므로 C도 기본으로 함께 바인딩한다.
  crouch: ['ControlLeft', 'KeyC'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  buy: ['KeyB'],
  scoreboard: ['Tab'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  nextWeapon: ['WheelDown'],
  prevWeapon: ['WheelUp'],
  // Q는 능력에 쓰므로 직전 무기는 기본 키 없음 (설정에서 지정 가능)
  lastWeapon: [],
  // Core (발로란트의 스파이크처럼 4번 슬롯), G로 버리기
  slot4: ['Digit4'],
  drop: ['KeyG'],
  ability1: ['KeyQ'],
  ability2: ['KeyZ'],
  signature: ['KeyF'],
  ultimate: ['KeyX'],
  map: ['KeyM'],
};

export interface PSXSettings {
  /** 화면 픽셀 몇 개가 렌더 픽셀 1개가 되는지 (1 = 네이티브). 정수 배율이라 픽셀 크기가 고르다 */
  pixelScale: number;
  /** 0 = 끔, 1 = 약하게, 2 = 강하게 (PS1 원본 수준) */
  vertexJitter: number;
  /** 0 = 끔, 1 = 약하게, 2 = 강하게 */
  affineWarp: number;
  dithering: boolean;
  /** 채널당 색상 비트 수 (PS1 = 5) */
  colorBits: number;
  fog: boolean;
}

export type GraphicsPreset = 'classic' | 'modern' | 'clean';

export const GRAPHICS_PRESETS: Record<GraphicsPreset, PSXSettings> = {
  /** PS1 원본에 가까운 강한 효과 */
  classic: { pixelScale: 4, vertexJitter: 2, affineWarp: 2, dithering: true, colorBits: 5, fog: true },
  /** 기본값: PS1 느낌은 유지하되 플레이하기 편한 선명도 */
  modern: { pixelScale: 2, vertexJitter: 1, affineWarp: 1, dithering: true, colorBits: 6, fog: true },
  /** 효과를 거의 끈 선명한 화면 (텍스처와 모델만 레트로) */
  clean: { pixelScale: 1, vertexJitter: 0, affineWarp: 0, dithering: false, colorBits: 8, fog: true },
};

export interface Settings {
  sensitivity: number;
  fov: number;
  invertY: boolean;
  bindings: KeyBindings;
  psx: PSXSettings;
  showDebug: boolean;
  /** 효과음 음량 0..1 */
  volume: number;
  /**
   * 성능 모드 (저사양 기기·크롬북): 렌더 해상도·그림자·입자 품질을 낮춘다.
   * auto = 크롬북이거나 프레임이 계속 낮으면 자동으로 켬
   */
  performance: 'auto' | 'high' | 'low';
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1.0,
  fov: 90,
  invertY: false,
  bindings: DEFAULT_BINDINGS,
  psx: { ...GRAPHICS_PRESETS.modern },
  showDebug: true,
  volume: 0.6,
  performance: 'auto',
};

// v2: PSX 설정 형식 변경 (renderHeight → pixelScale, 효과 단계화)
const STORAGE_KEY = 'blockfire.settings.v2';

export function loadSettings(): Settings {
  const base: Settings = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // 능력 키가 추가되기 전에 저장된 키 설정은 Q가 겹치므로 기본값으로 되돌린다
    if (saved.bindings && !('ability1' in saved.bindings)) delete saved.bindings;
    return {
      ...base,
      ...saved,
      bindings: { ...base.bindings, ...saved.bindings },
      psx: { ...base.psx, ...saved.psx },
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 무시
  }
}
