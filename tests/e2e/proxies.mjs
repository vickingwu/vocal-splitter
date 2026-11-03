// tests/e2e/proxies.mjs — A7: measure the keyless CORS proxies from a same-origin page of the local site (so COEP applies
// exactly as on GitHub Pages) and write ../evidence/proxies.json. PROXIES in site/src/ui/url-input.mjs is pinned by hand
// to the entries with works === true (the unit tests inject their own proxy list, so the pin never changes their logic).
//   node tests/e2e/proxies.mjs [--base http://127.0.0.1:8010/] [--out ../evidence/proxies.json]
// Targets: a CORS-less file that also needs a Referer (ccMixter — the direct attempt fails as a real user's would) and a
// CORS-enabled control (raw.githubusercontent.com). `works` = the proxy delivered the control bytes (2xx, not an HTML error
// page, byte count equal to the direct control fetch); the ccMixter result is recorded separately as `targetOk`.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { awaitIsolation, startServerIfNeeded, launchChromium } from '../lib/e2e-helpers.mjs';
import { evidenceDir } from '../lib/fixtures.mjs';
import { HEADERS_MS, STALL_MS } from '../../site/src/ui/url-input.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const base = (() => { const b = arg('--base', 'http://127.0.0.1:8010/'); return b.endsWith('/') ? b : b + '/'; })();
const out = path.resolve(arg('--out', path.join(evidenceDir, 'proxies.json')));

const CANDIDATES = [
  { name: 'allorigins', host: 'api.allorigins.win', template: 'https://api.allorigins.win/raw?url=<encoded>', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs', host: 'api.codetabs.com', template: 'https://api.codetabs.com/v1/proxy?quest=<encoded>', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];
const TARGET = 'https://ccmixter.org/content/stevieb357/stevieb357_-_Slow_Motion_Dream_2.mp3';
const CONTROL = 'https://raw.githubusercontent.com/deezer/spleeter/master/audio_example.mp3';
const log = (...a) => console.log('[proxies]', ...a);

// One §10.3-style attempt inside the page: headers timeout, stall timer re-armed per read, body streamed and counted.
const ATTEMPT = async ({ url, headersMs, stallMs }) => {
  const t0 = performance.now();
  const r = { url, status: null, contentType: null, bytes: 0, elapsedMs: null, htmlErrorPage: false, error: null, firstBytesText: null };
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort('headers'), headersMs);
  try {
    const resp = await fetch(url, { mode: 'cors', signal: ctl.signal });
    clearTimeout(timer);
    r.status = resp.status;
    r.contentType = resp.headers.get('content-type');
    r.contentLength = resp.headers.get('content-length');
    r.htmlErrorPage = /^text\/html/i.test(r.contentType || '');
    const reader = resp.body.getReader();
    let first = null;
    for (;;) {
      timer = setTimeout(() => ctl.abort('stall'), stallMs);
      let chunk;
      try { chunk = await reader.read(); } finally { clearTimeout(timer); }
      if (chunk.done) break;
      if (first === null) first = chunk.value.slice(0, 64);
      r.bytes += chunk.value.length;
      if (r.bytes > 50 * 1024 * 1024) { await reader.cancel(); r.error = 'over 50 MB — stopped'; break; }
    }
    if (first) r.firstBytesText = Array.from(first).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  } catch (e) {
    clearTimeout(timer);
    r.error = ctl.signal.aborted ? `abort:${ctl.signal.reason}` : `${e && e.name}: ${e && e.message}`;
  }
  r.elapsedMs = Math.round(performance.now() - t0);
  return r;
};

let server = null, browser = null, exitCode = 1;
const doc = { date: new Date().toISOString(), base, target: TARGET, control: CONTROL, timeouts: { headersMs: HEADERS_MS, stallMs: STALL_MS }, crossOriginIsolated: null, direct: {}, proxies: [], pinned: [] };
try {
  server = await startServerIfNeeded(base);
  browser = (await launchChromium(chromium, { headless: true })).browser;
  doc.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(base);
  doc.crossOriginIsolated = await awaitIsolation(page, {});
  log('page ready, isolated =', doc.crossOriginIsolated);
  const attempt = (url, kind) => page.evaluate(ATTEMPT, { url, headersMs: HEADERS_MS[kind], stallMs: STALL_MS });

  doc.direct.control = await attempt(CONTROL, 'direct');
  log('direct control', JSON.stringify({ status: doc.direct.control.status, bytes: doc.direct.control.bytes, error: doc.direct.control.error }));
  doc.direct.target = await attempt(TARGET, 'direct');
  log('direct target', JSON.stringify({ status: doc.direct.target.status, bytes: doc.direct.target.bytes, error: doc.direct.target.error }));
  const controlBytes = doc.direct.control.bytes;

  for (const p of CANDIDATES) {
    const control = await attempt(p.build(CONTROL), 'proxy');
    log(p.name, 'control', JSON.stringify({ status: control.status, ct: control.contentType, bytes: control.bytes, ms: control.elapsedMs, error: control.error }));
    const target = await attempt(p.build(TARGET), 'proxy');
    log(p.name, 'target', JSON.stringify({ status: target.status, ct: target.contentType, bytes: target.bytes, ms: target.elapsedMs, error: target.error }));
    const controlOk = control.error === null && control.status >= 200 && control.status < 300 && !control.htmlErrorPage && control.bytes > 0 && (controlBytes === 0 || control.bytes === controlBytes);
    const targetOk = target.error === null && target.status >= 200 && target.status < 300 && !target.htmlErrorPage && target.bytes > 0;
    doc.proxies.push({ proxy: p.name, host: p.host, template: p.template, control, target, controlOk, targetOk, works: controlOk, status: control.status, contentType: control.contentType, bytes: control.bytes, elapsedMs: control.elapsedMs, htmlErrorPage: control.htmlErrorPage });
  }
  doc.pinned = doc.proxies.filter((p) => p.works).map((p) => p.proxy);
  await context.close();
  exitCode = 0;
} catch (e) {
  doc.failure = { message: String(e && e.message).slice(0, 1000) };
  console.error('[proxies] FAIL', e && e.stack);
} finally {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  log('wrote', out, 'pinned =', JSON.stringify(doc.pinned));
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
