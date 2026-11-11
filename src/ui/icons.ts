import type { AbilityEffect, RoleClass } from '../abilities/abilityData';

/**
 * UI 아이콘 (인라인 SVG, 24×24 좌표계, currentColor).
 * 이미지 에셋 없이 역할군·능력 종류를 한눈에 구분하기 위한 단순한 기호.
 */

const svg = (body: string, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ROLE: Record<RoleClass, string> = {
  // 돌격: 앞으로 찌르는 겹화살
  duelist: '<path d="M4 18 12 4l8 14"/><path d="M8 18l4-7 4 7"/>',
  // 척후: 눈 + 파동
  initiator: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  // 감시: 방패
  sentinel: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z"/><path d="M12 8v7"/>',
  // 통제: 구름/연막
  controller: '<path d="M7 17h10a4 4 0 0 0 0-8 5 5 0 0 0-9.6-1.4A3.5 3.5 0 0 0 7 17z"/>',
};

const EFFECT: Record<AbilityEffect, string> = {
  stim: '<path d="M12 3v6"/><circle cx="12" cy="13" r="3"/><path d="M5 20h14"/><path d="M7 9l-2-2M17 9l2-2M12 16v4"/>',
  incendiary: '<path d="M4 16l9-9"/><path d="M13 7l3-1 2 2-1 3"/><path d="M16 15c2 2 3 3 3 4.5a2.5 2.5 0 0 1-5 0c0-1.5 1-2.5 2-4.5z"/>',
  skysmoke: '<path d="M12 2v7M9 6l3 3 3-3"/><circle cx="9" cy="16" r="4"/><circle cx="15" cy="15" r="4"/>',
  orbital: '<path d="M12 2v10"/><path d="M9 2h6"/><ellipse cx="12" cy="18" rx="8" ry="3"/><path d="M8 12h8l-1 6H9z"/>',
  blaze: '<path d="M3 20c3-2 4-6 4-9 2 2 3 4 3 6 1-3 3-6 3-10 3 3 5 7 5 13"/><path d="M3 20h18"/>',
  hothands: '<circle cx="12" cy="10" r="4"/><path d="M12 2c2 2 3 3 3 5"/><ellipse cx="12" cy="20" rx="7" ry="1.6"/>',
  curveball: '<path d="M4 18c0-8 6-12 14-12"/><circle cx="18" cy="6" r="2.5"/><path d="M18 1v2M23 6h-2M21.5 2.5l-1.4 1.4"/>',
  runitback: '<path d="M4 12a8 8 0 1 0 3-6.3"/><path d="M4 3v4h4"/><path d="M12 8c1.5 2 2 3 2 4a2 2 0 0 1-4 0c0-1 .5-2 2-4z"/>',
  cloudburst: '<circle cx="15" cy="14" r="5"/><path d="M3 6c4 0 7 2 9 6"/><path d="M10 10l2 2 1-3"/>',
  updraft: '<path d="M12 21V5M6 11l6-6 6 6"/><path d="M6 20c2-1 4-1 6 0s4 1 6 0"/>',
  tailwind: '<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 15h15a3 3 0 1 1-3 3"/><path d="M3 12h8"/>',
  bladestorm: '<path d="M14 3l7 7-9 9-4-4 9-9"/><path d="M8 15l-5 5"/>',
  aftershock: '<rect x="3" y="4" width="5" height="16"/><path d="M12 8l3 4-3 4M17 6l4 6-4 6"/>',
  flashpoint: '<rect x="3" y="4" width="5" height="16"/><circle cx="16" cy="12" r="3"/><path d="M16 4v2M16 18v2M21 12h2"/>',
  faultline: '<path d="M2 18h20"/><path d="M4 18l3-5 3 5 3-6 3 6 3-4 3 4"/>',
  quake: '<path d="M12 20L4 6M12 20l8-14"/><path d="M7 12h10M9 16h6"/>',
  drone: '<rect x="8" y="9" width="8" height="6" rx="2"/><path d="M4 7h4M16 7h4M6 7v2M18 7v2"/><circle cx="12" cy="12" r="1"/>',
  sticky: '<circle cx="12" cy="13" r="6"/><path d="M12 7V3M10 3h4M9 13h6"/>',
  salvo: '<path d="M12 3v10M9 10l3 3 3-3"/><circle cx="12" cy="18" r="3"/>',
  armageddon: '<path d="M3 18h18"/><circle cx="6" cy="14" r="2"/><circle cx="12" cy="12" r="3"/><circle cx="18" cy="14" r="2"/>',
  razorvine: '<path d="M3 18c3-6 6-6 9 0s6 6 9 0"/><path d="M6 13l-1-3M12 18v-4M18 13l1-3"/>',
  shear: '<path d="M4 20h16"/><path d="M8 20V6h8v14"/><path d="M8 10h8"/>',
  arcrose: '<circle cx="12" cy="10" r="3"/><path d="M12 13v8M9 6a4 4 0 0 1 6 0M8 18l4-2 4 2"/>',
  steelgarden: '<path d="M12 21V8M8 21l2-9M16 21l-2-9M4 21l4-6M20 21l-4-6"/><path d="M12 3l1 3h-2l1-3z"/>',
  pickmeup: '<path d="M12 20s-7-4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 6-7 10-7 10z"/><path d="M12 9v6M9 12h6"/>',
  meddle: '<path d="M12 4l2 5 5 .5-4 3.5 1 5-4-3-4 3 1-5-4-3.5 5-.5z"/>',
  ruse: '<circle cx="12" cy="13" r="6"/><path d="M12 2v4M9 4l3 2 3-2"/>',
  notdeadyet: '<path d="M8 21v-6a4 4 0 0 1 8 0v6"/><path d="M12 3v6M9 6h6"/>',
};

export function roleIcon(role: RoleClass, size = 24): string {
  return svg(ROLE[role], size);
}

export function effectIcon(effect: AbilityEffect, size = 24): string {
  return svg(EFFECT[effect], size);
}
