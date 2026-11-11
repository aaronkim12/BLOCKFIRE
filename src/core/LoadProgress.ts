/**
 * 로딩 진행률 추적.
 * 에셋을 불러오는 Promise를 track()으로 감싸면 전체/완료 개수가 집계되어
 * 로딩 화면이 실제 진행률을 표시할 수 있다.
 */
type Listener = (done: number, total: number, label: string) => void;

let total = 0;
let done = 0;
const listeners = new Set<Listener>();

export function track<T>(label: string, p: Promise<T>): Promise<T> {
  total++;
  emit(label);
  return p.then(
    (v) => {
      done++;
      emit(label);
      return v;
    },
    (e) => {
      done++;
      emit(label);
      throw e;
    },
  );
}

export function onLoadProgress(fn: Listener): () => void {
  listeners.add(fn);
  fn(done, total, '');
  return () => listeners.delete(fn);
}

function emit(label: string): void {
  for (const fn of listeners) fn(done, total, label);
}
