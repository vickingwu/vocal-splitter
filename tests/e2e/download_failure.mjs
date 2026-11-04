// tests/e2e/download_failure.mjs — FIX-2 R0/R2: the model download on a slow or resetting link, in the real UI (headless
// Chromium, the whole site served by tests/lib/throttle-server.mjs so the worker's fetches hit the fault injection).
//   node tests/e2e/download_failure.mjs --label before|after [--scenario throttle|reset|reload|all] [--model uvr_mdxnet_9482]
//        [--port 8012] [--rate 30000] [--throttle-seconds 20] [--out ../evidence/download_failure_repro.json]
// Scenarios: (i) throttle — every models/*.bin response streams at --rate B/s for --throttle-seconds, then full speed;
// (ii) reset — the first chunk response (≥ 1 MB) is cut by a TCP reset after 40 % of its bytes, once; (iii) reload — the
// page is reloaded once the download line shows ≥ 8 MB, then 开始 is pressed again; (iv) mirror — the origin stays at
// --rate B/s for the whole run while the manifest's first chunk mirror (--mirror <source id>) is answered by a Playwright
// route from the local site/models files (206 + CORS, as the CDN does): the probe must rank the mirror first and every
// byte must come from it over cross-origin Range requests — the browser-side proof that a non-origin source carries a
// download. The JSON records, per scenario, the progress lines, the final state, the error copy, the Cache Storage /
// IndexedDB contents and the server log (bytes sent per request, Range headers), merged under runs.<label>. With --label
// after the resume assertions are enforced (exit 1). Credentials come ONLY from VS_TEST_USER / VS_TEST_PASS.
import fs from 'node:fs';
import path from 'node:path';
import { startThrottleServer } from '../lib/throttle-server.mjs';
import { makeNavCounter, awaitIsolation, launchChromium, sleep } from '../lib/e2e-helpers.mjs';
import { fixturePath, repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const label = arg('--label', 'after');
const scenarioArg = arg('--scenario', 'all');
const modelId = arg('--model', 'uvr_mdxnet_9482');
const port = Number(arg('--port', '8012'));
const rate = Number(arg('--rate', '30000'));
const throttleSeconds = Number(arg('--throttle-seconds', '20'));
const mirrorArg = arg('--mirror', undefined);
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'download_failure_repro.json')));
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS'); process.exit(2); }
if (!['before', 'after'].includes(label)) { console.error('BAD_ARG: --label before|after'); process.exit(2); }
const scenarios = scenarioArg === 'all' ? ['throttle', 'reset', 'reload', 'mirror'] : scenarioArg.split(',');
// the mirror route must see the requests the coi service worker forwards (Playwright routes them only with this flag)
if (scenarios.includes('mirror')) process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium } = await import('playwright');
const MiB = 1048576;
const log = (...a) => console.log('[dlf]', ...a);

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'site', 'models', 'manifest.json'), 'utf8'));
const model = manifest.models[modelId];
if (!model) { console.error(`BAD_ARG: unknown model ${modelId}`); process.exit(2); }
const files = [model.files.model, model.files.externalData].filter(Boolean);
const fileBytes = files.reduce((a, f) => a + f.bytes, 0);
const chunkPaths = new Set(files.flatMap((f) => f.chunks.map((c) => '/' + c.path)));
const isChunk = (p) => chunkPaths.has(p);
const mirrorSource = (model.sources ?? []).find((s) => s.kind === 'chunks' && s.id !== 'origin' && (!mirrorArg || s.id === mirrorArg)) ?? null;
if (scenarios.includes('mirror') && !mirrorSource) { console.error(`BAD_ARG: model ${modelId} has no chunk mirror${mirrorArg ? ` with id ${mirrorArg}` : ''}`); process.exit(2); }

// Answers the mirror's URLs from site/ like the CDN would: 206 + Content-Range for a Range request, CORS headers, no caching.
async function routeMirror(context, base, mirrorLog) {
  const basePath = new URL(base).pathname;
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' };
  await context.route((u) => u.href.startsWith(base), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const rel = decodeURIComponent(u.pathname.slice(basePath.length));
    const entry = { path: rel.replace(/^models\//, ''), method: req.method(), range: req.headers()['range'] ?? null, origin: req.headers()['origin'] ?? null, status: null, length: 0 };
    mirrorLog.push(entry);
    const file = path.join(repoRoot, 'site', ...rel.split('/'));
    if (!/^models\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.bin$/.test(rel) || !fs.existsSync(file)) { entry.status = 404; await route.fulfill({ status: 404, headers: cors, body: '' }); return; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(entry.range || '');
    if (m) { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); status = start <= end && start < size ? 206 : 416; }
    if (status === 416) { entry.status = 416; await route.fulfill({ status: 416, headers: { ...cors, 'content-range': `bytes */${size}` }, body: '' }); return; }
    const buf = Buffer.alloc(end - start + 1);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    entry.status = status; entry.length = buf.length;
    const headers = { ...cors, 'content-type': 'application/octet-stream', 'content-length': String(buf.length), 'accept-ranges': 'bytes' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    await route.fulfill({ status, headers, body: buf });
  });
}

const MB_RE = /(\d+(?:\.\d+)?) MB \/ (\d+(?:\.\d+)?) MB/;
const parseDoneMB = (text) => { const m = MB_RE.exec(text || ''); return m ? Number(m[1]) : null; };

async function storageSnapshot(page) {
  return page.evaluate(async () => {
    const out = { caches: {}, idb: null };
    try {
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        const keys = await c.keys();
        const entries = [];
        for (const k of keys) {
          const r = await c.match(k);
          const len = r ? Number(r.headers.get('content-length')) || (await r.clone().arrayBuffer()).byteLength : null;
          entries.push({ url: k.url.replace(location.origin, ''), bytes: len });
        }
        out.caches[name] = entries;
      }
    } catch (e) { out.cachesError = String(e && e.message); }
    try {
      const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
      out.idb = [];
      for (const d of dbs) {
        if (!d.name) continue;
        const db = await new Promise((res, rej) => { const q = indexedDB.open(d.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        const stores = Array.from(db.objectStoreNames);
        const info = { name: d.name, stores: {} };
        for (const s of stores) {
          const keys = await new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
          info.stores[s] = keys.map(String);
        }
        db.close();
        out.idb.push(info);
      }
    } catch (e) { out.idbError = String(e && e.message); }
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
  const reqs = srv.log.slice(sinceIndex).filter((e) => isChunk(e.path));
  return {
    chunkRequests: reqs.map((e) => ({ path: e.path.replace(/^\/models\//, ''), range: e.range, status: e.status, length: e.length, sent: e.sent, reset: e.reset, ms: e.ms })),
    chunkBytesSent: reqs.reduce((a, e) => a + e.sent, 0),
    fileBytes,
    resets: reqs.filter((e) => e.reset).length,
    rangeRequests: reqs.filter((e) => e.range).length,
  };
};

const result = { label, modelId, fileBytes, chunkCount: files.reduce((a, f) => a + f.chunks.length, 0), rate, throttleSeconds, date: new Date().toISOString(), scenarios: {}, ok: null, failures: [] };
const check = (name, cond, info) => { if (!cond) { result.failures.push({ scenario: name.split('.')[0], check: name, info }); log('CHECK FAILED', name, JSON.stringify(info)); } return cond; };

const srv = await startThrottleServer({ root: path.join(repoRoot, 'site'), port });
const l = await launchChromium(chromium, { headless: true });
const browser = l.browser;
log('server', srv.url, 'browser', l.channel, browser.version());
try {
  for (const scenario of scenarios) {
    log('--- scenario', scenario);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const counter = makeNavCounter(context);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    const sourcesParam = scenario === 'mirror' ? `${mirrorSource.id},origin` : 'origin';
    const url = `${srv.url}?backend=wasm&model=${encodeURIComponent(modelId)}&sources=${encodeURIComponent(sourcesParam)}`;
    srv.setRules([]);
    const mirrorLog = [];
    if (scenario === 'mirror') await routeMirror(context, mirrorSource.base, mirrorLog);
    await page.goto(url);
    await login(page, counter);
    await clearStorage(page);
    await loadFixture(page);
    const sc = { url, consoleErrors };
    const logStart = srv.log.length;

    if (scenario === 'throttle') {
      const rule = { match: /\/models\/.*\.bin$/, rateBytesPerSec: rate };
      srv.setRules([rule]);
      let lifted = null;
      const run = await runJob(page, { onTick: ({ elapsedMs }) => { if (lifted === null && elapsedMs >= throttleSeconds * 1000) { rule.rateBytesPerSec = null; lifted = elapsedMs; log('rate limit lifted at', elapsedMs, 'ms'); } } });
      sc.run = run; sc.liftedAtMs = lifted;
      sc.server = serverSummary(srv, logStart);
      const dlLines = run.lines.filter((x) => x.text.includes('正在下载模型'));
      sc.downloadLines = dlLines.map((x) => `${x.atMs}ms ${x.text}`);
      sc.speedShown = dlLines.some((x) => / (KB|MB)\/s/.test(x.text));
      sc.etaShown = dlLines.some((x) => /预计剩余 \d+:\d\d/.test(x.text));
      sc.throttledLineExample = dlLines.find((x) => x.atMs > 5000 && x.atMs < throttleSeconds * 1000)?.text ?? null;
      sc.storage = await storageSnapshot(page);
      if (label === 'after') {
        check('throttle.done', run.state === 'done', { state: run.state, error: run.vsError });
        check('throttle.speed', sc.speedShown, { lines: sc.downloadLines.slice(0, 12) });
        check('throttle.eta', sc.etaShown, { lines: sc.downloadLines.slice(0, 12) });
      }
    }

    if (scenario === 'reset') {
      srv.setRules([{ match: /\/models\/.*\.bin$/, resetAtFraction: 0.4, resetOnce: true, minLength: MiB }]);
      const run = await runJob(page);
      sc.run = run;
      sc.server = serverSummary(srv, logStart);
      sc.storageAfterFirstRun = await storageSnapshot(page);
      sc.errorCopy = run.state === 'error' ? run.errorText : null;
      if (run.state === 'error') {
        // what the user would do next: press 开始 again — does anything survive?
        srv.setRules([]);
        const logStart2 = srv.log.length;
        await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
        const run2 = await runJob(page);
        sc.retry = { run: run2, server: serverSummary(srv, logStart2) };
        sc.retry.firstDownloadLine = run2.lines.find((x) => x.text.includes('正在下载模型'))?.text ?? null;
        sc.retry.bytesLost = sc.server.chunkBytesSent;   // everything of the first attempt was transferred for nothing
      }
      sc.storage = await storageSnapshot(page);
      if (label === 'after') {
        check('reset.done', run.state === 'done', { state: run.state, error: run.vsError, copy: run.errorText });
        check('reset.resetHappened', sc.server.resets === 1, { resets: sc.server.resets });
        check('reset.rangeRetry', sc.server.chunkRequests.some((r) => r.range && !r.reset && r.status === 206), { requests: sc.server.chunkRequests });
        // per-byte resume: the retry's Range starts inside the reset request's delivered bytes, at the count the browser had
        // received when the RST surfaced (fetchInto reports its final count in a finally, so the resume point is the last byte
        // written into the slot, not the last 100 ms report); the server's `sent` can be ahead of that — the bytes still in
        // transit when the RST arrived are gone (`lostOnReset`) — and the report's resumedBytes is exactly that offset
        const rangeStart = (r) => Number(/^bytes=(\d+)-/.exec(r.range ?? 'bytes=0-')?.[1] ?? 0);
        const resetReq = sc.server.chunkRequests.find((r) => r.reset);
        const resumeReq = resetReq && sc.server.chunkRequests.find((r) => r.path === resetReq.path && r.range && !r.reset && rangeStart(r) > rangeStart(resetReq) && rangeStart(r) <= rangeStart(resetReq) + resetReq.sent);
        check('reset.resumedAtReceived', !!resumeReq, { resetReq, requests: sc.server.chunkRequests.slice(0, 12) });
        sc.resume = resetReq && resumeReq ? { resetAt: rangeStart(resetReq) + resetReq.sent, resumedAt: rangeStart(resumeReq), keptBytes: rangeStart(resumeReq) - rangeStart(resetReq), lostOnReset: rangeStart(resetReq) + resetReq.sent - rangeStart(resumeReq), keptFractionOfSent: Number(((rangeStart(resumeReq) - rangeStart(resetReq)) / resetReq.sent).toFixed(3)) } : null;
        check('reset.reportResumedBytes', !!sc.resume && (run.timings?.download?.resumedBytes ?? -1) === sc.resume.keptBytes, { resumedBytes: run.timings?.download?.resumedBytes, resume: sc.resume });
        // accounting (an identity once the resume starts inside the reset request's range): the bytes beyond the file are the
        // 256 KB probe plus what the RST destroyed in transit — nothing the browser consumed was requested twice
        const probeSent = sc.server.chunkRequests.filter((r) => r.range === 'bytes=0-262143' && r.length === 262144).reduce((a, r) => a + r.sent, 0);
        const extra = sc.server.chunkBytesSent - fileBytes;
        check('reset.resumed', !!sc.resume && extra === probeSent + sc.resume.lostOnReset, { chunkBytesSent: sc.server.chunkBytesSent, fileBytes, extra, probeSent, lostOnReset: sc.resume?.lostOnReset });
      }
    }

    if (scenario === 'reload') {
      // 2 MiB/s per response, 4 segments in flight (the probe sees a fast link): the first wave of four 4 MiB segments is
      // complete and persisted after ~2 s; the page is reloaded once the line shows >= 20 MB (second wave in flight), so
      // at least 16 MiB must come back from storage and the second run must fetch at most the rest
      const rule = { match: /\/models\/.*\.bin$/, rateBytesPerSec: 2 * MiB };
      srv.setRules([rule]);
      let reloadAt = null;
      const run1 = await runJob(page, { onTick: ({ doneMB, text }) => { if (text.includes('正在下载模型') && doneMB !== null && doneMB >= 20) { reloadAt = doneMB; return 'stop'; } } });
      sc.firstRun = { lines: run1.lines, stoppedAtMB: reloadAt, server: serverSummary(srv, logStart) };
      await page.reload();
      await login(page, counter);
      sc.storageAfterReload = await storageSnapshot(page);
      await loadFixture(page);
      rule.rateBytesPerSec = null;
      const logStart2 = srv.log.length;
      const run2 = await runJob(page);
      sc.secondRun = { run: run2, server: serverSummary(srv, logStart2) };
      sc.secondRun.firstDownloadLine = run2.lines.find((x) => x.text.includes('正在下载模型'))?.text ?? null;
      sc.secondRun.firstDownloadMB = parseDoneMB(sc.secondRun.firstDownloadLine);
      sc.totalChunkBytesSent = sc.firstRun.server.chunkBytesSent + sc.secondRun.server.chunkBytesSent;
      sc.storage = await storageSnapshot(page);
      if (label === 'after') {
        check('reload.done', run2.state === 'done', { state: run2.state, error: run2.vsError });
        check('reload.resumedFromStorage', (sc.secondRun.firstDownloadMB ?? 0) >= 16, { firstDownloadLine: sc.secondRun.firstDownloadLine });
        check('reload.storageHasParts', Object.values(sc.storageAfterReload.caches ?? {}).some((es) => es.length >= 4) || (sc.storageAfterReload.idb ?? []).some((d) => Object.values(d.stores).some((ks) => ks.length >= 4)), sc.storageAfterReload);
        // the second run fetches at most what was not persisted (the file minus the first wave) plus one probe
        const second = sc.secondRun.server.chunkBytesSent;
        check('reload.notRedownloaded', second <= fileBytes - 16 * MiB + MiB, { secondRunChunkBytesSent: second, fileBytes, allowed: fileBytes - 16 * MiB + MiB });
        check('reload.restoredBytes', (run2.timings?.download?.restoredBytes ?? 0) >= 16 * MiB, run2.timings?.download);
      }
    }

    if (scenario === 'mirror') {
      // the origin stays slow for the whole run; the mirror (route-fulfilled from site/models, 206 + CORS) must win the probe
      // and carry every byte over cross-origin Range requests; the origin sees its 256 KB probe and nothing else
      srv.setRules([{ match: /\/models\/.*\.bin$/, rateBytesPerSec: rate }]);
      const run = await runJob(page);
      sc.run = run;
      sc.mirror = { id: mirrorSource.id, base: mirrorSource.base, requests: mirrorLog.map((e) => ({ ...e })), bytes: mirrorLog.reduce((a, e) => a + e.length, 0), rangeRequests: mirrorLog.filter((e) => e.range && e.status === 206).length, corsOrigin: mirrorLog.find((e) => e.origin)?.origin ?? null };
      sc.server = serverSummary(srv, logStart);
      sc.download = run.timings?.download ?? null;
      sc.downloadLines = run.lines.filter((x) => x.text.includes('正在下载模型')).map((x) => `${x.atMs}ms ${x.text}`);
      sc.storage = await storageSnapshot(page);
      if (label === 'after') {
        const d = sc.download ?? {};
        check('mirror.done', run.state === 'done', { state: run.state, error: run.vsError, copy: run.errorText });
        check('mirror.rankedFirst', Array.isArray(d.sources) && d.sources[0]?.id === mirrorSource.id, { sources: d.sources });
        check('mirror.carriedEveryByte', (d.used?.[mirrorSource.id] ?? 0) === fileBytes && !(d.used?.origin > 0), { used: d.used, fileBytes });
        check('mirror.rangeRequests', sc.mirror.rangeRequests >= Math.ceil(fileBytes / (4 * MiB)), { rangeRequests: sc.mirror.rangeRequests, requests: sc.mirror.requests.slice(0, 12) });
        check('mirror.crossOriginRequest', sc.mirror.corsOrigin === new URL(srv.url).origin, { corsOrigin: sc.mirror.corsOrigin });
        check('mirror.originOnlyProbed', sc.server.chunkBytesSent < MiB, { originChunkBytesSent: sc.server.chunkBytesSent, requests: sc.server.chunkRequests });
        check('mirror.concurrency', d.concurrency >= 2, { concurrency: d.concurrency, linkKBps: d.linkKBps });
      }
    }

    result.scenarios[scenario] = sc;
    log(scenario, 'state', (sc.run ?? sc.secondRun?.run)?.state, 'chunkBytesSent', (sc.server ?? sc.secondRun?.server)?.chunkBytesSent, 'resets', sc.server?.resets ?? '-', scenario === 'mirror' ? `mirrorBytes ${sc.mirror.bytes}` : '');
    await context.close();
  }
  result.ok = result.failures.length === 0;
} catch (e) {
  result.ok = false;
  result.failures.push({ check: 'harness', info: String(e && e.stack || e).slice(0, 2000) });
  console.error('[dlf] FAIL', e);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  await srv.stop();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')); } catch { prev = {}; }
  const merged = { ...prev, runs: { ...(prev.runs ?? {}), [label]: result } };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + '\n');
  log('wrote', outFile, 'ok', result.ok, 'failures', result.failures.length);
}
process.exit(result.ok ? 0 : 1);
