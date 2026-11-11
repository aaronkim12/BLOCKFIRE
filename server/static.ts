import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * 배포용: 빌드한 게임 파일(dist/)을 같은 포트로 내보내는 HTTP 서버.
 * WebSocket은 이 서버에 붙으므로, 게임과 온라인 서버가 주소 하나(포트 하나)로 동작한다.
 * dist/가 없으면(개발 중) 상태 확인용 응답만 한다.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function createStaticServer(root = resolve(process.env.STATIC_DIR ?? 'dist')): Server {
  const hasBuild = existsSync(join(root, 'index.html'));
  return createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (!hasBuild) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('BLOCKFIRE server (dist/ 없음: npm run build 후 게임 파일도 함께 제공)');
      return;
    }
    // 경로 탈출 방지
    let file = normalize(join(root, url));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) file = join(root, 'index.html');
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      // 해시가 붙은 빌드 파일은 오래 캐시, index.html은 매번 확인
      'cache-control': url.startsWith('/assets/') && ext === '.js' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  });
}
