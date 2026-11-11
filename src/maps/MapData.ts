/**
 * 맵 데이터 형식.
 * 레이아웃은 ASCII 격자로 작성하며 한 글자가 cellSize x cellSize 미터의 칸이 된다.
 * 북쪽(첫 줄)이 -Z, 동쪽(오른쪽)이 +X 방향이다.
 *
 * 범례
 *   #  벽 (wallHeight)
 *   .  바닥
 *   +  실내 바닥 (지붕 생성)
 *   A  설치 구역 A 바닥
 *   B  설치 구역 B 바닥
 *   T  공격팀 시작 지점
 *   D  수비팀 시작 지점
 *   c  상자 (앉으면 숨을 수 있는 높이)
 *   C  큰 상자 더미 (완전 엄폐)
 *   w  낮은 벽 (동서 방향)
 *   p  기둥
 *   h  높은 발판
 *   s  계단 (인접한 h 방향으로 올라감)
 */
export interface MapDefinition {
  id: string;
  name: string;
  /** 맵 선택 화면의 한 줄 설명 */
  blurb: string;
  cellSize: number;
  wallHeight: number;
  roofHeight: number;
  platformHeight: number;
  layout: string[];
  environment: {
    skyTop: number;
    skyHorizon: number;
    fogColor: number;
    fogNear: number;
    fogFar: number;
    sunColor: number;
    sunIntensity: number;
    /** 태양 방향 (지면을 향하는 방향의 반대, 정규화 불필요) */
    sunDirection: [number, number, number];
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
  };
  /**
   * 연습 모드 배치 (격자 칸 좌표, 소수 가능 — 14.5면 두 칸 사이)
   *   dummies: [열, 행, 바라보는 방향, 높이?] 6개
   *   showcase: 동작 쇼케이스 위치 [열, 행]
   */
  practice: {
    dummies: [number, number, number, number?][];
    showcase: [number, number];
  };
}

/** 격자 칸 좌표 → 월드 좌표 (칸 중심) */
export function cellToWorld(def: MapDefinition, c: number, r: number): { x: number; z: number } {
  const cs = def.cellSize;
  return { x: (-def.layout[0].length * cs) / 2 + (c + 0.5) * cs, z: (-def.layout.length * cs) / 2 + (r + 0.5) * cs };
}

export const SOLID_CELLS = new Set(['#']);
export const FLOOR_CELLS = new Set(['.', '+', 'A', 'B', 'T', 'D']);
export const PROP_CELLS = new Set(['c', 'C', 'w', 'p', 'h', 's']);
