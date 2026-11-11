/**
 * 캐릭터(에이전트)와 능력 데이터.
 * 능력의 작동 방식은 전술 FPS의 대표적인 역할군(돌격·척후·감시·통제) 구성을 참고했고,
 * 캐릭터 이름·능력 이름·설정·외형은 BLOCKFIRE 고유의 것이다.
 *
 * 능력 슬롯
 *   ability1 / ability2 : 라운드마다 구매해서 충전하는 기본 능력
 *   signature           : 라운드마다 1회 무료로 충전되는 고유 능력
 *   ultimate            : 궁극기 — 처치/사망/목표 달성으로 포인트를 모아야 사용
 */

export type AbilitySlot = 'ability1' | 'ability2' | 'signature' | 'ultimate';

export type AbilityEffect =
  // ── 통제 (WARDEN)
  | 'stim' // 신호기: 범위 안 아군의 연사·이동 속도 +10%
  | 'incendiary' // 발사기로 쏘는 소이탄: 튕긴 뒤 화염 지대
  | 'skysmoke' // 전술 지도에서 최대 3곳에 연막 투하
  | 'orbital' // 궁극기: 지도에서 고른 곳에 궤도 레이저 (2초 뒤 3초간)
  // ── 돌격 (VOLT)
  | 'blaze' // 앞으로 뻗어 나가는 불길 벽 (키를 누르고 있으면 휨, 벽 통과)
  | 'hothands' // 화염구: 떨어진 자리에 화염 지대
  | 'curveball' // 왼쪽/오른쪽으로 휘어 0.6초 뒤 터지는 섬광 (2킬마다 재충전)
  | 'runitback' // 궁극기: 표식을 남기고, 죽거나 시간이 끝나면 표식으로 돌아옴
  // ── 돌격 (GALE)
  | 'cloudburst' // 연막탄: 누르고 있는 동안 조준 방향으로 휘어 날아감
  | 'updraft' // 위로 높이 도약
  | 'tailwind' // 한 번 눌러 준비(1초), 다시 눌러 이동 방향으로 질주 (2킬마다 재충전)
  | 'bladestorm' // 궁극기: 정확한 투척 단검 (처치하면 다시 채워짐)
  // ── 척후 (TREMOR)
  | 'aftershock' // 벽에 붙여 벽 너머를 2연속 폭발로 공격
  | 'flashpoint' // 벽을 뚫고 넘어가 터지는 섬광
  | 'faultline' // 누르고 있으면 길어지는 일직선 충격파 (벽 통과)
  | 'quake' // 궁극기: 앞쪽 넓은 띠로 연쇄 지진 — 충격 + 공중으로 띄움
  // ── 척후 (MARSHAL)
  | 'drone' // 직접 조종하는 정찰 드론: 다시 누르면 파동으로 억제 + 위치 표시
  | 'sticky' // 닿으면 붙는(우클릭: 한 번 튕기는) 충격탄
  | 'salvo' // 전술 지도에서 고른 곳에 미사일 (3연속 폭발)
  | 'armageddon' // 궁극기: 지도에서 시작점→끝점, 경로를 따라 연쇄 폭격
  // ── 감시 (THORN)
  | 'razorvine' // 보이지 않는 가시덤불: 다시 눌러 발동하면 지나가는 적을 감속·피해
  | 'shear' // 벽에 붙이는 함정: 적이 지나가면 그 줄을 따라 벽이 솟음
  | 'arcrose' // 벽·바닥에 설치(우클릭: 벽 너머)하고 다시 눌러 섬광
  | 'steelgarden' // 궁극기: 주변 적의 주무기를 잠시 쓸 수 없게 만듦
  // ── 통제 (ECHO)
  | 'pickmeup' // 방금 처치(관여)한 적의 기운을 흡수: 가속 + 추가 체력
  | 'meddle' // 바닥에 닿으면 터져 범위 안 모두를 쇠약(일시적 체력 감소)
  | 'ruse' // 전술 지도로 연막 (죽은 뒤에도 사용 가능)
  | 'notdeadyet'; // 궁극기: 죽은 뒤 되살아남 — 짧은 시간 안에 처치하지 못하면 다시 쓰러짐

/** 역할군 (선택 화면 분류) */
export type RoleClass = 'duelist' | 'initiator' | 'sentinel' | 'controller';

export const ROLE_LABEL: Record<RoleClass, string> = {
  duelist: '돌격',
  initiator: '척후',
  sentinel: '감시',
  controller: '통제',
};

export type AbilityTarget = 'enemies' | 'self' | 'area';

export interface AbilityDef {
  id: string;
  slot: AbilitySlot;
  name: string;
  description: string;
  effect: AbilityEffect;
  /** 충전 1회 구매 가격 (signature/ultimate는 0) */
  cost: number;
  maxCharges: number;
  /** 라운드 시작 시 무료로 채워지는 충전 수 */
  freeCharges: number;
  /** 같은 능력을 다시 쓰기까지 대기 (초) */
  cooldown: number;
  /** 효과 지속 시간 (초) */
  duration: number;
  /** 효과 범위 (m) */
  radius: number;
  target: AbilityTarget;
  /** 궁극기 필요 포인트 */
  ultPoints?: number;
  /** 투척 능력: 던지는 속도 (m/s). 0이면 즉시 발동 */
  throwSpeed: number;
  /** 효과별 수치 (피해량, 이동 거리 등) */
  power: number;
  /** 고유 능력: 다 쓴 충전이 이 시간(초)마다 하나씩 다시 채워진다 */
  recharge?: number;
  /** 적을 이만큼 처치할 때마다 충전 하나 */
  killRecharge?: number;
  /** 키를 누르면 꺼내 들고, 좌클릭/우클릭으로 다르게 사용 (각각의 설명) */
  alt?: [string, string];
  /** 키를 누르고 있다가 떼면 발동 (누른 시간만큼 길어짐) */
  hold?: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  role: string;
  /** 대표 색 (UI) */
  color: string;
  roleClass: RoleClass;
  /** 한 줄 소개 (선택 화면) */
  tagline: string;
  /** 패시브: drift = 공중에서 점프를 누르고 있으면 천천히 내려옴, innerfire = 자기 불 위에서 회복 */
  passive?: 'drift' | 'innerfire';
  /** 패시브 설명 (선택 화면) */
  passiveText?: string;
  bio: string;
  abilities: Record<AbilitySlot, AbilityDef>;
}

const A = (d: AbilityDef) => d;

export const AGENTS: AgentDef[] = [
  // ───────────────────────── 통제: 지휘관 ─────────────────────────
  {
    id: 'warden',
    name: 'WARDEN',
    role: '통제 · 지휘',
    roleClass: 'controller',
    tagline: '하늘에서 길을 막는다',
    color: '#4fe0c0',
    bio: '노련한 야전 지휘관. 전술 지도로 하늘에서 연막을 떨어뜨려 길을 막고, 신호기로 팀을 몰아붙이며, 궤도 레이저로 자리를 지운다.',
    abilities: {
      ability1: A({
        id: 'rally', slot: 'ability1', name: 'RALLY BEACON', description: '신호기를 던진다. 착지한 자리 반경 6m 안의 아군은 연사·이동 속도가 10% 빨라진다 (벗어나도 4초 유지). 12초 지속.',
        effect: 'stim', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 12, radius: 6,
        target: 'area', throwSpeed: 14, power: 1.1,
      }),
      ability2: A({
        id: 'cinder', slot: 'ability2', name: 'CINDER SHELL', description: '발사기로 소이탄을 쏜다. 튕기다 멈춘 자리에 8초 동안 화염 지대(초당 60)가 생긴다.',
        effect: 'incendiary', cost: 250, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 8, radius: 4.5,
        target: 'enemies', throwSpeed: 24, power: 60,
      }),
      signature: A({
        id: 'skyveil', slot: 'signature', name: 'SKY VEIL', description: '전술 지도를 열어 50m 안에서 최대 3곳을 고르면(좌클릭, 다시 누르면 투하) 하늘에서 연막이 떨어져 19초 동안 시야를 막는다. 1회 무료, 추가 100.',
        effect: 'skysmoke', cost: 100, maxCharges: 3, freeCharges: 1, cooldown: 0.5, duration: 19.25, radius: 4.5,
        target: 'area', throwSpeed: 0, power: 50,
      }),
      ultimate: A({
        id: 'halo', slot: 'ultimate', name: 'HALO STRIKE', description: '전술 지도에서 한 곳을 고르면 2초 뒤 궤도 레이저가 3초 동안 내리쳐 총 500의 피해를 준다. 레이저 기둥은 시야도 가린다.',
        effect: 'orbital', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 3, radius: 7,
        target: 'enemies', ultPoints: 8, throwSpeed: 0, power: 500,
      }),
    },
  },
  // ───────────────────────── 돌격: 불꽃 ─────────────────────────
  {
    id: 'volt',
    name: 'VOLT',
    role: '돌격 · 화염',
    roleClass: 'duelist',
    tagline: '불꽃처럼 먼저',
    color: '#ffb43c',
    bio: '스스로를 불태워 싸우는 진입 전문가. 휘어 들어가는 섬광으로 모퉁이를 열고, 불길 벽으로 길을 가른다.',
    passive: 'innerfire',
    passiveText: '자기가 만든 불(FLAME LINE·HEAT CORE) 위에 서 있으면 초당 6.25씩 체력을 회복한다 (불 하나당 최대 50).',
    abilities: {
      ability1: A({
        id: 'flameline', slot: 'ability1', name: 'FLAME LINE', description: '앞으로 뻗어 나가는 불길 벽(약 18m)을 만든다. 키를 누르고 있으면 조준하는 쪽으로 휜다. 벽을 통과하고 시야를 막으며, 닿으면 초당 30 피해. 8초 지속.',
        effect: 'blaze', cost: 150, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 8, radius: 18,
        target: 'area', throwSpeed: 0, power: 30,
      }),
      ability2: A({
        id: 'heatcore', slot: 'ability2', name: 'HEAT CORE', description: '화염구를 던진다(좌클릭: 멀리, 우클릭: 짧게). 떨어진 자리에 4초 동안 화염 지대(초당 60)가 생긴다.',
        effect: 'hothands', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 4, radius: 4.5,
        target: 'enemies', throwSpeed: 20, power: 60, alt: ['멀리 던지기', '짧게 던지기'],
      }),
      signature: A({
        id: 'arcflare', slot: 'signature', name: 'ARC FLARE', description: '섬광탄을 꺼내 좌클릭은 왼쪽, 우클릭은 오른쪽으로 휘어 던진다. 0.6초 뒤 터지며 바라본 사람은 1.5초 동안 앞이 보이지 않는다. 1회 무료, 추가 250, 2킬마다 재충전.',
        effect: 'curveball', cost: 250, maxCharges: 2, freeCharges: 1, cooldown: 0.4, duration: 1.5, radius: 30,
        target: 'enemies', throwSpeed: 16, power: 0, killRecharge: 2, alt: ['왼쪽으로 휨', '오른쪽으로 휨'],
      }),
      ultimate: A({
        id: 'rekindle', slot: 'ultimate', name: 'REKINDLE', description: '지금 자리에 표식을 남긴다. 10초 안에 쓰러지거나 시간이 다 되면 표식으로 돌아와 체력 100(방어구는 사용할 때만큼)으로 다시 싸운다.',
        effect: 'runitback', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 10, radius: 0,
        target: 'self', ultPoints: 7, throwSpeed: 0, power: 100,
      }),
    },
  },
  // ───────────────────────── 돌격: 바람 ─────────────────────────
  {
    id: 'gale',
    name: 'GALE',
    role: '돌격 · 기동',
    roleClass: 'duelist',
    tagline: '바람보다 빠르게',
    color: '#9fe3ff',
    bio: '바람을 다루는 기동 전문가. 휘어 나가는 연막으로 길을 열고, 도약과 질주로 적이 예상하지 못한 각에서 나타난다.',
    passive: 'drift',
    passiveText: '공중에서 점프를 누르고 있으면 천천히 활강한다 (억제·감속 중에는 불가).',
    abilities: {
      ability1: A({
        id: 'veilburst', slot: 'ability1', name: 'VEIL BURST', description: '작은 연막탄을 던진다. 키를 누르고 있으면 조준하는 방향으로 휘어 날아가고, 닿은 자리(공중 포함)에 2.5초 동안 시야를 가리는 연기가 핀다.',
        effect: 'cloudburst', cost: 200, maxCharges: 2, freeCharges: 0, cooldown: 0.4, duration: 2.5, radius: 2.6,
        target: 'area', throwSpeed: 22, power: 0,
      }),
      ability2: A({
        id: 'uprise', slot: 'ability2', name: 'UPRISE', description: '순간적으로 바람을 일으켜 약 5.5m 높이로 솟구친다. 구매 단계에도 쓸 수 있다.',
        effect: 'updraft', cost: 150, maxCharges: 1, freeCharges: 0, cooldown: 0.3, duration: 0, radius: 0,
        target: 'self', throwSpeed: 0, power: 14.8,
      }),
      signature: A({
        id: 'slipstream', slot: 'signature', name: 'SLIPSTREAM', description: '눌러서 1초 동안 바람을 모은다. 그 뒤 7.5초 안에 다시 누르면 이동하는 방향(입력이 없으면 앞)으로 순식간에 질주한다 (질주 중에는 맞지 않음). 적을 2명 처치할 때마다 다시 충전된다.',
        effect: 'tailwind', cost: 0, maxCharges: 1, freeCharges: 1, cooldown: 0.2, duration: 0.18, radius: 7.5,
        target: 'self', throwSpeed: 0, power: 44, killRecharge: 2,
      }),
      ultimate: A({
        id: 'stormedge', slot: 'ultimate', name: 'STORM EDGE', description: '단검 5자루가 주위에 떠오른다. 좌클릭은 퍼짐·반동 없이 한 자루씩 — 처치하면 5자루로 다시 채워진다. 우클릭은 남은 단검을 0.33초 간격으로 모두 던진다(재충전 없음). 머리 150 · 몸 50 · 다리 42.',
        effect: 'bladestorm', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 0, radius: 0,
        target: 'enemies', ultPoints: 8, throwSpeed: 0, power: 5,
      }),
    },
  },
  // ───────────────────────── 척후: 지진 ─────────────────────────
  {
    id: 'tremor',
    name: 'TREMOR',
    role: '척후 · 돌파',
    roleClass: 'initiator',
    tagline: '벽 너머를 흔든다',
    color: '#ff8a3c',
    bio: '공학 의수로 땅을 울리는 돌파 전문가. 벽을 사이에 두고도 적을 흔들어 놓고 팀의 진입을 연다.',
    abilities: {
      ability1: A({
        id: 'rivet', slot: 'ability1', name: 'RIVET CHARGE', description: '벽에 폭약을 붙인다. 2.5초 뒤 벽 너머 공간에 두 번 폭발한다 (한 번에 최대 80).',
        effect: 'aftershock', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 1, duration: 2.5, radius: 3,
        target: 'enemies', throwSpeed: 0, power: 80,
      }),
      ability2: A({
        id: 'glare', slot: 'ability2', name: 'GLARE CHARGE', description: '벽을 뚫고 넘어가 0.5초 뒤 터지는 섬광. 터지는 쪽을 보고 있던 사람은 2.25초 동안 앞이 보이지 않는다.',
        effect: 'flashpoint', cost: 250, maxCharges: 2, freeCharges: 0, cooldown: 0.8, duration: 2.25, radius: 30,
        target: 'enemies', throwSpeed: 0, power: 0,
      }),
      signature: A({
        id: 'seismic', slot: 'signature', name: 'SEISMIC LINE', description: '키를 누르고 있으면 충격파가 닿을 거리가 늘어나고(최대 40m), 떼면 1.1초 뒤 폭 8m 띠 안의 적이 2.5초 동안 충격 상태가 된다. 벽을 통과한다. 50초마다 재충전.',
        effect: 'faultline', cost: 0, maxCharges: 1, freeCharges: 1, cooldown: 0.5, duration: 2.5, radius: 4,
        target: 'enemies', throwSpeed: 0, power: 40, recharge: 50, hold: true,
      }),
      ultimate: A({
        id: 'surge', slot: 'ultimate', name: 'GROUND SURGE', description: '앞쪽 폭 18m 띠를 따라 5m씩 8번 연쇄 지진. 맞은 적은 공중으로 뜨고 4초 동안 충격 상태가 된다. 지형을 무시한다.',
        effect: 'quake', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 4, radius: 18,
        target: 'enemies', ultPoints: 8, throwSpeed: 0, power: 40,
      }),
    },
  },
  // ───────────────────────── 척후: 화력 지원 ─────────────────────────
  {
    id: 'marshal',
    name: 'MARSHAL',
    role: '척후 · 화력 지원',
    roleClass: 'initiator',
    tagline: '하늘에서 길을 낸다',
    color: '#d9c25a',
    bio: '노련한 작전 지휘관. 직접 조종하는 드론으로 적을 찾아 묶어 두고, 정밀 폭격으로 숨을 곳을 없앤다.',
    abilities: {
      ability1: A({
        id: 'seeker', slot: 'ability1', name: 'SEEKER DRONE', description: '드론을 날려 6초 동안 직접 조종한다(이동 키·점프, 마우스로 방향). 좌클릭이나 같은 키로 파동을 내면 드론에서 보이는 16m 안 적이 8초 동안 억제되고 위치가 드러난다. 드론 체력 50.',
        effect: 'drone', cost: 400, maxCharges: 1, freeCharges: 0, cooldown: 1, duration: 6, radius: 16,
        target: 'enemies', throwSpeed: 0, power: 8,
      }),
      ability2: A({
        id: 'knock', slot: 'ability2', name: 'KNOCK GRENADE', description: '충격탄을 꺼내 좌클릭은 닿는 곳에 바로 붙이고, 우클릭은 한 번 튕긴 뒤 붙인다. 1초 뒤 터져 35~20 피해와 1.5~2.5초 충격.',
        effect: 'sticky', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 0.6, duration: 2.5, radius: 5,
        target: 'enemies', throwSpeed: 18, power: 35, alt: ['바로 붙이기', '한 번 튕기기'],
      }),
      signature: A({
        id: 'strike', slot: 'signature', name: 'STRIKE CALL', description: '전술 지도를 열어 45m 안에서 최대 2곳을 고르면(좌클릭, 다시 누르면 발사) 미사일이 1.25초 날아가 0.8초 간격으로 세 번 폭발한다 (한 번에 50~65). 미사일 1발당 1회 충전. 1회 무료, 추가 150.',
        effect: 'salvo', cost: 150, maxCharges: 2, freeCharges: 1, cooldown: 0.8, duration: 0.8, radius: 4,
        target: 'enemies', throwSpeed: 0, power: 65,
      }),
      ultimate: A({
        id: 'scorch', slot: 'ultimate', name: 'SCORCH PATH', description: '전술 지도에서 시작 지점과 끝 지점을 찍으면 3초 뒤 경로를 따라 16구간이 차례로 네 번씩 폭발한다 (한 번에 60). 피하지 않으면 살아남기 어렵다.',
        effect: 'armageddon', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 1, radius: 3.5,
        target: 'enemies', ultPoints: 9, throwSpeed: 0, power: 60,
      }),
    },
  },
  // ───────────────────────── 감시: 금속 정원 ─────────────────────────
  {
    id: 'thorn',
    name: 'THORN',
    role: '감시 · 함정',
    roleClass: 'sentinel',
    tagline: '들어온 길은 닫힌다',
    color: '#b48cff',
    bio: '액체 금속을 다루는 함정 설계자. 보이지 않는 가시와 벽으로 침입자의 발을 묶는다.',
    abilities: {
      ability1: A({
        id: 'briar', slot: 'ability1', name: 'BRIAR NEST', description: '가시덤불을 던진다. 떨어지면 거의 보이지 않고(4m 안의 적에게만 희미하게), 다시 누르면 0.3초 뒤 7초 동안 솟아 안에서 움직이는 적을 15% 느리게 하고 움직인 거리만큼 피해(걸음마다 10)를 준다.',
        effect: 'razorvine', cost: 150, maxCharges: 2, freeCharges: 0, cooldown: 0.5, duration: 7, radius: 4,
        target: 'enemies', throwSpeed: 14, power: 10,
      }),
      ability2: A({
        id: 'snapwall', slot: 'ability2', name: 'SNAP WALL', description: '벽면에 보이지 않는 함정 줄을 붙인다. 적이 그 줄을 지나가면 0.8초 뒤 줄을 따라 부서지지 않는 벽이 6초 동안 솟아 길을 끊는다.',
        effect: 'shear', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 6, radius: 6,
        target: 'enemies', throwSpeed: 0, power: 1e6,
      }),
      signature: A({
        id: 'glint', slot: 'signature', name: 'GLINT BLOOM', description: '금속 꽃을 꺼내 좌클릭은 조준한 면에, 우클릭은 그 벽 너머에 붙인다. 다시 누르면 0.5초 뒤 강한 빛을 내 바라본 사람의 눈을 2초 동안 멀게 한다. 쓴 뒤 20초마다 재충전.',
        effect: 'arcrose', cost: 0, maxCharges: 1, freeCharges: 1, cooldown: 0.5, duration: 2, radius: 25,
        target: 'enemies', throwSpeed: 0, power: 0, recharge: 20, alt: ['조준한 면에 설치', '벽 너머에 설치'],
      }),
      ultimate: A({
        id: 'thicket', slot: 'ultimate', name: 'IRON THICKET', description: '4.4초 뒤 주변 28m로 금속 가시가 퍼진다. 범위 안의 적은 8초 동안 주무기를 쓸 수 없다 (보조무기·칼은 가능).',
        effect: 'steelgarden', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 8, radius: 28,
        target: 'enemies', ultPoints: 8, throwSpeed: 0, power: 4.4,
      }),
    },
  },
  // ───────────────────────── 통제: 불멸 ─────────────────────────
  {
    id: 'echo',
    name: 'ECHO',
    role: '통제 · 불멸',
    roleClass: 'controller',
    tagline: '쓰러져도 끝이 아니다',
    color: '#ff7ad1',
    bio: '죽음을 몇 번이고 건너온 장난기 많은 전략가. 멀리서 연막을 깔고, 쓰러진 뒤에도 전장을 바꾼다.',
    abilities: {
      ability1: A({
        id: 'siphon', slot: 'ability1', name: 'SIPHON', description: '6초 안에 처치했거나 피해를 준 적이 쓰러지면, 그 기운을 흡수해 추가 체력 50(10초)과 3초 동안 이동 속도 10%를 얻는다.',
        effect: 'pickmeup', cost: 200, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 3, radius: 0,
        target: 'self', throwSpeed: 0, power: 50,
      }),
      ability2: A({
        id: 'wither', slot: 'ability2', name: 'WITHER', description: '파편을 던진다. 바닥에 닿으면 0.75초 뒤 터져 반경 4m 안의 모든 사람(나 포함)의 체력을 5초 동안 90 깎는다 (쇠약, 이것만으로는 죽지 않음).',
        effect: 'meddle', cost: 250, maxCharges: 1, freeCharges: 0, cooldown: 0.5, duration: 5, radius: 4,
        target: 'enemies', throwSpeed: 15, power: 90,
      }),
      signature: A({
        id: 'veilcall', slot: 'signature', name: 'VEIL CALL', description: '전술 지도를 열어 최대 2곳을 고르면 연막이 13.5초 동안 핀다. 쓰러진 뒤에도 쓸 수 있다 (내 몸 근처에 1개, 6초). 충전은 40초마다 다시 채워진다.',
        effect: 'ruse', cost: 150, maxCharges: 2, freeCharges: 2, cooldown: 0.6, duration: 13.5, radius: 4.2,
        target: 'area', throwSpeed: 0, power: 40, recharge: 40,
      }),
      ultimate: A({
        id: 'reprise', slot: 'ultimate', name: 'REPRISE', description: '쓰러진 뒤 사용하면 1.5초 뒤 그 자리에서 되살아난다 (처음 2초는 무적). 10초 안에 적을 처치하거나 처치에 관여하지 못하면 다시 쓰러진다.',
        effect: 'notdeadyet', cost: 0, maxCharges: 1, freeCharges: 0, cooldown: 0, duration: 10, radius: 0,
        target: 'self', ultPoints: 8, throwSpeed: 0, power: 100,
      }),
    },
  },
];

export const SLOTS: AbilitySlot[] = ['ability1', 'ability2', 'signature', 'ultimate'];

export function getAgent(id: string): AgentDef {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}
