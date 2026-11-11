import type { MapDefinition } from './MapData';

/**
 * FOUNDRY — 첫 번째 테스트 맵.
 * 수비 스폰(북) / 공격 스폰(남), 서쪽 A 구역, 동쪽 B 구역,
 * 중앙 통로, 중앙 뒤편 실내 건물, B 메인의 지붕 덮인 홀, A 구역 고지대.
 */
export const FOUNDRY: MapDefinition = {
  id: 'foundry',
  name: 'FOUNDRY',
  cellSize: 3,
  wallHeight: 6,
  roofHeight: 4,
  platformHeight: 1.6,
  // prettier-ignore
  layout: [
    '##############################',
    '#.........##DDDDDD##.........#',
    '#..c......##DDDDDD##......c..#',
    '#...........DDDDDD...........#',
    '#.####..####..pp..####..####.#',
    '#.#AAAAAAAA#.######.#BBBBBBBB#',
    '#.#AAcAAAAA#.#++++#.#BBBCCBBB#',
    '#.#AAAAhhAA..+++++#.#BBBBBBBB#',
    '#.#AAAAhhAA#.#++++..BBBBBBBBB#',
    '#.#AAAAssAA#.#++++#.#BBcBBBBB#',
    '#...AAAAAAA#.##++##.#BBBBBBB.#',
    '#.#AAAAAAAA#........#BBBBBBBB#',
    '#.####..####..c..c..####..##.#',
    '#.......#..............#.....#',
    '#.......#..##......##..#.....#',
    '#####..##..#........#..##..###',
    '#..........#..w..w..#........#',
    '#..........#........#..++++..#',
    '#..C...C...#...pp...#..++++..#',
    '#..........##......##..++++..#',
    '#.....c.....#......#...++++..#',
    '###..####...#......#...++++..#',
    '#......#....#..cc..#.........#',
    '#......#....#......#....c....#',
    '#......#..........#####.....##',
    '#...........................##',
    '#####...#####......####....###',
    '#####...#TTTTTTTTTTTT#.....###',
    '#####...TTTTTTTTTTTTTT.....###',
    '######..TTTTTTTTTTTTTT...#####',
    '##############################',
  ],
  environment: {
    skyTop: 0x2a3a6a,
    skyHorizon: 0xd8a070,
    fogColor: 0xb89070,
    fogNear: 40,
    fogFar: 170,
    sunColor: 0xffe2b8,
    sunIntensity: 2.6,
    sunDirection: [0.55, 1.0, 0.35],
    hemiSky: 0x9fb4d8,
    hemiGround: 0x6a5440,
    // 그늘 속 적도 식별할 수 있도록 환경광을 충분히 준다
    hemiIntensity: 1.8,
  },
};
