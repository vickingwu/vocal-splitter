// tests/e2e/bench_wasm.mjs — the §7.5 WASM-tier decision and the §16.D / §3.6 long-input cases (headless Chromium, desktop).
//   node tests/e2e/bench_wasm.mjs [--base http://127.0.0.1:8010/] [--repeat 3] [--out ../evidence/wasm_decision.json]
//   node tests/e2e/bench_wasm.mjs --long [--model <id>]      (five generated inputs in %TEMP%; never committed)
// Decision runs: ?backend=wasm&model=uvr_mdx_voc_ft on clip25.wav, --repeat times; each asserts the backend/model that
// actually ran (a decision is never taken from a run that silently used another model); rule over the aggregate
// (median of the per-run medians, worst peak):
//   tiers.standard.wasm = (medianChunkMs > 12000 || peakBytes > 2.5e9 || sessionFailed) ? 'uvr_mdxnet_9482' : 'uvr_mdx_voc_ft'
// peakBytes = performance.measureUserAgentSpecificMemory() when it delivered >= 5 samples, else the renderer's private
// commit sampled by tests/lib/proc_mem.ps1 (page + worker process = the ORT WASM heap). 9482 always runs once (the
// fallback check when selected, informational otherwise); if 9482 fails too → .fallback9482 and exit WASM_TIER_UNVERIFIED.
// --long reads the decision from the evidence file (or --model) and runs the 15-minute cases with that model.
// Credentials: VS_TEST_USER / VS_TEST_PASS from the environment (NO_CREDENTIALS otherwise); never written anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { awaitIsolation, login, startServerIfNeeded, readManifest, sleep, startMemoryPoller, startProcessMemoryPoller, makeNavCounter, launchChromium } from '../lib/e2e-helpers.mjs';
import { fixturePath, evidenceDir } from '../lib/fixtures.mjs';
import { encodeStereo, repeatBlocks, concat } from '../lib/mp3-fixtures.mjs';
import { mpegDuration } from '../../site/src/engine/mp3frames.mjs';
import { codeToCopy } from '../../site/src/ui/copy.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const args = {
  base: arg('--base', 'http://127.0.0.1:8010/'),
  out: path.resolve(arg('--out', path.join(evidenceDir, 'wasm_decision.json'))),
  long: argv.includes('--long'),
  model: arg('--model', undefined),
  repeat: Math.max(1, Number(arg('--repeat', '3')) || 3),
};
if (!args.base.endsWith('/')) args.base += '/';
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS in the environment'); process.exit(2); }

const VOC_FT = 'uvr_mdx_voc_ft', M9482 = 'uvr_mdxnet_9482';
const RULE = { maxMedianChunkMs: 12000, maxPeakBytes: 2.5e9 };
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const log = (...a) => console.log('[bench]', ...a);
const fail = (code, msg) => { const e = new Error(`${code}: ${msg ?? ''}`); e.code = code; throw e; };
const check = (cond, code, msg) => { if (!cond) fail(code, msg); };
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8'); };

const evalState = (page) => page.evaluate(() => window.__vs.state);
const evalError = (page) => page.evaluate(() => window.__vs.error);
const evalTimings = (page) => page.evaluate(() => window.__vs.timings());
const evalInput = (page) => page.evaluate(() => { const i = window.__vs.input(); return i ? { duration: i.duration, length: i.length, sampleRate: i.sampleRate, blobSize: i.blob ? i.blob.size : null } : null; });
const errorText = (page) => page.evaluate(() => document.getElementById('error').textContent);

async function waitFor(page, pred, timeout, what) {
  const t0 = Date.now();
  for (;;) {
    const st = await evalState(page);
    if (pred(st)) return st;
    if (Date.now() - t0 > timeout) fail('TIMEOUT', `${what}: state ${st} after ${Math.round((Date.now() - t0) / 1000)} s`);
    await sleep(500);
  }
}

async function openPage(browser, query) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const counter = makeNavCounter(context);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e && e.message).slice(0, 300)));
  const url = args.base + query;
  log('goto', url);
  const since = counter.count();
  const isolated = await (async () => { await page.goto(url); return awaitIsolation(page, { counter, sinceNavigation: since, maxExtraNavigations: 2 }); })();
  const st = await login(page, { user: USER, pass: PASS });
  check(st === 'idle', 'UNSUPPORTED', `state after login ${st}`);
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  return { context, page, isolated, consoleErrors };
}

async function uploadAndWait(page, file, { expect, timeout = 120000 }) {
  await page.setInputFiles('#file-input', file);
  const st = await waitFor(page, (s) => s === 'ready' || s === 'error', timeout, `after upload of ${path.basename(file)}`);
  if (expect && st !== expect) fail('INPUT_STATE', `${path.basename(file)}: expected ${expect}, got ${st} ${JSON.stringify(await evalError(page))}`);
  return st;
}

// peakBytes for the §7.5 rule: the in-page API when it delivered >= 5 samples (A28: Chrome delays/rate-limits it — one
// sample per minute was observed), otherwise the OS-level private commit of the renderer (page + worker = the ORT heap).
async function runJob(page) {
  await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
  const memory = startMemoryPoller(page);
  const procMem = startProcessMemoryPoller({ sinceMs: launchedAtMs });
  const t0 = Date.now();
  await page.click('#start');
  const st = await waitFor(page, (s) => s === 'done' || s === 'error', JOB_TIMEOUT_MS, 'job');
  const api = await memory.stop();
  const os_ = await procMem.stop();
  const timings = await evalTimings(page);
  const error = st === 'error' ? await evalError(page) : null;
  const peakBytes = api.peakBytes !== null ? api.peakBytes : os_.peakPrivateBytes;
  const peakSource = api.peakBytes !== null ? 'measureUserAgentSpecificMemory' : (os_.peakPrivateBytes !== null ? 'renderer private commit (Get-Process PrivateMemorySize64 via tests/lib/proc_mem.ps1)' : null);
  return { state: st, error, timings, memory: { peakBytes, peakSource, api, os: os_ }, wallMs: Date.now() - t0 };
}

// progress logging while a job runs (separate loop so runJob stays simple)
function progressLogger(page) {
  let stop = false;
  const loop = (async () => {
    let last = '';
    while (!stop) {
      try {
        const t = await page.evaluate(() => [window.__vs.state, document.getElementById('progress').textContent]);
        const line = t.join(' | ');
        if (line !== last) { log(line); last = line; }
      } catch { /* page busy */ }
      await sleep(2000);
    }
  })();
  return { async stop() { stop = true; await loop; } };
}

// ------------------------------------------------------------------------------------------------- decision run (§7.5)
async function decisionRun(browser, manifest, modelId) {
  const { context, page, isolated, consoleErrors } = await openPage(browser, `?backend=wasm&model=${modelId}`);
  try {
    await uploadAndWait(page, fixturePath('clip25.wav'), { expect: 'ready' });
    const pl = progressLogger(page);
    const r = await runJob(page);
    await pl.stop();
    const t = r.timings;
    const params = manifest.models[modelId].params;
    const chunkSamples = params.hop * (params.dimT - 1);
    const out = {
      modelId, requestedModelId: modelId, state: r.state, errorCode: r.error ? r.error.code : null, errorDetail: r.error ? r.error.detail : null,
      backend: t.backend ?? null, ranModelId: t.modelId ?? null, threads: t.threads ?? null, crossOriginIsolated: isolated,
      chunkMs: t.chunkMs ?? null, medianChunkMs: t.chunkMs ? median(t.chunkMs.slice(1)) : null, maxChunkMs: t.chunkMs ? Math.max(...t.chunkMs) : null,
      chunkSamples, chunkSeconds: chunkSamples / 44100,
      sessionMs: t.sessionMs ?? null, downloadMs: t.downloadMs ?? null, verifyMs: t.verifyMs ?? null, totalMs: t.totalMs ?? null, stftMs: t.stftMs ?? null, istftMs: t.istftMs ?? null,
      encodeMs: t.encodeMs ?? null, wallMs: r.wallMs,
      peakBytes: r.memory.peakBytes, peakSource: r.memory.peakSource, samples: r.memory.api.samples, memoryApi: r.memory.api, memoryOs: r.memory.os,
      sessionFailed: r.state === 'error' && (r.error.code === 'SESSION' || r.error.code === 'OOM'),
      failed: r.state === 'error', consoleErrors,
    };
    if (r.state === 'done') {
      check(t.backend === 'wasm', 'BACKEND_MISMATCH', `requested wasm, ran ${t.backend}`);
      check(t.modelId === modelId, 'MODEL_MISMATCH', `requested ${modelId}, ran ${t.modelId}`);
      check(t.fellBack === false, 'UNEXPECTED_FALLBACK');
    }
    return out;
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------------------------------------ long inputs (§16.D)
function writeWavFile(file, frames, { riffSize = null, dataSize = null } = {}) {
  const sr = 44100, ch = 2, bps = 16;
  const blockAlign = ch * bps / 8;
  const dataBytes = frames * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize === null ? 36 + dataBytes : riffSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bps, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize === null ? dataBytes : dataSize, 40);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    const BLOCK = 441000;                                        // 10 s
    const buf = Buffer.alloc(BLOCK * blockAlign);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    let i0 = 0;
    while (i0 < frames) {
      const n = Math.min(BLOCK, frames - i0);
      for (let i = 0; i < n; i++) {
        const t = (i0 + i) / sr;
        const l = 0.45 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 3300 * t) + 0.08 * rnd();
        const r = 0.45 * Math.sin(2 * Math.PI * 330 * t) + 0.15 * Math.sin(2 * Math.PI * 2750 * t) + 0.08 * rnd();
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), i * 4);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), i * 4 + 2);
      }
      fs.writeSync(fd, buf, 0, n * blockAlign);
      i0 += n;
    }
  } finally { fs.closeSync(fd); }
  return fs.statSync(file).size;
}

function buildLongInputs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  const t0 = Date.now();
  const f1 = path.join(dir, 'case1_15m00.wav');
  if (!fs.existsSync(f1) || fs.statSync(f1).size !== 44 + 39690000 * 4) writeWavFile(f1, 39690000);
  files.case1 = { file: f1, frames: 39690000, bytes: fs.statSync(f1).size };
  const f2 = path.join(dir, 'case2_15m00_5.wav');
  if (!fs.existsSync(f2) || fs.statSync(f2).size !== 44 + 39712050 * 4) writeWavFile(f2, 39712050);
  files.case2 = { file: f2, frames: 39712050, bytes: fs.statSync(f2).size, seconds: 39712050 / 44100 };
  const f5 = path.join(dir, 'case5_15m00_streaming_header.wav');
  if (!fs.existsSync(f5) || fs.statSync(f5).size !== files.case1.bytes) {
    fs.copyFileSync(f1, f5);
    const fd = fs.openSync(f5, 'r+');
    const ff = Buffer.alloc(4, 0xFF);
    fs.writeSync(fd, ff, 0, 4, 4);
    fs.writeSync(fd, ff, 0, 4, 40);
    fs.closeSync(fd);
  }
  files.case5 = { file: f5, frames: 39690000, bytes: fs.statSync(f5).size };
  log('wav files ready in', Math.round((Date.now() - t0) / 1000), 's');
  const f3 = path.join(dir, 'case3_mixed_7m.mp3');
  if (!fs.existsSync(f3)) {
    const b112 = encodeStereo(5, 112).bytes, b320 = encodeStereo(5, 320).bytes;
    fs.writeFileSync(f3, concat([repeatBlocks(b112, 21), repeatBlocks(b320, 63)]));
  }
  const bytes3 = new Uint8Array(fs.readFileSync(f3));
  const d3 = mpegDuration(bytes3);
  files.case3 = { file: f3, bytes: bytes3.length, seconds: d3 ? d3.seconds : null, frames: d3 ? d3.frames : null, naiveEstimateSeconds: bytes3.length * 8 / 112000 };
  const f4 = path.join(dir, 'case4_cbr128_16m.mp3');
  if (!fs.existsSync(f4)) fs.writeFileSync(f4, repeatBlocks(encodeStereo(5, 128).bytes, 192));
  const bytes4 = new Uint8Array(fs.readFileSync(f4));
  const d4 = mpegDuration(bytes4);
  files.case4 = { file: f4, bytes: bytes4.length, seconds: d4 ? d4.seconds : null, frames: d4 ? d4.frames : null };
  log('mp3 files ready', JSON.stringify({ case3: files.case3.seconds, case4: files.case4.seconds }));
  return files;
}

async function longRun(browser, modelId) {
  const dir = path.join(os.tmpdir(), 'vs_long_inputs');
  const files = buildLongInputs(dir);
  const long = { modelId, inputsDir: dir, inputs: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { ...v, file: path.basename(v.file) }])), cases: [] };
  const { context, page, isolated, consoleErrors } = await openPage(browser, `?backend=wasm&model=${modelId}&maxChunks=3`);
  long.crossOriginIsolated = isolated;
  try {
    // case 1 — WAV 15:00.000 accepted; ?maxChunks=3; done without OOM; the 15-minute memory check
    {
      const c = { id: 1, name: 'WAV 15:00.000 (39,690,000 frames), ?maxChunks=3', ok: false };
      try {
        const t0 = Date.now();
        await uploadAndWait(page, files.case1.file, { expect: 'ready', timeout: 180000 });
        c.decodeWallMs = Date.now() - t0;
        const input = await evalInput(page);
        c.decodedLength = input ? input.length : null;
        const pl = progressLogger(page);
        const r = await runJob(page);
        await pl.stop();
        c.state = r.state; c.errorCode = r.error ? r.error.code : null;
        check(r.state === 'done', r.error ? r.error.code : 'JOB_ERROR', JSON.stringify(r.error));
        check(r.timings.backend === 'wasm' && r.timings.modelId === modelId, 'MODEL_MISMATCH', JSON.stringify({ backend: r.timings.backend, modelId: r.timings.modelId }));
        c.peakBytes = r.memory.peakBytes; c.peakSource = r.memory.peakSource; c.memoryApi = r.memory.api; c.memoryOs = r.memory.os;
        c.chunkMs = r.timings.chunkMs; c.probeMs = r.timings.probeMs; c.probeKind = r.timings.probeKind; c.decodeMs = r.timings.decodeMs; c.encodeMs = r.timings.encodeMs;
        c.sessionMs = r.timings.sessionMs; c.totalMs = r.timings.totalMs; c.wallMs = r.wallMs; c.modelId = r.timings.modelId; c.threads = r.timings.threads;
        c.stemLength = await page.evaluate(() => window.__vs.stems()[0].length);
        c.mp3Bytes = await page.evaluate(() => ({ vocals: window.__vs.mp3('vocals')?.size ?? null, instrumental: window.__vs.mp3('instrumental')?.size ?? null }));
        check(Math.abs(c.stemLength - 39690000) <= 1, 'STEM_LENGTH', String(c.stemLength));
        c.ok = true;
        long.peakBytes = c.peakBytes; long.chunkMs = c.chunkMs; long.probeMs = c.probeMs; long.decodeMs = c.decodeMs; long.encodeMs = c.encodeMs; long.modelId = c.modelId;
      } catch (e) { c.failure = { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 500) }; }
      long.cases.push(c); log('case 1', JSON.stringify({ ok: c.ok, peakBytes: c.peakBytes, failure: c.failure }));
    }
    // case 2 — WAV 15:00.500 refused by the exact WAV-header probe before decoding
    {
      const c = { id: 2, name: 'WAV 15:00.500 (39,712,050 frames) → TOO_LONG before decode', ok: false };
      try {
        await uploadAndWait(page, files.case2.file, { expect: 'error', timeout: 180000 });
        const err = await evalError(page); const t = await evalTimings(page); const text = await errorText(page);
        c.errorCode = err?.code; c.detail = err?.detail; c.probeMs = t.probeMs; c.probeKind = t.probeKind; c.decodeMs = t.decodeMs ?? null; c.errorText = text;
        check(err && err.code === 'TOO_LONG', 'CODE', JSON.stringify(err));
        check(Math.abs(err.detail.seconds - 900.5) <= 0.01, 'SECONDS', String(err.detail.seconds));
        check(t.decodeMs === undefined, 'DECODE_RAN', `decodeMs ${t.decodeMs}`);
        check(t.probeMs !== undefined && t.probeKind === 'wav', 'PROBE', JSON.stringify({ probeMs: t.probeMs, probeKind: t.probeKind }));
        check(text === '文件超过 15 分钟（当前 15:01）。请裁剪后重试。', 'ERROR_TEXT', text);
        c.ok = true;
        long.tooLong = { tooLongBeforeDecode: true, probeMs: t.probeMs };
      } catch (e) { c.failure = { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 500) }; }
      long.cases.push(c); log('case 2', JSON.stringify({ ok: c.ok, failure: c.failure }));
    }
    // case 3 — mixed-bitrate MP3 ≈ 7 min without Xing: accepted (the naive estimate would refuse it)
    {
      const c = { id: 3, name: 'MP3 mixed 112/320 kbps ≈ 7:00, no Xing → accepted', ok: false, truthSeconds: files.case3.seconds, naiveEstimateSeconds: files.case3.naiveEstimateSeconds };
      try {
        await uploadAndWait(page, files.case3.file, { expect: 'ready', timeout: 180000 });
        const err = await evalError(page); const t = await evalTimings(page); const input = await evalInput(page);
        c.error = err; c.probeKind = t.probeKind; c.probeMs = t.probeMs; c.decodeMs = t.decodeMs; c.decodedLength = input.length; c.duration = input.duration;
        check(err === null, 'ERROR_SET', JSON.stringify(err));
        const T = files.case3.seconds;
        c.deltaSamples = input.length - Math.round(T * 44100);
        check(Math.abs(c.deltaSamples) <= 2 * 1152, 'LENGTH', `decoded ${input.length} vs T·44100 ${Math.round(T * 44100)} (Δ ${c.deltaSamples})`);
        c.chromeEstimateSeconds = await page.evaluate(() => new Promise((resolve) => {
          const blob = window.__vs.input().blob;
          const el = document.createElement('audio'); el.preload = 'metadata';
          const url = URL.createObjectURL(blob);
          const done = (v) => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } resolve(v); };
          const timer = setTimeout(() => done(null), 10000);
          el.addEventListener('loadedmetadata', () => { clearTimeout(timer); done(el.duration); });
          el.addEventListener('error', () => { clearTimeout(timer); done(null); });
          el.src = url;
        }));
        c.ok = true;
      } catch (e) { c.failure = { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 500) }; }
      long.cases.push(c); log('case 3', JSON.stringify({ ok: c.ok, truth: c.truthSeconds, chrome: c.chromeEstimateSeconds, failure: c.failure }));
    }
    // case 4 — CBR 128 kbps ≈ 16 min without Xing: refused before decoding with the walked duration
    {
      const c = { id: 4, name: 'MP3 CBR 128 kbps ≈ 16:00, no Xing → TOO_LONG before decode', ok: false, truthSeconds: files.case4.seconds };
      try {
        await uploadAndWait(page, files.case4.file, { expect: 'error', timeout: 180000 });
        const err = await evalError(page); const t = await evalTimings(page); const text = await errorText(page);
        c.errorCode = err?.code; c.detail = err?.detail; c.probeMs = t.probeMs; c.probeKind = t.probeKind; c.decodeMs = t.decodeMs ?? null; c.errorText = text;
        const T = files.case4.seconds;
        check(err && err.code === 'TOO_LONG', 'CODE', JSON.stringify(err));
        check(Math.abs(err.detail.seconds - T) <= 0.1, 'SECONDS', `${err.detail.seconds} vs ${T}`);
        check(t.decodeMs === undefined, 'DECODE_RAN', `decodeMs ${t.decodeMs}`);
        check(t.probeKind === 'mpeg', 'PROBE_KIND', t.probeKind);
        const expected = codeToCopy('TOO_LONG', { seconds: T, maxSeconds: 900 });
        c.expectedText = expected;
        check(text === expected, 'ERROR_TEXT', `${text} !== ${expected}`);
        c.ok = true;
      } catch (e) { c.failure = { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 500) }; }
      long.cases.push(c); log('case 4', JSON.stringify({ ok: c.ok, failure: c.failure }));
    }
    // case 5 — case-1 WAV with RIFF/data sizes 0xFFFFFFFF (streaming header): accepted, decoded length exact
    {
      const c = { id: 5, name: 'WAV 15:00.000 with 0xFFFFFFFF RIFF/data sizes → accepted', ok: false };
      try {
        const t0 = Date.now();
        await uploadAndWait(page, files.case5.file, { expect: 'ready', timeout: 180000 });
        c.decodeWallMs = Date.now() - t0;
        const err = await evalError(page); const t = await evalTimings(page); const input = await evalInput(page);
        c.error = err; c.probeKind = t.probeKind; c.probeMs = t.probeMs; c.decodeMs = t.decodeMs; c.decodedLength = input.length;
        check(err === null, 'ERROR_SET', JSON.stringify(err));
        check(t.probeKind === 'wav', 'PROBE_KIND', t.probeKind);
        check(t.decodeMs !== undefined, 'DECODE_MS');
        check(Math.abs(input.length - 39690000) <= 1, 'LENGTH', String(input.length));
        c.ok = true;
      } catch (e) { c.failure = { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 500) }; }
      long.cases.push(c); log('case 5', JSON.stringify({ ok: c.ok, failure: c.failure }));
    }
    long.consoleErrors = consoleErrors;
  } finally {
    await context.close();
  }
  long.allOk = long.cases.length === 5 && long.cases.every((c) => c.ok);
  return long;
}

// ------------------------------------------------------------------------------------------------------------ main
let server = null, browser = null, exitCode = 1;
let launchedAtMs = Date.now();
try {
  server = await startServerIfNeeded(args.base);
  launchedAtMs = Date.now() - 5000;
  const launched = await launchChromium(chromium, { headless: true });
  browser = launched.browser;
  const browserBuild = { channel: launched.channel, version: browser.version() };
  log('browser', JSON.stringify(browserBuild));
  const manifest = await readManifest(args.base);
  const current = readJson(args.out);
  if (!args.long) {
    // Run-to-run noise on this laptop straddles both limits (observed medians 8.2–12.0 s, peaks 1.8–2.5 GB), so the rule is
    // applied to --repeat runs: timing = median of the per-run medians, memory = the worst peak, any failure counts.
    const runs = [];
    for (let i = 0; i < args.repeat; i++) {
      const r = await decisionRun(browser, manifest, VOC_FT);
      runs.push(r);
      log(`voc_ft run ${i + 1}/${args.repeat}`, JSON.stringify({ medianChunkMs: r.medianChunkMs, peakBytes: r.peakBytes, peakSource: r.peakSource, apiSamples: r.samples, threads: r.threads, failed: r.failed }));
      if (r.failed) break;
    }
    const ok = runs.filter((r) => !r.failed && r.medianChunkMs !== null);
    const agg = {
      runs: runs.length,
      medianChunkMs: ok.length ? median(ok.map((r) => r.medianChunkMs)) : null,
      medianChunkMsPerRun: runs.map((r) => r.medianChunkMs),
      peakBytes: ok.some((r) => r.peakBytes !== null) ? Math.max(...ok.filter((r) => r.peakBytes !== null).map((r) => r.peakBytes)) : null,
      peakBytesPerRun: runs.map((r) => r.peakBytes),
      failed: runs.some((r) => r.failed), sessionFailed: runs.some((r) => r.sessionFailed), errorCode: runs.find((r) => r.failed)?.errorCode ?? null,
    };
    const decision = (agg.medianChunkMs === null || agg.medianChunkMs > RULE.maxMedianChunkMs || (agg.peakBytes !== null && agg.peakBytes > RULE.maxPeakBytes) || agg.sessionFailed || agg.failed) ? M9482 : VOC_FT;
    const reasons = [];
    if (agg.failed) reasons.push(`job failed: ${agg.errorCode}`);
    if (agg.medianChunkMs !== null && agg.medianChunkMs > RULE.maxMedianChunkMs) reasons.push(`medianChunkMs ${Math.round(agg.medianChunkMs)} > ${RULE.maxMedianChunkMs}`);
    if (agg.peakBytes !== null && agg.peakBytes > RULE.maxPeakBytes) reasons.push(`peakBytes ${agg.peakBytes} > ${RULE.maxPeakBytes}`);
    if (agg.sessionFailed) reasons.push('session/OOM failure');
    const r1 = runs[0];
    const doc = {
      ...current,
      date: new Date().toISOString(), base: args.base, rule: RULE, repeat: args.repeat, manifestVersion: manifest.version, browserBuild,
      vocFt: { aggregate: agg, runs },
      medianChunkMs: agg.medianChunkMs, chunkSamples: r1.chunkSamples, peakBytes: agg.peakBytes, peakSource: r1.peakSource, samples: r1.samples, threads: r1.threads,
      crossOriginIsolated: r1.crossOriginIsolated, sessionFailed: agg.sessionFailed, errorCode: agg.errorCode,
      decision, decisionReasons: reasons, hardware: `${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 1e9)} GB RAM`,
    };
    delete doc.fallback9482;
    // 9482 always runs once: the fallback check when it is selected, otherwise the informational WASM numbers for the report.
    const r2 = await decisionRun(browser, manifest, M9482);
    doc.run9482 = r2;
    log('9482', JSON.stringify({ medianChunkMs: r2.medianChunkMs, peakBytes: r2.peakBytes, failed: r2.failed }));
    if (decision === M9482) {
      const bad = r2.failed || r2.sessionFailed || (r2.peakBytes !== null && r2.peakBytes > RULE.maxPeakBytes);
      if (bad) {
        doc.fallback9482 = { sessionFailed: r2.sessionFailed, peakBytes: r2.peakBytes, medianChunkMs: r2.medianChunkMs, errorCode: r2.errorCode };
        doc.verified = false;
        writeJson(args.out, doc);
        console.error('WASM_TIER_UNVERIFIED: 9482 also failed the bench', JSON.stringify(doc.fallback9482));
        process.exit(3);
      }
    }
    doc.verified = true;
    writeJson(args.out, doc);
    log('decision', decision, reasons.length ? reasons.join('; ') : '(all rule limits met)', JSON.stringify({ medianChunkMs: agg.medianChunkMs, peakBytes: agg.peakBytes }));
    exitCode = 0;
  } else {
    const modelId = args.model ?? current.decision ?? manifest.tiers.standard.wasm;
    check(manifest.models[modelId], 'BAD_MODEL', modelId);
    const long = await longRun(browser, modelId);
    long.browserBuild = browserBuild;
    writeJson(args.out, { ...readJson(args.out), long });
    log('long cases', JSON.stringify(long.cases.map((c) => ({ id: c.id, ok: c.ok, failure: c.failure ?? null }))));
    exitCode = long.allOk ? 0 : 1;
  }
} catch (e) {
  console.error('[bench] FAIL', e && e.code ? e.code : 'ERROR', e && e.message);
  if (!(e && e.code)) console.error(e && e.stack);
  try { writeJson(args.out, { ...readJson(args.out), failure: { code: e && e.code ? e.code : 'ERROR', message: String(e && e.message).slice(0, 1000) }, date: new Date().toISOString() }); } catch { /* ignore */ }
  exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
