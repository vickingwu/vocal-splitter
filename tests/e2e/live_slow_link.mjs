// tests/e2e/live_slow_link.mjs — SHIP-2 step 6: the model download on the LIVE site over a slow link with one response cut
// midway, in headless Chromium.
//   node tests/e2e/live_slow_link.mjs --base https://vickingwu.github.io/vocal-splitter/ [--model uvr_mdxnet_9482]
//        [--rate 30000] [--throttle-seconds 25] [--truncate-at 1500000] [--no-sw] [--out ../evidence/e2e_live_slow_link.json]
// Throttle: Playwright's route API cannot pace a body (route.fulfill hands the whole body over at once), so the ~30 KB/s link
// is emulated with CDP Network.emulateNetworkConditions on the page session (downloadThroughput = --rate B/s) for
// --throttle-seconds, then lifted. ?sources=origin pins the download to same-origin chunks. Abort midway: context.route
// catches the first 4 MiB same-origin Range request after the throttle is lifted, fetches the real 206 and fulfils it with the
// first --truncate-at bytes only, keeping the original Content-Length / Content-Range headers — the body ends early, as it
// does when a connection is reset. Asserts: the download line showed the throttled speed, concurrency 1 was chosen, the
// truncated request was followed by a Range request resuming at (start + --truncate-at), report.resumedBytes >= --truncate-at,
// state done, used.origin === fileBytes. Credentials ONLY from VS_TEST_USER / VS_TEST_PASS.
import fs from 'node:fs';
import path from 'node:path';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';     // route/observe the requests the coi service worker forwards
const { chromium } = await import('playwright');
import { makeNavCounter, awaitIsolation, launchChromium, login, readManifest, sleep } from '../lib/e2e-helpers.mjs';
import { fixturePath, repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
let base = arg('--base', 'https://vickingwu.github.io/vocal-splitter/');
if (!base.endsWith('/')) base += '/';
const modelId = arg('--model', 'uvr_mdxnet_9482');
const rate = Number(arg('--rate', '30000'));
const throttleSeconds = Number(arg('--throttle-seconds', '25'));
const truncateAt = Number(arg('--truncate-at', '1500000'));
const noSw = argv.includes('--no-sw');
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'e2e_live_slow_link.json')));
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS'); process.exit(2); }
const log = (...a) => console.log('[slow-link]', ...a);
const MiB = 1048576;

const manifest = await readManifest(base);
const model = manifest.models[modelId];
if (!model) { console.error(`BAD_ARG: unknown model ${modelId}`); process.exit(2); }
const files = [model.files.model, model.files.externalData].filter(Boolean);
const fileBytes = files.reduce((a, f) => a + f.bytes, 0);
const isOriginChunk = (u) => u.href.startsWith(base + 'models/') && /\.bin(\?.*)?$/.test(u.pathname + u.search);
const parseRange = (h) => { const m = /^bytes=(\d+)-(\d+)$/.exec(h ?? ''); return m ? { start: Number(m[1]), end: Number(m[2]) } : null; };

const result = { date: new Date().toISOString(), base, manifestVersion: manifest.version, modelId, fileBytes, rate, throttleSeconds, truncateAt, noSw, method: 'CDP Network.emulateNetworkConditions (page session) for the throttle; context.route truncates one 4 MiB same-origin Range response after the throttle is lifted', requests: [], lines: [], checks: {}, ok: false };
const l = await launchChromium(chromium, { headless: true });
const browser = l.browser;
result.browser = { channel: l.channel, version: browser.version() };
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(noSw ? { serviceWorkers: 'block' } : {}) });
const counter = makeNavCounter(context);
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 50) consoleErrors.push(m.text().slice(0, 300)); });
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const setThrottle = async (on) => { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: on ? rate : -1, uploadThroughput: -1 }); };

let truncated = null;
let liftAt = null;                                         // wall-clock ms when the throttle was lifted
const t0 = Date.now();
context.on('request', (r) => { const u = new URL(r.url()); if (isOriginChunk(u) && result.requests.length < 200) result.requests.push({ atMs: Date.now() - t0, path: u.pathname.replace(/^.*\/models\//, ''), range: r.headers()['range'] ?? null, sw: r.serviceWorker() ? true : false }); });
context.on('response', (r) => { const u = new URL(r.url()); if (!isOriginChunk(u)) return; const e = result.requests.find((x) => x.path === u.pathname.replace(/^.*\/models\//, '') && x.range === (r.request().headers()['range'] ?? null) && x.status === undefined); if (e) { e.status = r.status(); e.contentRange = r.headers()['content-range'] ?? null; e.contentLength = r.headers()['content-length'] ?? null; } });
await context.route(isOriginChunk, async (route) => {
  const req = route.request();
  const rg = parseRange(req.headers()['range']);
  const span = rg ? rg.end - rg.start + 1 : 0;
  if (!truncated && liftAt !== null && rg && span === 4 * MiB) {
    const resp = await route.fetch();
    const body = await resp.body();
    const headers = { ...resp.headers() };
    delete headers['content-encoding'];
    const partial = body.subarray(0, Math.min(truncateAt, body.length));
    truncated = { atMs: Date.now() - t0, path: new URL(req.url()).pathname.replace(/^.*\/models\//, ''), range: req.headers()['range'], upstreamStatus: resp.status(), upstreamBytes: body.length, deliveredBytes: partial.length, headersKept: { 'content-length': headers['content-length'] ?? null, 'content-range': headers['content-range'] ?? null } };
    log('truncating', JSON.stringify(truncated));
    try { await route.fulfill({ status: resp.status(), headers, body: partial }); }
    catch (e) { truncated.fulfillError = String(e && e.message).slice(0, 300); truncated.deliveredBytes = 0; log('fulfill failed, aborting instead:', truncated.fulfillError); try { await route.abort('connectionreset'); } catch { /* ignore */ } }
    return;
  }
  await route.continue();
});

try {
  const url = `${base}?backend=wasm&model=${encodeURIComponent(modelId)}&sources=origin`;
  await page.goto(url);
  result.isolated = await awaitIsolation(page, { counter, sinceNavigation: 0, maxExtraNavigations: 2, timeout: 20000 });
  await login(page, { user: USER, pass: PASS });
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  result.caps = await page.evaluate(() => { const c = window.__vs.caps; return c ? { threads: c.threads, isolated: c.isolated } : null; });
  await page.evaluate(async () => { for (const n of await caches.keys()) await caches.delete(n); });   // a fresh download, nothing restored
  await page.setInputFiles('#file-input', fixturePath('clip25.wav'));
  await page.waitForFunction(() => window.__vs.state === 'ready', null, { timeout: 60000 });
  await setThrottle(true);
  result.throttleOnAtMs = Date.now() - t0;
  await page.click('#start');
  const tStart = Date.now();
  let lifted = false;
  for (;;) {
    const s = await page.evaluate(() => ({ state: window.__vs.state, text: document.getElementById('progress').textContent, error: document.getElementById('error').textContent }));
    if (result.lines.length === 0 || result.lines[result.lines.length - 1].text !== s.text) result.lines.push({ atMs: Date.now() - tStart, state: s.state, text: s.text });
    if (!lifted && Date.now() - tStart >= throttleSeconds * 1000) { await setThrottle(false); lifted = true; liftAt = Date.now(); result.liftedAtMs = liftAt - tStart; log('throttle lifted at', result.liftedAtMs, 'ms'); }
    if (s.state === 'done' || s.state === 'error') { result.state = s.state; result.errorText = s.error; result.vsError = await page.evaluate(() => window.__vs.error); break; }
    if (Date.now() - tStart > 20 * 60 * 1000) { result.state = s.state; result.timeout = true; break; }
    await sleep(250);
  }
  result.elapsedMs = Date.now() - tStart;
  const t = await page.evaluate(() => (window.__vs.timings ? window.__vs.timings() : null));
  result.download = t && t.download ? t.download : null;
  result.threads = t ? t.threads : null;
  result.truncated = truncated;
  result.consoleErrors = consoleErrors;
  const dl = result.lines.filter((x) => x.text.includes('正在下载模型'));
  result.downloadLines = dl.map((x) => `${x.atMs}ms ${x.text}`);
  // the throttled window: KB/s readings shown before the throttle was lifted (the first reading arrives after the probe)
  const kbps = dl.filter((x) => x.atMs < (result.liftedAtMs ?? Infinity)).map((x) => { const m = /(\d+) KB\/s/.exec(x.text); return m ? Number(m[1]) : null; }).filter((v) => v !== null);
  result.throttledKBps = kbps;
  const resumeReq = truncated && result.requests.find((r) => { const rg = parseRange(r.range); return rg && r.path === truncated.path && rg.start === parseRange(truncated.range).start + truncated.deliveredBytes && r.atMs > truncated.atMs; });
  result.resumeRequest = resumeReq ?? null;
  const d = result.download ?? {};
  result.checks = {
    done: result.state === 'done',
    throttleEffective: kbps.length > 0 && Math.max(...kbps) <= Math.round(rate / 1024 * 2.5),
    concurrencyOne: d.concurrency === 1,
    truncatedOnce: !!truncated && truncated.deliveredBytes < truncated.upstreamBytes,
    resumedAfterTruncation: !!resumeReq,
    reportResumedBytes: (d.resumedBytes ?? 0) >= truncateAt,
    originCarriedFile: (d.used?.origin ?? 0) === fileBytes,
    noDecrease: (() => { const mb = dl.map((x) => Number(/(\d+(?:\.\d)?) MB \//.exec(x.text)?.[1] ?? 0)); return mb.every((v, i) => i === 0 || v >= mb[i - 1]); })(),
  };
  result.ok = Object.values(result.checks).every(Boolean);
  log('checks', JSON.stringify(result.checks), 'download', JSON.stringify({ concurrency: d.concurrency, linkKBps: d.linkKBps, failures: d.failures, progressedFailures: d.progressedFailures, resumedBytes: d.resumedBytes, used: d.used, sources: d.sources?.map((s) => `${s.id} ${s.probe?.kBps} kB/s ${s.probe?.error ?? ''}`) }));
} catch (e) {
  result.harnessError = String(e && e.stack || e).slice(0, 2000);
  result.ok = false;
  console.error('[slow-link] FAIL', e);
} finally {
  try { await page.screenshot({ path: outFile.replace(/\.json$/, '.png') }); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  log('wrote', outFile, 'ok', result.ok);
}
process.exit(result.ok ? 0 : 1);
