/**
 * 모든 맵의 겹침·이동 가능성 검사:  npm run check:maps
 */
import { MAPS } from '../src/maps';
import { validateMap } from '../src/maps/validateMap';

let failed = 0;
for (const def of MAPS) {
  const errors = validateMap(def);
  if (errors.length === 0) {
    console.log(`✔ ${def.name}: 겹치는 벽·바닥 없음, 모든 구역에 갈 수 있음`);
  } else {
    failed++;
    console.log(`✘ ${def.name}: 문제 ${errors.length}개`);
    for (const e of errors.slice(0, 40)) console.log('   - ' + e);
  }
}
process.exit(failed ? 1 : 0);
