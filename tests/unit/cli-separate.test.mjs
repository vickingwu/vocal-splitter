// tests/unit/cli-separate.test.mjs — scripts/cli_separate.mjs without ffmpeg or a model: the pure helpers of scripts/lib/cli_lib.mjs
// (arguments, model choice, output names, ffmpeg argument lists, ffprobe parsing, duration cap), the file-system part store
// (scripts/lib/fs_store.mjs) and the Node http fetchInto adapter (scripts/lib/fetch_into_http.mjs) against a local node:http
// server, including one real loadModelBytes run over http into the fs store (what the GitHub Actions runner does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseArgs, chooseModelId, baseName, outputNames, ffprobeArgs, parseProbe, durationVerdict, ffmpegDecodeArgs, ffmpegEncodeArgs, mmss, DEFAULTS } from '../../scripts/lib/cli_lib.mjs';
import { createFsStore } from '../../scripts/lib/fs_store.mjs';
import { fetchIntoHttp, makeFetchInto } from '../../scripts/lib/fetch_into_http.mjs';
import { validateManifest, loadModelBytes } from '../../site/src/engine/model-loader.mjs';
import { fileKey } from '../../site/src/engine/part-store.mjs';
import { makeChunkBytes, makeManifest, serveMapFor, concatBytes } from '../lib/fakes.mjs';
import { readManifest, repoRoot } from '../lib/fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cli-test-'));

test('parseArgs: defaults, flags, --key=value, errors', () => {
  const a = parseArgs(['song.mp3']);
  assert.equal(a.input, 'song.mp3');
  assert.equal(a.model, null); assert.equal(a.tier, 'standard'); assert.equal(a.out, 'out'); assert.equal(a.wav, false); assert.equal(a.maxSeconds, 900);
  assert.equal(a.modelsBase, null); assert.equal(a.cache, null); assert.equal(a.sources, null); assert.equal(a.json, null);
  const b = parseArgs(['--out', 'o', '--wav', 'in.mp4', '--model=uvr_mdxnet_9482', '--max-seconds', '60', '--sources', 'origin, raw-github', '--models-base', 'https://x/site/', '--cache', 'c', '--json', 'r.json', '--name', 'n', '--denoise', '--tier', 'hq', '--ffmpeg', 'f', '--ffprobe', 'p']);
  assert.equal(b.input, 'in.mp4'); assert.equal(b.out, 'o'); assert.equal(b.wav, true); assert.equal(b.model, 'uvr_mdxnet_9482'); assert.equal(b.maxSeconds, 60);
  assert.deepEqual(b.sources, ['origin', 'raw-github']); assert.equal(b.modelsBase, 'https://x/site/'); assert.equal(b.cache, 'c'); assert.equal(b.json, 'r.json');
  assert.equal(b.name, 'n'); assert.equal(b.denoise, true); assert.equal(b.tier, 'hq'); assert.equal(b.ffmpeg, 'f'); assert.equal(b.ffprobe, 'p');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs([]).input, null);
  assert.equal(parseArgs(['--', '--weird.mp3']).input, '--weird.mp3');
  assert.throws(() => parseArgs(['a', 'b']), /BAD_ARG: unexpected argument b/);
  assert.throws(() => parseArgs(['a', '--nope']), /BAD_ARG: unknown option --nope/);
  assert.throws(() => parseArgs(['a', '--out']), /needs a value/);
  assert.throws(() => parseArgs(['a', '--out', '--wav']), /needs a value/);
  assert.throws(() => parseArgs(['a', '--tier', 'ultra']), /--tier must be standard or hq/);
  assert.throws(() => parseArgs(['a', '--max-seconds', '0']), /--max-seconds/);
  assert.throws(() => parseArgs(['a', '--max-seconds', 'x']), /--max-seconds/);
  assert.equal(Object.isFrozen(DEFAULTS), true);
});

test('chooseModelId on the real manifest: --model wins, standard → the wasm model, hq → the webgpu model, errors', () => {
  const manifest = validateManifest(readManifest());
  assert.equal(chooseModelId(manifest, {}), manifest.tiers.standard.wasm);
  assert.equal(chooseModelId(manifest, { tier: 'standard' }), 'uvr_mdx_voc_ft');
  assert.equal(chooseModelId(manifest, { tier: 'hq' }), 'melroformer_duality_student');
  assert.equal(chooseModelId(manifest, { model: 'uvr_mdxnet_9482', tier: 'hq' }), 'uvr_mdxnet_9482');
  assert.throws(() => chooseModelId(manifest, { model: 'nope' }), /UNKNOWN_MODEL: nope; known: uvr_mdx_voc_ft/);
  assert.throws(() => chooseModelId({ tiers: {}, models: {} }, { tier: 'hq' }), /NO_MODEL_FOR_TIER: hq/);
});

test('baseName / outputNames: input name without extension, --name override, unsafe characters, length cap, empty → audio', () => {
  assert.equal(baseName('/tmp/in/My Song.final.mp3'), 'My Song.final');
  assert.equal(baseName('C:\\x\\录屏 2026-11-04.mov'), '录屏 2026-11-04');
  assert.equal(baseName('a.mp3', 'custom'), 'custom');
  assert.equal(baseName('a.mp3', '   '), 'a');
  assert.equal(baseName('a/b:c*d?.wav'), 'b_c_d_', 'file-system characters replaced');
  assert.equal(baseName('.mp3'), 'audio');
  assert.equal(baseName(''), 'audio');
  assert.equal(baseName('x'.repeat(200) + '.mp3').length, 80);
  assert.deepEqual(outputNames('clip25'), { vocalsWav: '人声-clip25.wav', instWav: '伴奏-clip25.wav', vocalsMp3: '人声-clip25.mp3', instMp3: '伴奏-clip25.mp3' });
});

test('ffmpeg / ffprobe argument lists and probe parsing', () => {
  const dec = ffmpegDecodeArgs('in.mp4', 'o.wav');
  assert.ok(dec.includes('-nostdin') && dec.includes('-y') && dec.indexOf('-i') === dec.indexOf('in.mp4') - 1);
  assert.deepEqual(dec.slice(dec.indexOf('-map'), dec.indexOf('-map') + 2), ['-map', '0:a:0'], 'first audio stream only');
  assert.deepEqual(dec.slice(-10), ['-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', '-f', 'wav', 'o.wav'], 'stereo 44.1 kHz float32 WAV, video dropped');
  const enc = ffmpegEncodeArgs('s.wav', 's.mp3');
  assert.deepEqual(enc.slice(enc.indexOf('-c:a')), ['-c:a', 'libmp3lame', '-b:a', '320k', '-joint_stereo', '0', '-f', 'mp3', 's.mp3']);
  const probe = ffprobeArgs('x.mov');
  assert.equal(probe[probe.length - 1], 'x.mov');
  assert.ok(probe.includes('-show_entries') && probe.includes('json'));
  const p = parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }], format: { duration: '10.0' } }));
  assert.deepEqual(p, { seconds: 10, audioStreams: 1, codec: 'aac', sampleRate: 48000, channels: 2 });
  assert.throws(() => parseProbe({ streams: [{ codec_type: 'video' }], format: { duration: '3' } }), /NO_AUDIO/);
  assert.throws(() => parseProbe({ streams: [{ codec_type: 'audio' }], format: {} }), /NO_DURATION/);
  assert.deepEqual(durationVerdict(900.5, 900), { seconds: 900.5, maxSeconds: 900 });
  assert.equal(durationVerdict(900, 900), null);
  assert.equal(mmss(1052), '17:32'); assert.equal(mmss(0), '0:00'); assert.equal(mmss(59.9), '0:59');
});

test('fs store: put/get/delete/keys with the part-store key shapes, atomic temp files ignored, missing → null', async () => {
  const dir = tmp();
  const store = createFsStore(dir);
  assert.equal(store.name, 'fs');
  const k1 = 'm:' + 'a'.repeat(64), k2 = k1 + ':part-0', k3 = k1 + ':part-12', other = 'n:' + 'b'.repeat(64);
  assert.equal(await store.get(k1), null);
  assert.equal(await store.put(k2, Uint8Array.from([1, 2, 3])), true);
  await store.put(k3, new Uint8Array(5).fill(9));
  await store.put(other, Uint8Array.from([7]));
  fs.writeFileSync(path.join(dir, 'junk.123.tmp'), 'x');
  assert.deepEqual(Array.from(await store.get(k2)), [1, 2, 3]);
  assert.deepEqual((await store.keys(k1 + ':part-')).sort(), [k2, k3]);
  assert.deepEqual((await store.keys('')).sort(), [k2, k3, other].sort());
  assert.ok(fs.existsSync(path.join(dir, encodeURIComponent(k2))), 'file name = encodeURIComponent(key)');
  await store.delete(k2);
  await store.delete(k2);                                    // idempotent
  assert.equal(await store.get(k2), null);
  assert.deepEqual(await store.keys(k1), [k3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// a Range-capable static server over `files` (path → bytes); `mode` 'ranges' | 'ignore-range' (200 + whole body) | 'gzip-header'
function serve(files, mode = 'ranges') {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push({ path: u.pathname, range: req.headers.range ?? null, encoding: req.headers['accept-encoding'] ?? null });
    const body = files[u.pathname];
    if (!body) { res.statusCode = 404; res.end('nope'); return; }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (m && mode === 'ranges') {
      const s = Number(m[1]), e = Math.min(Number(m[2]), body.length - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${s}-${e}/${body.length}`);
      res.setHeader('Content-Length', String(e - s + 1));
      res.end(Buffer.from(body.subarray(s, e + 1)));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', String(body.length));
    res.end(Buffer.from(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) })));
}

test('fetchIntoHttp: 206 Range into the slot, 200-to-Range → rangeIgnored (read up to the slot), overflow guard, 404, identity encoding, onBytes final count', async () => {
  const body = makeChunkBytes([5000], 3)[0];
  const s = await serve({ '/a.bin': body });
  try {
    const target = new Uint8Array(1000);
    const headers = [];
    const bytes = [];
    const r = await fetchIntoHttp(new URL('a.bin', s.base), target, { range: { start: 1000, end: 1999 }, onHeaders: (h) => headers.push(h), onBytes: (b) => bytes.push(b) });
    assert.equal(r.ok, true); assert.equal(r.status, 206); assert.equal(r.received, 1000); assert.equal(r.rangeIgnored, false);
    assert.equal(r.contentLength, 1000); assert.equal(r.contentRange, 'bytes 1000-1999/5000'); assert.equal(r.contentEncoding, null);
    assert.deepEqual(Array.from(target.subarray(0, 8)), Array.from(body.subarray(1000, 1008)));
    assert.equal(headers.length, 1); assert.equal(headers[0].status, 206); assert.equal(headers[0].received, 0);
    assert.equal(bytes[bytes.length - 1], 1000, 'the final onBytes reports every written byte');
    assert.ok(/identity/.test(s.hits[0].encoding) && !/gzip|br|deflate/.test(s.hits[0].encoding), `Accept-Encoding ${s.hits[0].encoding}: no compressed representation`);
    // a whole request without range: body longer than the slot → overflow marker, nothing past the slot
    const small = new Uint8Array(100);
    const o = await fetchIntoHttp(new URL('a.bin', s.base), small, {});
    assert.equal(o.received, 101); assert.equal(o.ok, true);
    // exact fit
    const exact = new Uint8Array(5000);
    const e = await fetchIntoHttp(new URL('a.bin', s.base), exact, {});
    assert.equal(e.received, 5000); assert.deepEqual(Array.from(exact.subarray(4990)), Array.from(body.subarray(4990)));
    // 404
    const nf = await fetchIntoHttp(new URL('missing.bin', s.base), new Uint8Array(10), {});
    assert.equal(nf.ok, false); assert.equal(nf.status, 404); assert.equal(nf.received, 0);
  } finally { await s.close(); }
  // a host that ignores Range: 200 → rangeIgnored, the slot is filled from the start of the body and the read stops there
  const s2 = await serve({ '/a.bin': body }, 'ignore-range');
  try {
    const target = new Uint8Array(1000);
    const r = await fetchIntoHttp(new URL('a.bin', s2.base), target, { range: { start: 1000, end: 1999 } });
    assert.equal(r.status, 200); assert.equal(r.rangeIgnored, true); assert.equal(r.received, 1000);
    assert.deepEqual(Array.from(target.subarray(0, 8)), Array.from(body.subarray(0, 8)), 'a 200 body starts at byte 0');
  } finally { await s2.close(); }
});

test('makeFetchInto dispatches http(s) to the network and localhost URLs to the file-system adapter', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'models', 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'm', 'p.bin'), Buffer.from([9, 8, 7]));
  const fetchInto = makeFetchInto(dir);
  const t1 = new Uint8Array(3);
  const r1 = await fetchInto(new URL('http://localhost/models/m/p.bin?v=1'), t1, {});
  assert.equal(r1.ok, true); assert.deepEqual(Array.from(t1), [9, 8, 7]);
  const s = await serve({ '/models/m/p.bin': Uint8Array.from([1, 2, 3, 4]) });
  try {
    const t2 = new Uint8Array(4);
    const r2 = await fetchInto(new URL('models/m/p.bin', s.base), t2, {});
    assert.equal(r2.status, 200); assert.deepEqual(Array.from(t2), [1, 2, 3, 4]);
    assert.equal(s.hits.length, 1);
  } finally { await s.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadModelBytes over http (origin only) into the fs store: assembled file stored under its key, parts gone, second load from the store without a request', async () => {
  const chunks = makeChunkBytes([3000, 3000, 1500], 5);
  const manifest = makeManifest({ modelChunks: chunks, version: 'cli-test' });
  validateManifest(manifest);
  const files = Object.fromEntries(Object.entries(serveMapFor(manifest, 'fake_model', chunks)).map(([p, b]) => ['/site/' + p, b]));
  const s = await serve(files);
  const dir = tmp();
  try {
    const store = createFsStore(dir);
    const baseUrl = s.base + 'site/';
    const deps = { fetchInto: makeFetchInto(repoRoot), store, subtle: globalThis.crypto.subtle, baseUrl, sourceIds: ['origin'], warn: () => {}, limits: { segmentBytes: 1024, probeTimeoutMs: 2000 } };
    const events = [];
    const r1 = await loadModelBytes(manifest, 'fake_model', deps, (e) => events.push(e.stage));
    assert.deepEqual(Array.from(r1.bytes), Array.from(concatBytes(chunks)));
    assert.equal(r1.report.downloadedBytes, 7500);
    assert.deepEqual(r1.report.fromStore, []);
    assert.equal(r1.report.sources.length, 1); assert.equal(r1.report.sources[0].id, 'origin'); assert.equal(r1.report.sources[0].ranges, true, 'the probe saw a clean 206');
    assert.ok(s.hits.every((h) => h.path.startsWith('/site/models/fake_model/')), JSON.stringify(s.hits.slice(0, 3)));
    assert.ok(s.hits.some((h) => h.range !== null), 'Range requests were made');
    const key = fileKey('fake_model', manifest.models.fake_model.files.model.sha256);
    assert.deepEqual(await store.keys(''), [key], 'only the assembled file remains in the store');
    assert.equal((await store.get(key)).length, 7500);
    const hitsAfterFirst = s.hits.length;
    const r2 = await loadModelBytes(manifest, 'fake_model', deps, () => {});
    assert.deepEqual(r2.report.fromStore, ['fake.onnx']);
    assert.equal(r2.report.downloadedBytes, 0);
    assert.equal(s.hits.length, hitsAfterFirst, 'the second load made no request');
    assert.deepEqual(Array.from(r2.bytes), Array.from(r1.bytes));
    assert.ok(events.includes('download'));
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
