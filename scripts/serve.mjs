// scripts/serve.mjs — static file server for local tests and E2E.
//   node scripts/serve.mjs [--port 8010] [--root site] [--coi]
// MIME: .html .css .mjs/.js → text/javascript, .json, .wasm → application/wasm, .bin → application/octet-stream, .wav, .mp3, .png, .svg, .txt.
// No COOP/COEP headers unless --coi. 404 for anything else. Never serves outside the root (resolved path must stay under it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const port = Number(arg('--port', '8010'));
const root = path.resolve(arg('--root', 'site'));
const coi = argv.includes('--coi');
const host = arg('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function resolveFile(urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (pathname.includes('\\') || pathname.split('/').some((s) => s === '..')) return null;
  let file = path.resolve(root, '.' + (pathname.startsWith('/') ? pathname : '/' + pathname));
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    let st = fs.statSync(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); }
    if (!st.isFile()) return null;
    return { file, size: st.size };
  } catch { return null; }
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  const hit = resolveFile(req.url || '/');
  if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(method === 'HEAD' ? undefined : 'not found'); return; }
  const ext = path.extname(hit.file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': String(hit.size), 'Cache-Control': 'no-store' };
  if (coi) { headers['Cross-Origin-Opener-Policy'] = 'same-origin'; headers['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  res.writeHead(200, headers);
  if (method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(hit.file);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
});

server.listen(port, host, () => {
  console.log(`serving ${root} at http://${host}:${port}/${coi ? ' (COOP/COEP on)' : ''}`);
});
