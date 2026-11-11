import { NET_PORT, type ClientMsg, type RoomInfo, type ServerMsg } from './protocol';

/**
 * 서버 연결 (WebSocket). 방 정보와 서버 시계를 들고 있고, 받은 메시지를 구독자에게 넘긴다.
 * 서버 주소: ?server=ws://host:port, 없으면 같은 호스트의 5174 포트.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  id = '';
  room: RoomInfo | null = null;
  /** 서버 시각 - 내 시각 (초), 왕복 시간 (초) */
  private clockOffset = 0;
  rtt = 0.05;
  private handlers = new Set<(m: ServerMsg) => void>();
  private pingTimer = 0;
  lastError = '';

  /**
   * 서버 주소: ?server=… > 빌드 설정 VITE_SERVER_URL > 개발 중이면 같은 호스트의 5174 > 배포 판은 페이지와 같은 주소
   */
  static defaultUrl(): string {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
    const env = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (env) return env;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (import.meta.env.DEV) return `${proto}://${location.hostname || '127.0.0.1'}:${NET_PORT}`;
    return `${proto}://${location.host}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 접속. 무료 서버는 한동안 아무도 없으면 잠들어서 깨어나는 데 1분쯤 걸린다:
   * 처음 시도가 실패하면 /health로 깨우고 최대 90초 동안 다시 시도한다.
   */
  async connect(name: string, url = NetClient.defaultUrl(), onStatus?: (text: string) => void): Promise<void> {
    const started = performance.now();
    let woke = false;
    for (;;) {
      try {
        await this.connectOnce(name, url, 6000);
        return;
      } catch (e) {
        if (performance.now() - started > 90000) throw e;
        if (!woke) {
          woke = true;
          // 잠든 서버 깨우기 (응답 내용은 필요 없음)
          void fetch(url.replace(/^ws/, 'http').replace(/\/$/, '') + '/health', { mode: 'no-cors' }).catch(() => {});
        }
        onStatus?.(`서버를 깨우는 중… (무료 서버는 처음 접속에 최대 1분) ${Math.round((performance.now() - started) / 1000)}초`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private connectOnce(name: string, url: string, timeoutMs: number): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
        reject(new Error('서버에 연결할 수 없습니다'));
      }, timeoutMs);
      ws.onopen = () => {
        this.send({ t: 'hello', name });
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`서버에 연결할 수 없습니다 (${url})`));
      };
      let welcomed = false;
      ws.onclose = () => {
        // 접속에 성공했던 연결이 끊겼을 때만 알린다 (깨우는 중 실패한 시도는 조용히)
        if (!welcomed) return;
        this.room = null;
        this.emit({ t: 'room', room: null });
      };
      ws.onmessage = (ev) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.t === 'welcome') {
          welcomed = true;
          this.id = m.id;
          clearTimeout(timer);
          resolve();
          this.ping();
          clearInterval(this.pingTimer);
          this.pingTimer = window.setInterval(() => this.ping(), 2000);
        }
        if (m.t === 'room') this.room = m.room;
        if (m.t === 'error') this.lastError = m.msg;
        if (m.t === 'pong') {
          const now = performance.now() / 1000;
          const rtt = now - m.c;
          this.rtt = this.rtt * 0.7 + rtt * 0.3;
          // 서버 시각은 왕복의 절반 전에 찍힌 것
          if (m.s > 0) this.clockOffset = m.s + rtt / 2 - now;
        }
        if (m.t === 'snap') {
          // 스냅샷 시각으로도 시계를 맞춘다 (느슨하게)
          const est = m.time + this.rtt / 2 - performance.now() / 1000;
          this.clockOffset += (est - this.clockOffset) * 0.05;
        }
        this.emit(m);
      };
    });
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() / 1000 });
  }

  /** 지금 서버 시각 추정 (초) */
  serverTime(): number {
    return performance.now() / 1000 + this.clockOffset;
  }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  on(fn: (m: ServerMsg) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  private emit(m: ServerMsg): void {
    for (const h of [...this.handlers]) h(m);
  }

  close(): void {
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.room = null;
  }
}
