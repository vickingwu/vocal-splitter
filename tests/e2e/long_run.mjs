// tests/e2e/long_run.mjs — one long input through the REAL UI with per-chunk telemetry (the 5-minute repro of 2026-11-04).
//   node tests/e2e/long_run.mjs --input <wav|mp3> [--base http://127.0.0.1:8010/] [--backend wasm|webgpu] [--tier standard|hq]
//        [--model <id>] [--device "iPhone 14"] [--no-sw] [--cdp http://127.0.0.1:9222] [--no-snr] [--max-chunks N]
//        [--denoise-then-hq] [--timeout-min 45] [--mem-interval-ms 5000] [--label <tag>] [--out <json>]
// Records: every progress-line stage/chunk change with its timestamp, the engine's per-chunk ms (window.__vs.timings().chunkMs)
// and their trend (first-10 vs last-10 median, least-squares slope), renderer private memory sampled by tests/lib/proc_mem.ps1
// every --mem-interval-ms, page JS heap, MP3 encode ms, download event, total wall time, stall snapshots (no progress for
// > max(60 s, 3 × median chunk time)). No ?maxChunks hook unless --max-chunks is given (then it is recorded as such).
// --no-snr skips the first-period check (the input is clip25 × N: its first ~22 s are chunk-identical to clip25, so those
// samples are compared with audio-separator's clip25 stems after peak normalization — informational, not a gate).
// Credentials come ONLY from VS_TEST_USER / VS_TEST_PASS in the environment; they are never written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, devices } from 'playwright';
import { makeNavCounter, awaitIsolation, login, startServerIfNeeded, readManifest, sleep, startProcessMemoryPoller, launchChromium } from '../lib/e2e-helpers.mjs';
import { b64ToF32, b64ToU8 } from '../lib/b64.mjs';
import { referenceStems, repoRoot } from '../lib/fixtures.mjs';
import { readWav } from '../../site/src/engine/wav.mjs';
import { walk, mpegDuration } from '../../site/src/engine/mp3frames.mjs';
import { planMdx } from '../../site/src/engine/mdx.mjs';
import { snrPeakNormalizedDb } from '../lib/snr.mjs';

// ------------------------------------------------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const args = {
  input: arg('--input', undefined),
  base: arg('--base', 'http://127.0.0.1:8010/'),
  backend: arg('--backend', 'wasm'),
  tier: arg('--tier', 'standard'),
  model: arg('--model', undefined),
  device: arg('--device', undefined),
  noSw: flag('--no-sw'),
  cdp: arg('--cdp', undefined),
  noSnr: flag('--no-snr'),
  maxChunks: arg('--max-chunks', undefined) ? Number(arg('--max-chunks')) : null,
  denoiseThenHq: flag('--denoise-then-hq'),
  timeoutMin: Number(arg('--timeout-min', '45')) || 45,
  memIntervalMs: Number(arg('--mem-interval-ms', '5000')) || 5000,
  label: arg('--label', undefined),
  out: arg('--out', undefined),
};
if (!args.input) { console.error('BAD_ARG: --input <wav|mp3> is required'); process.exit(2); }
args.input = path.resolve(args.input);
if (!fs.existsSync(args.input)) { console.error(`BAD_ARG: input not found ${args.input}`); process.exit(2); }
if (!args.base.endsWith('/')) args.base += '/';
if (!['wasm', 'webgpu'].includes(args.backend)) { console.error(`BAD_ARG: --backend ${args.backend}`); process.exit(2); }
if (!['standard', 'hq'].includes(args.tier)) { console.error(`BAD_ARG: --tier ${args.tier}`); process.exit(2); }
if (args.device && !devices[args.device]) { console.error(`BAD_ARG: unknown device "${args.device}"`); process.exit(2); }
if (args.maxChunks !== null && !(Number.isInteger(args.maxChunks) && args.maxChunks >= 1)) { console.error('BAD_ARG: --max-chunks needs a positive integer'); process.exit(2); }
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS in the environment'); process.exit(2); }

const label = args.label ?? `${args.device ? 'iphone14' : 'chromium'}_${args.backend}_${args.tier}${args.noSw ? '_nosw' : ''}_${path.basename(args.input, path.extname(args.input))}`;
const outFile = args.out ? path.resolve(args.out) : path.resolve(repoRoot, '..', 'evidence', 'long', `long_run_${label}.json`);
const mobile = args.device !== undefined && /iPhone|iPad/.test(devices[args.device].userAgent);
const JOB_TIMEOUT_MS = args.timeoutMin * 60 * 1000;
const log = (...a) => console.log(`[long ${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (code, msg) => { const e = new Error(`${code}: ${msg ?? ''}`); e.code = code; throw e; };
const check = (cond, code, msg) => { if (!cond) fail(code, msg); };
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const round = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------------------------------------- page helpers
const B64_PAGE = `(u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }`;
async function readStemPrefix(page, index, count) {
  const b64 = await page.evaluate(({ index, count, enc }) => {
    const a = window.__vs.stems()[index];
    const v = a.subarray(0, Math.min(count, a.length));
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return (new Function('return ' + enc)())(u8);
  }, { index, count, enc: B64_PAGE });
  return b64ToF32(b64);
}
async function readMp3(page, stem) {
  const b64 = await page.evaluate(async ({ stem, enc }) => {
    const blob = window.__vs.mp3(stem);
    if (!blob) return null;
    const u8 = new Uint8Array(await blob.arrayBuffer());
    return (new Function('return ' + enc)())(u8);
  }, { stem, enc: B64_PAGE });
  return b64 === null ? null : b64ToU8(b64);
}
function checkMp3(bytes, inputSamples, label_) {
  const w = walk(bytes);
  const problems = [];
  if (w.junkBytes !== 0) problems.push(`${w.junkBytes} junk bytes`);
  if (w.frames.length === 0) problems.push('no frames');
  for (const f of w.frames) {
    const b2 = bytes[f.offset + 1], b3 = bytes[f.offset + 2], b4 = bytes[f.offset + 3];
    if (!(bytes[f.offset] === 0xFF && (b2 & 0xE0) === 0xE0)) { problems.push(`sync at ${f.offset}`); break; }
    if (((b2 >> 3) & 3) !== 3 || ((b2 >> 1) & 3) !== 1) { problems.push(`not MPEG-1 Layer III at ${f.offset}`); break; }
    if ((b3 >> 4) !== 0xE) { problems.push(`not 320 kbps at ${f.offset}`); break; }
    if (((b3 >> 2) & 3) !== 0) { problems.push(`not 44.1 kHz at ${f.offset}`); break; }
    if (((b4 >> 6) & 3) !== 0) { problems.push(`not stereo at ${f.offset}`); break; }
  }
  const d = mpegDuration(bytes);
  const delta = d ? Math.round(d.seconds * 44100) - inputSamples : null;
  const slack = 576 + 2 * 1152;
  if (d === null) problems.push('duration null');
  else if (!(delta >= 0 && delta <= slack)) problems.push(`duration Δ ${delta} samples outside [0, ${slack}]`);
  return { label: label_, ok: problems.length === 0, problems, frames: w.frames.length, durationS: d ? round(d.seconds, 3) : null, deltaSamples: delta, bytes: bytes.length };
}

// Trend over the engine's per-chunk ms: medians of the first/last 10 (index 0 excluded from "first" when > 10 chunks — the
// first chunk carries warm-up/shader compilation), least-squares slope per chunk, classification.
function trendOf(chunkMs) {
  const n = chunkMs.length;
  if (n === 0) return { count: 0 };
  const body = n > 10 ? chunkMs.slice(1) : chunkMs.slice();
  const k = Math.min(10, Math.floor(body.length / 2)) || body.length;
  const first = body.slice(0, k), last = body.slice(-k);
  const mFirst = median(first), mLast = median(last);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  body.forEach((y, i) => { sx += i; sy += y; sxx += i * i; sxy += i * y; });
  const m = body.length;
  const slope = m > 1 ? (m * sxy - sx * sy) / (m * sxx - sx * sx) : 0;
  const med = median(chunkMs);
  const ratio = mFirst > 0 ? mLast / mFirst : null;
  const driftOverRun = slope * (m - 1);
  const classification = n < 6 ? 'too-few-chunks' : (ratio !== null && ratio <= 1.15 && Math.abs(driftOverRun) <= 0.15 * med) ? 'flat' : (driftOverRun > 0 ? 'growing' : 'falling');
  return {
    count: n, medianMs: round(med), meanMs: round(chunkMs.reduce((a, b) => a + b, 0) / n), minMs: round(Math.min(...chunkMs)), maxMs: round(Math.max(...chunkMs)),
    p90Ms: round([...chunkMs].sort((a, b) => a - b)[Math.min(n - 1, Math.floor(0.9 * n))]),
    firstMs: round(chunkMs[0]), lastMs: round(chunkMs[n - 1]), first10MedianMs: round(mFirst), last10MedianMs: round(mLast), lastOverFirstRatio: round(ratio, 3),
    slopeMsPerChunk: round(slope, 2), driftOverRunMs: round(driftOverRun), classification,
  };
}

// ------------------------------------------------------------------------------------------------------------ main
const result = {
  label, date: new Date().toISOString(), base: args.base,
  requested: { input: args.input, inputBytes: fs.statSync(args.input).size, backend: args.backend, tier: args.tier, model: args.model ?? null, device: args.device ?? null, noSw: args.noSw, cdp: args.cdp ?? null, maxChunksHook: args.maxChunks, denoiseThenHq: args.denoiseThenHq, timeoutMin: args.timeoutMin },
  hardware: `${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 1e9)} GB RAM`,
  browserBuild: null, cdpInfo: null, adapterInfo: null, crossOriginIsolated: null, isolatedAtCaps: null, navigations: null, caps: null, policy: null,
  input: null, ran: null, finished: false, state: null, error: null, timings: null, chunkTrend: null, expectedChunks: null,
  stages: [], chunkEvents: [], stalls: [], memory: null, pageHeap: [], mp3: null, download: null, stemStats: null, firstPeriodSnr: null, denoiseCheckbox: null,
  wall: {}, consoleErrors: [], ok: false,
};
let server = null, browser = null, context = null, exitCode = 1, cdpUp = false;
const launchedAtMs = Date.now() - 5000;
const writeOut = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8'); log('wrote', outFile); };
const contextOptions = () => ({ ...(args.device ? devices[args.device] : { viewport: { width: 1280, height: 900 } }), acceptDownloads: true, ...(args.noSw ? { serviceWorkers: 'block' } : {}) });

try {
  server = await startServerIfNeeded(args.base);
  log('server', server.started ? 'started by the harness' : 'already answering', args.base);

  // ---- browser (same rules as e2e.mjs: --cdp probed once for 3 s; webgpu → headless Chromium with the WebGPU flags + adapter probe)
  if (args.cdp) {
    let ok = false, versionInfo = null;
    try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000); const r = await fetch(new URL('/json/version', args.cdp).href, { signal: ac.signal }); clearTimeout(t); ok = r.ok; if (ok) versionInfo = await r.json(); } catch { ok = false; }
    cdpUp = ok;
    result.cdpInfo = { url: args.cdp, up: ok, browser: versionInfo?.Browser ?? null };
    log('cdp', JSON.stringify(result.cdpInfo));
  }
  if (cdpUp) {
    browser = await chromium.connectOverCDP(args.cdp);
    result.browserBuild = { channel: 'cdp', version: browser.version() };
    context = browser.contexts()[0] ?? await browser.newContext(contextOptions());
  } else if (args.backend === 'webgpu') {
    const l = await launchChromium(chromium, { headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
    browser = l.browser; result.browserBuild = { channel: l.channel, version: browser.version() };
    const probeCtx = await browser.newContext();
    const probePage = await probeCtx.newPage();
    const probeUrl = args.base + '__gpu_probe__';
    await probeCtx.route(probeUrl, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>gpu probe</title>' }));
    await probePage.goto(probeUrl);
    const info = await probePage.evaluate(async () => { if (!navigator.gpu) return { absent: true }; const a = await navigator.gpu.requestAdapter(); if (!a) return null; const i = a.info ?? {}; return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', description: i.description ?? '' }; });
    await probeCtx.close();
    result.adapterInfo = info;
    const software = !info || info.absent || /google|swiftshader/i.test(info.vendor) || /swiftshader/i.test(info.architecture);
    check(!software, 'NO_HARDWARE_WEBGPU', JSON.stringify(info));
    context = await browser.newContext(contextOptions());
  } else {
    const l = await launchChromium(chromium, { headless: true });
    browser = l.browser; result.browserBuild = { channel: l.channel, version: browser.version() };
    context = await browser.newContext(contextOptions());
  }

  const counter = makeNavCounter(context);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(`${new Date().toISOString().slice(11, 19)} ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => result.consoleErrors.push(`${new Date().toISOString().slice(11, 19)} pageerror: ${String(e && e.message).slice(0, 300)}`));

  const url = args.base + `?backend=${args.backend}&tier=${args.tier}` + (args.model ? `&model=${encodeURIComponent(args.model)}` : '') + (args.maxChunks !== null ? `&maxChunks=${args.maxChunks}` : '');
  log('goto', url);
  const since0 = counter.count();
  await page.goto(url);
  const isoTimeout = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(args.base) ? 5000 : 20000;
  result.crossOriginIsolated = await awaitIsolation(page, { counter, sinceNavigation: since0, maxExtraNavigations: 2, timeout: isoTimeout });
  result.navigations = counter.count();
  log('isolated', result.crossOriginIsolated, 'navigations', result.navigations);
  if (args.noSw && result.crossOriginIsolated === true) fail('NO_SW_ISOLATED', 'serviceWorkers: block but crossOriginIsolated is true');

  // ---- login (positive only) + caps
  const st0 = await login(page, { user: USER, pass: PASS });
  check(st0 === 'idle', 'UNSUPPORTED', `state after login ${st0}`);
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  const caps = await page.evaluate(() => { const c = window.__vs.caps; return c ? { backend: c.backend, threads: c.threads, hasGpu: c.hasGpu, adapterInfo: c.adapterInfo, software: c.software, isolated: c.isolated, policy: c.policy, f16: c.f16, sbs: c.sbs, hq: c.hq } : null; });
  result.caps = caps ? { backend: caps.backend, threads: caps.threads, hasGpu: caps.hasGpu, software: caps.software, isolated: caps.isolated, f16: caps.f16, sbs: caps.sbs, hq: caps.hq } : null;
  result.policy = caps ? caps.policy : null;
  if (caps && caps.adapterInfo) result.adapterInfo = caps.adapterInfo;
  result.isolatedAtCaps = await page.evaluate(() => crossOriginIsolated);
  result.locationSearch = await page.evaluate(() => location.search);
  log('caps', JSON.stringify(result.caps), 'policy', JSON.stringify(result.policy));
  const manifest = await readManifest(args.base);
  result.manifestVersion = manifest.version;
  const expectedModelId = args.model ?? manifest.tiers[args.tier]?.[args.backend === 'wasm' && mobile ? 'wasmLow' : args.backend];
  check(expectedModelId !== undefined, 'NO_MODEL_FOR_BACKEND', `tier ${args.tier} has no ${args.backend} model`);
  result.expectedModelId = expectedModelId;
  if (args.tier === 'hq') check(caps && caps.hq === true, 'HQ_NOT_OFFERED', JSON.stringify(result.caps));

  // ---- input (upload through the real file input) → decode
  const tIn = Date.now();
  await page.setInputFiles('#file-input', args.input);
  const inSt = await (async () => { for (;;) { const s = await page.evaluate(() => window.__vs.state); if (s === 'ready' || s === 'error') return s; if (Date.now() - tIn > 5 * 60 * 1000) fail('DECODE_TIMEOUT', `state ${s}`); await sleep(250); } })();
  result.wall.decodeMs = Date.now() - tIn;
  const inTimings = await page.evaluate(() => window.__vs.timings());
  const inInfo = await page.evaluate(() => { const i = window.__vs.input(); return i ? { duration: i.duration, length: i.length, sampleRate: i.sampleRate, blobSize: i.blob ? i.blob.size : null } : null; });
  result.input = { file: path.basename(args.input), state: inSt, probeMs: round(inTimings.probeMs, 1), probeKind: inTimings.probeKind ?? null, decodeMs: round(inTimings.decodeMs), ...(inInfo ?? {}), fileLine: await page.evaluate(() => document.getElementById('file-name').textContent) };
  if (inSt === 'error') { result.error = await page.evaluate(() => window.__vs.error); fail(result.error?.code ?? 'INPUT_ERROR', JSON.stringify(result.error)); }
  log('input', JSON.stringify(result.input));
  const n = inInfo.length;
  const model = manifest.models[expectedModelId];
  if (model.arch === 'mdx') {
    const plan = planMdx(n, model.params);
    const nonSkipped = plan.chunks.filter((c) => !c.skippable).length;
    result.expectedChunks = { planned: plan.chunks.length, nonSkipped, run: args.maxChunks !== null ? Math.min(args.maxChunks, nonSkipped) : nonSkipped, chunkSamples: plan.chunkSize, stepSamples: plan.step, stepSeconds: round(plan.step / 44100, 3) };
  } else {
    const p = model.params;
    result.expectedChunks = { nonSkipped: null, run: null, chunkSamples: p.chunkSamples, stepSamples: p.stepSamples, stepSeconds: round(p.stepSamples / 44100, 3), estimate: Math.ceil(n / p.stepSamples) };
  }

  // ---- model select (+ the 降噪 interaction the user may have hit: tick 降噪, then pick 高质量)
  await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('#model-select option')).map((o) => o.value));
  check(options.includes(args.tier), 'TIER_NOT_OFFERED', `options ${options.join(',')}`);
  if (args.denoiseThenHq) {
    await page.selectOption('#model-select', 'standard');
    await page.check('#denoise');
    const before = await page.evaluate(() => ({ checked: document.getElementById('denoise').checked, disabled: document.getElementById('denoise').disabled }));
    await page.selectOption('#model-select', args.tier);
    const after = await page.evaluate(() => ({ checked: document.getElementById('denoise').checked, disabled: document.getElementById('denoise').disabled, select: document.getElementById('model-select').value }));
    result.denoiseCheckbox = { beforeSelectingHq: before, afterSelectingHq: after };
    log('denoise checkbox', JSON.stringify(result.denoiseCheckbox));
  } else {
    await page.selectOption('#model-select', args.tier);
    result.denoiseCheckbox = await page.evaluate(() => ({ checked: document.getElementById('denoise').checked, disabled: document.getElementById('denoise').disabled, select: document.getElementById('model-select').value }));
  }

  // ---- start + telemetry loop
  const memSeries = [];
  const procMem = !cdpUp ? startProcessMemoryPoller({ sinceMs: launchedAtMs, intervalMs: args.memIntervalMs, onSample: (s) => memSeries.push(s) }) : null;
  const t0 = Date.now();
  result.wall.startedAt = new Date(t0).toISOString();
  await page.click('#start');
  let lastKey = null, lastAdvanceAt = t0, lastChunkIndex = null, lastHeapAt = 0, lastLogAt = 0, stallOpen = null, encodingStartedAt = null;
  const chunkDeltas = [];
  let finalState = null;
  for (;;) {
    const snap = await page.evaluate(() => ({ state: window.__vs.state, text: document.getElementById('progress').textContent, backendLine: document.getElementById('backend-line').textContent, error: window.__vs.error, heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null }));
    const nowMs = Date.now();
    const rel = nowMs - t0;
    // stage key = the progress line without its counters (seconds, MP3 percentages, download bytes) → one entry per stage
    const stageKey = `${snap.state}|${snap.text.replace(/ · \d+s$/, '').replace(/\d+%/g, 'N%').replace(/[\d.]+ MB/g, 'N MB')}`;
    if (stageKey !== lastKey) {
      const m = /分离中 (\d+)\/(\d+) 段/.exec(snap.text);
      if (m) {
        const idx = Number(m[1]), count = Number(m[2]);
        if (idx !== lastChunkIndex) {
          if (lastChunkIndex !== null && result.chunkEvents.length) chunkDeltas.push(rel - result.chunkEvents[result.chunkEvents.length - 1].atMs);
          result.chunkEvents.push({ index: idx, count, atMs: rel, text: snap.text });
          lastChunkIndex = idx;
          if (idx === 11 || idx === Math.floor(count / 2) + 1 || idx === count) log('progress', snap.text, 'wall', mmss(rel), 'mem', memSeries.length ? `${(memSeries[memSeries.length - 1].priv / 1e9).toFixed(2)} GB` : 'n/a');
        }
      } else {
        result.stages.push({ state: snap.state, text: snap.text, atMs: rel, backendLine: snap.backendLine });
        log('stage', snap.state, snap.text, 'wall', mmss(rel));
        if (snap.state === 'encoding' && encodingStartedAt === null) encodingStartedAt = rel;
      }
      lastKey = stageKey;
      lastAdvanceAt = nowMs;
      if (stallOpen) { stallOpen.recovered = true; stallOpen.recoveredAfterMs = nowMs - stallOpen.sinceAbs; stallOpen = null; }
    }
    if (nowMs - lastHeapAt >= 5000 && snap.heap) { result.pageHeap.push({ atMs: rel, usedMB: round(snap.heap.used / 1e6), totalMB: round(snap.heap.total / 1e6) }); lastHeapAt = nowMs; }
    if (nowMs - lastLogAt >= 60000) { lastLogAt = nowMs; log('tick', snap.state, snap.text, 'wall', mmss(rel), 'mem', memSeries.length ? `${(memSeries[memSeries.length - 1].priv / 1e9).toFixed(2)} GB` : 'n/a'); }
    if (snap.state === 'done' || snap.state === 'error') { finalState = snap.state; result.error = snap.error; break; }
    // stall rule: separating → max(60 s, 3 × median chunk delta) with no chunk advance; other busy stages → 5 min with no change
    const medDelta = chunkDeltas.length >= 3 ? median(chunkDeltas) : null;
    const threshold = snap.state === 'separating' ? Math.max(60000, medDelta !== null ? 3 * medDelta : 60000 * 5) : 5 * 60000;
    if (!stallOpen && nowMs - lastAdvanceAt > threshold) {
      stallOpen = { state: snap.state, text: snap.text, atMs: rel, sinceAbs: lastAdvanceAt, silentMs: nowMs - lastAdvanceAt, thresholdMs: threshold, medianChunkDeltaMs: round(medDelta), heap: snap.heap, consoleErrors: result.consoleErrors.slice(-10), vsError: snap.error, backend: await page.evaluate(() => window.__vs.backend), memPrivBytes: memSeries.length ? memSeries[memSeries.length - 1].priv : null, recovered: false };
      result.stalls.push(stallOpen);
      log('STALL?', JSON.stringify({ state: snap.state, text: snap.text, silentMs: stallOpen.silentMs, thresholdMs: threshold }));
    }
    if (rel > JOB_TIMEOUT_MS) { finalState = 'timeout'; break; }
    await sleep(250);
  }
  const tEnd = Date.now();
  result.wall.totalMs = tEnd - t0;
  result.wall.totalMmss = mmss(result.wall.totalMs);
  result.wall.encodingMs = encodingStartedAt !== null ? tEnd - t0 - encodingStartedAt : null;
  result.state = finalState;
  if (procMem) {
    const m = await procMem.stop();
    const series = memSeries.map((s) => ({ atMs: s.atMs - t0, privMB: round(s.priv / 1e6), wsMB: round(s.ws / 1e6) }));
    const privs = series.map((s) => s.privMB);
    const q = Math.max(1, Math.floor(series.length / 4));
    result.memory = {
      peakPrivateBytes: m.peakPrivateBytes, peakPrivateGB: round((m.peakPrivateBytes ?? 0) / 1e9, 2), peakWorkingSetBytes: m.peakWorkingSetBytes, samples: m.samples, intervalMs: args.memIntervalMs, label: m.label, error: m.error,
      firstQuarterMedianMB: series.length ? round(median(privs.slice(0, q))) : null, lastQuarterMedianMB: series.length ? round(median(privs.slice(-q))) : null,
      series,
    };
    log('memory', JSON.stringify({ peakGB: result.memory.peakPrivateGB, samples: m.samples, q1: result.memory.firstQuarterMedianMB, q4: result.memory.lastQuarterMedianMB }));
  }
  const t = await page.evaluate(() => window.__vs.timings());
  result.timings = { ...t, chunkMs: Array.isArray(t.chunkMs) ? t.chunkMs.map((x) => Math.round(x)) : t.chunkMs };
  result.chunkTrend = Array.isArray(t.chunkMs) ? trendOf(t.chunkMs) : null;
  result.chunkEventDeltas = { count: chunkDeltas.length, medianMs: round(median(chunkDeltas)), maxMs: chunkDeltas.length ? round(Math.max(...chunkDeltas)) : null };
  result.ran = { backend: t.backend ?? null, modelId: t.modelId ?? null, tier: t.tier ?? null, threads: t.threads ?? null, fellBack: t.fellBack ?? null, denoise: t.denoise ?? null };
  result.backendLine = await page.evaluate(() => document.getElementById('backend-line').textContent);
  result.progressLineAtEnd = await page.evaluate(() => document.getElementById('progress').textContent);
  log('state', finalState, 'wall', result.wall.totalMmss, 'ran', JSON.stringify(result.ran), 'trend', JSON.stringify(result.chunkTrend));
  if (finalState === 'error') fail(result.error?.code ?? 'JOB_ERROR', JSON.stringify(result.error));
  if (finalState === 'timeout') fail('JOB_TIMEOUT', `still ${result.progressLineAtEnd} after ${result.wall.totalMmss}`);
  result.finished = true;

  // ---- assertions on what ran
  check(t.backend === args.backend, 'BACKEND_MISMATCH', `expected ${args.backend}, ran ${t.backend}`);
  check(t.modelId === expectedModelId, 'MODEL_MISMATCH', `expected ${expectedModelId}, ran ${t.modelId}`);
  check(t.fellBack === false, 'UNEXPECTED_FALLBACK');
  if (result.isolatedAtCaps === false) check(t.threads === 1, 'THREADS', `not isolated but threads ${t.threads}`);
  if (args.noSw) check(t.threads === 1, 'NO_SW_THREADS', `threads ${t.threads}`);
  const lastEvt = result.chunkEvents[result.chunkEvents.length - 1];
  result.progressChunkCount = lastEvt ? lastEvt.count : null;
  if (model.arch === 'mdx' && result.expectedChunks) {
    check(t.chunkMs.length === result.expectedChunks.run, 'CHUNK_COUNT', `ran ${t.chunkMs.length} chunks, expected ${result.expectedChunks.run}`);
    if (args.maxChunks === null) check(result.progressChunkCount === t.chunkMs.length, 'PROGRESS_COUNT', `progress said ${result.progressChunkCount}, engine ran ${t.chunkMs.length}`);
  }

  // ---- outputs: stems (length + in-page stats), MP3 frames, download event
  result.stemStats = await page.evaluate(() => {
    const st = window.__vs.stems();
    const stat = (a) => { let p = 0, s = 0, bad = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== v || v === Infinity || v === -Infinity) { bad++; continue; } const x = Math.abs(v); if (x > p) p = x; s += v * v; } return { length: a.length, peak: Number(p.toFixed(4)), rms: Number(Math.sqrt(s / a.length).toFixed(5)), nonFinite: bad }; };
    return { vocalsL: stat(st[0]), vocalsR: stat(st[1]), instL: stat(st[2]), instR: stat(st[3]) };
  });
  check(Math.abs(result.stemStats.vocalsL.length - n) <= 1, 'STEM_LENGTH', `${result.stemStats.vocalsL.length} vs decoded ${n}`);
  const mp3v = await readMp3(page, 'vocals');
  const mp3i = await readMp3(page, 'instrumental');
  check(mp3v && mp3i, 'MP3_MISSING');
  result.mp3 = { vocals: checkMp3(mp3v, n, 'vocals'), instrumental: checkMp3(mp3i, n, 'instrumental'), encodeMs: t.encodeMs ?? null, ok: false };
  result.mp3.ok = result.mp3.vocals.ok && result.mp3.instrumental.ok;
  const anchor = await page.evaluate(() => { const a = document.getElementById('dl-vocals-mp3'); return { disabled: a.getAttribute('aria-disabled'), download: a.getAttribute('download'), text: a.textContent }; });
  result.download = { anchor, eventOk: false, suggestedFilename: null, size: null, error: null };
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#dl-vocals-mp3')]);
    result.download.suggestedFilename = dl.suggestedFilename();
    const p = await dl.path();
    result.download.size = p ? fs.statSync(p).size : null;
    result.download.eventOk = result.download.size === mp3v.byteLength;
  } catch (e) { result.download.error = String(e && e.message).slice(0, 200); }
  log('mp3', JSON.stringify({ ok: result.mp3.ok, vocals: result.mp3.vocals, inst: result.mp3.instrumental, encodeMs: t.encodeMs, download: result.download }));

  // ---- first-period check vs audio-separator's clip25 stems (informational; the input must be clip25 × N for this to mean anything)
  if (!args.noSnr && model.arch === 'mdx' && args.maxChunks === null) {
    try {
      const refs = referenceStems(t.modelId);
      const rv = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
      const ri = readWav(new Uint8Array(fs.readFileSync(refs.instrumental)));
      // chunks whose range ends before trim + 1,102,500 see identical audio in clip25 and clip25×N; the first differing
      // chunk is k = 5 (start 5·195,840 = 979,200) for both geometries → samples before 979,200 − trim are comparable
      const W = 970000;
      const ours = [await readStemPrefix(page, 0, W), await readStemPrefix(page, 1, W), await readStemPrefix(page, 2, W), await readStemPrefix(page, 3, W)];
      const v = snrPeakNormalizedDb(rv.left.subarray(0, W), rv.right.subarray(0, W), ours[0], ours[1], 0.9);
      const i = snrPeakNormalizedDb(ri.left.subarray(0, W), ri.right.subarray(0, W), ours[2], ours[3], 0.9);
      result.firstPeriodSnr = { samples: W, seconds: round(W / 44100, 2), vocalsDb: round(v.db, 2), instDb: round(i.db, 2), reference: path.basename(refs.vocals), bar: 25, pass: v.db >= 25 && i.db >= 25, formula: 'peak-normalized (0.9) stereo SNR over the first 970,000 samples vs audio-separator clip25 stems' };
      log('firstPeriodSnr', JSON.stringify(result.firstPeriodSnr));
    } catch (e) { result.firstPeriodSnr = { skipped: String(e && e.message).slice(0, 200) }; }
  }

  try { await page.screenshot({ path: path.join(path.dirname(outFile), `long_run_${label}.png`), fullPage: false }); } catch (e) { log('screenshot failed', e.message); }
  result.ok = true;
  exitCode = 0;
  log('PASS', label);
} catch (e) {
  result.ok = false;
  result.failure = { code: e && e.code ? e.code : 'ERROR', message: String(e && e.message).slice(0, 2000) };
  console.error('[long] FAIL', result.failure.code, result.failure.message);
  if (!(e && e.code)) console.error(e && e.stack);
  exitCode = 1;
} finally {
  writeOut();
  try { if (context && !cdpUp) await context.close(); } catch { /* ignore */ }
  try { if (browser && !cdpUp) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
