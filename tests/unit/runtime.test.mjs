// tests/unit/runtime.test.mjs — FIX-3 R5: the ONNX Runtime files as managed assets. Manifest validation of `runtime`,
// runtime source ranking (probe on the .wasm, range-less whole-file sources allowed for single-chunk files), cache keys
// (`runtime:<name>:<sha256>`), the loader path (loadRuntimeBytes, RUNTIME_DOWNLOAD / RUNTIME_HASH, the compressed-range
// resume reset), the offline import of runtime files, the handler order (runtime → configureRuntime → model → session,
// progress tagged asset: 'runtime', runtimeLoaded on a session fallback) and the state.mjs error mapping (an XHR /
// network session failure → RUNTIME_DOWNLOAD, never GPU_ONLY_MODEL; a real device loss → GPU_ONLY_MODEL with its reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, runtimeFiles, runtimeFileId, loadRuntimeBytes, loadModelBytes, sweepStaleEntries, RUNTIME_DIR } from '../../site/src/engine/model-loader.mjs';
import { resolveSources, probeSources } from '../../site/src/engine/sources.mjs';
import { fileKey, partKey } from '../../site/src/engine/part-store.mjs';
import { candidatesForSize, importModelFiles } from '../../site/src/engine/model-import.mjs';
import { reduce, createInitialState, isNetworkFailureMessage } from '../../site/src/ui/state.mjs';
import { codeToCopy } from '../../site/src/ui/copy.mjs';
import { devicePolicy } from '../../site/src/ui/device.mjs';
import { readManifest } from '../lib/fixtures.mjs';
import { makeManifest, makeChunkBytes, makeRuntime, RUNTIME_NAMES, makeFetchIntoFake, makeStoreFake, makeHandlerFixture, makeAudio, makeGpuFake, makeOrtFake, waitForPosted, settle, sha256Hex } from '../lib/fakes.mjs';

const subtle = globalThis.crypto.subtle;
const deps = (fetchInto, extra = {}) => ({ fetchInto, subtle, baseUrl: 'http://localhost/', origin: 'http://localhost', warn: () => {}, sleep: async () => {}, ...extra });
const NPM = (backend, names) => [
  { id: 'origin', kind: 'chunks', base: './', label: '站内' },
  { id: 'npm', kind: 'whole', urls: { wasm: `https://npm.test/dist/${names.wasm}`, glue: `https://npm.test/dist/${names.glue}` }, label: 'npm' },
];
const clone = (v) => JSON.parse(JSON.stringify(v));

// ----------------------------------------------------------------------------------------------------- manifest
test('validateManifest: the committed manifest carries runtime.webgpu / runtime.wasm; a fixture manifest validates with and without a runtime section', () => {
  const real = readManifest();
  assert.equal(validateManifest(real), real);
  for (const b of ['webgpu', 'wasm']) {
    assert.equal(real.runtime[b].wasm.name, RUNTIME_NAMES[b].wasm);
    assert.equal(real.runtime[b].glue.name, RUNTIME_NAMES[b].glue);
    assert.equal(real.runtime[b].sources[0].id, 'origin');
    assert.ok(real.runtime[b].sources.some((s) => s.kind === 'whole' && /onnxruntime-web@1\.31\.1|onnxruntime-web\/1\.31\.1/.test(s.urls.wasm)), 'npm copies listed');
    for (const s of real.runtime[b].sources.filter((x) => x.kind === 'chunks' && x.id !== 'origin')) assert.ok(s.base.includes(real.tag), `${b}/${s.id} pinned to ${real.tag}`);
  }
  // jsDelivr's GitHub endpoints cap files at 20 MB: not listed for the 28.7 MB WebGPU binary, listed for the 14.8 MB WASM one
  assert.ok(!real.runtime.webgpu.sources.some((s) => /fastly\.jsdelivr\.net\/gh|cdn\.jsdmirror\.com\/gh|jsdelivr\.b-cdn\.net\/gh/.test(s.base ?? '')));
  assert.ok(real.runtime.wasm.sources.some((s) => /fastly\.jsdelivr\.net\/gh/.test(s.base ?? '')));
  assert.equal(real.version, '2026-11-05.1');
  assert.equal(real.tag, 'models-2026-11-05.1');
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  assert.equal(validateManifest(m), m);
  m.runtime = makeRuntime().section;
  assert.equal(validateManifest(m), m);
  m.runtime = makeRuntime({ sources: NPM }).section;
  assert.equal(validateManifest(m), m);
});

test('validateManifest: runtime rejects an empty section, an unknown backend, a wrong extension, a bad sha256, equal names, a whole source without urls.glue, a non-origin first source', () => {
  const base = () => { const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) }); m.runtime = makeRuntime({ sources: NPM }).section; return m; };
  const rejects = (mutate, pathRe) => {
    const m = base();
    mutate(m);
    assert.throws(() => validateManifest(m), (e) => e.code === 'MANIFEST' && pathRe.test(e.detail.path), `${pathRe}`);
  };
  rejects((m) => { m.runtime = {}; }, /^runtime$/);
  rejects((m) => { m.runtime = []; }, /^runtime$/);
  rejects((m) => { m.runtime.cuda = m.runtime.webgpu; }, /^runtime\.cuda$/);
  rejects((m) => { m.runtime.webgpu.wasm.name = 'ort-wasm.mjs'; }, /^runtime\.webgpu\.wasm\.name$/);
  rejects((m) => { m.runtime.webgpu.glue.name = 'glue.js'; }, /^runtime\.webgpu\.glue\.name$/);
  rejects((m) => { m.runtime.wasm.wasm.sha256 = 'ABC'; }, /^runtime\.wasm\.wasm\.sha256$/);
  rejects((m) => { m.runtime.wasm.wasm.bytes = 0; }, /^runtime\.wasm\.wasm\.bytes$/);
  rejects((m) => { delete m.runtime.wasm.glue; }, /^runtime\.wasm\.glue$/);
  rejects((m) => { m.runtime.wasm.glue.name = m.runtime.wasm.wasm.name; }, /^runtime\.wasm\.glue\.name$/);
  rejects((m) => { delete m.runtime.webgpu.sources[1].urls.glue; }, /^runtime\.webgpu\.sources\[1\]\.urls\.glue$/);
  rejects((m) => { m.runtime.webgpu.sources[1].urls.wasm = 'http://npm.test/x.wasm'; }, /^runtime\.webgpu\.sources\[1\]\.urls\.wasm$/);
  rejects((m) => { m.runtime.webgpu.sources.reverse(); }, /^runtime\.webgpu\.sources\[0\]$/);
  rejects((m) => { m.runtime.webgpu.sources.push({ id: 'origin', kind: 'chunks', base: './', label: 'dup' }); }, /^runtime\.webgpu\.sources\[2\]\.id$/);
});

test('runtimeFiles / runtimeFileId: one chunk per file at vendor/ort/<name>; keys runtime:<name>:<sha256>; sweepStaleEntries keeps the runtime of the manifest and drops an old one', async () => {
  const rt = makeRuntime();
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  assert.equal(runtimeFiles(m, 'webgpu'), null);
  m.runtime = rt.section;
  const files = runtimeFiles(m, 'webgpu');
  assert.deepEqual(files.map((f) => f.key), ['wasm', 'glue']);
  assert.deepEqual(files[0].file.chunks, [{ path: RUNTIME_DIR + RUNTIME_NAMES.webgpu.wasm, bytes: 3000, sha256: rt.section.webgpu.wasm.sha256 }]);
  assert.equal(files[1].file.chunks[0].path, 'vendor/ort/' + RUNTIME_NAMES.webgpu.glue);
  assert.equal(runtimeFileId(RUNTIME_NAMES.webgpu.wasm), 'runtime:ort-wasm-simd-threaded.asyncify.wasm');
  assert.equal(fileKey(runtimeFileId('x.wasm'), 'ab'), 'runtime:x.wasm:ab');
  assert.equal(partKey(runtimeFileId('x.wasm'), 'ab', 3), 'runtime:x.wasm:ab:part-3');
  const live = fileKey(runtimeFileId(RUNTIME_NAMES.webgpu.wasm), rt.section.webgpu.wasm.sha256);
  const liveGlue = fileKey(runtimeFileId(RUNTIME_NAMES.wasm.glue), rt.section.wasm.glue.sha256);
  const stale = fileKey(runtimeFileId(RUNTIME_NAMES.webgpu.wasm), '0'.repeat(64));
  const model = fileKey('fake_model', m.models.fake_model.files.model.sha256);
  const store = makeStoreFake({ initial: [[live, new Uint8Array(1)], [liveGlue + ':part-0', new Uint8Array(1)], [stale + ':part-2', new Uint8Array(1)], [stale, new Uint8Array(1)], [model, new Uint8Array(1)]] });
  const r = await sweepStaleEntries(m, { store });
  assert.deepEqual(r.deleted.sort(), [stale, stale + ':part-2'].sort());
  assert.deepEqual([...store._map.keys()].sort(), [live, liveGlue + ':part-0', model].sort());
});

// -------------------------------------------------------------------------------------------------------- ranking
test('probeSources probes the file named by probeKey; a whole source answering 200 to the Range is excluded for a model but kept range-less for the runtime (allowRangelessWhole)', async () => {
  const rt = makeRuntime({ sources: NPM });
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  m.runtime = rt.section;
  const serve = { ...rt.serve };
  for (const b of ['webgpu', 'wasm']) for (const k of ['wasm', 'glue']) serve[`npm.test/dist/${RUNTIME_NAMES[b][k]}`] = rt.bytes[b][k];
  const files = Object.fromEntries(runtimeFiles(m, 'webgpu').map((f) => [f.key, f.file]));
  // the npm host ignores Range (200); the origin honours it
  const fetchInto = makeFetchIntoFake(serve, (p) => (p.startsWith('npm.test/') ? { noRange: true } : null));
  const sources = resolveSources(m.runtime.webgpu, 'http://localhost/', { version: 'v1' });
  const strict = await probeSources(sources, files, { fetchInto, now: () => performance.now(), origin: 'http://localhost', probeKey: 'wasm' });
  assert.deepEqual(strict.ranked.map((s) => s.id), ['origin']);
  assert.deepEqual(strict.excluded, [{ id: 'npm', reason: 'range ignored' }]);
  const probed = fetchInto.calls.filter((c) => c.range);
  assert.ok(probed.every((c) => c.pathname.endsWith(RUNTIME_NAMES.webgpu.wasm)), `probe on the .wasm: ${probed.map((c) => c.pathname)}`);
  assert.ok(fetchInto.calls.some((c) => c.pathname === 'vendor/ort/' + RUNTIME_NAMES.webgpu.wasm && c.query === '?v=v1'), 'origin URL carries ?v=');
  const lenient = await probeSources(sources, files, { fetchInto, now: () => performance.now(), origin: 'http://localhost', probeKey: 'wasm', allowRangelessWhole: true });
  assert.deepEqual(lenient.ranked.map((s) => s.id).sort(), ['npm', 'origin']);
  assert.equal(lenient.ranked.find((s) => s.id === 'npm').ranges, false);
  assert.equal(lenient.ranked.find((s) => s.id === 'origin').ranges, true);
  assert.deepEqual(lenient.excluded, []);
  // a dirty 206 (compressed representation: Content-Encoding set) is the same for a whole source: excluded strictly, range-less leniently
  const gz = makeFetchIntoFake(serve, (p) => (p.startsWith('npm.test/') ? { contentEncoding: 'br', contentRange: 'bytes 0-2999/700' } : null));
  const s2 = await probeSources(sources, files, { fetchInto: gz, now: () => performance.now(), origin: 'http://localhost', probeKey: 'wasm' });
  assert.deepEqual(s2.excluded, [{ id: 'npm', reason: 'range answer not clean' }]);
  const l2 = await probeSources(sources, files, { fetchInto: gz, now: () => performance.now(), origin: 'http://localhost', probeKey: 'wasm', allowRangelessWhole: true });
  assert.equal(l2.ranked.find((s) => s.id === 'npm').ranges, false);
});

// --------------------------------------------------------------------------------------------------------- loader
test('loadRuntimeBytes: wasm then glue through the loader (probe on the wasm, segments, sha256), stored under runtime:<name>:<sha256>, served from the store on the next load; null without a runtime section', async () => {
  const rt = makeRuntime();
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  assert.equal(await loadRuntimeBytes(m, 'webgpu', deps(makeFetchIntoFake({}))), null);
  m.runtime = rt.section;
  const fetchInto = makeFetchIntoFake(rt.serve);
  const store = makeStoreFake();
  const events = [];
  const r = await loadRuntimeBytes(m, 'webgpu', deps(fetchInto, { store, limits: { segmentBytes: 1000 } }), (e) => events.push(e));
  assert.deepEqual(r.wasm, rt.bytes.webgpu.wasm);
  assert.deepEqual(r.glue, rt.bytes.webgpu.glue);
  assert.equal(r.report.downloadedBytes, 3300);
  assert.deepEqual(r.report.used, { origin: 3300 });
  assert.equal(r.report.sources[0].id, 'origin');
  // 1 probe + 3 wasm segments + 1 glue segment, every one on vendor/ort/<name> with the version query
  assert.equal(fetchInto.calls.length, 5);
  assert.equal(fetchInto.calls[0].pathname, 'vendor/ort/' + RUNTIME_NAMES.webgpu.wasm);
  assert.deepEqual(fetchInto.calls[0].range, { start: 0, end: 2999 }, 'the probe reads the whole 3000 B wasm (< PROBE_BYTES)');
  assert.ok(fetchInto.calls.every((c) => c.pathname.startsWith('vendor/ort/') && c.query === '?v=test-1'));
  assert.deepEqual(fetchInto.calls.slice(1, 4).map((c) => c.range), [{ start: 0, end: 999 }, { start: 1000, end: 1999 }, { start: 2000, end: 2999 }]);
  assert.equal(fetchInto.calls[4].pathname, 'vendor/ort/' + RUNTIME_NAMES.webgpu.glue);
  const wasmKey = fileKey(runtimeFileId(RUNTIME_NAMES.webgpu.wasm), rt.section.webgpu.wasm.sha256);
  const glueKey = fileKey(runtimeFileId(RUNTIME_NAMES.webgpu.glue), rt.section.webgpu.glue.sha256);
  assert.deepEqual([...store._map.keys()].sort(), [glueKey, wasmKey].sort(), 'assembled files stored, parts dropped');
  assert.deepEqual(store._map.get(wasmKey), rt.bytes.webgpu.wasm);
  // progress: download events with the two-file totals, verify twice; bytesDone never decreases
  const dl = events.filter((e) => e.stage === 'download');
  assert.ok(dl.length >= 2);
  assert.ok(dl.every((e) => e.bytesTotal === 3300 && e.fileCount === 2 && e.chunkCount === 2));
  for (let i = 1; i < dl.length; i++) assert.ok(dl[i].bytesDone >= dl[i - 1].bytesDone);
  assert.equal(dl[dl.length - 1].bytesDone, 3300);
  assert.equal(events.filter((e) => e.stage === 'verify').length, 2);
  // second load: both files from the store, no request at all
  const fetch2 = makeFetchIntoFake(rt.serve);
  const r2 = await loadRuntimeBytes(m, 'webgpu', deps(fetch2, { store }));
  assert.equal(fetch2.calls.length, 0);
  assert.deepEqual(r2.report.fromStore, [RUNTIME_NAMES.webgpu.wasm, RUNTIME_NAMES.webgpu.glue]);
  assert.equal(r2.report.sources, null);
  assert.deepEqual(r2.wasm, rt.bytes.webgpu.wasm);
  // the wasm backend has its own two files and keys
  const r3 = await loadRuntimeBytes(m, 'wasm', deps(makeFetchIntoFake(rt.serve), { store }));
  assert.deepEqual(r3.wasm, rt.bytes.wasm.wasm);
  assert.equal(store._map.size, 4);
});

test('loadRuntimeBytes terminal: every source failing → RUNTIME_DOWNLOAD { bytesSaved, bytesTotal }; a wrong byte → RUNTIME_HASH; a model load keeps MODEL_DOWNLOAD', async () => {
  const rt = makeRuntime();
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  m.runtime = rt.section;
  const store = makeStoreFake();
  // the glue (file 2) answers 503 for ever; the wasm (3 segments) is stored → bytesSaved 3000 / 3300
  const dead = makeFetchIntoFake(rt.serve, (p) => (p.endsWith('.mjs') ? { status: 503 } : null));
  await assert.rejects(loadRuntimeBytes(m, 'webgpu', deps(dead, { store, limits: { segmentBytes: 1000 } })), (e) => {
    assert.equal(e.code, 'RUNTIME_DOWNLOAD');
    assert.equal(e.detail.bytesTotal, 3300);
    assert.equal(e.detail.bytesSaved, 3000);
    assert.deepEqual(e.detail.sources, ['origin']);
    assert.match(e.message, /ort-wasm-simd-threaded\.asyncify\.mjs: segment 1\/1 failed on every source/);
    return true;
  });
  assert.equal(codeToCopy('RUNTIME_DOWNLOAD', { bytesSaved: 3000, bytesTotal: 3300 }), '运行环境下载失败（已保存 0.0 MB / 0.0 MB，刷新后继续）。');
  // a corrupt wasm from the only source → RUNTIME_HASH (the chunk mismatch poisons origin, nothing else can serve it)
  const corrupt = { ...rt.serve };
  const bad = rt.bytes.wasm.wasm.slice(); bad[7] ^= 1;
  corrupt['vendor/ort/' + RUNTIME_NAMES.wasm.wasm] = bad;
  await assert.rejects(loadRuntimeBytes(m, 'wasm', deps(makeFetchIntoFake(corrupt), { store: makeStoreFake() })), (e) => e.code === 'RUNTIME_HASH' && /sha256 mismatch/.test(e.message));
  // the model path is untouched: MODEL_DOWNLOAD / MODEL_HASH codes
  const chunks = makeChunkBytes([100, 50]);
  const mm = makeManifest({ modelChunks: chunks });
  const serve = {}; mm.models.fake_model.files.model.chunks.forEach((c, i) => { serve[c.path] = chunks[i]; });
  await assert.rejects(loadModelBytes(mm, 'fake_model', deps(makeFetchIntoFake(serve, () => ({ status: 503 })))), (e) => e.code === 'MODEL_DOWNLOAD');
});

test('a whole-file runtime source that cannot serve ranges streams the file once (whole-chunk mode) and carries the download when the origin is dead', async () => {
  const rt = makeRuntime({ sources: NPM });
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  m.runtime = rt.section;
  const serve = { ...rt.serve };
  for (const k of ['wasm', 'glue']) serve[`npm.test/dist/${RUNTIME_NAMES.webgpu[k]}`] = rt.bytes.webgpu[k];
  const fetchInto = makeFetchIntoFake(serve, (p) => (p.startsWith('npm.test/') ? { noRange: true } : { status: 503 }));
  const r = await loadRuntimeBytes(m, 'webgpu', deps(fetchInto, { store: makeStoreFake(), limits: { segmentBytes: 1000 } }));
  assert.deepEqual(r.wasm, rt.bytes.webgpu.wasm);
  assert.deepEqual(r.report.used, { npm: 3300 });
  assert.equal(r.report.sources.find((s) => s.id === 'npm').ranges, false);
  const npmCalls = fetchInto.calls.filter((c) => c.pathname.startsWith('npm.test/'));
  // the probe (a Range the host answered with 200), then ONE range-less request per file — not one per 1000 B segment
  assert.deepEqual(npmCalls.map((c) => [c.pathname.split('/').pop(), c.range ? 'range' : 'whole']), [[RUNTIME_NAMES.webgpu.wasm, 'range'], [RUNTIME_NAMES.webgpu.wasm, 'whole'], [RUNTIME_NAMES.webgpu.glue, 'whole']]);
  assert.deepEqual(r.report.excluded, [{ id: 'origin', reason: 'HTTP 503' }].filter(() => false), 'origin is never excluded (kept as the last fallback)');
});

test('a range answered on a compressed representation, or with 416, cannot be resumed mid-segment: the next request starts the segment over (resumeResets); an uncompressed range still resumes per byte', async () => {
  const rt = makeRuntime();
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  m.runtime = rt.section;
  const wasmPath = 'vendor/ort/' + RUNTIME_NAMES.wasm.wasm;
  // (a) the probe (attempt 1) saw a clean range, but the first segment request (attempt 2) comes back from an edge that
  // compresses (Content-Encoding) and resets after half its body — the FIX-2 live finding on cdn.jsdelivr.net
  const gz = makeFetchIntoFake(rt.serve, (p, attempt) => (p === wasmPath && attempt === 2 ? { contentEncoding: 'gzip', resetAfterHalf: true } : null));
  const r = await loadRuntimeBytes(m, 'wasm', deps(gz, { store: makeStoreFake(), limits: { segmentBytes: 1000 } }));
  assert.deepEqual(r.wasm, rt.bytes.wasm.wasm);
  // segments run in parallel (the fake link is fast), so the order varies: count the requests for segment 0 (bytes 0-999)
  const seg0 = (fi) => fi.calls.filter((c) => c.pathname === wasmPath && c.range && c.range.end === 999).map((c) => c.range.start);
  assert.deepEqual(seg0(gz), [0, 0], 'the reset request, then its retry from the segment start — never from byte 500');
  assert.equal(r.report.resumeResets, 1);
  assert.equal(r.report.failures, 1);
  // (b) 416 to the resume request → the segment starts over
  // (segments run in parallel: the 416 is keyed on the resume offset, not on the attempt count of the path)
  const h416 = makeFetchIntoFake(rt.serve, (p, attempt, opts) => (p === wasmPath ? (attempt === 2 ? { resetAfterHalf: true } : opts.range && opts.range.start === 500 ? { status: 416 } : null) : null));
  const r2 = await loadRuntimeBytes(m, 'wasm', deps(h416, { store: makeStoreFake(), limits: { segmentBytes: 1000 } }));
  assert.deepEqual(r2.wasm, rt.bytes.wasm.wasm);
  assert.deepEqual(seg0(h416), [0, 500, 0], 'reset at 500, resume at 500 → 416, start over');
  assert.equal(r2.report.resumeResets, 1);
  // (c) control: an uncompressed reset resumes at the received byte (FIX-2 behaviour)
  const plain = makeFetchIntoFake(rt.serve, (p, attempt) => (p === wasmPath && attempt === 2 ? { resetAfterHalf: true } : null));
  const r3 = await loadRuntimeBytes(m, 'wasm', deps(plain, { store: makeStoreFake(), limits: { segmentBytes: 1000 } }));
  assert.deepEqual(seg0(plain), [0, 500]);
  assert.equal(r3.report.resumeResets, 0);
  assert.equal(r3.report.resumedBytes, 500);
});

// --------------------------------------------------------------------------------------------------------- import
test('offline import accepts the runtime files: hash-matched against manifest.runtime, stored under the runtime keys, reported as 运行环境; the next load needs no network', async () => {
  const rt = makeRuntime();
  const m = makeManifest({ modelChunks: makeChunkBytes([100, 50]) });
  m.runtime = rt.section;
  const cands = candidatesForSize(m, 3000);
  assert.deepEqual(cands.map((c) => [c.kind, c.runtime, c.keyId, c.fileKey]), [['whole', 'webgpu', runtimeFileId(RUNTIME_NAMES.webgpu.wasm), 'wasm'], ['whole', 'wasm', runtimeFileId(RUNTIME_NAMES.wasm.wasm), 'wasm']]);
  assert.equal(candidatesForSize(m, 300).length, 2, 'both glues share the size');
  const store = makeStoreFake();
  const file = (name, bytes) => ({ name, size: bytes.length, slice: async (a, b) => bytes.subarray(a, b) });
  const wrong = makeChunkBytes([3000], 99)[0];
  const r = await importModelFiles(m, [file(RUNTIME_NAMES.webgpu.wasm, rt.bytes.webgpu.wasm), file(RUNTIME_NAMES.webgpu.glue, rt.bytes.webgpu.glue), file('other.wasm', wrong)], { store, subtle });
  assert.deepEqual(r.mismatched, ['other.wasm']);
  assert.equal(r.imported.length, 1);
  assert.equal(r.imported[0].kind, 'runtime');
  assert.equal(r.imported[0].backend, 'webgpu');
  assert.equal(r.imported[0].bytes, 3300);
  assert.deepEqual(r.imported[0].files.map((f) => f.matched), [RUNTIME_NAMES.webgpu.wasm, RUNTIME_NAMES.webgpu.glue]);
  const wasmPart = partKey(runtimeFileId(RUNTIME_NAMES.webgpu.wasm), rt.section.webgpu.wasm.sha256, 0);
  const gluePart = partKey(runtimeFileId(RUNTIME_NAMES.webgpu.glue), rt.section.webgpu.glue.sha256, 0);
  assert.deepEqual([...store._map.keys()].sort(), [gluePart, wasmPart].sort());
  assert.deepEqual(store._map.get(wasmPart), rt.bytes.webgpu.wasm);
  // the loader assembles the imported parts: zero requests, no probe
  const fetchInto = makeFetchIntoFake(rt.serve, () => ({ status: 503 }));
  const loaded = await loadRuntimeBytes(m, 'webgpu', deps(fetchInto, { store }));
  assert.equal(fetchInto.calls.length, 0);
  assert.deepEqual(loaded.wasm, rt.bytes.webgpu.wasm);
  assert.equal(loaded.report.restoredBytes, 3300);
  assert.equal(loaded.report.sources, null);
  // a model file in the same pick keeps its model entry, listed before the runtime by the copy
  const chunks = makeChunkBytes([100, 50]);
  const mm = makeManifest({ modelChunks: chunks });
  mm.runtime = rt.section;
  const whole = new Uint8Array(150); whole.set(chunks[0], 0); whole.set(chunks[1], 100);
  const r2 = await importModelFiles(mm, [file(RUNTIME_NAMES.wasm.wasm, rt.bytes.wasm.wasm), file('fake.onnx', whole)], { store: makeStoreFake(), subtle });
  assert.deepEqual(r2.imported.map((x) => [x.kind, x.modelId ?? x.backend, x.bytes]), [['runtime', 'wasm', 3000], ['model', 'fake_model', 150]]);
});

// -------------------------------------------------------------------------------------------------------- handler
const N = 10000;
const sep = (jobId, over = {}) => { const a = makeAudio(N); return { type: 'separate', jobId, tier: 'standard', modelId: 'fake_model', left: a.left, right: a.right, denoise: false, ...over }; };
const untilEnd = (posted) => waitForPosted(posted, (p) => p.some((x) => x.type === 'result' || x.type === 'error' || x.type === 'backend-fallback'));

test('handler: the runtime is downloaded before the model, handed to configureRuntime once, progress tagged asset runtime, timings.runtime reported, the .wasm blob released after the session; a second job reuses it', async () => {
  const runtime = makeRuntime();
  const f = await makeHandlerFixture({ runtime, store: makeStoreFake() });
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
  f.handler.onMessage(sep('j1'));
  await untilEnd(f.posted);
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result', JSON.stringify(r));
  const paths = f.fetchInto.calls.map((c) => c.pathname);
  // runtime probe + wasm + glue (3), then the model probe + 3 chunks (4); every runtime request before the first model request
  assert.equal(paths.length, 7, paths.join(','));
  assert.ok(paths.slice(0, 3).every((p) => p.startsWith('vendor/ort/')) && paths.slice(3).every((p) => p.startsWith('models/')), paths.join(','));
  assert.equal(paths[0], 'vendor/ort/' + RUNTIME_NAMES.wasm.wasm);
  assert.equal(f.runtimeCalls.length, 1);
  const call = f.runtimeCalls[0];
  assert.equal(call.ort, f.ort);
  assert.equal(call.backend, 'wasm');
  assert.deepEqual(call.wasm, runtime.bytes.wasm.wasm);
  assert.deepEqual(call.glue, runtime.bytes.wasm.glue);
  assert.deepEqual(call.names, RUNTIME_NAMES.wasm);
  assert.deepEqual(f.released, ['wasm'], 'release() once the session exists');
  // progress: runtime download/verify events first (asset runtime, totals 3300), then the model's (no asset)
  const prog = f.posted.filter((x) => x.type === 'progress');
  const rtEvents = prog.filter((x) => x.asset === 'runtime');
  assert.ok(rtEvents.length >= 3);
  assert.ok(rtEvents.every((x) => x.stage === 'download' || x.stage === 'verify'));
  assert.ok(rtEvents.filter((x) => x.stage === 'download').every((x) => x.bytesTotal === 3300));
  const firstModelDl = prog.findIndex((x) => x.stage === 'download' && x.asset === undefined);
  const lastRt = prog.lastIndexOf(rtEvents[rtEvents.length - 1]);
  assert.ok(firstModelDl > lastRt, 'runtime events precede the model download');
  assert.ok(prog.filter((x) => x.asset === undefined && x.stage === 'download').every((x) => x.bytesTotal === 2500));
  // the probe + download happen inside the job (jobId on every event after separate was dequeued)
  assert.equal(r.timings.runtime.report.downloadedBytes, 3300);
  assert.deepEqual(r.timings.runtime.report.used, { origin: 3300 });
  assert.equal(typeof r.timings.runtime.downloadMs, 'number');
  assert.equal(typeof r.timings.runtime.configureMs, 'number');
  assert.equal(r.timings.download.downloadedBytes, 2500);
  // second job: nothing fetched again, configureRuntime not called again
  f.handler.onMessage(sep('j2'));
  await waitForPosted(f.posted, (p) => p.filter((x) => x.type === 'result').length === 2);
  assert.equal(f.fetchInto.calls.length, 7);
  assert.equal(f.runtimeCalls.length, 1);
  assert.equal(f.released.length, 1);
  const r2 = f.posted[f.posted.length - 1];
  assert.equal(r2.timings.runtime.report.downloadedBytes, 3300, 'the memoised load report is reported again');
});

test('handler: without a runtime section nothing changes (no configureRuntime call, timings.runtime null, 4 requests)', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilEnd(f.posted);
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result');
  assert.equal(r.timings.runtime, null);
  assert.equal(f.runtimeCalls.length, 0);
  assert.equal(f.fetchInto.calls.length, 4);
  assert.ok(f.posted.filter((x) => x.type === 'progress').every((x) => x.asset === undefined));
});

test('handler: a runtime download that fails on every source → RUNTIME_DOWNLOAD with the separate jobId and { bytesSaved, bytesTotal }, the model is never requested, no fallback; the next job retries and completes', async () => {
  const runtime = makeRuntime();
  let dead = true;
  const store = makeStoreFake();
  const f = await makeHandlerFixture({
    backend: 'webgpu', gpu: makeGpuFake(), runtime, store,
    overrides: (p) => (dead && p === 'vendor/ort/' + RUNTIME_NAMES.webgpu.glue ? { status: 503 } : null),
    loadRuntimeBytes: (manifest, backend, d, onProgress) => loadRuntimeBytes(manifest, backend, { ...d, sleep: async () => {} }, onProgress),
  });
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
  f.handler.onMessage(sep('j1'));
  await waitForPosted(f.posted, (p) => p.some((x) => x.type === 'error'));
  await settle(30);
  const e = f.posted.find((x) => x.type === 'error');
  assert.equal(e.code, 'RUNTIME_DOWNLOAD');
  assert.equal(e.jobId, 'j1');
  assert.equal(e.detail.bytesTotal, 3300);
  assert.equal(e.detail.bytesSaved, 3000, 'the wasm is in the store, the glue failed');
  assert.equal(f.posted.filter((x) => x.type === 'backend-fallback').length, 0, 'a network failure is never a GPU fallback');
  assert.ok(!f.fetchInto.calls.some((c) => c.pathname.startsWith('models/')), 'the model download waits for the runtime');
  assert.equal(f.runtimeCalls.length, 0);
  assert.equal(codeToCopy(e.code, e.detail), '运行环境下载失败（已保存 0.0 MB / 0.0 MB，刷新后继续）。');
  dead = false;
  f.handler.onMessage(sep('j2'));
  await waitForPosted(f.posted, (p) => p.some((x) => x.type === 'result'));
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result');
  assert.equal(r.jobId, 'j2');
  assert.equal(f.runtimeCalls.length, 1);
  assert.deepEqual(r.timings.runtime.report.fromStore, [RUNTIME_NAMES.webgpu.wasm], 'the assembled wasm came from the store, not the network');
  assert.equal(r.timings.runtime.report.downloadedBytes, 300, 'only the glue was fetched');
  assert.equal(r.timings.backend, 'webgpu');
});

test('handler: a webgpu session failure after the runtime was handed over → backend-fallback { reason: session, runtimeLoaded: true }; a wasm one → SESSION { runtimeLoaded: true }', async () => {
  const runtime = makeRuntime();
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake(), runtime, ort: makeOrtFake({ createError: new Error('shader compile failed') }) });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilEnd(f.posted);
  const fb = f.posted.filter((x) => x.type === 'backend-fallback');
  assert.deepEqual(fb, [{ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: 'shader compile failed', runtimeLoaded: true }]);
  assert.equal(f.runtimeCalls.length, 1);
  const w = await makeHandlerFixture({ runtime, ort: makeOrtFake({ createError: new Error("Aborted(NetworkError: Failed to execute 'send' on 'XMLHttpRequest')") }) });
  w.handler.onMessage(w.init());
  w.handler.onMessage(sep('j1'));
  await untilEnd(w.posted);
  const e = w.posted.find((x) => x.type === 'error');
  assert.equal(e.code, 'SESSION');
  assert.deepEqual(e.detail, { runtimeLoaded: true });
});

// ---------------------------------------------------------------------------------------------------------- state
const DESKTOP = devicePolicy({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156', maxTouchPoints: 0 });
const MANIFEST = readManifest();
const types = (effects) => effects.map((e) => e.type);
const find = (effects, type) => effects.find((e) => e.type === type);
function run(state, ...events) { let s = state, effects = []; for (const ev of events) { const r = reduce(s, ev); s = r.state; effects = r.effects; } return { state: s, effects }; }
function boot({ backend = 'webgpu', manifest = MANIFEST, hq = false } = {}) {
  return run(createInitialState(), { type: 'login-ok', policy: DESKTOP, simd: true }, { type: 'caps-ready', backend, threads: 8, hq, manifest, query: {} }).state;
}
const toReady = (s) => run(s, { type: 'file', name: 'song.mp3' }, { type: 'decoded', duration: 25 }).state;
const started = (s, tier = 'standard') => run(toReady(s), { type: 'tier', tier }, { type: 'start', denoise: false }).state;
const worker = (msg) => ({ type: 'worker', msg });
const USER_LINE = "Aborted(NetworkError: Failed to execute 'send' on 'XMLHttpRequest': Failed to load 'https://vickingwu.github.io/vocal-splitter/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm'.). Build with -sASSERTIONS for more info.";

test('isNetworkFailureMessage: the XHR line of the user report and fetch failures match; shader / device messages do not', () => {
  for (const m of [USER_LINE, 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'net::ERR_CONNECTION_RESET', 'Failed to load resource', 'network error', 'Load failed']) assert.equal(isNetworkFailureMessage(m), true, m);
  for (const m of ['shader compile failed', 'device lost', 'requestDevice failed', 'Can\'t initialize onnxruntime.', '', undefined, null]) assert.equal(isNetworkFailureMessage(m), false, String(m));
});

test('state: a session fallback carrying the XHR network line → RUNTIME_DOWNLOAD job error (worker terminated, no WASM re-dispatch, never GPU_ONLY_MODEL) — on the standard and the hq tier', () => {
  const hqManifest = { ...MANIFEST, tiers: { ...MANIFEST.tiers, hq: { webgpu: 'uvr_mdx_voc_ft' } } };
  for (const tier of ['standard', 'hq']) {
    const s = started(boot({ manifest: hqManifest, hq: true }), tier);
    assert.equal(s.job.tier, tier);
    const r = reduce(s, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: USER_LINE }));
    assert.equal(r.state.state, 'error', tier);
    assert.equal(r.state.error.code, 'RUNTIME_DOWNLOAD', tier);
    assert.deepEqual(r.state.error.detail, { reason: 'session', network: true });
    assert.equal(r.state.job, null);
    const t = types(r.effects);
    assert.ok(t.includes('terminate worker') && t.includes('render error') && t.includes('release wake lock'), t.join(','));
    assert.ok(!t.includes('dispatch job') && !t.includes('spawn worker') && !t.includes('reset select to standard'), t.join(','));
    assert.equal(find(r.effects, 'render error').code, 'RUNTIME_DOWNLOAD');
    assert.equal(find(r.effects, 'render error').message, USER_LINE);
    assert.equal(codeToCopy('RUNTIME_DOWNLOAD', r.state.error.detail), '运行环境下载失败。请检查网络后重试。');
    assert.equal(find(r.effects, 'log').args[0], 'webgpu-fallback');
  }
});

test('state: the same network line with runtimeLoaded: true → SESSION (the runtime bytes were fine); a non-network session failure keeps the fallback (wasm re-dispatch / GPU_ONLY_MODEL with the reason word)', () => {
  const s = started(boot());
  const r = reduce(s, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: USER_LINE, runtimeLoaded: true }));
  assert.equal(r.state.state, 'error');
  assert.equal(r.state.error.code, 'SESSION');
  assert.ok(!types(r.effects).includes('dispatch job'));
  const s2 = started(boot());
  const r2 = reduce(s2, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: 'shader compile failed', runtimeLoaded: true }));
  assert.equal(r2.state.state, 'loading-model');
  assert.equal(r2.state.job.backend, 'wasm');
  assert.equal(r2.state.job.fellBack, true);
  assert.ok(types(r2.effects).includes('dispatch job'));
  const hqManifest = { ...MANIFEST, tiers: { ...MANIFEST.tiers, hq: { webgpu: 'uvr_mdx_voc_ft' } } };
  const s3 = started(boot({ manifest: hqManifest, hq: true }), 'hq');
  const r3 = reduce(s3, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: 'shader compile failed', runtimeLoaded: true }));
  assert.equal(r3.state.state, 'ready');
  assert.deepEqual(r3.state.error, { code: 'GPU_ONLY_MODEL', detail: { reason: 'session' } });
  assert.equal(codeToCopy(r3.state.error.code, r3.state.error.detail), 'GPU 不可用（原因：session），高质量模型无法运行。请改用「标准」模型。');
  // a real device loss on the hq tier → GPU_ONLY_MODEL naming the reason
  const s4 = started(boot({ manifest: hqManifest, hq: true }), 'hq');
  const r4 = reduce(s4, worker({ type: 'error', jobId: s4.job.id, code: 'GPU_LOST', message: 'device lost', detail: { reason: 'destroyed' } }));
  assert.equal(r4.state.state, 'ready');
  assert.deepEqual(r4.state.error, { code: 'GPU_ONLY_MODEL', detail: { reason: 'GPU_LOST' } });
  assert.equal(codeToCopy(r4.state.error.code, r4.state.error.detail), 'GPU 不可用（原因：device lost），高质量模型无法运行。请改用「标准」模型。');
  assert.ok(types(r4.effects).includes('reset select to standard'));
  // a fallback before any job (idle device loss shape) only terminates the worker
  const idle = reduce(toReady(boot()), worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: USER_LINE }));
  assert.equal(idle.state.state, 'ready');
  assert.deepEqual(types(idle.effects), ['log']);
});

test('state: a RUNTIME_DOWNLOAD error from the worker is an ordinary job error on a webgpu job (not a fallback), rendered with the saved figure', () => {
  const s = started(boot());
  const r = reduce(s, worker({ type: 'error', jobId: s.job.id, code: 'RUNTIME_DOWNLOAD', message: 'ort-wasm-simd-threaded.asyncify.wasm: segment 4/7 failed on every source (6 attempts)', detail: { bytesSaved: 12 * 1048576, bytesTotal: 28 * 1048576, chunkIndex: 0, chunkCount: 2 } }));
  assert.equal(r.state.state, 'error');
  assert.equal(r.state.error.code, 'RUNTIME_DOWNLOAD');
  assert.ok(!types(r.effects).includes('dispatch job'));
  assert.ok(types(r.effects).includes('terminate worker'));
  assert.equal(codeToCopy(r.state.error.code, r.state.error.detail), '运行环境下载失败（已保存 12 MB / 28 MB，刷新后继续）。');
  // start again after it: the error clears and a new job is dispatched (the loader resumes from the store)
  const again = reduce(r.state, { type: 'start', denoise: false });
  assert.equal(again.state.error, null);
  assert.equal(again.state.state, 'loading-model');
  assert.ok(types(again.effects).includes('spawn worker'));
});
