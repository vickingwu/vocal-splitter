// tests/e2e/live_sources.mjs — SHIP-2 / review-3 finding 11: model bytes arriving from a NON-origin source on the live
// site, in real Chromium (the local mirror scenario of download_failure.mjs route-fulfils the mirror; this one hits the CDN).
//   node tests/e2e/live_sources.mjs --base https://vickingwu.github.io/vocal-splitter/ [--model uvr_mdxnet_9482]
//        [--sources <csv of source ids | all>] [--timeout-min 8] [--out ../evidence/sources_live_chromium.json]
// Per source id, in a fresh context: every same-origin models/**/*.bin request is aborted at the network layer (the "dead
// origin" hook — the probe keeps origin as the range-less last resort, so every byte must come from the pinned source), the
// page is opened with ?sources=<id> (the app appends origin), login, fixture, 开始, poll until done/error/timeout. Records
// timings.download (ranked sources, excluded, used bytes per source, concurrency, failures, resumedBytes), the download
// lines, the download events' sourceIds, every response seen for the source's URLs (status, Content-Range, ACAO, encoding),
// and the verdict: state done AND used[<id>] === fileBytes AND no origin bytes. Credentials ONLY from VS_TEST_USER /
// VS_TEST_PASS. Exit 0 when every requested source carried the file.
import fs from 'node:fs';
import path from 'node:path';
// requests issued through the coi service worker are routed/observed only with this flag (set before playwright loads)
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium } = await import('playwright');
import { makeNavCounter, awaitIsolation, launchChromium, login, readManifest, sleep } from '../lib/e2e-helpers.mjs';
import { fixturePath, repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
let base = arg('--base', 'https://vickingwu.github.io/vocal-splitter/');
if (!base.endsWith('/')) base += '/';
const modelId = arg('--model', 'uvr_mdxnet_9482');
const sourcesArg = arg('--sources', 'all');
const timeoutMs = Number(arg('--timeout-min', '8')) * 60 * 1000;
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'sources_live_chromium.json')));
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS'); process.exit(2); }
const log = (...a) => console.log('[live-src]', ...a);

const manifest = await readManifest(base);
const model = manifest.models[modelId];
if (!model) { console.error(`BAD_ARG: unknown model ${modelId}`); process.exit(2); }
const files = [model.files.model, model.files.externalData].filter(Boolean);
const fileBytes = files.reduce((a, f) => a + f.bytes, 0);
const remote = (model.sources ?? []).filter((s) => s.id !== 'origin');
const ids = sourcesArg === 'all' ? remote.map((s) => s.id) : sourcesArg.split(',').map((s) => s.trim()).filter(Boolean);
for (const id of ids) if (!remote.some((s) => s.id === id)) { console.error(`BAD_ARG: ${modelId} has no remote source ${id}`); process.exit(2); }
const prefixesOf = (s) => (s.kind === 'chunks' ? [s.base] : Object.values(s.urls));
const originChunk = (u) => u.href.startsWith(base + 'models/') && /\.bin$/.test(u.pathname);
const MB_RE = /(\d+(?:\.\d+)?) MB \/ (\d+(?:\.\d+)?) MB/;

const result = { date: new Date().toISOString(), base, manifestVersion: manifest.version, tag: manifest.tag, modelId, fileBytes, chunkCount: files.reduce((a, f) => a + f.chunks.length, 0), deadOrigin: 'every same-origin models/**/*.bin request aborted (connectionrefused) via context.route + PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS', runs: {}, carried: [], failed: [] };
const l = await launchChromium(chromium, { headless: true });
const browser = l.browser;
result.browser = { channel: l.channel, version: browser.version() };
log('browser', l.channel, browser.version(), 'model', modelId, fileBytes, 'B', 'sources', ids.join(','));
try {
  for (const id of ids) {
    const src = remote.find((s) => s.id === id);
    const prefixes = prefixesOf(src);
    log('--- source', id, src.kind, prefixes.join(' | '));
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const counter = makeNavCounter(context);
    const run = { id, kind: src.kind, label: src.label, prefixes, originAborted: 0, responses: [], failedRequests: [], consoleErrors: [], lines: [], state: null, ok: false };
    await context.route(originChunk, (route) => { run.originAborted++; route.abort('connectionrefused'); });
    const seen = new Set();
    context.on('response', (r) => {
      const u = r.url();
      if (!prefixes.some((p) => u.startsWith(p))) return;
      const h = r.headers();
      const key = `${r.request().method()} ${u} ${r.request().headers()['range'] ?? ''} ${r.status()}`;
      if (seen.has(key) || run.responses.length >= 200) return;
      seen.add(key);
      run.responses.push({ url: u.replace(prefixes[0], ''), range: r.request().headers()['range'] ?? null, status: r.status(), contentRange: h['content-range'] ?? null, contentLength: h['content-length'] ?? null, contentEncoding: h['content-encoding'] ?? null, acao: h['access-control-allow-origin'] ?? null, fromServiceWorker: r.fromServiceWorker() });
    });
    context.on('requestfailed', (r) => { const u = r.url(); if (prefixes.some((p) => u.startsWith(p)) && run.failedRequests.length < 50) run.failedRequests.push({ url: u.replace(prefixes[0], ''), range: r.headers()['range'] ?? null, error: r.failure()?.errorText ?? null }); });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && run.consoleErrors.length < 50) run.consoleErrors.push(m.text().slice(0, 300)); });
    const t0 = Date.now();
    try {
      const url = `${base}?backend=wasm&model=${encodeURIComponent(modelId)}&sources=${encodeURIComponent(id)}`;
      await page.goto(url);
      run.isolated = await awaitIsolation(page, { counter, sinceNavigation: 0, maxExtraNavigations: 2, timeout: 20000 });
      await login(page, { user: USER, pass: PASS });
      await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
      run.caps = await page.evaluate(() => { const c = window.__vs.caps; return c ? { threads: c.threads, isolated: c.isolated } : null; });
      await page.setInputFiles('#file-input', fixturePath('clip25.wav'));
      await page.waitForFunction(() => window.__vs.state === 'ready', null, { timeout: 60000 });
      await page.click('#start');
      const tStart = Date.now();
      for (;;) {
        const s = await page.evaluate(() => ({ state: window.__vs.state, text: document.getElementById('progress').textContent, error: document.getElementById('error').textContent }));
        if (run.lines.length === 0 || run.lines[run.lines.length - 1].text !== s.text) run.lines.push({ atMs: Date.now() - tStart, state: s.state, text: s.text });
        if (s.state === 'done' || s.state === 'error') { run.state = s.state; run.errorText = s.error; run.vsError = await page.evaluate(() => window.__vs.error); break; }
        if (Date.now() - tStart > timeoutMs) { run.state = s.state; run.timeout = true; break; }
        await sleep(250);
      }
      run.elapsedMs = Date.now() - tStart;
      const t = await page.evaluate(() => (window.__vs.timings ? window.__vs.timings() : null));
      run.download = t && t.download ? t.download : null;
      const ev = await page.evaluate(() => (window.__vs.downloadEvents ?? []).map((e) => e.sourceId));
      run.downloadEventSources = ev.reduce((m, s) => { m[s ?? 'null'] = (m[s ?? 'null'] ?? 0) + 1; return m; }, {});
      run.downloadLines = run.lines.filter((x) => x.text.includes('正在下载模型')).map((x) => `${x.atMs}ms ${x.text}`);
      const dl = run.lines.filter((x) => x.text.includes('正在下载模型'));
      run.downloadMs = dl.length ? (run.lines.find((x) => !x.text.includes('正在下载模型') && x.atMs > dl[dl.length - 1].atMs)?.atMs ?? null) : null;
      const used = run.download?.used ?? {};
      run.usedBytes = used[id] ?? 0;
      run.originBytes = used.origin ?? 0;
      run.rankedFirst = Array.isArray(run.download?.sources) ? run.download.sources[0]?.id ?? null : null;
      run.probe = Array.isArray(run.download?.sources) ? run.download.sources.find((s) => s.id === id)?.probe ?? null : null;
      run.excluded = run.download?.excluded ?? null;
      run.ok = run.state === 'done' && run.usedBytes === fileBytes && !(run.originBytes > 0);
      if (run.downloadMs && run.usedBytes) run.MBps = Number((run.usedBytes / 1048576 / (run.downloadMs / 1000)).toFixed(2));
      run.why = run.ok ? null : (run.timeout ? `timeout after ${Math.round(run.elapsedMs / 1000)} s in state ${run.state}` : run.state === 'error' ? `error ${JSON.stringify(run.vsError)}` : `used[${id}]=${run.usedBytes} origin=${run.originBytes} fileBytes=${fileBytes}`);
    } catch (e) {
      run.state = run.state ?? 'harness-error';
      run.harnessError = String(e && e.stack || e).slice(0, 1500);
      run.ok = false;
      run.why = 'harness: ' + String(e && e.message).slice(0, 300);
    }
    run.totalMs = Date.now() - t0;
    try { await page.screenshot({ path: path.join(path.dirname(outFile), `sources_live_chromium_${id}.png`) }); } catch { /* ignore */ }
    await context.close();
    result.runs[id] = run;
    (run.ok ? result.carried : result.failed).push(id);
    log(id, run.ok ? 'OK' : 'FAIL', `state=${run.state}`, `used=${run.usedBytes}/${fileBytes}`, `origin=${run.originBytes}`, `originAborted=${run.originAborted}`, `rankedFirst=${run.rankedFirst}`, `probe=${JSON.stringify(run.probe)}`, `responses=${run.responses.length}`, `MBps=${run.MBps ?? '-'}`, run.why ?? '');
  }
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  result.ok = result.failed.length === 0;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  log('wrote', outFile, 'carried', result.carried.join(','), 'failed', result.failed.join(','));
}
process.exit(result.ok ? 0 : 1);
