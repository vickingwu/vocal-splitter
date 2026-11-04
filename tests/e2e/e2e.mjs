// tests/e2e/e2e.mjs — browser E2E harness (design §16.C, §22.6, §23.6; design_accepted DA-1, DA-2, DA-4).
//   node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm|webgpu [--tier standard|hq] [--model <id>]
//        [--fixture clip25|clip25_48k] [--browser chromium|webkit] [--device "<name>"] [--cdp http://127.0.0.1:9222]
//        [--retry] [--expect-fallback <reason>] [--no-sw] [--no-webgpu] [--out ../evidence/e2e_<tag>.json]
// --expect-fallback <reason> (DA-1): the page is loaded with ?backend=webgpu in the requested browser; the run must end on
//   WASM with fellBack === true, the wasm model for the device, exactly one console.error 'webgpu-fallback <reason>'.
// --no-sw (DA-2 / A48): the context blocks service workers → no isolation, 1 thread, no reload.
// --no-webgpu (Chromium): launch with --disable-blink-features=WebGPU so navigator.gpu is absent in page and worker.
// --tier hq (§15 Tier 2): no audio-separator reference exists, so instead of the SNR gate the run records the gate (c) inputs
//   (per-window ms, median ≤ 30 s, backend that ran), writes the stems as float32 WAVs next to --out, and computes (b-vocal)
//   vs the Voc_FT vocals over evidence/ref_tier2/window.json's window plus the GPU-vs-CPU-EP agreement (result.hq).
// Mobile runs (--device with an iPhone/iPad UA) add the §22.6 layout/policy/keep-awake/download assertions; WebKit-only
// failures (A41) are recorded in webkitIssues with the login/layout results that did pass.
// Credentials come ONLY from VS_TEST_USER / VS_TEST_PASS in the environment; they are never written anywhere.
import fs from 'node:fs';
import path from 'node:path';
// --no-webgpu rewrites worker.mjs and --dead-source aborts a model source: requests issued through the coi service worker,
// which Playwright routes only with this flag.
if (process.argv.includes('--no-webgpu') || process.argv.includes('--dead-source')) process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium, webkit, devices } = await import('playwright');
import { makeNavCounter, awaitIsolation, startServerIfNeeded, readManifest, sleep, layoutCheck, startMemoryPoller, startProcessMemoryPoller, launchChromium } from '../lib/e2e-helpers.mjs';
import { b64ToF32, b64ToU8 } from '../lib/b64.mjs';
import { fixturePath, referenceStems, repoRoot, evidenceDir } from '../lib/fixtures.mjs';
import { readWav } from '../../site/src/engine/wav.mjs';
import { walk, mpegDuration } from '../../site/src/engine/mp3frames.mjs';
import { snrStereoDb, snrPeakNormalizedDb } from '../lib/snr.mjs';
import { writeWavF32 } from '../lib/wavf32.mjs';

// ------------------------------------------------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const args = {
  base: arg('--base', 'http://127.0.0.1:8010/'),
  backend: arg('--backend', 'wasm'),
  tier: arg('--tier', 'standard'),
  model: arg('--model', undefined),
  fixture: arg('--fixture', 'clip25'),
  browser: arg('--browser', 'chromium'),
  device: arg('--device', undefined),
  cdp: arg('--cdp', undefined),
  retry: flag('--retry'),
  out: arg('--out', undefined),
  expectFallback: arg('--expect-fallback', undefined),
  noSw: flag('--no-sw'),
  noWebgpu: flag('--no-webgpu'),
  // FIX-2: --sources <csv> pins the download sources (?sources= hook); --dead-source <id> aborts every request to that
  // manifest source so the probe must exclude it and the download must fall back; --import feeds models_src/<file> through
  // the 离线导入 control before 开始 and asserts the loader used no network.
  sources: arg('--sources', undefined),
  deadSource: arg('--dead-source', undefined),
  import: flag('--import'),
};
if (!args.base.endsWith('/')) args.base += '/';
if (!['wasm', 'webgpu'].includes(args.backend)) { console.error(`BAD_ARG: --backend ${args.backend}`); process.exit(2); }
if (!['standard', 'hq'].includes(args.tier)) { console.error(`BAD_ARG: --tier ${args.tier}`); process.exit(2); }
if (!['clip25', 'clip25_48k'].includes(args.fixture)) { console.error(`BAD_ARG: --fixture ${args.fixture}`); process.exit(2); }
if (!['chromium', 'webkit'].includes(args.browser)) { console.error(`BAD_ARG: --browser ${args.browser}`); process.exit(2); }
if (args.device && !devices[args.device]) { console.error(`BAD_ARG: unknown device "${args.device}"`); process.exit(2); }
if (flag('--expect-fallback') && !args.expectFallback) { console.error('BAD_ARG: --expect-fallback needs a reason (e.g. no-gpu-in-worker)'); process.exit(2); }
if (args.expectFallback && args.backend !== 'webgpu') { console.error('BAD_ARG: --expect-fallback requires --backend webgpu (the override that the worker falls back from)'); process.exit(2); }
if (args.expectFallback && args.cdp) { console.error('BAD_ARG: --expect-fallback cannot be combined with --cdp'); process.exit(2); }
if (args.noWebgpu && (args.browser !== 'chromium' || args.cdp)) { console.error('BAD_ARG: --no-webgpu is a Chromium launch flag (--disable-blink-features=WebGPU)'); process.exit(2); }

const USER = process.env.VS_TEST_USER;
const PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS in the environment'); process.exit(2); }

const tag = args.out ? path.basename(args.out).replace(/^e2e_/, '').replace(/\.json$/, '') : `${args.browser}_${args.backend}`;
const outFile = args.out ? path.resolve(args.out) : path.resolve(repoRoot, '..', 'evidence', `e2e_${tag}.json`);
const mobile = args.device !== undefined && /iPhone|iPad/.test(devices[args.device].userAgent);
// The backend the run must END on: the requested one, or wasm after an expected fallback.
const finalBackend = args.expectFallback ? 'wasm' : args.backend;
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const SNR_THRESHOLD = args.fixture === 'clip25' ? 25 : 20;
const SNR_LABEL = args.fixture === 'clip25' ? 'parity' : 'resample_smoke';
const EXPECTED_SAMPLES = 1102500;
const MP3_SLACK = 576 + 2 * 1152;
const LAYOUT_WIDTHS = args.device ? [devices[args.device].viewport.width, 375] : [];

const log = (...a) => console.log('[e2e]', ...a);
const fail = (code, msg) => { const e = new Error(`${code}: ${msg ?? ''}`); e.code = code; throw e; };
const check = (cond, code, msg) => { if (!cond) fail(code, msg); };

// ---------------------------------------------------------------------------------------------------------- page helpers
const evalState = (page) => page.evaluate(() => window.__vs.state);
const evalVs = (page) => page.evaluate(() => ({ state: window.__vs.state, loggedIn: window.__vs.loggedIn, error: window.__vs.error, backend: window.__vs.backend, isolated: window.__vs.isolated }));
const token = (page) => page.evaluate(() => { try { return localStorage.getItem('vs-session'); } catch { return 'EXC'; } });
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const st = getComputedStyle(el); return !el.hidden && st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null; }, sel);
const textOf = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? (el.textContent || '') : null; }, sel);

// After 退出 the page reloads (clearSession + location.reload()); poll until the NEW document reports locked, tolerating the
// evaluate that lands in the old document mid-navigation.
async function waitLocked(page, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await evalState(page)) === 'locked' && (await token(page)) === null) return true; } catch { /* navigating */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(250);
  }
}

async function waitForJob(page, { timeout, onTick, interval = 500 }) {
  const t0 = Date.now();
  for (;;) {
    const st = await evalState(page);
    if (onTick) await onTick(st);
    if (st === 'done' || st === 'error') return st;
    if (Date.now() - t0 > timeout) fail('JOB_TIMEOUT', `state ${st} after ${Math.round((Date.now() - t0) / 1000)} s`);
    await sleep(interval);
  }
}

const B64_PAGE = `(u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }`;
async function readStem(page, index) {
  const b64 = await page.evaluate(({ index, enc }) => {
    const a = window.__vs.stems()[index];
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    return (new Function('return ' + enc)())(u8);
  }, { index, enc: B64_PAGE });
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

function snrOfStems(modelId, stems) {
  const ref = referenceStems(modelId);
  const rv = readWav(new Uint8Array(fs.readFileSync(ref.vocals)));
  const ri = readWav(new Uint8Array(fs.readFileSync(ref.instrumental)));
  return {
    vocalsDb: snrStereoDb(rv.left, rv.right, stems[0], stems[1]),
    instDb: snrStereoDb(ri.left, ri.right, stems[2], stems[3]),
  };
}

// §15 Tier 2 run (--tier hq): there is no audio-separator reference for the melroformer model, so the run records the gate
// (c) inputs (per-window ms, median ≤ 30 s, backend that ran), writes the stems next to the JSON (float32 WAV) and computes
// from them (b-vocal, no NoVox) vs the Voc_FT vocals over the window of evidence/ref_tier2/window.json (same formula as
// roformer_parity.test.mjs) plus the agreement with the CPU-EP stems written by that test (GPU vs CPU, informational).
function hqEvaluate(t, stems, tagName) {
  const chunkMs = Array.isArray(t.chunkMs) ? t.chunkMs.slice() : [];
  const sorted = chunkMs.slice().sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const out = {
    gateC: { windowCount: chunkMs.length, windowMs: chunkMs.map(Math.round), medianWindowMs: median === null ? null : Math.round(median), maxWindowMs: chunkMs.length ? Math.round(Math.max(...chunkMs)) : null, budgetMs: 30000, backend: t.backend, pass: median !== null && median <= 30000 && t.backend === 'webgpu', formula: 'median(timings.chunkMs) ≤ 30000 ms AND timings.backend === webgpu' },
    stems: {}, bVocal: null, gpuVsCpu: null, vsVocFt: null,
  };
  const dir = path.dirname(outFile);
  const files = { vocals: path.join(dir, `e2e_${tagName}_vocals.wav`), instrumental: path.join(dir, `e2e_${tagName}_inst.wav`) };
  writeWavF32(files.vocals, stems[0], stems[1]);
  writeWavF32(files.instrumental, stems[2], stems[3]);
  out.stems = { vocals: path.basename(files.vocals), instrumental: path.basename(files.instrumental), samples: stems[0].length, format: 'float32 WAV 44.1 kHz stereo' };
  const windowFile = path.join(evidenceDir, 'ref_tier2', 'window.json');
  let refs = null;
  try { refs = referenceStems('uvr_mdx_voc_ft'); } catch { refs = null; }
  if (refs) {
    const asV = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
    const asI = readWav(new Uint8Array(fs.readFileSync(refs.instrumental)));
    out.vsVocFt = { vocalsDb: snrPeakNormalizedDb(asV.left, asV.right, stems[0], stems[1]).db, instDb: snrPeakNormalizedDb(asI.left, asI.right, stems[2], stems[3]).db, note: 'informational: whole clip vs Voc_FT, both peak-normalized to 0.9' };
    if (fs.existsSync(windowFile)) {
      const win = JSON.parse(fs.readFileSync(windowFile, 'utf8').replace(/^\uFEFF/, ''));
      const s = win.windowStart, L = win.windowLen;
      const b = snrPeakNormalizedDb(asV.left.slice(s, s + L), asV.right.slice(s, s + L), stems[0].slice(s, s + L), stems[1].slice(s, s + L), 0.9);
      out.bVocal = { db: b.db, bar: 10, windowStart: s, windowLen: L, reference: path.basename(refs.vocals), pass: b.db >= 10, formula: "dB(ref_as′, ref_as′ − ours_voc′), both peak-normalized to 0.9 over the window" };
    } else out.bVocal = { skipped: `window.json missing (${windowFile})` };
  } else out.vsVocFt = { skipped: 'Voc_FT reference stems missing' };
  const cpuV = path.join(evidenceDir, 'ref_tier2', 'clip25_cpu_vocals.wav');
  const cpuI = path.join(evidenceDir, 'ref_tier2', 'clip25_cpu_inst.wav');
  if (fs.existsSync(cpuV) && fs.existsSync(cpuI)) {
    const v = readWav(new Uint8Array(fs.readFileSync(cpuV)));
    const i = readWav(new Uint8Array(fs.readFileSync(cpuI)));
    out.gpuVsCpu = { vocalsDb: snrStereoDb(v.left, v.right, stems[0], stems[1]), instDb: snrStereoDb(i.left, i.right, stems[2], stems[3]), reference: 'ref_tier2/clip25_cpu_*.wav (roformer_parity.test.mjs, onnxruntime-node CPU EP)', formula: 'raw SNR = 10·log10(Σcpu² / Σ(cpu − gpu)²)' };
  } else out.gpuVsCpu = { skipped: 'CPU-EP stems missing (run tests/parity/roformer_parity.test.mjs first)' };
  return out;
}

function checkMp3(bytes, inputSamples, label) {
  const w = walk(bytes);
  check(w.junkBytes === 0, 'MP3_JUNK', `${label}: ${w.junkBytes} junk bytes`);
  check(w.frames.length > 0, 'MP3_NO_FRAMES', label);
  for (const f of w.frames) {
    const b2 = bytes[f.offset + 1], b3 = bytes[f.offset + 2], b4 = bytes[f.offset + 3];
    check(bytes[f.offset] === 0xFF && (b2 & 0xE0) === 0xE0, 'MP3_SYNC', label);
    check(((b2 >> 3) & 3) === 3, 'MP3_VERSION', `${label}: not MPEG-1 at ${f.offset}`);
    check(((b2 >> 1) & 3) === 1, 'MP3_LAYER', `${label}: not Layer III at ${f.offset}`);
    check((b3 >> 4) === 0xE, 'MP3_BITRATE', `${label}: not 320 kbps at ${f.offset}`);
    check(((b3 >> 2) & 3) === 0, 'MP3_SAMPLERATE', `${label}: not 44.1 kHz at ${f.offset}`);
    check(((b4 >> 6) & 3) === 0, 'MP3_MODE', `${label}: not stereo at ${f.offset}`);
  }
  const d = mpegDuration(bytes);
  check(d !== null, 'MP3_DURATION_NULL', label);
  const delta = Math.round(d.seconds * 44100) - inputSamples;
  check(delta >= 0 && delta <= MP3_SLACK, 'MP3_DURATION', `${label}: Δ ${delta} samples outside [0, ${MP3_SLACK}]`);
  return { frames: w.frames.length, durationS: d.seconds, deltaSamples: delta, bytes: bytes.length };
}

// §22.6 layout assertions at every configured width; restores the device viewport afterwards. Returns the violations found.
async function layoutAt(page, label, layout) {
  if (!args.device) return;
  const base = devices[args.device].viewport;
  for (const width of LAYOUT_WIDTHS) {
    if (width !== base.width) await page.setViewportSize({ width, height: 667 });
    const r = await layoutCheck(page);
    layout.checks.push({ label, width, ...r });
    for (const v of r.violations) layout.violations.push({ label, width, ...v });
    if (width !== base.width) await page.setViewportSize(base);
  }
}

// ------------------------------------------------------------------------------------------------------------ main
const result = {
  base: args.base,
  requested: { backend: args.backend, tier: args.tier, model: args.model ?? null, fixture: args.fixture, browser: args.browser, device: args.device ?? null, retry: args.retry, expectFallback: args.expectFallback ?? null, noSw: args.noSw, noWebgpu: args.noWebgpu, cdp: args.cdp ?? null, sources: args.sources ?? null, deadSource: args.deadSource ?? null, import: args.import },
  ran: null, crossOriginIsolated: null, navigations: null, adapterInfo: null, cdpInfo: null,
  login: { negativeOk: false, persistedOk: false, logoutOk: false, hrefUnchanged: false, noPreLoginRequests: false },
  layout: null, policy: null, snr: null, hq: null, mp3: null, timings: null, retry: null, consoleErrors: [], webkitIssues: [], ignoredOptions: [],
  memoryPeakBytes: null, memorySamples: 0, memoryLabel: null, date: new Date().toISOString(),
};
let server = null, browser = null, context = null, exitCode = 1, cdpUp = false;
const launchedAtMs = Date.now() - 5000;
const writeOut = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8'); log('wrote', outFile); };
const contextOptions = () => ({ ...(args.device ? devices[args.device] : { viewport: { width: 1280, height: 900 } }), acceptDownloads: true, ...(args.noSw ? { serviceWorkers: 'block' } : {}) });

try {
  server = await startServerIfNeeded(args.base);
  log('server', server.started ? 'started by the harness' : 'already answering', args.base);

  // ---- browser selection (§16.C): --cdp is probed ONCE (3 s); when it is down the webgpu run falls back to headless Chromium
  if (args.cdp) {
    let ok = false, versionInfo = null;
    try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000); const r = await fetch(new URL('/json/version', args.cdp).href, { signal: ac.signal }); clearTimeout(t); ok = r.ok; if (ok) versionInfo = await r.json(); } catch { ok = false; }
    cdpUp = ok;
    result.cdpInfo = { url: args.cdp, up: ok, browser: versionInfo?.Browser ?? null, userAgent: versionInfo?.['User-Agent'] ?? null };
    log('cdp', JSON.stringify(result.cdpInfo));
    if (!ok) log(`${args.cdp}/json/version did not answer within 3 s — falling back to headless Chromium`);
  }
  if (cdpUp) {
    browser = await chromium.connectOverCDP(args.cdp);
    result.browserBuild = { channel: 'cdp', version: browser.version() };
    context = browser.contexts()[0] ?? await browser.newContext(contextOptions());
  } else if (args.backend === 'webgpu' && !args.expectFallback) {
    const l = await launchChromium(chromium, { headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
    browser = l.browser; result.browserBuild = { channel: l.channel, version: browser.version() };
    // navigator.gpu needs a secure context (about:blank is not one), so the adapter probe runs on a blank same-origin page
    // served by a route under the base URL — no coi script, no reload.
    const probeCtx = await browser.newContext();
    const probePage = await probeCtx.newPage();
    const probeUrl = args.base + '__gpu_probe__';
    await probeCtx.route(probeUrl, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>gpu probe</title>' }));
    await probePage.goto(probeUrl);
    const info = await probePage.evaluate(async () => { if (!navigator.gpu) return { absent: true }; const a = await navigator.gpu.requestAdapter(); if (!a) return null; const i = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : {}); return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', description: i.description ?? '' }; });
    await probeCtx.close();
    result.adapterInfo = info;
    const software = !info || info.absent || /google|swiftshader/i.test(info.vendor) || /swiftshader/i.test(info.architecture);
    if (software) {
      result.webgpu = 'not exercised (software adapter)';
      result.ok = null;
      writeOut();
      await browser.close();
      server.stop();
      process.exit(0);
    }
    context = await browser.newContext(contextOptions());
  } else if (args.browser === 'webkit') {
    browser = await webkit.launch({ headless: true });
    result.browserBuild = { channel: 'webkit', version: browser.version() };
    context = await browser.newContext(contextOptions());
  } else {
    const l = await launchChromium(chromium, { headless: true });
    browser = l.browser; result.browserBuild = { channel: l.channel, version: browser.version(), noWebgpu: args.noWebgpu };
    context = await browser.newContext(contextOptions());
    if (args.noWebgpu) {
      // --no-webgpu hides navigator.gpu INSIDE the worker (the iOS-Safari shape that WebKit-on-Windows cannot run to
      // completion here — no WebAudio, A41): worker.mjs is served with a test-only prefix that masks WorkerNavigator.gpu.
      // Chromium 156 ignores --disable-blink-features=WebGPU, and the request is made by the coi service worker, which
      // Playwright only routes with PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 (set above).
      const HIDE_GPU = "try { Object.defineProperty(WorkerNavigator.prototype, 'gpu', { get: () => undefined, configurable: true }); } catch (e) {} // e2e --no-webgpu: hide WebGPU in the worker\n";
      result.noWebgpu = { intercepted: 0, method: 'worker.mjs served with a WorkerNavigator.prototype.gpu → undefined prefix (route via PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS)' };
      await context.route((u) => /\/worker\.mjs(\?.*)?$/.test(u.href), async (route) => {
        const resp = await route.fetch();
        const body = await resp.text();
        result.noWebgpu.intercepted++;
        await route.fulfill({ response: resp, body: HIDE_GPU + body, headers: { ...resp.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
      });
    }
  }

  const counter = makeNavCounter(context);
  const page = await context.newPage();
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => result.consoleErrors.push('pageerror: ' + String(e && e.message).slice(0, 300)));
  const layout = args.device ? { ok: false, widths: LAYOUT_WIDTHS, violations: [], checks: [] } : null;
  result.layout = layout;

  const url = args.base + `?backend=${args.backend}&tier=${args.tier}` + (args.model ? `&model=${encodeURIComponent(args.model)}` : '') + (args.sources ? `&sources=${encodeURIComponent(args.sources)}` : '');
  // --dead-source: every request to that source's host (chunk mirror base or whole-file URL) is aborted at the network layer
  const manifestForRoutes = await readManifest(args.base);
  let deadRouted = 0;
  if (args.deadSource) {
    const bases = new Set();
    for (const m of Object.values(manifestForRoutes.models)) for (const s of m.sources ?? []) {
      if (s.id !== args.deadSource) continue;
      if (s.kind === 'chunks') bases.add(s.base); else for (const u of Object.values(s.urls)) bases.add(u);
    }
    check(bases.size > 0, 'DEAD_SOURCE_UNKNOWN', `no manifest source with id ${args.deadSource}`);
    const prefixes = [...bases];
    await context.route((u) => prefixes.some((p) => u.href.startsWith(p)), (route) => { deadRouted++; route.abort('connectionrefused'); });
    result.deadSource = { id: args.deadSource, prefixes };
  }
  log('goto', url);
  const since0 = counter.count();
  await page.goto(url);
  // the live site installs the service worker over the network, so the isolation wait is longer there than locally
  const isoTimeout = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(args.base) ? 5000 : 20000;
  result.crossOriginIsolated = await awaitIsolation(page, { counter, sinceNavigation: since0, maxExtraNavigations: 2, timeout: isoTimeout });
  result.navigations = counter.count();
  log('isolated', result.crossOriginIsolated, 'navigations', result.navigations);
  // DA-2: without a service worker there is nothing to reload for; Chromium must not isolate. WebKit ignoring the block
  // (A44) is recorded, not failed, and the run then continues as an ordinary isolated run.
  let noSwActive = false;
  if (args.noSw) {
    if (result.crossOriginIsolated === true) {
      check(args.browser === 'webkit', 'NO_SW_ISOLATED', 'serviceWorkers: block but crossOriginIsolated is true');
      result.ignoredOptions.push('serviceWorkers: block (context still cross-origin isolated)');
      log('WebKit ignored serviceWorkers: block — continuing as an isolated run');
    } else {
      noSwActive = true;
      check(result.navigations - since0 === 1, 'NO_SW_RELOAD', `${result.navigations - since0} navigations without a service worker`);
    }
  }
  if (layout) await layoutAt(page, 'login', layout);

  // ---- login gate (§23): negative case first
  check(await evalState(page) === 'locked', 'STATE', 'expected locked after load');
  check(await visible(page, '#login'), 'LOGIN_HIDDEN', '#login must be visible');
  check(!(await visible(page, '#app')), 'APP_VISIBLE', '#app must be hidden before login');
  const urlBeforeSubmit = page.url();
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', PASS + 'x');
  await page.press('#login-pass', 'Enter');
  await page.waitForFunction(() => (document.getElementById('login-error').textContent || '').length > 0, null, { timeout: 30000 });
  const loginErr = await page.evaluate(() => document.getElementById('login-error').textContent);
  check(loginErr === '账号或密码错误', 'LOGIN_COPY', `got ${JSON.stringify(loginErr)}`);
  const vsNeg = await evalVs(page);
  check(vsNeg.state === 'locked', 'STATE', `after a wrong password: ${vsNeg.state}`);
  check(vsNeg.error && vsNeg.error.code === 'LOGIN_FAILED', 'ERROR_CODE', JSON.stringify(vsNeg.error));
  check(await token(page) === null, 'TOKEN', 'no session token after a failed login');
  const preLogin = urls.filter((u) => u.includes('models/') || u.includes('worker.mjs'));
  check(preLogin.length === 0, 'PRELOGIN_REQUEST', preLogin.join(', '));
  result.login.noPreLoginRequests = true;
  result.login.hrefUnchanged = page.url() === urlBeforeSubmit;
  check(result.login.hrefUnchanged, 'HREF_CHANGED', `${urlBeforeSubmit} → ${page.url()}`);
  result.login.negativeOk = true;
  log('negative login ok');

  // positive case
  const requestsBeforePositive = urls.length;
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', PASS);
  await page.press('#login-pass', 'Enter');
  await page.waitForFunction(() => window.__vs.state === 'idle' || window.__vs.state === 'unsupported', null, { timeout: 30000 });
  check(await evalState(page) === 'idle', 'UNSUPPORTED', `state ${await evalState(page)} after login (SIMD missing?)`);
  check(!(await visible(page, '#login')), 'LOGIN_VISIBLE', '#login must be hidden after login');
  check(await visible(page, '#app'), 'APP_HIDDEN', '#app must be visible after login');
  check((await page.evaluate(() => document.getElementById('login-error').textContent)) === '', 'LOGIN_ERROR_NOT_CLEARED');
  check((await evalVs(page)).loggedIn === true, 'LOGGED_IN');
  const tok = await token(page);
  check(/^[0-9a-f]{64}$/.test(tok ?? ''), 'TOKEN_SHAPE', String(tok));
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  check(urls.slice(0, requestsBeforePositive).every((u) => !u.includes('models/')), 'MANIFEST_BEFORE_LOGIN');
  check(urls.slice(requestsBeforePositive).some((u) => u.includes('models/manifest.json')), 'MANIFEST_NOT_FETCHED');
  log('positive login ok');
  if (layout) await layoutAt(page, 'idle', layout);

  // persistence across reload
  const since1 = counter.count();
  await page.reload();
  await awaitIsolation(page, { counter, sinceNavigation: since1, maxExtraNavigations: 1 });
  check(await evalState(page) === 'idle', 'PERSIST_STATE', `after reload: ${await evalState(page)}`);
  check(!(await visible(page, '#login')), 'PERSIST_FORM', 'form shown after reload despite the token');
  result.login.persistedOk = true;
  log('persistence ok');

  // ---- caps / policy (DA-4 on mobile: field by field, touch against navigator.maxTouchPoints read in-page)
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  const caps = await page.evaluate(() => { const c = window.__vs.caps; return c ? { backend: c.backend, threads: c.threads, hasGpu: c.hasGpu, adapterInfo: c.adapterInfo, software: c.software, isolated: c.isolated, policy: c.policy, f16: c.f16, sbs: c.sbs, hq: c.hq } : null; });

  // ---- expected model (for the backend the run must end on): iOS policy or a single WASM thread (FIX-2 R5) → wasmLow
  const manifest = manifestForRoutes;
  const lowModel = finalBackend === 'wasm' && (mobile || (caps && caps.threads === 1));
  const expectedModelId = args.model ?? manifest.tiers[args.tier]?.[lowModel ? 'wasmLow' : finalBackend];
  check(expectedModelId !== undefined, 'NO_MODEL_FOR_BACKEND', `tier ${args.tier} has no ${finalBackend} model`);
  result.expectedModelId = expectedModelId;
  result.threadsRule = { threads: caps ? caps.threads : null, lowModel, mobile };
  result.policy = caps ? caps.policy : null;
  result.caps = caps ? { backend: caps.backend, threads: caps.threads, hasGpu: caps.hasGpu, software: caps.software, isolated: caps.isolated, f16: caps.f16, sbs: caps.sbs, hq: caps.hq } : null;
  // isolation as the app saw it when it chose the thread count (the coi reload may land after the first probe above)
  result.isolatedAtCaps = await page.evaluate(() => crossOriginIsolated);
  if (result.isolatedAtCaps !== result.crossOriginIsolated) log('isolation changed after the first probe:', result.crossOriginIsolated, '→', result.isolatedAtCaps);
  if (args.backend === 'webgpu' && caps && caps.adapterInfo) result.adapterInfo = caps.adapterInfo;
  if (cdpUp && args.backend === 'webgpu') {
    const info = caps ? caps.adapterInfo : null;
    const software = !caps || !caps.hasGpu || !info || /google|swiftshader/i.test(info.vendor ?? '') || /swiftshader/i.test(info.architecture ?? '');
    if (software) {
      result.webgpu = 'not exercised (software adapter)';
      result.ok = null;
      log('cdp browser has no hardware WebGPU adapter — not exercised');
      writeOut();
      process.exit(0);
    }
  }
  if (mobile) {
    const p = result.policy;
    check(p && p.isIOS === true, 'POLICY_IOS', JSON.stringify(p));
    check(p.lowMemory === true, 'POLICY_LOWMEM', JSON.stringify(p));
    check(p.maxSeconds === 360, 'POLICY_MAXSECONDS', JSON.stringify(p));
    check(p.keepWorkerAfterResult === false, 'POLICY_KEEPWORKER', JSON.stringify(p));
    check(p.parallelEncode === false, 'POLICY_PARALLEL', JSON.stringify(p));
    const touchInPage = await page.evaluate(() => navigator.maxTouchPoints > 0);
    check(p.touch === touchInPage, 'POLICY_TOUCH', `policy.touch ${p.touch} vs navigator.maxTouchPoints > 0 → ${touchInPage}`);
    const hint = await textOf(page, '#drop-hint');
    check(hint && hint.includes('最长 6 分钟'), 'DROP_HINT', JSON.stringify(hint));
    log('policy ok', JSON.stringify(p));
  }

  // ---- input + start
  await page.setInputFiles('#file-input', fixturePath(`${args.fixture}.wav`));
  await page.waitForFunction(() => window.__vs.state === 'ready' || window.__vs.state === 'error', null, { timeout: 60000 });
  if (await evalState(page) === 'error') fail((await evalVs(page)).error?.code ?? 'INPUT_ERROR', JSON.stringify((await evalVs(page)).error));
  await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
  if (layout) await layoutAt(page, 'ready', layout);
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('#model-select option')).map((o) => o.value));
  check(options.includes(args.tier), 'TIER_NOT_OFFERED', `options ${options.join(',')}`);
  // R6: 降噪 is disabled whenever 高质量 is selected (the melroformer host has no denoise pass)
  if (options.includes('hq')) {
    await page.selectOption('#model-select', 'hq');
    const dn = await page.evaluate(() => ({ disabled: document.getElementById('denoise').disabled, value: document.getElementById('model-select').value }));
    check(dn.value === 'hq' && dn.disabled === true, 'DENOISE_NOT_DISABLED_FOR_HQ', JSON.stringify(dn));
    await page.selectOption('#model-select', 'standard');
    check((await page.evaluate(() => document.getElementById('denoise').disabled)) === false, 'DENOISE_STUCK_DISABLED');
    result.denoiseDisabledForHq = true;
  }
  await page.selectOption('#model-select', args.tier);

  // ---- FIX-2 R2b: offline import of the expected model's original file(s) from models_src/ (never committed)
  if (args.import) {
    const em = manifest.models[expectedModelId];
    const files = [em.files.model, em.files.externalData].filter(Boolean).map((f) => path.join(repoRoot, 'models_src', f.name));
    for (const f of files) check(fs.existsSync(f), 'IMPORT_FILE_MISSING', f);
    const t0i = Date.now();
    const urlsBefore = urls.length;
    await page.setInputFiles('#import-input', files);
    await page.waitForFunction(() => /^(已导入|文件与清单不匹配)/.test(document.getElementById('import-line').textContent || ''), null, { timeout: 120000 });
    const line = await textOf(page, '#import-line');
    const expectedLine = `已导入：${em.displayName}（${Math.round([em.files.model, em.files.externalData].filter(Boolean).reduce((a, f) => a + f.bytes, 0) / 1048576)} MB）`;
    check(line === expectedLine, 'IMPORT_LINE', `${JSON.stringify(line)} !== ${JSON.stringify(expectedLine)}`);
    const imported = await page.evaluate(() => window.__vs.imported && { imported: window.__vs.imported.imported.map((m) => ({ modelId: m.modelId, bytes: m.bytes, files: m.files.length })), mismatched: window.__vs.imported.mismatched });
    check(imported && imported.imported.length === 1 && imported.imported[0].modelId === expectedModelId && imported.mismatched.length === 0, 'IMPORT_RESULT', JSON.stringify(imported));
    const storeKeys = await page.evaluate(async () => { const out = []; for (const n of await caches.keys()) { const c = await caches.open(n); for (const k of await c.keys()) out.push(k.url.replace(location.origin, '')); } return out; });
    check(storeKeys.some((k) => k.includes('.vs-store/') && decodeURIComponent(k.split('.vs-store/')[1] || '').startsWith(`${expectedModelId}:${em.files.model.sha256}:part-`)), 'IMPORT_CACHE_ENTRY', storeKeys.slice(0, 5).join(', '));
    check(!urls.slice(urlsBefore).some((u) => /\/models\/[A-Za-z0-9_-]+\//.test(u)), 'IMPORT_NETWORK', 'the import itself must not fetch model bytes');
    result.import = { files: files.map((f) => path.basename(f)), line, ms: Date.now() - t0i, cacheEntries: storeKeys.length, ...imported };
    log('import ok', line, `${result.import.ms} ms`);
  }
  const urlsBeforeStart = urls.length;
  const t0 = Date.now();
  const memory = args.browser === 'chromium' ? startMemoryPoller(page) : null;
  const procMem = args.browser === 'chromium' && !cdpUp ? startProcessMemoryPoller({ sinceMs: launchedAtMs }) : null;
  await page.click('#start');
  let keepAwakeSeen = false;
  let keepAwakeText = null;
  let layoutSeparating = false;
  const progressTexts = [];
  const st = await waitForJob(page, {
    timeout: JOB_TIMEOUT_MS,
    interval: noSwActive ? 250 : 500,
    onTick: async (s) => {
      if (await visible(page, '#keep-awake')) { keepAwakeSeen = true; keepAwakeText = await page.evaluate(() => document.getElementById('keep-awake').textContent); }
      if (s !== 'done' && s !== 'error') {
        const pt = await page.evaluate(() => document.getElementById('progress').textContent);
        if (progressTexts[progressTexts.length - 1] !== pt) progressTexts.push(pt);
        log('state', s, pt);
      }
      if (s === 'separating' && layout && !layoutSeparating) { layoutSeparating = true; await layoutAt(page, 'separating', layout); }
    },
  });
  if (memory) {
    const m = await memory.stop();
    result.memoryPeakBytes = m.peakBytes; result.memorySamples = m.samples; result.memoryLabel = m.label; result.memoryError = m.error; result.memoryApi = m;
    log('memory api', JSON.stringify({ peakBytes: m.peakBytes, samples: m.samples, label: m.label }));
  }
  if (procMem) {
    const m = await procMem.stop();
    result.memoryOs = m;
    log('memory os', JSON.stringify({ peakPrivateBytes: m.peakPrivateBytes, peakWorkingSetBytes: m.peakWorkingSetBytes, samples: m.samples }));
  }
  if (st === 'error') { const vs = await evalVs(page); console.error('[e2e] __vs.error', JSON.stringify(vs.error)); fail(vs.error?.code ?? 'JOB_ERROR', JSON.stringify(vs.error)); }
  log('done in', Math.round((Date.now() - t0) / 1000), 's');
  if (mobile) { check(keepAwakeSeen && keepAwakeText === '处理中请保持屏幕亮起', 'KEEP_AWAKE_MISSING'); check(!(await visible(page, '#keep-awake')), 'KEEP_AWAKE_STUCK'); }
  else check(!keepAwakeSeen, 'KEEP_AWAKE_ON_DESKTOP');
  result.keepAwakeSeen = keepAwakeSeen;
  result.progressTexts = progressTexts;
  if (layout) await layoutAt(page, 'done', layout);

  // ---- backend / model first
  const t = await page.evaluate(() => window.__vs.timings());
  result.timings = t;
  check(t.backend === finalBackend, 'BACKEND_MISMATCH', `expected ${finalBackend}, ran ${t.backend}`);
  check(t.modelId === expectedModelId, 'MODEL_MISMATCH', `expected ${expectedModelId}, ran ${t.modelId}`);
  const backendLine = await page.evaluate(() => document.getElementById('backend-line').textContent);
  if (args.expectFallback) {
    check(t.fellBack === true, 'FALLBACK_MISSING', `fellBack ${t.fellBack}`);
    check(t.tier === 'standard', 'FALLBACK_TIER', t.tier);
    const fb = result.consoleErrors.filter((m) => m.includes('webgpu-fallback'));
    check(fb.length === 1, 'FALLBACK_LOG_COUNT', `${fb.length} console.error lines contain 'webgpu-fallback': ${JSON.stringify(fb)}`);
    check(fb[0].includes(args.expectFallback), 'FALLBACK_REASON', fb[0]);
    check(/^运行方式：WASM · \d+ 线程( · 小模型)?$/.test(backendLine), 'FALLBACK_BACKEND_LINE', backendLine);
    result.fallback = { reason: args.expectFallback, consoleLine: fb[0], backendLine, dispatchDecodeMs: t.dispatchDecodeMs ?? null };
    log('fallback ok', fb[0]);
  } else {
    check(t.fellBack === false, 'UNEXPECTED_FALLBACK');
    check(backendLine.includes(finalBackend === 'wasm' ? 'WASM' : 'WebGPU'), 'BACKEND_LINE', backendLine);
  }
  result.ran = { backend: t.backend, modelId: t.modelId, tier: t.tier, threads: t.threads, fellBack: t.fellBack };
  const vsAfter = await evalVs(page);
  check(vsAfter.backend && vsAfter.backend.name === finalBackend && vsAfter.backend.modelId === expectedModelId, 'VS_BACKEND', JSON.stringify(vsAfter.backend));
  if (result.isolatedAtCaps === false) check(t.threads === 1, 'THREADS', `not isolated but threads ${t.threads}`);
  if (noSwActive) {
    check(t.threads === 1, 'NO_SW_THREADS', `threads ${t.threads}`);
    check(vsAfter.backend.threads === 1, 'NO_SW_VS_THREADS', JSON.stringify(vsAfter.backend));
    const seen = progressTexts.some((p) => p.includes('WASM · 1 线程'));
    check(seen, 'NO_SW_PROGRESS_LABEL', JSON.stringify(progressTexts.slice(-5)));
    // FIX-2 R5 threads rule: one thread on a desktop policy → the small model and the 小模型 label
    if (!mobile && !args.model && args.tier === 'standard') {
      check(t.modelId === manifest.tiers.standard.wasmLow, 'NO_SW_SMALL_MODEL', `ran ${t.modelId}`);
      check(backendLine === '运行方式：WASM · 1 线程 · 小模型', 'NO_SW_BACKEND_LINE', backendLine);
    }
    result.a48 = { nonIsolatedRunOk: true, threads: t.threads, progressLabelSeen: seen, modelId: t.modelId, backendLine };
  }

  // ---- FIX-2 R4/R5 progress lines + download report
  const dlLines = progressTexts.filter((p) => p.startsWith('正在下载模型'));
  const sepLines = progressTexts.filter((p) => p.startsWith('分离中'));
  for (const p of dlLines) check(/^正在下载模型( · 文件 \d+\/\d+)? · \d+(\.\d)? MB \/ \d+(\.\d)? MB( · \d+ KB\/s| · \d+\.\d MB\/s)?( · 预计剩余 \d+:\d\d)?$/.test(p), 'DOWNLOAD_LINE', p);
  for (const p of sepLines) check(/^分离中 \d+\/\d+ 段( · WASM · \d+ 线程( · 小模型)?)? · 已用 \d+:\d\d( · 预计剩余 \d+:\d\d)?$/.test(p), 'SEPARATING_LINE', p);
  check(sepLines.length >= 1, 'NO_SEPARATING_LINE', JSON.stringify(progressTexts.slice(0, 8)));
  if (t.chunkMs.length >= 4) check(sepLines.some((p) => p.includes('预计剩余')), 'NO_SEPARATION_ETA', JSON.stringify(sepLines.slice(0, 6)));
  check(t.download && typeof t.download === 'object', 'NO_DOWNLOAD_REPORT', JSON.stringify(t.download));
  result.download = t.download;
  result.downloadLines = dlLines.slice(0, 20);
  if (args.deadSource) {
    check(deadRouted > 0, 'DEAD_SOURCE_NOT_HIT', 'the dead source was never requested');
    check(Array.isArray(t.download.excluded) && t.download.excluded.some((x) => x.id === args.deadSource), 'DEAD_SOURCE_NOT_EXCLUDED', JSON.stringify(t.download.excluded));
    check(!(t.download.used && t.download.used[args.deadSource]), 'DEAD_SOURCE_USED', JSON.stringify(t.download.used));
    check(t.download.downloadedBytes > 0 || t.download.restoredBytes > 0 || t.download.fromStore.length > 0, 'DEAD_SOURCE_NO_BYTES', JSON.stringify(t.download));
    result.deadSource.routed = deadRouted;
    log('dead source excluded', JSON.stringify(t.download.excluded));
  }
  if (args.import) {
    check(t.download.downloadedBytes === 0 && t.download.sources === null, 'IMPORT_DOWNLOADED', JSON.stringify(t.download));
    const em = manifest.models[expectedModelId];
    check(t.download.restoredBytes === [em.files.model, em.files.externalData].filter(Boolean).reduce((a, f) => a + f.bytes, 0), 'IMPORT_RESTORED_BYTES', JSON.stringify(t.download));
    const modelRequests = urls.slice(urlsBeforeStart).filter((u) => /\/models\/[A-Za-z0-9_-]+\//.test(u) || /^https:\/\/(hf-mirror\.com|huggingface\.co|cdn\.jsdelivr\.net|fastly\.jsdelivr\.net|gcore\.jsdelivr\.net|cdn\.jsdmirror\.com|jsdelivr\.b-cdn\.net|raw\.githubusercontent\.com|ghfast\.top|ghproxy\.net)\//.test(u));
    check(modelRequests.length === 0, 'IMPORT_MODEL_REQUEST', modelRequests.slice(0, 5).join(', '));
    check(dlLines.length === 0, 'IMPORT_DOWNLOAD_LINE', JSON.stringify(dlLines));
    result.import.separationUsedNoNetwork = true;
    log('import: separation used no network');
  }

  // ---- quality
  const stems = [await readStem(page, 0), await readStem(page, 1), await readStem(page, 2), await readStem(page, 3)];
  const n = stems[0].length;
  check(Math.abs(n - EXPECTED_SAMPLES) <= 1, 'STEM_LENGTH', `decoded length ${n}`);
  if (args.tier === 'hq') {
    result.hq = hqEvaluate(t, stems, tag);
    result.snr = null;
    log('hq', JSON.stringify({ gateC: result.hq.gateC, bVocal: result.hq.bVocal, gpuVsCpu: result.hq.gpuVsCpu, vsVocFt: result.hq.vsVocFt }));
    check(result.hq.gateC.windowCount >= 1, 'HQ_NO_WINDOWS', 'timings.chunkMs is empty');
    const finite = stems.every((s) => { for (let i = 0; i < s.length; i++) { const v = s[i]; if (v !== v || v === Infinity || v === -Infinity) return false; } return true; });
    check(finite, 'HQ_NONFINITE', 'a stem contains NaN/Infinity');
  } else {
    const snr = snrOfStems(t.modelId, stems);
    result.snr = { ...snr, threshold: SNR_THRESHOLD, label: SNR_LABEL, modelId: t.modelId, samples: n };
    log('snr', JSON.stringify(result.snr));
    check(snr.vocalsDb >= SNR_THRESHOLD, 'SNR_VOCALS', `${snr.vocalsDb.toFixed(2)} dB < ${SNR_THRESHOLD}`);
    check(snr.instDb >= SNR_THRESHOLD, 'SNR_INST', `${snr.instDb.toFixed(2)} dB < ${SNR_THRESHOLD}`);
  }

  // ---- MP3
  const mp3v = await readMp3(page, 'vocals');
  const mp3i = await readMp3(page, 'instrumental');
  check(mp3v && mp3i, 'MP3_MISSING');
  const mv = checkMp3(mp3v, n, 'vocals');
  const mi = checkMp3(mp3i, n, 'instrumental');
  const expectedName = `${args.fixture}_人声.mp3`;
  const anchor = await page.evaluate(() => { const a = document.getElementById('dl-vocals-mp3'); return { disabled: a.getAttribute('aria-disabled'), download: a.getAttribute('download'), text: a.textContent }; });
  check(anchor.disabled !== 'true', 'MP3_ANCHOR_DISABLED', JSON.stringify(anchor));
  check(anchor.download === expectedName, 'MP3_DOWNLOAD_NAME', `${anchor.download} !== ${expectedName}`);
  let downloadEventOk = false, downloadSize = null;
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#dl-vocals-mp3')]);
    check(dl.suggestedFilename() === expectedName, 'DOWNLOAD_FILENAME', dl.suggestedFilename());
    const p = await dl.path();
    downloadSize = p ? fs.statSync(p).size : null;
    downloadEventOk = downloadSize === mp3v.byteLength;
  } catch (e) {
    if (mobile || e.code) throw e;
    log('download event not observed on desktop (best effort):', e.message);
  }
  if (mobile) check(downloadEventOk, 'DOWNLOAD_EVENT', `size ${downloadSize} vs ${mp3v.byteLength}`);
  result.mp3 = { vocals: mv, instrumental: mi, downloadName: anchor.download, downloadEventOk, downloadSize };
  log('mp3', JSON.stringify(result.mp3));

  // ---- retry step (§16.C)
  if (args.retry) {
    const first = t.chunkMs.length;
    check(t.dispatchDecodeMs === undefined, 'RETRY_PRE', `first run must not re-decode (dispatchDecodeMs ${t.dispatchDecodeMs})`);
    check(typeof t.decodeMs === 'number', 'RETRY_DECODE_MS');
    check(await page.evaluate(() => !document.getElementById('start').disabled), 'RETRY_START_DISABLED');
    await page.click('#start');
    await page.waitForFunction(() => window.__vs.state !== 'done', null, { timeout: 30000 });
    const mid = await page.evaluate(() => ({ error: window.__vs.error, mp3: window.__vs.mp3('vocals'), srcs: [document.getElementById('audio-vocals').getAttribute('src'), document.getElementById('audio-inst').getAttribute('src')], chunkMs: window.__vs.timings().chunkMs, decodeMs: window.__vs.timings().decodeMs, state: window.__vs.state }));
    check(mid.error === null, 'RETRY_ERROR_NOT_CLEARED', JSON.stringify(mid.error));
    check(mid.mp3 === null, 'RETRY_MP3_NOT_DROPPED');
    check(mid.srcs.every((s) => !s), 'RETRY_PLAYERS_NOT_UNLOADED', JSON.stringify(mid.srcs));
    check(mid.chunkMs === undefined, 'RETRY_JOB_TIMINGS_NOT_CLEARED');
    check(typeof mid.decodeMs === 'number' && mid.decodeMs === t.decodeMs, 'RETRY_INPUT_TIMINGS_LOST');
    const st2 = await waitForJob(page, { timeout: JOB_TIMEOUT_MS, onTick: async (s) => { if (s !== 'done' && s !== 'error') log('retry state', s, await page.evaluate(() => document.getElementById('progress').textContent)); } });
    if (st2 === 'error') { const vs = await evalVs(page); fail(vs.error?.code ?? 'JOB_ERROR', 'retry: ' + JSON.stringify(vs.error)); }
    const t2 = await page.evaluate(() => window.__vs.timings());
    check(t2.chunkMs.length === first, 'RETRY_CHUNKS', `${t2.chunkMs.length} !== ${first}`);
    check(t2.backend === finalBackend && t2.modelId === expectedModelId && t2.fellBack === (args.expectFallback ? true : false), 'RETRY_BACKEND', JSON.stringify({ backend: t2.backend, modelId: t2.modelId, fellBack: t2.fellBack }));
    check(t2.decodeMs === t.decodeMs, 'RETRY_DECODE_MS_CHANGED');
    check(typeof t2.dispatchDecodeMs === 'number', 'RETRY_NO_REDECODE', `dispatchDecodeMs ${t2.dispatchDecodeMs}`);
    const stems2 = [await readStem(page, 0), await readStem(page, 1), await readStem(page, 2), await readStem(page, 3)];
    check(Math.abs(stems2[0].length - EXPECTED_SAMPLES) <= 1, 'RETRY_STEM_LENGTH', String(stems2[0].length));
    const snr2 = snrOfStems(t2.modelId, stems2);
    check(snr2.vocalsDb >= SNR_THRESHOLD && snr2.instDb >= SNR_THRESHOLD, 'RETRY_SNR', JSON.stringify(snr2));
    result.retry = { ok: true, chunkCount: first, chunkCount2: t2.chunkMs.length, dispatchDecodeMs: t2.dispatchDecodeMs, snr: snr2, timings: t2 };
    log('retry ok', JSON.stringify({ chunkCount: first, dispatchDecodeMs: t2.dispatchDecodeMs }));
  }

  // ---- layout verdict (§22.6)
  if (layout) {
    layout.ok = layout.violations.length === 0 && layout.checks.length >= 2 * LAYOUT_WIDTHS.length;
    const labels = [...new Set(layout.checks.map((c) => c.label))];
    layout.labels = labels;
    log('layout', JSON.stringify({ ok: layout.ok, labels, violations: layout.violations.length }));
    check(layout.ok, 'LAYOUT', JSON.stringify(layout.violations.slice(0, 10)));
  }

  // ---- screenshot (viewport only; never read back)
  try { await page.screenshot({ path: path.join(path.dirname(outFile), `e2e_${tag}.png`), fullPage: false }); } catch (e) { log('screenshot failed', e.message); }

  // ---- logout (last step of every run)
  const since2 = counter.count();
  await page.click('#logout');
  await awaitIsolation(page, { counter, sinceNavigation: since2, maxExtraNavigations: 1 });
  await waitLocked(page);
  check(await evalState(page) === 'locked', 'LOGOUT_STATE', await evalState(page));
  check(await token(page) === null, 'LOGOUT_TOKEN');
  check(await visible(page, '#login'), 'LOGOUT_FORM');
  result.login.logoutOk = true;
  result.navigations = counter.count();
  result.ok = true;
  exitCode = 0;
  log('PASS');
} catch (e) {
  result.ok = false;
  result.failure = { code: e && e.code ? e.code : 'ERROR', message: String(e && e.message).slice(0, 2000) };
  console.error('[e2e] FAIL', result.failure.code, result.failure.message);
  if (!(e && e.code)) console.error(e && e.stack);
  exitCode = 1;
  // A41: WebKit-on-Windows media-stack failures (its build has no WebAudio at all) are recorded next to the login/layout
  // results that did pass; the remaining layout check and the logout step still run so the JSON reports them.
  if (args.browser === 'webkit' && ['DECODE', 'INTERNAL', 'OOM', 'SESSION', 'INFERENCE', 'WORKER', 'MP3', 'INPUT_ERROR', 'JOB_TIMEOUT', 'UNSUPPORTED'].includes(result.failure.code)) {
    result.webkitIssues.push({ code: result.failure.code, message: result.failure.message.slice(0, 500) });
    try {
      const page = context && context.pages()[0];
      if (page) {
        result.webkitCapabilities = await page.evaluate(() => ({ OfflineAudioContext: typeof OfflineAudioContext, AudioContext: typeof AudioContext, serviceWorker: typeof navigator.serviceWorker, gpu: typeof navigator.gpu, wakeLock: typeof navigator.wakeLock, maxTouchPoints: navigator.maxTouchPoints, SharedArrayBuffer: typeof SharedArrayBuffer, crossOriginIsolated }));
        if (result.layout) await layoutAt(page, 'after-issue', result.layout);
        const counter = makeNavCounter(context);
        const since = counter.count();
        await page.click('#logout');
        await awaitIsolation(page, { counter, sinceNavigation: since, maxExtraNavigations: 1 });
        result.login.logoutOk = await waitLocked(page);
        log('after the WebKit issue: logout', result.login.logoutOk);
      }
    } catch (e2) { log('post-issue steps failed', e2 && e2.message); }
  }
} finally {
  if (result.layout) {
    const l = result.layout;
    l.complete = ['login', 'idle', 'ready', 'separating', 'done'].every((s) => l.checks.some((c) => c.label === s));
    if (result.ok !== true) { l.ok = l.checks.length > 0 && l.violations.length === 0; l.labels = [...new Set(l.checks.map((c) => c.label))]; }
  }
  writeOut();
  try { if (context && !cdpUp) await context.close(); } catch { /* ignore */ }
  try { if (browser && !cdpUp) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
