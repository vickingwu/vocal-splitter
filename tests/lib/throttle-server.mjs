// tests/lib/throttle-server.mjs — static server for site/ with network-fault injection, used by tests/e2e/download_failure.mjs
// (FIX-2 R0/R2). Same MIME table as scripts/serve.mjs, plus: Range requests (206, or 200 when `ranges: false` to imitate
// a host that ignores Range), per-path byte-rate limiting (streams `rate/10` bytes every 100 ms), and a one-shot
// connection reset after a fraction of the response has been sent. Every request is logged with the bytes actually sent.
//   const srv = await startThrottleServer({ root, port });
//   srv.setRules([{ match: /models\/.*\.bin$/, rateBytesPerSec: 30000, resetAtFraction: 0.4, resetOnce: true }]);
//   srv.log → [{ t, method, path, range, status, length, sent, reset, rule }]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

function resolveFile(root, urlPath) {
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
    return { file, size: st.size, pathname };
  } catch { return null; }
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' ? size - 1 : (m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

export async function startThrottleServer({ root, port, host = '127.0.0.1', ranges = true, cors = false } = {}) {
  const rootResolved = path.resolve(root);
  let rules = [];
  const log = [];
  const state = { ranges, resetsDone: new Map() };   // rule index → resets performed
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const t = Date.now();
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      if (method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD' }); res.end(); return; }
    }
    if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const hit = resolveFile(rootResolved, req.url || '/');
    if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(method === 'HEAD' ? undefined : 'not found'); log.push({ t, method, path: req.url, status: 404, sent: 0 }); return; }
    const ext = path.extname(hit.file).toLowerCase();
    const ruleIndex = rules.findIndex((r) => r.match.test(hit.pathname));
    const rule = ruleIndex >= 0 ? rules[ruleIndex] : null;
    const rangeHeader = req.headers.range;
    let start = 0, end = hit.size - 1, status = 200;
    const useRanges = rule && rule.ranges !== undefined ? rule.ranges : state.ranges;
    if (rangeHeader && useRanges) {
      const r = parseRange(rangeHeader, hit.size);
      if (r && r.invalid) { res.writeHead(416, { 'Content-Range': `bytes */${hit.size}` }); res.end(); log.push({ t, method, path: hit.pathname, range: rangeHeader, status: 416, sent: 0 }); return; }
      if (r) { start = r.start; end = r.end; status = 206; }
    }
    const length = end - start + 1;
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': String(length), 'Cache-Control': 'no-store', 'Accept-Ranges': useRanges ? 'bytes' : 'none' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${hit.size}`;
    const entry = { t, method, path: hit.pathname, range: rangeHeader ?? null, status, start, end, length, sent: 0, reset: false, rule: ruleIndex >= 0 ? ruleIndex : null, ms: null };
    log.push(entry);
    res.writeHead(status, headers);
    if (method === 'HEAD') { res.end(); entry.ms = Date.now() - t; return; }

    const fd = fs.openSync(hit.file, 'r');
    let pos = start;
    let closed = false;
    const finish = () => { if (closed) return; closed = true; try { fs.closeSync(fd); } catch { /* ignore */ } entry.ms = Date.now() - t; };
    res.on('close', finish);
    // the rule object is read on every tick, so the harness can lift a rate limit (rule.rateBytesPerSec = null) mid-response
    const rate = () => (rule && rule.rateBytesPerSec ? rule.rateBytesPerSec : null);
    const resetEligible = rule && typeof rule.resetAtFraction === 'number' && length >= (rule.minLength ?? 0)
      && (!rule.resetOnce || (state.resetsDone.get(ruleIndex) ?? 0) < (rule.resetTimes ?? 1));
    const resetAt = resetEligible ? start + Math.floor(rule.resetAtFraction * length) : null;
    if (resetAt !== null) state.resetsDone.set(ruleIndex, (state.resetsDone.get(ruleIndex) ?? 0) + 1);
    const slice = () => { const r = rate(); return r ? Math.max(1024, Math.floor(r / 10)) : 256 * 1024; };

    const pump = () => {
      if (closed) return;
      if (pos > end) { res.end(); finish(); return; }
      let n = Math.min(slice(), end - pos + 1);
      if (resetAt !== null && pos + n > resetAt && pos <= resetAt) n = Math.max(0, resetAt - pos);
      if (n > 0) {
        const buf = Buffer.allocUnsafe(n);
        const got = fs.readSync(fd, buf, 0, n, pos);
        pos += got;
        entry.sent += got;
        const ok = res.write(got === n ? buf : buf.subarray(0, got));
        if (!ok) { res.once('drain', () => schedule()); return; }
      }
      if (resetAt !== null && pos >= resetAt && pos <= end) {
        entry.reset = true;
        // a TCP reset mid-body: the browser sees a network error on the stream (fetch TypeError / reader rejection)
        setTimeout(() => { try { req.socket.destroy(); } catch { /* ignore */ } finish(); }, 20);
        return;
      }
      schedule();
    };
    const schedule = () => { if (rate()) setTimeout(pump, 100); else setImmediate(pump); };
    pump();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    url: `http://${host}:${port}/`,
    log,
    setRules(next) { rules = next; state.resetsDone.clear(); },   // keeps the caller's objects: mutate rule.rateBytesPerSec to change a live response
    get rules() { return rules; },
    setRanges(v) { state.ranges = v; },
    async stop() { for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } } await new Promise((r) => server.close(() => r())); },
  };
}
