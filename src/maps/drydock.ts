import type { MapDefinition } from './MapData';

/**
 * DRYDOCK — 해 질 녘 조선소.
 * 수비 스폰(북) / 공격 스폰(남). 서쪽 A 구역(고지대 + 계단), 동쪽 B 구역(지붕 덮인 창고 입구),
 * 중앙은 지붕 덮인 연결 통로와 낮은 벽, 양옆에 긴 외곽 통로.
 * 작업 원칙: 모든 칸은 격자 한 칸씩만 차지하므로 벽·바닥이 서로 겹치지 않고,
 * npm run check:maps 로 겹침과 이동 가능성을 검사한다.
 */
export const DRYDOCK: MapDefinition = {
  id: 'drydock',
  name: 'DRYDOCK',
  blurb: '해 질 녘 조선소 · 지붕 덮인 중앙 통로',
  cellSize: 3,
  wallHeight: 6,
  roofHeight: 4,
  platformHeight: 1.6,
  // prettier-ignore
  layout: [
    '############################',
    '#.......###DDDDDD###.......#',
    '#..c....###DDDDDD###....c..#',
    '#...........DDDD...........#',
    '#.####..p............p..##.#',
    '#.#AAAAAAAA##....##BBBBBBB.#',
    '#.#AAhhAAAA##.++.##BBBCBBB.#',
    '#.#AAhhAAAA...++...BBBBBBB.#',
    '#.#AAssAAcA##.++.##BBBBBcB.#',
    '#...AAAAAAA##.++.##BBBBBBB.#',
    '#.#AAAAAAAA##....##BBBBBBB.#',
    '#.####..####..ww..####..##.#',
    '#.......#............#.....#',
    '###..#..#..c......c..#..#..#',
    '#....#..####......####..#..#',
    '#....#.......p..p.......#..#',
    '#.C..####............####..#',
    '#....#+++++#..ww..#+++++#..#',
    '#....#+++++...cc...+++++...#',
    '#....#+++++#......#+++++#..#',
    '#....#######..##..#######..#',
    '#..c.....................c.#',
    '###...##...#......#...##.###',
    '#.....##.c.#......#.c..#...#',
    '#..........................#',
    '####...###TTTTTTTT###...####',
    '####......TTTTTTTT......####',
    '#####.....TTTTTTTT.....#####',
    '############################',
  ],
  environment: {
    skyTop: 0x1c2a4a,
    skyHorizon: 0x7fa6c8,
    fogColor: 0x6f8aa4,
    fogNear: 40,
    fogFar: 165,
    sunColor: 0xd8e6ff,
    sunIntensity: 2.3,
    sunDirection: [-0.5, 1.0, 0.45],
    hemiSky: 0xa8c0e0,
    hemiGround: 0x4a5560,
    hemiIntensity: 1.9,
  },
  practice: {
    // [열, 행, 방향, 높이?] — 격자 칸 중심에 세운다
    dummies: [
      [4, 6, Math.PI],
      [5, 6, Math.PI, 1.6],
      [24, 7, Math.PI * 0.8],
      [14, 13, Math.PI],
      [23, 18, Math.PI],
      [14, 2, Math.PI],
    ],
    showcase: [13, 23],
  },
};
