// tests/unit/copy.test.mjs — design §12.3 / §16.A: forbidden-phrase scan over every UI string (static, progress, error and
// site/index.html text), codeToCopy coverage of ERROR_CODES, the exact interpolated renders, and the RENDER_GUARD check over
// strings rendered from REAL thrown details (loader, handler, URL loop, duration probe) through tests/lib/fakes.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STATIC, ERROR_COPY, DEFAULT_ERROR_COPY, codeToCopy, mmss, progress, backendLine, backendLabel, dropZoneHint, fileLine, allStaticStrings, formatRate, importResult } from '../../site/src/ui/copy.mjs';
import { ERROR_CODES, EngineError } from '../../site/src/engine/errors.mjs';
import { loadModelBytes, validateManifest } from '../../site/src/engine/model-loader.mjs';
import { fetchAudioUrl } from '../../site/src/ui/url-input.mjs';
import { probeDuration, durationVerdict } from '../../site/src/ui/decode.mjs';
import { FORBIDDEN, RENDER_GUARD, findForbidden } from '../lib/forbidden.mjs';
import { makeChunkBytes, makeManifest, makeFetchIntoFake, makeFetchFake, makeOrtFake, makeHandlerFixture, makeAudio, waitForPosted, serveMapFor, makeStoreFake } from '../lib/fakes.mjs';
import { encodeStereo, repeatBlocks } from '../lib/mp3-fixtures.mjs';
import { repoRoot } from '../lib/fixtures.mjs';

const assertClean = (text, where) => {
  const hits = findForbidden(text);
  assert.equal(hits.length, 0, `${where}: forbidden phrase ${JSON.stringify(hits)} in ${JSON.stringify(text)}`);
};
const assertRenders = (text, where) => {
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, `${where}: empty`);
  assert.ok(!RENDER_GUARD.test(text), `${where}: render guard hit in ${JSON.stringify(text)}`);
  assertClean(text, where);
};

const SAMPLE_DETAILS = {
  TOO_LONG: [{ seconds: 1052, maxSeconds: 900 }, { seconds: 452, maxSeconds: 360 }, { seconds: 900.5 }],
  URL_STATUS: [{ status: 404 }, { status: 403 }],
  MODEL_DOWNLOAD: [{ bytesSaved: 61 * 1048576, bytesTotal: 219 * 1048576, chunkIndex: 1, chunkCount: 5 }, { bytesSaved: 0, bytesTotal: 29704436 }, { chunkIndex: 0, chunkCount: 1, status: 0 }],
};

function renderedProgress() {
  return [
    progress.downloadLink(12 * 1048576, 45 * 1048576, 3), progress.downloadLink(12 * 1048576, null, 3), progress.downloadLink(0, null, 0),
    progress.decoding(2), progress.downloadModel({ doneBytes: 96 * 1048576, totalBytes: 213 * 1048576 }), progress.downloadModel({ doneBytes: 61 * 1048576, totalBytes: 219 * 1048576, bytesPerSec: 0.3 * 1048576, etaSec: 520, fileIndex: 0, fileCount: 2 }), progress.downloadModel({ doneBytes: 0, totalBytes: 29704436, bytesPerSec: 27 * 1024, etaSec: 1100.4 }), progress.importing(12 * 1048576, 64 * 1048576), progress.verify(1),
    progress.init(backendLabel('webgpu', 8), 3), progress.init(backendLabel('wasm', 8), 3), progress.init(backendLabel('wasm', 1), 3), progress.init(backendLabel('wasm', 1, true), 3),
    progress.separating(17, 55, null, 41), progress.separating(17, 55, backendLabel('wasm', 1), 41), progress.separating(17, 69, null, 185, 580), progress.separating(2, 69, null, 12, null), progress.finalize(83),
    progress.encoding(43, 41, 6), progress.done(83), progress.encodingButton(43),
    backendLine('webgpu', 8), backendLine('wasm', 8), backendLine('wasm', 1), backendLine('wasm', 1, true),
    dropZoneHint(900, false), dropZoneHint(360, true), fileLine('song.mp3', 227),
    importResult([{ displayName: '高质量', bytes: 213 * 1048576 }], 0), importResult([{ displayName: '标准', bytes: 64 * 1048576 }], 1), importResult([], 2), formatRate(27 * 1024), formatRate(0.3 * 1048576),
  ];
}

test('forbidden-phrase list is the brief §1.10 list and the guard is well-formed', () => {
  assert.equal(FORBIDDEN.length, 11);
  for (const re of FORBIDDEN) assert.ok(re instanceof RegExp);
  assert.ok(RENDER_GUARD.test('第 2/undefined 块'));
  assert.ok(RENDER_GUARD.test('x NaN'));
  assert.ok(RENDER_GUARD.test('[object Object]'));
  assert.ok(RENDER_GUARD.test('${x}'));
  assert.ok(!RENDER_GUARD.test('文件超过 15 分钟（当前 17:32）。请裁剪后重试。'));
});

test('every static string, every rendered error and progress string is free of forbidden phrases and render-guard hits', () => {
  for (const s of allStaticStrings()) assertRenders(s, 'static');
  for (const code of [...ERROR_CODES, 'NOPE']) {
    const details = SAMPLE_DETAILS[code] ?? [{}];
    for (const d of details) assertRenders(codeToCopy(code, d), `codeToCopy(${code})`);
  }
  for (const s of renderedProgress()) assertRenders(s, 'progress');
  for (const s of [STATIC.loginUser, STATIC.loginPass, STATIC.loginSubmit, STATIC.logout, STATIC.loginError]) assertRenders(s, 'login');
  assert.ok(dropZoneHint(900, false).includes('最长 15 分钟') && dropZoneHint(900, false).startsWith('拖入音频文件，或点击选择'));
  assert.ok(dropZoneHint(360, true).includes('最长 6 分钟') && dropZoneHint(360, true).startsWith('点击选择音频文件') && !dropZoneHint(360, true).includes('拖入'));
});

test('codeToCopy resolves every ERROR_CODES entry and an unknown code to a non-empty string; default for the codes without a row', () => {
  for (const code of ERROR_CODES) assert.ok(codeToCopy(code, SAMPLE_DETAILS[code]?.[0] ?? {}).length > 0, code);
  assert.equal(codeToCopy('NOPE'), DEFAULT_ERROR_COPY);
  for (const code of ['INFERENCE', 'MODEL_IO', 'NUMERIC', 'WORKER', 'INTERNAL', 'GPU_LOST', 'FFT_SIZE', 'FALLBACK']) assert.equal(codeToCopy(code), DEFAULT_ERROR_COPY, code);
  assert.equal(Object.keys(ERROR_COPY).length, 19);
});

test('exact renders of §12.3', () => {
  assert.equal(codeToCopy('TOO_LONG', { seconds: 1052 }), '文件超过 15 分钟（当前 17:32）。请裁剪后重试。');
  assert.equal(codeToCopy('TOO_LONG', { seconds: 900.5 }), '文件超过 15 分钟（当前 15:01）。请裁剪后重试。');
  assert.equal(codeToCopy('TOO_LONG', { seconds: 452, maxSeconds: 360 }), '文件超过 6 分钟（当前 7:32）。请裁剪后重试。');
  assert.equal(codeToCopy('MODEL_DOWNLOAD', { bytesSaved: 61 * 1048576, bytesTotal: 219 * 1048576, chunkIndex: 1, chunkCount: 5 }), '模型下载失败（已保存 61 MB / 219 MB，刷新后继续）');
  assert.equal(codeToCopy('MODEL_DOWNLOAD', { chunkIndex: 0, chunkCount: 1, status: 0 }), '模型下载失败。请检查网络后重试。');
  assert.equal(codeToCopy('URL_STATUS', { status: 404 }), '链接返回 404。请检查链接，或下载后用本地上传。');
  assert.equal(codeToCopy('LOGIN_FAILED'), '账号或密码错误');
  assert.equal(codeToCopy('CANCELLED'), '已取消。');
  assert.equal(mmss(1052), '17:32');
  assert.equal(mmss(227), '3:47');
  assert.equal(mmss(0), '0:00');
  assert.equal(progress.separating(17, 55, null, 41), '分离中 17/55 段 · 已用 0:41');
  assert.equal(progress.separating(17, 55, backendLabel('wasm', 1), 41), '分离中 17/55 段 · WASM · 1 线程 · 已用 0:41');
  assert.equal(progress.separating(17, 69, null, 185, 580), '分离中 17/69 段 · 已用 3:05 · 预计剩余 9:40');
  assert.equal(progress.separating(17, 69, backendLabel('wasm', 1), 185, 579.2), '分离中 17/69 段 · WASM · 1 线程 · 已用 3:05 · 预计剩余 9:40');
  assert.equal(progress.separating(2, 69, null, 12, null), '分离中 2/69 段 · 已用 0:12');
  assert.equal(progress.finalize(83), '正在合成 · 83s');
  assert.equal(progress.encoding(43, 41, 6), '正在编码 MP3 · 人声 43% · 伴奏 41% · 6s');
  assert.equal(progress.done(83), '用时 83s');
  assert.equal(progress.encodingButton(43), 'MP3 编码中 43%');
  assert.equal(progress.init(backendLabel('wasm', 8), 3), '正在初始化（WASM · 8 线程）· 3s');
  assert.equal(progress.init(backendLabel('webgpu', 8), 3), '正在初始化（WebGPU）· 3s');
  assert.equal(progress.downloadModel({ doneBytes: 96 * 1048576, totalBytes: 213 * 1048576 }), '正在下载模型 · 96 MB / 213 MB');
  assert.equal(progress.downloadModel({ doneBytes: 61 * 1048576, totalBytes: 219 * 1048576, bytesPerSec: 0.3 * 1048576, etaSec: 520 }), '正在下载模型 · 61 MB / 219 MB · 0.3 MB/s · 预计剩余 8:40');
  assert.equal(progress.downloadModel({ doneBytes: 61 * 1048576, totalBytes: 219 * 1048576, bytesPerSec: 0.3 * 1048576, etaSec: 520, fileIndex: 0, fileCount: 2 }), '正在下载模型 · 文件 1/2 · 61 MB / 219 MB · 0.3 MB/s · 预计剩余 8:40');
  assert.equal(progress.downloadModel({ doneBytes: 0.6 * 1048576, totalBytes: 29704436, bytesPerSec: 27 * 1024, etaSec: 1100.4 }), '正在下载模型 · 0.6 MB / 28 MB · 27 KB/s · 预计剩余 18:21');
  assert.equal(progress.downloadModel({ doneBytes: 1048576, totalBytes: 29704436, bytesPerSec: 2.5 * 1048576, etaSec: null }), '正在下载模型 · 1.0 MB / 28 MB · 2.5 MB/s');
  assert.equal(progress.importing(12 * 1048576, 64 * 1048576), '正在导入 · 12 MB / 64 MB');
  assert.equal(formatRate(27 * 1024), '27 KB/s');
  assert.equal(formatRate(0.3 * 1048576), '0.3 MB/s');
  assert.equal(formatRate(18.6 * 1048576), '18.6 MB/s');
  assert.equal(importResult([{ displayName: '高质量', bytes: 213 * 1048576 }], 0), '已导入：高质量（213 MB）');
  assert.equal(importResult([{ displayName: '标准', bytes: 64 * 1048576 }], 1), '已导入：标准（64 MB）；1 个文件与清单不匹配');
  assert.equal(importResult([], 2), '文件与清单不匹配');
  assert.equal(progress.downloadLink(12 * 1048576, 45 * 1048576, 3), '正在下载链接 · 12 MB / 45 MB · 3s');
  assert.equal(progress.downloadLink(12 * 1048576, null, 3), '正在下载链接 · 12 MB · 3s');
  assert.equal(progress.decoding(2), '正在解码音频 · 2s');
  assert.equal(progress.verify(1), '正在校验模型 · 1s');
  assert.equal(backendLine('webgpu', 8), '运行方式：WebGPU');
  assert.equal(backendLine('wasm', 8), '运行方式：WASM · 8 线程');
  assert.equal(backendLine('wasm', 1), '运行方式：WASM · 1 线程');
  assert.equal(backendLine('wasm', 1, true), '运行方式：WASM · 1 线程 · 小模型');
  assert.equal(backendLabel('wasm', 8, false), 'WASM · 8 线程');
  assert.equal(fileLine('song.mp3', 227.9), 'song.mp3 · 3:47');
});

// visible text + title/placeholder/aria-label/alt of site/index.html via a regex tag stripper (no DOM library)
test('site/index.html visible text and attributes are free of forbidden phrases', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'site', 'index.html'), 'utf8');
  const attrs = [];
  for (const m of html.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) attrs.push(m[1]);
  const titleTag = /<title>([^<]*)<\/title>/.exec(html);
  if (titleTag) attrs.push(titleTag[1]);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const pieces = text.split(/\s+/).filter(Boolean);
  assert.ok(pieces.length > 10, 'index.html has visible text');
  assertClean(text, 'index.html text');
  for (const a of attrs) assertRenders(a, 'index.html attribute');
  assert.ok(text.includes('人声分离') && text.includes('账号') && text.includes('密码') && text.includes('登录') && text.includes('退出'));
  assert.ok(attrs.some((a) => a.includes('https://example.com/song.mp3')));
  assert.ok(!/undefined|NaN|\[object /.test(text), 'no render-guard literal in index.html text');
});

// ---------------------------------------------------------------------------------------------- RENDER_GUARD over real details
test('RENDER_GUARD: strings rendered from real thrown details (loader, handler, URL loop, duration probe)', async () => {
  const details = [];
  const subtle = globalThis.crypto.subtle;
  const collect = async (promise) => {
    try { await promise; assert.fail('expected a throw'); } catch (e) {
      assert.ok(e instanceof EngineError, `expected EngineError, got ${e && e.stack}`);
      details.push({ code: e.code, detail: e.detail });
      return e;
    }
  };

  // loader: 503 chunk, corrupted chunk, whole-file mismatch
  const mk = (overrides, patch) => {
    const modelChunks = makeChunkBytes([1000, 1000, 500], 1);
    const manifest = makeManifest({ modelChunks });
    if (patch) patch(manifest);
    validateManifest(manifest);
    const fetchInto = makeFetchIntoFake(serveMapFor(manifest, 'fake_model', modelChunks), overrides);
    return loadModelBytes(manifest, 'fake_model', { fetchInto, store: makeStoreFake(), subtle, baseUrl: 'http://localhost/', warn: () => {}, sleep: async () => {}, limits: { segmentBytes: 400, probeTimeoutMs: 500 } });
  };
  const e503 = await collect(mk((p) => (p.endsWith('part-01.bin') ? { status: 503 } : null)));
  assert.equal(e503.code, 'MODEL_DOWNLOAD');
  assert.equal(e503.detail.bytesTotal, 2500);
  assert.equal(e503.detail.chunkIndex, 1);
  assert.ok(e503.detail.bytesSaved >= 0 && e503.detail.bytesSaved <= 1500);
  assert.ok(codeToCopy('MODEL_DOWNLOAD', e503.detail).startsWith('模型下载失败（已保存 '));
  const eHash = await collect(mk((p) => (p.endsWith('part-01.bin') ? { bytes: makeChunkBytes([1000], 99)[0] } : null)));
  assert.equal(eHash.code, 'MODEL_HASH');
  const eWhole = await collect(mk(() => null, (m) => { m.models.fake_model.files.model.sha256 = 'a'.repeat(64); }));
  assert.equal(eWhole.code, 'MODEL_HASH');
  assert.equal(eWhole.detail.chunkIndex, -1);

  // handler: MODEL_IO (wrong output dims) and INTERNAL (model not valid for the backend)
  const bad = await makeHandlerFixture({ ort: makeOrtFake({ dims: [1, 4, 10, 10] }) });
  const a = makeAudio(10000);
  bad.handler.onMessage(bad.init());
  bad.handler.onMessage({ type: 'separate', jobId: 'j1', tier: 'standard', modelId: 'fake_model', left: a.left, right: a.right, denoise: false });
  await waitForPosted(bad.posted, (p) => p.some((m) => m.type === 'error'));
  const io = bad.posted.find((m) => m.type === 'error');
  assert.equal(io.code, 'MODEL_IO');
  details.push({ code: io.code, detail: io.detail });
  const inv = await makeHandlerFixture({});
  inv.handler.onMessage(inv.init());
  inv.handler.onMessage({ type: 'separate', jobId: 'j2', tier: 'standard', modelId: 'nope', left: a.left, right: a.right, denoise: false });
  await waitForPosted(inv.posted, (p) => p.some((m) => m.type === 'error'));
  const internal = inv.posted.find((m) => m.type === 'error');
  assert.equal(internal.code, 'INTERNAL');
  details.push({ code: internal.code, detail: internal.detail });

  // URL loop: exhausted attempts, direct 403 + proxies failing, direct 404
  const run = (script) => fetchAudioUrl('https://example.org/a.mp3', { fetch: makeFetchFake(script), userSignal: new AbortController().signal, proxies: [{ name: 'p', host: 'p.invalid', build: (u) => 'https://p.invalid/?u=' + encodeURIComponent(u) }] });
  const eFetch = await collect(run(() => new TypeError('Failed to fetch')));
  assert.equal(eFetch.code, 'URL_FETCH');
  const e403 = await collect(run((u) => (u.startsWith('https://example.org') ? { status: 403 } : { status: 500 })));
  assert.equal(e403.code, 'URL_STATUS');
  assert.equal(e403.detail.status, 403);
  const e404 = await collect(run(() => ({ status: 404 })));
  assert.equal(e404.code, 'URL_STATUS');

  // duration probe: 900.5 s 8 kHz mono 8-bit WAV WITH its body; ≈16-minute 320 kbps MP3
  const frames = 7204000;
  const wav = new Uint8Array(44 + frames);
  const dv = new DataView(wav.buffer);
  const w4 = (o, str) => { for (let i = 0; i < 4; i++) wav[o + i] = str.charCodeAt(i); };
  w4(0, 'RIFF'); dv.setUint32(4, 36 + frames, true); w4(8, 'WAVE'); w4(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w4(36, 'data'); dv.setUint32(40, frames, true);
  const pw = await probeDuration(null, wav);
  assert.deepEqual(pw, { seconds: 900.5, exact: true, kind: 'wav' });
  const vw = durationVerdict(pw, 900);
  assert.ok(vw);
  details.push({ code: 'TOO_LONG', detail: vw });
  assert.equal(codeToCopy('TOO_LONG', vw), '文件超过 15 分钟（当前 15:01）。请裁剪后重试。');
  const block = encodeStereo(2.0, 320).bytes;
  const mp3 = repeatBlocks(block, 480);
  const pm = await probeDuration(null, mp3);
  assert.equal(pm.kind, 'mpeg');
  assert.ok(pm.seconds > 950 && pm.seconds < 1000, `≈ 16 min: ${pm.seconds}`);
  const vm = durationVerdict(pm, 900);
  assert.ok(vm);
  details.push({ code: 'TOO_LONG', detail: vm });
  details.push({ code: 'TOO_LONG', detail: durationVerdict({ seconds: 452.2, exact: true }, 360) });

  assert.ok(details.length >= 10);
  for (const { code, detail } of details) assertRenders(codeToCopy(code, detail), `real ${code} ${JSON.stringify(detail)}`);
});
