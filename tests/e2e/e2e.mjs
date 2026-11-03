// tests/e2e/e2e.mjs — browser E2E harness (design §16.C, §22.6, §23.6; design_accepted DA-4).
//   node tests/e2e/e2e.mjs --base http://127.0.0.1:8010/ --backend wasm|webgpu [--tier standard|hq] [--model <id>]
//        [--fixture clip25|clip25_48k] [--browser chromium|webkit] [--device "<name>"] [--cdp http://127.0.0.1:9222]
//        [--retry] [--out ../evidence/e2e_<tag>.json]   (--expect-fallback <reason> and --no-sw arrive with FEAT-004)
// Credentials come ONLY from VS_TEST_USER / VS_TEST_PASS in the environment; they are never written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { makeNavCounter, awaitIsolation, startServerIfNeeded, readManifest, sleep } from '../lib/e2e-helpers.mjs';
import { b64ToF32, b64ToU8 } from '../lib/b64.mjs';
import { fixturePath, referenceStems, repoRoot } from '../lib/fixtures.mjs';
import { readWav } from '../../site/src/engine/wav.mjs';
import { walk, mpegDuration } from '../../site/src/engine/mp3frames.mjs';
import { snrStereoDb } from '../lib/snr.mjs';

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
  expectFallback: arg('--expect-fallback', flag('--expect-fallback') ? 'true' : undefined),
  noSw: flag('--no-sw'),
};
if (!args.base.endsWith('/')) args.base += '/';
if (!['wasm', 'webgpu'].includes(args.backend)) { console.error(`BAD_ARG: --backend ${args.backend}`); process.exit(2); }
if (!['standard', 'hq'].includes(args.tier)) { console.error(`BAD_ARG: --tier ${args.tier}`); process.exit(2); }
if (!['clip25', 'clip25_48k'].includes(args.fixture)) { console.error(`BAD_ARG: --fixture ${args.fixture}`); process.exit(2); }
if (!['chromium', 'webkit'].includes(args.browser)) { console.error(`BAD_ARG: --browser ${args.browser}`); process.exit(2); }
if (args.device && !devices[args.device]) { console.error(`BAD_ARG: unknown device "${args.device}"`); process.exit(2); }
if (args.expectFallback !== undefined || args.noSw) { console.error('NOT_IMPLEMENTED: --expect-fallback and --no-sw are implemented in FEAT-004'); process.exit(2); }

const USER = process.env.VS_TEST_USER;
const PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS in the environment'); process.exit(2); }

const tag = args.out ? path.basename(args.out).replace(/^e2e_/, '').replace(/\.json$/, '') : `${args.browser}_${args.backend}`;
const outFile = args.out ? path.resolve(args.out) : path.resolve(repoRoot, '..', 'evidence', `e2e_${tag}.json`);
const mobile = args.device !== undefined && /iPhone|iPad/.test(devices[args.device].userAgent);
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const SNR_THRESHOLD = args.fixture === 'clip25' ? 25 : 20;
const SNR_LABEL = args.fixture === 'clip25' ? 'parity' : 'resample_smoke';
const EXPECTED_SAMPLES = 1102500;
const MP3_SLACK = 576 + 2 * 1152;

const log = (...a) => console.log('[e2e]', ...a);
const fail = (code, msg) => { const e = new Error(`${code}: ${msg ?? ''}`); e.code = code; throw e; };
const check = (cond, code, msg) => { if (!cond) fail(code, msg); };

// ---------------------------------------------------------------------------------------------------------- page helpers
const evalState = (page) => page.evaluate(() => window.__vs.state);
const evalVs = (page) => page.evaluate(() => ({ state: window.__vs.state, loggedIn: window.__vs.loggedIn, error: window.__vs.error, backend: window.__vs.backend, isolated: window.__vs.isolated }));
const token = (page) => page.evaluate(() => { try { return localStorage.getItem('vs-session'); } catch { return 'EXC'; } });
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const st = getComputedStyle(el); return !el.hidden && st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null; }, sel);
const waitState = async (page, pred, timeout) => page.waitForFunction((src) => (new Function('s', `return (${src})(s)`))(window.__vs.state), pred.toString(), { timeout, polling: 250 });

async function waitForJob(page, { timeout, onTick }) {
  const t0 = Date.now();
  for (;;) {
    const st = await evalState(page);
    if (onTick) await onTick(st);
    if (st === 'done' || st === 'error') return st;
    if (Date.now() - t0 > timeout) fail('JOB_TIMEOUT', `state ${st} after ${Math.round((Date.now() - t0) / 1000)} s`);
    await sleep(500);
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

// ------------------------------------------------------------------------------------------------------------ main
const result = {
  base: args.base, requested: { backend: args.backend, tier: args.tier, model: args.model ?? null, fixture: args.fixture, browser: args.browser, device: args.device ?? null, retry: args.retry },
  ran: null, crossOriginIsolated: null, navigations: null, adapterInfo: null,
  login: { negativeOk: false, persistedOk: false, logoutOk: false, hrefUnchanged: false, noPreLoginRequests: false },
  snr: null, mp3: null, timings: null, retry: null, consoleErrors: [], date: new Date().toISOString(),
};
let server = null, browser = null, context = null, exitCode = 1;
const writeOut = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8'); log('wrote', outFile); };

try {
  server = await startServerIfNeeded(args.base);
  log('server', server.started ? 'started by the harness' : 'already answering', args.base);

  // ---- browser selection (§16.C)
  if (args.cdp) {
    let ok = false;
    try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000); const r = await fetch(new URL('/json/version', args.cdp).href, { signal: ac.signal }); clearTimeout(t); ok = r.ok; } catch { ok = false; }
    check(ok, 'CDP_DOWN', `${args.cdp}/json/version did not answer`);
    browser = await chromium.connectOverCDP(args.cdp);
    context = browser.contexts()[0] ?? await browser.newContext({ acceptDownloads: true });
  } else if (args.backend === 'webgpu') {
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
    const probeCtx = await browser.newContext();
    const probePage = await probeCtx.newPage();
    await probePage.goto('about:blank');
    const info = await probePage.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); if (!a) return null; const i = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : {}); return { vendor: i.vendor ?? '', architecture: i.architecture ?? '' }; });
    await probeCtx.close();
    result.adapterInfo = info;
    const software = !info || /google|swiftshader/i.test(info.vendor) || /swiftshader/i.test(info.architecture);
    if (software) {
      result.webgpu = 'not exercised (software adapter)';
      writeOut();
      await browser.close();
      server.stop();
      process.exit(0);
    }
    context = await browser.newContext({ ...(args.device ? devices[args.device] : { viewport: { width: 1280, height: 900 } }), acceptDownloads: true });
  } else {
    const type = args.browser === 'webkit' ? webkit : chromium;
    browser = await type.launch({ headless: true });
    context = await browser.newContext({ ...(args.device ? devices[args.device] : { viewport: { width: 1280, height: 900 } }), acceptDownloads: true });
  }

  const counter = makeNavCounter(context);
  const page = await context.newPage();
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => result.consoleErrors.push('pageerror: ' + String(e && e.message).slice(0, 300)));

  const url = args.base + `?backend=${args.backend}&tier=${args.tier}` + (args.model ? `&model=${encodeURIComponent(args.model)}` : '');
  log('goto', url);
  const since0 = counter.count();
  await page.goto(url);
  result.crossOriginIsolated = await awaitIsolation(page, { counter, sinceNavigation: since0, maxExtraNavigations: 2 });
  result.navigations = counter.count();
  log('isolated', result.crossOriginIsolated, 'navigations', result.navigations);

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
  await page.waitForFunction(() => window.__vs.state === 'idle', null, { timeout: 30000 });
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

  // persistence across reload
  const since1 = counter.count();
  await page.reload();
  await awaitIsolation(page, { counter, sinceNavigation: since1, maxExtraNavigations: 1 });
  check(await evalState(page) === 'idle', 'PERSIST_STATE', `after reload: ${await evalState(page)}`);
  check(!(await visible(page, '#login')), 'PERSIST_FORM', 'form shown after reload despite the token');
  result.login.persistedOk = true;
  log('persistence ok');

  // ---- expected model
  const manifest = await readManifest(args.base);
  const expectedModelId = args.model ?? manifest.tiers[args.tier]?.[args.backend === 'wasm' && mobile ? 'wasmLow' : args.backend];
  check(expectedModelId !== undefined, 'NO_MODEL_FOR_BACKEND', `tier ${args.tier} has no ${args.backend} model`);
  result.expectedModelId = expectedModelId;

  // ---- input + start
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });
  const policy = await page.evaluate(() => window.__vs.caps && window.__vs.caps.policy);
  result.policy = policy;
  await page.setInputFiles('#file-input', fixturePath(`${args.fixture}.wav`));
  await page.waitForFunction(() => window.__vs.state === 'ready' || window.__vs.state === 'error', null, { timeout: 60000 });
  if (await evalState(page) === 'error') fail((await evalVs(page)).error?.code ?? 'INPUT_ERROR', JSON.stringify((await evalVs(page)).error));
  await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('#model-select option')).map((o) => o.value));
  check(options.includes(args.tier), 'TIER_NOT_OFFERED', `options ${options.join(',')}`);
  await page.selectOption('#model-select', args.tier);
  const t0 = Date.now();
  await page.click('#start');
  let keepAwakeSeen = false;
  let keepAwakeText = null;
  const st = await waitForJob(page, { timeout: JOB_TIMEOUT_MS, onTick: async (s) => { if (await visible(page, '#keep-awake')) { keepAwakeSeen = true; keepAwakeText = await page.evaluate(() => document.getElementById('keep-awake').textContent); } if (s !== 'done' && s !== 'error') log('state', s, await page.evaluate(() => document.getElementById('progress').textContent)); } });
  if (st === 'error') { const vs = await evalVs(page); console.error('[e2e] __vs.error', JSON.stringify(vs.error)); fail(vs.error?.code ?? 'JOB_ERROR', JSON.stringify(vs.error)); }
  log('done in', Math.round((Date.now() - t0) / 1000), 's');
  if (mobile) { check(keepAwakeSeen && keepAwakeText === '处理中请保持屏幕亮起', 'KEEP_AWAKE_MISSING'); check(!(await visible(page, '#keep-awake')), 'KEEP_AWAKE_STUCK'); }
  else check(!keepAwakeSeen, 'KEEP_AWAKE_ON_DESKTOP');
  result.keepAwakeSeen = keepAwakeSeen;

  // ---- backend / model first
  const t = await page.evaluate(() => window.__vs.timings());
  result.timings = t;
  check(t.backend === args.backend, 'BACKEND_MISMATCH', `requested ${args.backend}, ran ${t.backend}`);
  check(t.modelId === expectedModelId, 'MODEL_MISMATCH', `expected ${expectedModelId}, ran ${t.modelId}`);
  check(t.fellBack === false, 'UNEXPECTED_FALLBACK');
  result.ran = { backend: t.backend, modelId: t.modelId, tier: t.tier, threads: t.threads, fellBack: t.fellBack };
  const vsAfter = await evalVs(page);
  check(vsAfter.backend && vsAfter.backend.name === args.backend && vsAfter.backend.modelId === expectedModelId, 'VS_BACKEND', JSON.stringify(vsAfter.backend));
  const backendLine = await page.evaluate(() => document.getElementById('backend-line').textContent);
  check(backendLine.includes(args.backend === 'wasm' ? 'WASM' : 'WebGPU'), 'BACKEND_LINE', backendLine);
  if (result.crossOriginIsolated === false) check(t.threads === 1, 'THREADS', `not isolated but threads ${t.threads}`);

  // ---- quality
  const stems = [await readStem(page, 0), await readStem(page, 1), await readStem(page, 2), await readStem(page, 3)];
  const n = stems[0].length;
  check(Math.abs(n - EXPECTED_SAMPLES) <= 1, 'STEM_LENGTH', `decoded length ${n}`);
  const snr = snrOfStems(t.modelId, stems);
  result.snr = { ...snr, threshold: SNR_THRESHOLD, label: SNR_LABEL, modelId: t.modelId, samples: n };
  log('snr', JSON.stringify(result.snr));
  check(snr.vocalsDb >= SNR_THRESHOLD, 'SNR_VOCALS', `${snr.vocalsDb.toFixed(2)} dB < ${SNR_THRESHOLD}`);
  check(snr.instDb >= SNR_THRESHOLD, 'SNR_INST', `${snr.instDb.toFixed(2)} dB < ${SNR_THRESHOLD}`);

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
    check(t2.backend === args.backend && t2.modelId === expectedModelId && t2.fellBack === false, 'RETRY_BACKEND', JSON.stringify({ backend: t2.backend, modelId: t2.modelId, fellBack: t2.fellBack }));
    check(t2.decodeMs === t.decodeMs, 'RETRY_DECODE_MS_CHANGED');
    check(typeof t2.dispatchDecodeMs === 'number', 'RETRY_NO_REDECODE', `dispatchDecodeMs ${t2.dispatchDecodeMs}`);
    const stems2 = [await readStem(page, 0), await readStem(page, 1), await readStem(page, 2), await readStem(page, 3)];
    check(Math.abs(stems2[0].length - EXPECTED_SAMPLES) <= 1, 'RETRY_STEM_LENGTH', String(stems2[0].length));
    const snr2 = snrOfStems(t2.modelId, stems2);
    check(snr2.vocalsDb >= SNR_THRESHOLD && snr2.instDb >= SNR_THRESHOLD, 'RETRY_SNR', JSON.stringify(snr2));
    result.retry = { ok: true, chunkCount: first, chunkCount2: t2.chunkMs.length, dispatchDecodeMs: t2.dispatchDecodeMs, snr: snr2, timings: t2 };
    log('retry ok', JSON.stringify({ chunkCount: first, dispatchDecodeMs: t2.dispatchDecodeMs }));
  }

  // ---- screenshot (viewport only; never read back)
  try { await page.screenshot({ path: path.join(path.dirname(outFile), `e2e_${tag}.png`), fullPage: false }); } catch (e) { log('screenshot failed', e.message); }

  // ---- logout (last step of every run)
  const since2 = counter.count();
  await page.click('#logout');
  await awaitIsolation(page, { counter, sinceNavigation: since2, maxExtraNavigations: 1 });
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
} finally {
  writeOut();
  try { if (context && !args.cdp) await context.close(); } catch { /* ignore */ }
  try { if (browser && !args.cdp) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
