// tests/e2e/runtime_download.mjs — FIX-3 R5 (a)–(d): the ONNX Runtime files through the loader, in the real UI (headless
// Chromium, the whole site served by tests/lib/throttle-server.mjs on --port so the worker's fetches hit the fault injection;
// the coi service worker's forwarded requests are routed via PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1).
//   node tests/e2e/runtime_download.mjs [--scenario blocked|throttle_reset|dead_reload|import_webgpu|all] [--port 8012]
//        [--rate 30000] [--throttle-seconds 20] [--out ../evidence/runtime_download_e2e.json]
// (a) blocked      — every origin request for vendor/ort/*.wasm is aborted; the manifest's first runtime chunk mirror
//                    (raw-github) is answered by a Playwright route from site/vendor/ort/ (206 + CORS, as the CDN does):
//                    the loader must take every byte from the mirror, the job completes, ORT itself fetches nothing.
// (b) throttle_reset — the origin streams vendor/ort/*.wasm at --rate B/s for --throttle-seconds, and the first big response
//                    is cut by a TCP reset after 40 % of its bytes: the loader resumes at the received byte and completes.
// (c) dead_reload  — the origin dies once the runtime line shows >= 8 MB (every later vendor/ort/*.wasm request aborted):
//                    RUNTIME_DOWNLOAD copy with the saved-bytes figure; a reload + 开始 resumes from the store and completes.
// (d) import_webgpu — the WebGPU runtime files (ort-wasm-simd-threaded.asyncify.wasm + .mjs) go in through 「导入模型文件」;
//                    a WebGPU job (hardware adapter, headless Chromium --enable-unsafe-webgpu) runs with no vendor/ort/*.wasm
//                    request at all. Skipped (recorded) when the adapter is software.
// Every scenario asserts ORT_OWN_FETCH: no request for vendor/ort/ort-wasm-simd-threaded*.{wasm,mjs} without the loader's
// ?v= query (a bare URL would be ORT's own fetch / glue import). Credentials come ONLY from VS_TEST_USER / VS_TEST_PASS.
import fs from 'node:fs';
import path from 'node:path';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
import { startThrottleServer } from '../lib/throttle-server.mjs';
import { makeNavCounter, awaitIsolation, launchChromium, sleep } from '../lib/e2e-helpers.mjs';
import { fixturePath, repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const scenarioArg = arg('--scenario', 'all');
const port = Number(arg('--port', '8012'));
const rate = Number(arg('--rate', '30000'));
const throttleSeconds = Number(arg('--throttle-seconds', '20'));
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'runtime_download_e2e.json')));
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS'); process.exit(2); }
const scenarios = scenarioArg === 'all' ? ['blocked', 'throttle_reset', 'dead_reload', 'import_webgpu'] : scenarioArg.split(',');
const { chromium } = await import('playwright');
const MiB = 1048576;
const log = (...a) => console.log('[rtd]', ...a);

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'site', 'models', 'manifest.json'), 'utf8'));
if (!manifest.runtime) { console.error('BAD_MANIFEST: no runtime section'); process.exit(2); }
const rtBytes = (b) => manifest.runtime[b].wasm.bytes + manifest.runtime[b].glue.bytes;
const WASM_RE = /\/vendor\/ort\/[^/?]+\.wasm(\?.*)?$/;
const ORT_FILE_RE = /\/vendor\/ort\/ort-wasm-simd-threaded[^/?]*\.(wasm|mjs)(\?.*)?$/;
// same-origin requests for the runtime files without the loader's ?v= (mirror URLs are cross-origin and carry none)
// the browser's own favicon request 404s on the throttle server; nothing of the app
const unexpectedConsole = (errors) => errors.filter((c) => !/favicon\.ico/.test(c));
const ortOwnFetches = (urls) => urls.filter((u) => u.startsWith(srv.url) && ORT_FILE_RE.test(u) && !/\?v=/.test(u));

// Answers a chunk mirror's URLs from site/ like the CDN would: 206 + Content-Range for a Range request, CORS headers, no caching.
async function routeMirror(context, base, mirrorLog) {
  const basePath = new URL(base).pathname;
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' };
  await context.route((u) => u.href.startsWith(base), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const rel = decodeURIComponent(u.pathname.slice(basePath.length));
    const entry = { path: rel, method: req.method(), range: req.headers()['range'] ?? null, origin: req.headers()['origin'] ?? null, status: null, length: 0 };
    mirrorLog.push(entry);
    const file = path.join(repoRoot, 'site', ...rel.split('/'));
    // the runtime files and the model chunks (the same mirror id serves the model's sources too, so its probe must not 404)
    if (!/^(vendor\/ort\/[A-Za-z0-9_.-]+\.(wasm|mjs)|models\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.bin)$/.test(rel) || !fs.existsSync(file)) { entry.status = 404; await route.fulfill({ status: 404, headers: cors, body: '' }); return; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(entry.range || '');
    if (m) { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); status = start <= end && start < size ? 206 : 416; }
    if (status === 416) { entry.status = 416; await route.fulfill({ status: 416, headers: { ...cors, 'content-range': `bytes */${size}` }, body: '' }); return; }
    const buf = Buffer.alloc(end - start + 1);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    entry.status = status; entry.length = buf.length;
    const headers = { ...cors, 'content-type': rel.endsWith('.wasm') ? 'application/wasm' : rel.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'content-length': String(buf.length), 'accept-ranges': 'bytes' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    await route.fulfill({ status, headers, body: buf });
  });
}

const MB_RE = /(\d+(?:\.\d+)?) MB \/ (\d+(?:\.\d+)?) MB/;
const parseDoneMB = (text) => { const m = MB_RE.exec(text || ''); return m ? Number(m[1]) : null; };

async function storageKeys(page) {
  return page.evaluate(async () => {
    const out = [];
    try { for (const name of await caches.keys()) { const c = await caches.open(name); for (const k of await c.keys()) { const r = await c.match(k); out.push({ key: decodeURIComponent(k.url.split('.vs-store/')[1] ?? k.url), bytes: r ? Number(r.headers.get('content-length')) || null : null }); } } } catch (e) { out.push({ error: String(e && e.message) }); }
    return out;
  });
}

async function clearStorage(page) {
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
    try { const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []; for (const d of dbs) if (d.name) await new Promise((r) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => r(); }); } catch { /* ignore */ }
  });
}

async function login(page, counter) {
  const since = counter.count();
  await awaitIsolation(page, { counter, sinceNavigation: since, maxExtraNavigations: 2 });
  const st = await page.evaluate(() => window.__vs.state);
  if (st === 'locked') {
    await page.fill('#login-user', USER);
    await page.fill('#login-pass', PASS);
    await page.press('#login-pass', 'Enter');
  }
  await page.waitForFunction(() => window.__vs.state === 'idle', null, { timeout: 30000 });
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
}

async function loadFixture(page) {
  await page.setInputFiles('#file-input', fixturePath('clip25.wav'));
  await page.waitForFunction(() => window.__vs.state === 'ready' || window.__vs.state === 'error', null, { timeout: 60000 });
  const st = await page.evaluate(() => window.__vs.state);
  if (st !== 'ready') throw new Error('fixture not accepted: ' + JSON.stringify(await page.evaluate(() => window.__vs.error)));
}

// Runs one job; polls every 250 ms; `onTick({ state, text, doneMB, elapsedMs })` may return 'stop' to end polling early.
async function runJob(page, { timeoutMs = 15 * 60 * 1000, onTick } = {}) {
  const t0 = Date.now();
  const lines = [];
  await page.click('#start');
  for (;;) {
    const s = await page.evaluate(() => ({ state: window.__vs.state, text: document.getElementById('progress').textContent, error: document.getElementById('error').textContent }));
    const doneMB = parseDoneMB(s.text);
    if (lines.length === 0 || lines[lines.length - 1].text !== s.text) lines.push({ atMs: Date.now() - t0, state: s.state, text: s.text });
    if (onTick) { const r = await onTick({ ...s, doneMB, elapsedMs: Date.now() - t0 }); if (r === 'stop') return { state: s.state, lines, errorText: s.error, stopped: true, elapsedMs: Date.now() - t0 }; }
    if (s.state === 'done' || s.state === 'error') return { state: s.state, lines, errorText: s.error, vsError: await page.evaluate(() => window.__vs.error), elapsedMs: Date.now() - t0, timings: await page.evaluate(() => window.__vs.timings()) };
    if (Date.now() - t0 > timeoutMs) return { state: s.state, lines, errorText: s.error, timeout: true, elapsedMs: Date.now() - t0 };
    await sleep(250);
  }
}

const serverSummary = (srv, sinceIndex = 0) => {
  const reqs = srv.log.slice(sinceIndex).filter((e) => /^\/vendor\/ort\//.test(e.path));
  return {
    runtimeRequests: reqs.map((e) => ({ path: e.path.replace(/^\/vendor\/ort\//, ''), range: e.range, status: e.status, length: e.length, sent: e.sent, reset: e.reset, ms: e.ms })),
    runtimeBytesSent: reqs.reduce((a, e) => a + e.sent, 0),
    resets: reqs.filter((e) => e.reset).length,
    rangeRequests: reqs.filter((e) => e.range).length,
  };
};
const rtLinesOf = (run) => run.lines.filter((x) => x.text.includes('运行环境')).map((x) => `${x.atMs}ms ${x.text}`);

const result = { date: new Date().toISOString(), manifestVersion: manifest.version, rate, throttleSeconds, runtimeBytes: { webgpu: rtBytes('webgpu'), wasm: rtBytes('wasm') }, scenarios: {}, ok: null, failures: [] };
const check = (name, cond, info) => { if (!cond) { result.failures.push({ scenario: name.split('.')[0], check: name, info }); log('CHECK FAILED', name, JSON.stringify(info).slice(0, 600)); } return cond; };

const srv = await startThrottleServer({ root: path.join(repoRoot, 'site'), port });
const l = await launchChromium(chromium, { headless: true });
let browser = l.browser;
log('server', srv.url, 'browser', l.channel, browser.version());
try {
  for (const scenario of scenarios) {
    log('--- scenario', scenario);
    let gpuBrowser = null;
    if (scenario === 'import_webgpu') {
      // navigator.gpu needs the WebGPU launch flags and a secure context; the adapter probe runs on a routed blank page under the base
      const g = await launchChromium(chromium, { headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
      gpuBrowser = g.browser;
      const probeCtx = await gpuBrowser.newContext();
      const probePage = await probeCtx.newPage();
      const probeUrl = srv.url + '__gpu_probe__';
      await probeCtx.route(probeUrl, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>gpu probe</title>' }));
      await probePage.goto(probeUrl);
      const info = await probePage.evaluate(async () => { if (!navigator.gpu) return { absent: true }; const a = await navigator.gpu.requestAdapter(); if (!a) return null; const i = a.info ?? {}; return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', description: i.description ?? '' }; });
      await probeCtx.close();
      const software = !info || info.absent || /google|swiftshader/i.test(info.vendor) || /swiftshader/i.test(info.architecture);
      if (software) {
        result.scenarios[scenario] = { skipped: 'no hardware WebGPU adapter', adapterInfo: info };
        log('import_webgpu skipped: software adapter', JSON.stringify(info));
        await gpuBrowser.close();
        continue;
      }
      result.scenarios[scenario] = { adapterInfo: info };
      log('adapter', JSON.stringify(info));
    }
    const b = gpuBrowser ?? browser;
    const context = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const counter = makeNavCounter(context);
    const page = await context.newPage();
    const consoleErrors = [];
    const urls = [];
    const failedResponses = [];                       // every non-2xx/206 response the page saw (what a 404 console line refers to)
    page.on('request', (r) => urls.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) failedResponses.push({ url: r.url(), status: r.status() }); });
    page.on('console', (m) => { if (m.type() === 'error') { const loc = m.location(); consoleErrors.push(m.text().slice(0, 300) + (loc && loc.url ? ` @ ${loc.url}` : '')); } });
    const backend = scenario === 'import_webgpu' ? 'webgpu' : 'wasm';
    const rt = manifest.runtime[backend];
    const mirror = rt.sources.find((s) => s.kind === 'chunks' && s.id !== 'origin');
    const sourcesParam = scenario === 'blocked' ? `${mirror.id},origin` : 'origin';
    const url = `${srv.url}?backend=${backend}&sources=${encodeURIComponent(sourcesParam)}`;
    srv.setRules([]);
    const mirrorLog = [];
    let dead = false;
    let originWasmAborted = 0;
    if (scenario === 'blocked') {
      await routeMirror(context, mirror.base, mirrorLog);
      await context.route((u) => u.origin === new URL(srv.url).origin && WASM_RE.test(u.pathname + u.search), (route) => { originWasmAborted++; route.abort('connectionrefused'); });
    }

    await page.goto(url);
    await login(page, counter);
    await clearStorage(page);
    await loadFixture(page);
    const sc = { ...(result.scenarios[scenario] ?? {}), url, backend, consoleErrors, failedResponses };
    const logStart = srv.log.length;
    const urlsStart = urls.length;

    if (scenario === 'blocked') {
      const run = await runJob(page);
      sc.run = run;
      sc.server = serverSummary(srv, logStart);
      sc.mirror = { id: mirror.id, base: mirror.base, requests: mirrorLog.map((e) => ({ ...e })), bytes: mirrorLog.reduce((a, e) => a + e.length, 0), rangeRequests: mirrorLog.filter((e) => e.range && e.status === 206).length, corsOrigin: mirrorLog.find((e) => e.origin)?.origin ?? null };
      sc.originWasmAborted = originWasmAborted;
      sc.runtime = run.timings?.runtime ?? null;
      sc.runtimeLines = rtLinesOf(run);
      sc.ortOwnFetches = ortOwnFetches(urls.slice(urlsStart));
      sc.storage = await storageKeys(page);
      const d = sc.runtime?.report ?? {};
      check('blocked.done', run.state === 'done', { state: run.state, error: run.vsError, copy: run.errorText });
      check('blocked.backend', run.timings?.backend === 'wasm', { backend: run.timings?.backend });
      check('blocked.mirrorCarriedEveryByte', (d.used?.[mirror.id] ?? 0) === rtBytes('wasm') && !(d.used?.origin > 0), { used: d.used, rtBytes: rtBytes('wasm') });
      check('blocked.mirrorRanges', sc.mirror.rangeRequests >= Math.ceil(rt.wasm.bytes / (4 * MiB)) + 1, { rangeRequests: sc.mirror.rangeRequests, requests: sc.mirror.requests.slice(0, 12) });
      check('blocked.crossOriginRequest', sc.mirror.corsOrigin === new URL(srv.url).origin, { corsOrigin: sc.mirror.corsOrigin });
      check('blocked.originWasmBlocked', originWasmAborted >= 1 && sc.server.runtimeRequests.filter((r) => r.path.endsWith('.wasm')).length === 0, { originWasmAborted, originRuntimeRequests: sc.server.runtimeRequests });
      check('blocked.ortOwnFetch', sc.ortOwnFetches.length === 0, { ortOwnFetches: sc.ortOwnFetches });
      check('blocked.runtimeLine', sc.runtimeLines.some((x) => /正在下载运行环境 · \d+(\.\d)? MB \/ \d+(\.\d)? MB/.test(x)), { lines: sc.runtimeLines.slice(0, 10) });
      check('blocked.storedRuntime', sc.storage.some((k) => k.key === `runtime:${rt.wasm.name}:${rt.wasm.sha256}`) && sc.storage.some((k) => k.key === `runtime:${rt.glue.name}:${rt.glue.sha256}`), { storage: sc.storage.slice(0, 10) });
      check('blocked.noConsoleError', unexpectedConsole(consoleErrors).length === 0, { consoleErrors });
    }

    if (scenario === 'throttle_reset') {
      const rule = { match: /\/vendor\/ort\/.*\.wasm$/, rateBytesPerSec: rate, resetAtFraction: 0.4, resetOnce: true, minLength: MiB };
      srv.setRules([rule]);
      let lifted = null;
      const run = await runJob(page, { onTick: ({ elapsedMs }) => { if (lifted === null && elapsedMs >= throttleSeconds * 1000) { rule.rateBytesPerSec = null; lifted = elapsedMs; log('rate limit lifted at', elapsedMs, 'ms'); } } });
      sc.run = run; sc.liftedAtMs = lifted;
      sc.server = serverSummary(srv, logStart);
      sc.runtime = run.timings?.runtime ?? null;
      sc.runtimeLines = rtLinesOf(run);
      sc.ortOwnFetches = ortOwnFetches(urls.slice(urlsStart));
      const d = sc.runtime?.report ?? {};
      const rangeStart = (r) => Number(/^bytes=(\d+)-/.exec(r.range ?? 'bytes=0-')?.[1] ?? 0);
      const resetReq = sc.server.runtimeRequests.find((r) => r.reset);
      const resumeReq = resetReq && sc.server.runtimeRequests.find((r) => r.path === resetReq.path && r.range && !r.reset && rangeStart(r) > rangeStart(resetReq) && rangeStart(r) <= rangeStart(resetReq) + resetReq.sent);
      sc.resume = resetReq && resumeReq ? { resetAt: rangeStart(resetReq) + resetReq.sent, resumedAt: rangeStart(resumeReq), keptBytes: rangeStart(resumeReq) - rangeStart(resetReq), lostOnReset: rangeStart(resetReq) + resetReq.sent - rangeStart(resumeReq) } : null;
      check('throttle_reset.done', run.state === 'done', { state: run.state, error: run.vsError, copy: run.errorText });
      check('throttle_reset.resetHappened', sc.server.resets === 1, { resets: sc.server.resets });
      check('throttle_reset.resumedAtReceived', !!resumeReq, { resetReq, requests: sc.server.runtimeRequests.slice(0, 12) });
      check('throttle_reset.reportResumedBytes', !!sc.resume && (d.resumedBytes ?? -1) === sc.resume.keptBytes && d.failures >= 1, { resumedBytes: d.resumedBytes, failures: d.failures, resume: sc.resume });
      check('throttle_reset.speedShown', sc.runtimeLines.some((x) => /正在下载运行环境 .* (KB|MB)\/s/.test(x)), { lines: sc.runtimeLines.slice(0, 12) });
      check('throttle_reset.ortOwnFetch', sc.ortOwnFetches.length === 0, { ortOwnFetches: sc.ortOwnFetches });
      check('throttle_reset.usedOrigin', (d.used?.origin ?? 0) === rtBytes('wasm'), { used: d.used });
      check('throttle_reset.noConsoleError', unexpectedConsole(consoleErrors).length === 0, { consoleErrors });
    }

    if (scenario === 'dead_reload') {
      // 2 MiB/s per response, 4 segments in flight: the origin dies (every in-flight and later vendor/ort/*.wasm response cut
      // by a reset — the server's kill switch) once the runtime line shows >= 8 MB; the cut requests persist their prefixes,
      // the ladder (1+2+4+8+16 s on the only source) ends in RUNTIME_DOWNLOAD with 已保存 >= 4 MB
      const rule = { match: /\/vendor\/ort\/.*\.wasm$/, rateBytesPerSec: 2 * MiB };
      srv.setRules([rule]);
      let killedAt = null;
      const run1 = await runJob(page, { onTick: ({ text, doneMB }) => { if (!dead && text.includes('正在下载运行环境') && doneMB !== null && doneMB >= 8) { dead = true; rule.kill = true; killedAt = doneMB; log('origin killed at', doneMB, 'MB'); } } });
      sc.firstRun = { lines: run1.lines, killedAtMB: killedAt, state: run1.state, errorText: run1.errorText, vsError: run1.vsError, server: serverSummary(srv, logStart) };
      sc.firstRun.runtimeLines = rtLinesOf(run1);
      sc.storageAfterFailure = await storageKeys(page);
      const savedInStore = sc.storageAfterFailure.filter((k) => k.key.startsWith(`runtime:${rt.wasm.name}:`)).reduce((a, k) => a + (k.bytes ?? 0), 0);
      sc.savedInStore = savedInStore;
      const copyMatch = /^运行环境下载失败（已保存 (\d+(?:\.\d)?) MB \/ (\d+(?:\.\d)?) MB，刷新后继续）。$/.exec(run1.errorText || '');
      check('dead_reload.errorCode', run1.state === 'error' && run1.vsError?.code === 'RUNTIME_DOWNLOAD', { state: run1.state, error: run1.vsError });
      check('dead_reload.copy', !!copyMatch, { copy: run1.errorText });
      check('dead_reload.savedFigure', !!copyMatch && Number(copyMatch[1]) >= 4 && Math.abs(Number(copyMatch[1]) - savedInStore / MiB) < 1.5, { copy: run1.errorText, savedInStore, detail: run1.vsError?.detail });
      check('dead_reload.detail', run1.vsError?.detail?.bytesSaved === savedInStore && run1.vsError?.detail?.bytesTotal === rtBytes('wasm'), { detail: run1.vsError?.detail, savedInStore });
      check('dead_reload.notGpu', !/GPU/.test(run1.errorText || '') && !(consoleErrors.some((c) => c.includes('webgpu-fallback'))), { copy: run1.errorText, consoleErrors });
      // reload: the session persists, the stored prefixes come back, the origin is alive again
      dead = false;
      rule.kill = false;
      rule.rateBytesPerSec = null;
      await page.reload();
      await login(page, counter);
      await loadFixture(page);
      const logStart2 = srv.log.length;
      const urlsStart2 = urls.length;
      const run2 = await runJob(page);
      sc.secondRun = { state: run2.state, lines: run2.lines, server: serverSummary(srv, logStart2), runtime: run2.timings?.runtime ?? null, runtimeLines: rtLinesOf(run2) };
      sc.secondRun.firstRuntimeLine = run2.lines.find((x) => x.text.includes('正在下载运行环境'))?.text ?? null;
      sc.ortOwnFetches = ortOwnFetches(urls.slice(urlsStart));
      const d2 = sc.secondRun.runtime?.report ?? {};
      check('dead_reload.secondDone', run2.state === 'done', { state: run2.state, error: run2.vsError, copy: run2.errorText });
      check('dead_reload.resumedFromStore', (d2.restoredBytes ?? 0) >= savedInStore && savedInStore >= 4 * MiB, { restoredBytes: d2.restoredBytes, savedInStore });
      check('dead_reload.notRedownloaded', sc.secondRun.server.runtimeBytesSent <= rtBytes('wasm') - savedInStore + MiB, { secondRunBytesSent: sc.secondRun.server.runtimeBytesSent, savedInStore, rtBytes: rtBytes('wasm') });
      check('dead_reload.ortOwnFetch', sc.ortOwnFetches.length === 0, { ortOwnFetches: sc.ortOwnFetches });
    }

    if (scenario === 'import_webgpu') {
      const files = [rt.wasm.name, rt.glue.name].map((n) => path.join(repoRoot, 'site', 'vendor', 'ort', n));
      const t0i = Date.now();
      await page.setInputFiles('#import-input', files);
      await page.waitForFunction(() => /^(已导入|文件与清单不匹配)/.test(document.getElementById('import-line').textContent || ''), null, { timeout: 120000 });
      const line = await page.evaluate(() => document.getElementById('import-line').textContent);
      sc.import = { files: files.map((f) => path.basename(f)), line, ms: Date.now() - t0i, result: await page.evaluate(() => window.__vs.imported && { imported: window.__vs.imported.imported.map((m) => ({ kind: m.kind, backend: m.backend ?? null, bytes: m.bytes, files: m.files.length })), mismatched: window.__vs.imported.mismatched }) };
      sc.storageAfterImport = await storageKeys(page);
      const expectedLine = `已导入：运行环境（WebGPU，${Math.round(rtBytes('webgpu') / MiB)} MB）`;
      check('import_webgpu.line', line === expectedLine, { line, expectedLine });
      const urlsBeforeStart = urls.length;
      const run = await runJob(page);
      sc.run = run;
      sc.runtime = run.timings?.runtime ?? null;
      sc.runtimeLines = rtLinesOf(run);
      sc.ortFileRequests = urls.slice(urlsBeforeStart).filter((u) => ORT_FILE_RE.test(u));
      sc.ortOwnFetches = ortOwnFetches(urls.slice(urlsStart));
      sc.server = serverSummary(srv, logStart);
      const d = sc.runtime?.report ?? {};
      check('import_webgpu.done', run.state === 'done', { state: run.state, error: run.vsError, copy: run.errorText });
      check('import_webgpu.backend', run.timings?.backend === 'webgpu' && run.timings?.fellBack === false, { backend: run.timings?.backend, fellBack: run.timings?.fellBack });
      check('import_webgpu.noRuntimeRequest', sc.ortFileRequests.length === 0 && sc.server.runtimeRequests.filter((r) => /\.wasm$/.test(r.path)).length === 0, { ortFileRequests: sc.ortFileRequests, server: sc.server.runtimeRequests });
      check('import_webgpu.restored', d.downloadedBytes === 0 && d.sources === null && d.restoredBytes === rtBytes('webgpu'), { report: d });
      check('import_webgpu.ortOwnFetch', sc.ortOwnFetches.length === 0, { ortOwnFetches: sc.ortOwnFetches });
      check('import_webgpu.noDownloadLine', !sc.runtimeLines.some((x) => x.includes('正在下载运行环境')), { lines: sc.runtimeLines });
      check('import_webgpu.noConsoleError', unexpectedConsole(consoleErrors).length === 0, { consoleErrors });
    }

    result.scenarios[scenario] = sc;
    log(scenario, 'state', (sc.run ?? sc.secondRun)?.state, 'ortOwnFetches', sc.ortOwnFetches?.length ?? '-');
    await context.close();
    if (gpuBrowser) await gpuBrowser.close();
  }
  result.ok = result.failures.length === 0;
} catch (e) {
  result.ok = false;
  result.failures.push({ check: 'harness', info: String(e && e.stack || e).slice(0, 2000) });
  console.error('[rtd] FAIL', e);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  await srv.stop();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  log('wrote', outFile, 'ok', result.ok, 'failures', result.failures.length);
}
process.exit(result.ok ? 0 : 1);
