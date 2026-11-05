// tests/e2e/video_input.mjs — video containers as input (screen recordings): tests/fixtures/clip10.mp4 (10 s of clip25.wav
// as AAC under a black H.264 track) goes through the file input in headless Chromium; the run asserts the accept list and the
// drop-zone copy, the pre-decode probe (audio-element path), the decoded length ≈ 10 s, a completed separation on the audio
// track (stems of the decoded length, finite, non-silent) and valid 320 kbps MP3s.
//   node tests/e2e/video_input.mjs [--base http://127.0.0.1:8010/] [--fixture clip10.mp4] [--out ../evidence/e2e_video_input.json]
// Credentials from VS_TEST_USER / VS_TEST_PASS only.
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright');
import { makeNavCounter, awaitIsolation, startServerIfNeeded, sleep, launchChromium, login } from '../lib/e2e-helpers.mjs';
import { b64ToF32, b64ToU8 } from '../lib/b64.mjs';
import { fixturePath, repoRoot } from '../lib/fixtures.mjs';
import { walk, mpegDuration } from '../../site/src/engine/mp3frames.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const base = (() => { const b = arg('--base', 'http://127.0.0.1:8010/'); return b.endsWith('/') ? b : b + '/'; })();
const fixture = arg('--fixture', 'clip10.mp4');
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'e2e_video_input.json')));
const USER = process.env.VS_TEST_USER, PASS = process.env.VS_TEST_PASS;
if (!USER || !PASS) { console.error('NO_CREDENTIALS: set VS_TEST_USER and VS_TEST_PASS'); process.exit(2); }
const EXPECTED_SECONDS = 10;
const log = (...a) => console.log('[video-e2e]', ...a);
const fail = (code, msg) => { const e = new Error(`${code}: ${msg ?? ''}`); e.code = code; throw e; };
const check = (c, code, msg) => { if (!c) fail(code, msg); };
const B64 = `(u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }`;

const result = { base, fixture, date: new Date().toISOString(), ok: false, consoleErrors: [] };
let server = null, browser = null, exitCode = 1;
try {
  server = await startServerIfNeeded(base);
  const l = await launchChromium(chromium, { headless: true });
  browser = l.browser;
  result.browser = { channel: l.channel, version: browser.version() };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const counter = makeNavCounter(context);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text().slice(0, 300)); });
  const since0 = counter.count();
  await page.goto(base + '?backend=wasm');
  result.crossOriginIsolated = await awaitIsolation(page, { counter, sinceNavigation: since0, maxExtraNavigations: 2 });
  check(await login(page, { user: USER, pass: PASS }) === 'idle', 'LOGIN');
  await page.waitForFunction(() => window.__vs.caps !== null, null, { timeout: 30000 });

  // accept list + copy
  const accept = await page.getAttribute('#file-input', 'accept');
  result.accept = accept;
  for (const want of ['video/*', '.mp4', '.mov', '.webm', '.mkv', 'audio/*']) check(accept.split(',').includes(want), 'ACCEPT', `${want} missing from ${accept}`);
  const hint = await page.textContent('#drop-hint');
  result.dropHint = hint;
  check(hint.includes('mp3 / wav / m4a / aac / flac / ogg / opus / mp4 / mov') && hint.includes('最长 15 分钟'), 'DROP_HINT', hint);

  // the mp4 through the file input → ready
  const file = fixturePath(fixture);
  check(fs.existsSync(file), 'FIXTURE_MISSING', file);
  result.fixtureBytes = fs.statSync(file).size;
  check(result.fixtureBytes < 1024 * 1024, 'FIXTURE_TOO_BIG', String(result.fixtureBytes));
  const t0 = Date.now();
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => window.__vs.state === 'ready' || window.__vs.state === 'error', null, { timeout: 60000 });
  const st = await page.evaluate(() => ({ state: window.__vs.state, error: window.__vs.error }));
  check(st.state === 'ready', st.error?.code ?? 'INPUT_ERROR', JSON.stringify(st.error));
  const input = await page.evaluate(() => { const i = window.__vs.input(); return i ? { duration: i.duration, length: i.length, sampleRate: i.sampleRate } : null; });
  const timings0 = await page.evaluate(() => window.__vs.timings());
  result.input = { ...input, readyMs: Date.now() - t0, probeKind: timings0.probeKind, probeMs: timings0.probeMs, decodeMs: timings0.decodeMs };
  log('input', JSON.stringify(result.input));
  check(input && Math.abs(input.duration - EXPECTED_SECONDS) < 0.1, 'DURATION', `decoded ${input && input.duration} s, expected ≈ ${EXPECTED_SECONDS}`);
  check(input.sampleRate === 44100, 'SAMPLE_RATE', String(input.sampleRate));
  check(Math.abs(input.length - EXPECTED_SECONDS * 44100) <= 0.1 * 44100, 'LENGTH', String(input.length));
  check(timings0.probeKind === 'audio-element', 'PROBE_KIND', `pre-decode probe kind ${timings0.probeKind} (mp4 → <audio> metadata path)`);
  const fileLine = await page.textContent('#file-name');
  result.fileLine = fileLine;
  check(fileLine === `${fixture} · 0:10` || fileLine === `${fixture} · 0:09`, 'FILE_LINE', fileLine);   // floor of 9.99…–10.0x s

  // separation on the audio track
  await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
  const t1 = Date.now();
  await page.click('#start');
  const progress = [];
  for (;;) {
    const s = await page.evaluate(() => window.__vs.state);
    if (s === 'done' || s === 'error') break;
    const pt = await page.textContent('#progress');
    if (progress[progress.length - 1] !== pt) { progress.push(pt); log('state', s, pt); }
    check(Date.now() - t1 < 15 * 60 * 1000, 'JOB_TIMEOUT', s);
    await sleep(500);
  }
  const after = await page.evaluate(() => ({ state: window.__vs.state, error: window.__vs.error }));
  check(after.state === 'done', after.error?.code ?? 'JOB_ERROR', JSON.stringify(after.error));
  const t = await page.evaluate(() => window.__vs.timings());
  result.timings = t;
  result.progress = progress.slice(0, 30);
  result.ran = { backend: t.backend, modelId: t.modelId, threads: t.threads, chunkCount: Array.isArray(t.chunkMs) ? t.chunkMs.length : null, separateMs: Date.now() - t1 };
  log('done', JSON.stringify(result.ran));
  check(t.backend === 'wasm', 'BACKEND', t.backend);
  const stems = [];
  for (let i = 0; i < 4; i++) {
    const b64 = await page.evaluate(({ i, enc }) => { const a = window.__vs.stems()[i]; const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); return (new Function('return ' + enc)())(u8); }, { i, enc: B64 });
    stems.push(b64ToF32(b64));
  }
  const n = stems[0].length;
  check(n === input.length, 'STEM_LENGTH', `${n} vs decoded ${input.length}`);
  const energy = stems.map((s) => { let e = 0; let finite = true; for (let i = 0; i < s.length; i++) { const v = s[i]; if (v !== v || v === Infinity || v === -Infinity) finite = false; e += v * v; } return { energy: e, finite }; });
  result.stems = { samples: n, vocalsEnergy: energy[0].energy + energy[1].energy, instEnergy: energy[2].energy + energy[3].energy, finite: energy.every((e) => e.finite) };
  check(result.stems.finite, 'STEM_NONFINITE');
  check(result.stems.vocalsEnergy > 0 && result.stems.instEnergy > 0, 'STEM_SILENT', JSON.stringify(result.stems));

  // MP3s (320 kbps CBR stereo, duration Δ within the encoder slack)
  result.mp3 = {};
  for (const stem of ['vocals', 'instrumental']) {
    const b64 = await page.evaluate(async ({ stem, enc }) => { const blob = window.__vs.mp3(stem); if (!blob) return null; return (new Function('return ' + enc)())(new Uint8Array(await blob.arrayBuffer())); }, { stem, enc: B64 });
    check(b64 !== null, 'MP3_MISSING', stem);
    const bytes = b64ToU8(b64);
    const w = walk(bytes);
    check(w.junkBytes === 0 && w.frames.length > 0, 'MP3_FRAMES', stem);
    for (const f of w.frames) check(bytes[f.offset] === 0xFF && ((bytes[f.offset + 1] >> 3) & 3) === 3 && ((bytes[f.offset + 1] >> 1) & 3) === 1 && (bytes[f.offset + 2] >> 4) === 0xE && ((bytes[f.offset + 2] >> 2) & 3) === 0, 'MP3_HEADER', stem);
    const d = mpegDuration(bytes);
    const delta = Math.round(d.seconds * 44100) - n;
    check(delta >= 0 && delta <= 576 + 2 * 1152, 'MP3_DURATION', `${stem}: Δ ${delta}`);
    result.mp3[stem] = { bytes: bytes.length, frames: w.frames.length, durationS: d.seconds, deltaSamples: delta };
  }
  const dlName = await page.getAttribute('#dl-vocals-mp3', 'download');
  check(dlName === `${fixture.replace(/\.[^.]+$/, '')}_人声.mp3`, 'DOWNLOAD_NAME', dlName);
  result.downloadName = dlName;
  try { await page.screenshot({ path: outFile.replace(/\.json$/, '.png') }); } catch { /* ignore */ }
  await page.click('#logout');
  result.ok = true;
  exitCode = 0;
  log('PASS');
} catch (e) {
  result.ok = false;
  result.failure = { code: e && e.code ? e.code : 'ERROR', message: String(e && e.message).slice(0, 2000) };
  console.error('[video-e2e] FAIL', result.failure.code, result.failure.message);
  if (!(e && e.code)) console.error(e && e.stack);
} finally {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
  log('wrote', outFile);
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (server) server.stop();
}
process.exit(exitCode);
