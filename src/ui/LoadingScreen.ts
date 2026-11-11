import { onLoadProgress } from '../core/LoadProgress';

const TIPS = [
  '멈추거나 앉으면 탄이 정확해집니다. 달리면서 쏘지 마세요.',
  'SHIFT로 걸으면 발소리가 나지 않습니다.',
  '연사할수록 반동으로 탄이 위로 튑니다. 짧게 끊어 쏘세요.',
  '헤드샷은 대부분의 무기로 한두 발이면 충분합니다.',
  '방어구는 받는 피해의 66%를 대신 흡수합니다.',
  '설정에서 그래픽 프리셋(클래식 PS1 / 레트로 모던 / 선명)을 바꿀 수 있습니다.',
  'Core는 설치 구역 안에서 E를 누르고 있으면 설치됩니다.',
];

const SEGMENTS = 24;

/** 첫 실행 시 에셋을 불러오는 동안 보이는 로딩 화면 */
export class LoadingScreen {
  private root: HTMLDivElement;
  private segs: HTMLElement[] = [];
  private pct: HTMLElement;
  private file: HTMLElement;
  private tip: HTMLElement;
  private tipTimer: number;
  private unsubscribe: () => void;
  private shown = 0;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'loading-screen';
    this.root.innerHTML = `
      <div class="ls-center">
        <div class="ls-cube"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <h1 class="logo">BLOCK<span>FIRE</span><sup class="beta">BETA</sup></h1>
        <div class="ls-bar"></div>
        <div class="ls-row"><span class="ls-file">준비 중</span><span class="ls-pct">0%</span></div>
      </div>
      <p class="ls-tip"></p>
    `;
    container.appendChild(this.root);
    const bar = this.root.querySelector('.ls-bar')!;
    for (let i = 0; i < SEGMENTS; i++) bar.appendChild(document.createElement('i'));
    this.segs = [...bar.children] as HTMLElement[];
    this.pct = this.root.querySelector('.ls-pct')!;
    this.file = this.root.querySelector('.ls-file')!;
    this.tip = this.root.querySelector('.ls-tip')!;
    let t = Math.floor(Math.random() * TIPS.length);
    const showTip = () => (this.tip.textContent = `TIP · ${TIPS[t++ % TIPS.length]}`);
    showTip();
    this.tipTimer = window.setInterval(showTip, 3500);
    this.unsubscribe = onLoadProgress((done, total, label) => this.progress(done, total, label));
  }

  private progress(done: number, total: number, label: string): void {
    // 진행률은 뒤로 가지 않는다 (불러올 파일이 나중에 추가되어 total이 늘어날 수 있음)
    // 단계 사이에 잠깐 done === total이 될 수 있으므로 finish() 전에는 99%까지만
    const ratio = total > 0 ? Math.min(0.99, done / total) : 0;
    this.shown = Math.max(this.shown, ratio);
    const lit = Math.round(this.shown * SEGMENTS);
    this.segs.forEach((s, i) => s.classList.toggle('on', i < lit));
    this.pct.textContent = `${Math.round(this.shown * 100)}%`;
    if (label) this.file.textContent = `LOADING ${label}`;
  }

  /** 로딩 완료: 100%를 잠깐 보여준 뒤 사라진다 */
  finish(): Promise<void> {
    this.shown = 1;
    this.progress(1, 1, '');
    this.file.textContent = 'READY';
    this.unsubscribe();
    clearInterval(this.tipTimer);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.root.classList.add('done');
        setTimeout(() => {
          this.root.remove();
          resolve();
        }, 450);
      }, 250);
    });
  }

  fail(message: string): void {
    clearInterval(this.tipTimer);
    this.root.classList.add('error');
    this.file.textContent = message;
  }
}
