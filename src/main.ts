import './ui/style.css';
import { Game } from './core/Game';
import { FOUNDRY } from './maps/foundry';

const container = document.getElementById('app')!;

try {
  const game = new Game(container, FOUNDRY);
  // 자동 테스트/디버깅용 핸들 (?autotest 이면 포인터 락 없이 입력을 받는다)
  (window as unknown as { __blockfire: Game }).__blockfire = game;
  if (new URLSearchParams(location.search).has('autotest')) game.input.forceActive = true;
} catch (err) {
  console.error(err);
  container.innerHTML = `<pre class="fatal">게임을 시작할 수 없습니다.\n\n${String(err)}</pre>`;
}
