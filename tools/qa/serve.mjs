// Static HTTP server for the repo root, used by the QA harness.
//   import { startServer } from './serve.mjs'
//   const s = await startServer();      // random free port (safe with concurrent workers)
//   s.url -> 'http://localhost:PORT'    s.close()
// CLI:  node tools/qa/serve.mjs [port]   (default 8080) to poke at the game by hand.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

export function startServer({ root = REPO_ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found: ' + rel); }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': st.size,
          'cache-control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) {
      res.writeHead(400); res.end('bad request');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({
        server,
        port: p,
        url: `http://localhost:${p}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8080);
  const s = await startServer({ port });
  console.log(`serving ${REPO_ROOT} at ${s.url}/knights_out_final.html?debug=1  (CDN three.js is NOT routed here: it needs the internet)`);
}
