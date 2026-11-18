/**
 * 모든 맵의 겹침·이동 가능성·공정성 검사:  npm run check:maps
 */
import { MAPS } from '../src/maps';
import { analyzeMap } from '../src/maps/fairness';

let failed = 0;
for (const def of MAPS) {
  const r = analyzeMap(def);
  const s = r.stats;
  const info = s ? ` (공격→A ${s.atkToA} · 공격→B ${s.atkToB} · 수비→A ${s.defToA} · 수비→B ${s.defToB} · 스폰 간 ${s.spawnGap} · 입구 A ${s.entrancesA}/B ${s.entrancesB})` : '';
  if (r.errors.length === 0) {
    console.log(`✔ ${def.name}: 겹침 없음 · 모든 구역에 갈 수 있음 · 공정성 통과${info}`);
  } else {
    failed++;
    console.log(`✘ ${def.name}: 문제 ${r.errors.length}개${info}`);
    for (const e of r.errors.slice(0, 40)) console.log('   - ' + e);
  }
  for (const w of r.warnings) console.log('   ! ' + w);
}
process.exit(failed ? 1 : 0);
