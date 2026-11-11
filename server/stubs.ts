/**
 * 서버에는 화면·소리가 없다: Vfx·Sound 자리에 넣는 "무엇을 호출해도 아무 일도 하지 않는" 객체.
 * 능력 효과 코드는 클라이언트와 그대로 공유하고, 그리기·재생 호출만 사라진다.
 */
export function noop<T>(): T {
  const fn = function () {} as unknown as object;
  const proxy: object = new Proxy(fn, {
    get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : proxy),
    apply: () => proxy,
  });
  return proxy as T;
}
