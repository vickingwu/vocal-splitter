// tests/unit/model-loader.test.mjs — design §16.A row `model-loader.test.mjs` (§6.2 validator, §6.3 loader, Node adapter),
// loader cases rewritten for FIX-2 R2/R3 (resumable multi-source download): source ranking, range assembly, stall / failure /
// backoff fallback, sha mismatch → next source, part persistence + resume, terminal error, legacy cache key migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, loadModelBytes, planSegments, migrateLegacyCache, concurrencyFor, SEGMENT_BYTES, BACKOFF_MS } from '../../site/src/engine/model-loader.mjs';
import { fileKey, partKey } from '../../site/src/engine/part-store.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';
import { makeNodeFetchInto } from '../../scripts/lib/fetch_into_node.mjs';
import { makeChunkBytes, concatBytes, makeManifest, makeFetchIntoFake, makeCacheStorageFake, makeStoreFake, sha256Hex } from '../lib/fakes.mjs';
import { readManifest, repoRoot } from '../lib/fixtures.mjs';

const subtle = globalThis.crypto.subtle;
const BASE = 'http://localhost/';
const ORIGIN = { id: 'origin', kind: 'chunks', base: './', label: '站内' };
const MIRROR = { id: 'mirror', kind: 'chunks', base: 'https://mirror.test/gh/x@tag/site/', label: 'mirror' };
const WHOLE = { id: 'hf', kind: 'whole', urls: { model: 'https://hf.test/repo/resolve/main/fake.onnx' }, label: 'hf' };

function serveMap(manifest, modelId, chunkArrays, sources = [ORIGIN]) {
  const m = manifest.models[modelId];
  const serve = {};
  let k = 0;
  const all = [];
  for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) { serve[c.path] = chunkArrays[k]; all.push([f, c, chunkArrays[k++]]); }
  for (const s of sources) {
    if (s.kind === 'chunks' && s.base !== './') for (const [, c, bytes] of all) serve[new URL(c.path, s.base).host + new URL(c.path, s.base).pathname] = bytes;
    if (s.kind === 'whole') for (const fk of ['model', 'externalData']) { if (!s.urls[fk] || !m.files[fk]) continue; const u = new URL(s.urls[fk]); serve[u.host + u.pathname] = concatBytes(all.filter(([f]) => f === m.files[fk]).map(([, , b]) => b)); }
  }
  return serve;
}

// Small segments (400 B) and instant backoff/stall timers keep the tests in milliseconds; `sleeps` records every wait.
function setup({ sizes = [1000, 1000, 500], externalSizes = null, overrides, store = null, sources = undefined, segmentBytes = 400, ranges = true, sourceIds = undefined, warn, stallMs = 200 } = {}) {
  const modelChunks = makeChunkBytes(sizes, 1);
  const externalChunks = externalSizes ? makeChunkBytes(externalSizes, 2) : null;
  const manifest = validateManifest(makeManifest({ modelChunks, externalChunks, sources }));
  const serve = serveMap(manifest, 'fake_model', [...modelChunks, ...(externalChunks ?? [])], sources ?? [ORIGIN]);
  const fetchInto = makeFetchIntoFake(serve, overrides, { ranges });
  const warns = [];
  const progress = [];
  const sleeps = [];
  const deps = { fetchInto, store, subtle, baseUrl: BASE, warn: warn ?? ((...a) => warns.push(a)), sleep: async (ms) => { sleeps.push(ms); }, limits: { segmentBytes, stallMs, probeTimeoutMs: 500 }, sourceIds };
  const segs = planSegments(manifest.models.fake_model.files.model, segmentBytes);
  return { manifest, modelChunks, externalChunks, serve, fetchInto, deps, warns, sleeps, progress, segs, onProgress: (e) => progress.push(e), expected: concatBytes(modelChunks) };
}
// the probe is the one call per source with a 256 KB range (or the whole first chunk / file when smaller)
const isProbe = (c, size) => !!c.range && c.range.start === 0 && c.range.end === Math.min(262144, size) - 1 && c.targetLength === Math.min(262144, size);
const downloads = (fetchInto, probeSize) => fetchInto.calls.filter((c) => !isProbe(c, probeSize));

async function expectEngineError(promise, code) {
  try { await promise; } catch (e) {
    assert.ok(e instanceof EngineError, `expected EngineError, got ${e && e.stack}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected ${code} to be thrown`);
}

// ------------------------------------------------------------------ loader happy path
test('3 chunks (1000/1000/500 B, 400 B segments) → one probe + 8 range requests, exact bytes, progress shape, report', async () => {
  const s = setup();
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.externalData, undefined);
  assert.equal(s.segs.length, 8, 'segments 400/400/200 + 400/400/200 + 400/100');
  assert.ok(isProbe(s.fetchInto.calls[0], 1000), 'first call is the probe of chunk 0');
  const dl = downloads(s.fetchInto, 1000);
  assert.equal(dl.length, 8);
  for (const c of dl) { assert.equal(c.query, '?v=test-1'); assert.equal(c.cache, undefined); assert.ok(c.range, 'range request'); assert.equal(c.range.end - c.range.start + 1, c.targetLength); assert.equal(c.origin, 'http://localhost'); }
  assert.deepEqual(dl.map((c) => `${c.pathname.slice(-11)}:${c.range.start}`).sort(), ['part-00.bin:0', 'part-00.bin:400', 'part-00.bin:800', 'part-01.bin:0', 'part-01.bin:400', 'part-01.bin:800', 'part-02.bin:0', 'part-02.bin:400']);
  const stages = s.progress.map((p) => p.stage);
  assert.ok(stages.includes('download') && stages.includes('verify'));
  assert.equal(stages.lastIndexOf('download') < stages.lastIndexOf('verify'), true);
  const last = s.progress.filter((p) => p.stage === 'download').pop();
  assert.deepEqual(last, { stage: 'download', bytesDone: 2500, bytesTotal: 2500, chunksDone: 3, chunkCount: 3, fileIndex: 0, fileCount: 1, sourceId: 'origin' });
  assert.equal(s.warns.length, 0);
  assert.deepEqual(r.report.sources.map((x) => [x.id, x.ranges]), [['origin', true]]);
  assert.deepEqual(r.report.used, { origin: 2500 });
  assert.equal(r.report.failures, 0);
  assert.deepEqual(s.sleeps, []);
});

test('range-less host (200 to a Range request) → whole-chunk mode: one request per chunk, no range header, bytes exact', async () => {
  const s = setup({ ranges: false });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  const dl = downloads(s.fetchInto, 1000);
  assert.equal(dl.length, 3);
  for (const c of dl) assert.equal(c.range, null);
  assert.deepEqual(dl.map((c) => c.targetLength).sort((a, b) => a - b), [500, 1000, 1000]);
  assert.deepEqual(r.report.sources.map((x) => [x.id, x.ranges]), [['origin', false]]);
});

test('progress bytesDone never decreases (in-flight bytes are counted once, cleared only when marked present) — range and whole-chunk modes', async () => {
  for (const ranges of [true, false]) {
    const s = setup({ ranges, sizes: [1000, 1000, 500], externalSizes: [900, 300], overrides: () => ({ delayMs: 3 }) });
    const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
    assert.deepEqual(r.bytes, s.expected);
    const dls = s.progress.filter((p) => p.stage === 'download');
    for (let i = 1; i < dls.length; i++) assert.ok(dls[i].bytesDone >= dls[i - 1].bytesDone, `ranges ${ranges}: ${dls[i - 1].bytesDone} → ${dls[i].bytesDone}`);
    assert.equal(dls[dls.length - 1].bytesDone, 3700);
    assert.ok(dls.every((p) => p.bytesDone <= p.bytesTotal));
  }
});

test('two-file manifest (2 + 3 chunks): both files assembled, fileIndex/fileCount in progress, externalData { path, data }, one probe per load', async () => {
  const s = setup({ sizes: [800, 700], externalSizes: [600, 500, 400] });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.externalData.path, 'fake.onnx.data');
  assert.deepEqual(r.externalData.data, concatBytes(s.externalChunks));
  const dls = s.progress.filter((p) => p.stage === 'download');
  for (const p of dls) { assert.equal(p.chunkCount, 5); assert.equal(p.bytesTotal, 3000); assert.equal(p.fileCount, 2); }
  assert.ok(dls.some((p) => p.fileIndex === 0) && dls.some((p) => p.fileIndex === 1));
  assert.deepEqual(dls.pop(), { stage: 'download', bytesDone: 3000, bytesTotal: 3000, chunksDone: 5, chunkCount: 5, fileIndex: 1, fileCount: 2, sourceId: 'origin' });
  assert.equal(s.progress.filter((p) => p.stage === 'verify').length, 2);
  assert.equal(s.fetchInto.calls.filter((c) => isProbe(c, 800)).length, 1, 'the probe runs once per load, not per file');
});

// ------------------------------------------------------------------ sources: ranking, fallback, stall, hash mismatch
test('source ranking: the fastest probe wins; a whole-file source serves file-offset ranges cross-origin', async () => {
  const s = setup({ sources: [ORIGIN, MIRROR, WHOLE], overrides: (p) => (p.startsWith('mirror.test') || p === 'models/fake_model/core.part-00.bin' ? { delayMs: 25 } : null) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.sources[0].id, 'hf', JSON.stringify(r.report.sources));
  assert.deepEqual(Object.keys(r.report.used), ['hf']);
  const dl = s.fetchInto.calls.filter((c) => c.pathname.startsWith('hf.test') && !isProbe(c, 2500));
  assert.deepEqual(dl.map((c) => c.range.start).sort((a, b) => a - b), [0, 400, 800, 1000, 1400, 1800, 2000, 2400], 'whole-file ranges are file offsets');
  assert.ok(dl.every((c) => c.origin === 'http://localhost'), 'the page origin is passed so fetchInto picks mode cors');
});

test('same-origin is never excluded: a failed origin probe keeps it as the last, range-less fallback', async () => {
  const s = setup({ sources: [ORIGIN, MIRROR], overrides: (p, attempt, opts, call) => (p.startsWith('models/') && isProbe(call, 1000) ? { status: 503 } : null) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.deepEqual(r.report.sources.map((x) => x.id), ['mirror', 'origin']);
  assert.equal(r.report.sources[1].ranges, false);
  assert.deepEqual(r.report.excluded, []);
  assert.deepEqual(Object.keys(r.report.used), ['mirror']);
});

test('dead mirror (connection refused) is excluded by the probe; the download runs on origin; ?sources= restricts and orders', async () => {
  const s = setup({ sources: [ORIGIN, MIRROR], overrides: (p) => (p.startsWith('mirror.test') ? { reject: new TypeError('Failed to fetch') } : null) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.deepEqual(r.report.excluded, [{ id: 'mirror', reason: 'TypeError: Failed to fetch' }]);
  assert.deepEqual(Object.keys(r.report.used), ['origin']);
  const s2 = setup({ sources: [ORIGIN, MIRROR, WHOLE], sourceIds: ['hf'] });
  const r2 = await loadModelBytes(s2.manifest, 'fake_model', s2.deps);
  assert.deepEqual(r2.bytes, s2.expected);
  assert.deepEqual(r2.report.sources.map((x) => x.id).sort(), ['hf', 'origin'], 'only the pinned source plus the origin fallback are probed');
  assert.ok(!s2.fetchInto.calls.some((c) => c.pathname.startsWith('mirror.test')));
});

test('request failures: 503 on the best source → retry after 1 s, 2 s → cursor moves to the next source; bytes exact', async () => {
  const s = setup({ sources: [ORIGIN, MIRROR], overrides: (p, attempt, opts, call) => (p.startsWith('mirror.test') && !isProbe(call, 1000) ? { status: 503 } : (p.startsWith('models/') ? { delayMs: 15 } : null)) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.sources[0].id, 'mirror', 'mirror probed faster');
  assert.ok(r.report.failures >= 2, `failures ${r.report.failures}`);
  assert.ok(s.sleeps.length >= 2 && s.sleeps.includes(BACKOFF_MS[0]), JSON.stringify(s.sleeps));
  assert.ok(s.sleeps.every((ms) => ms === BACKOFF_MS[0] || ms === BACKOFF_MS[1]), 'the cursor leaves a source after two failures on it, so no segment waits longer than 2 s');
  assert.equal(r.report.used.origin, 2500, JSON.stringify(r.report.used));
  assert.equal(r.report.used.mirror ?? 0, 0);
});

test('stall (no bytes for stallMs) aborts the request and counts as a failure; a hanging mirror cannot hang the load', async () => {
  const s = setup({ sources: [ORIGIN, MIRROR], stallMs: 60, overrides: (p, attempt, opts, call) => (p.startsWith('mirror.test') && !isProbe(call, 1000) ? { hang: true } : (p.startsWith('models/') ? { delayMs: 10 } : null)) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.ok(r.report.stalls >= 1, `stalls ${r.report.stalls}`);
  assert.equal(r.report.used.origin, 2500, JSON.stringify(r.report.used));
  const hung = s.fetchInto.calls.filter((c) => c.pathname.startsWith('mirror.test') && !isProbe(c, 1000));
  assert.ok(hung.length >= 1 && hung.every((c) => c.signal.aborted), 'the stalled requests were aborted');
});

test('terminal: every source fails for the same segment → MODEL_DOWNLOAD { bytesSaved, bytesTotal }; the good segments stay persisted', async () => {
  const store = makeStoreFake();
  const s = setup({ store, overrides: (p, attempt, opts, call) => (opts.range && opts.range.start === 800 && !isProbe(call, 1000) ? { status: 500 } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress), 'MODEL_DOWNLOAD');
  assert.equal(e.detail.bytesTotal, 2500);
  assert.ok(e.detail.bytesSaved >= 800 && e.detail.bytesSaved <= 2100, `bytesSaved ${e.detail.bytesSaved}`);
  assert.deepEqual(e.detail.sources, ['origin']);
  assert.ok(s.sleeps.length >= 2 && s.sleeps.every((ms) => ms === BACKOFF_MS[0] || ms === BACKOFF_MS[1]), `1 s then 2 s per failing segment on the single source: ${JSON.stringify(s.sleeps)}`);
  const parts = [...store._map.keys()].filter((k) => k.includes(':part-'));
  assert.ok(parts.length >= 2, 'completed segments were persisted before the failure');
  assert.ok(!store._map.has(fileKey('fake_model', s.manifest.models.fake_model.files.model.sha256)));
});

test('sha256 mismatch: corrupted bytes from the best source → chunk discarded and re-fetched from the next source; no wait', async () => {
  const bad = makeChunkBytes([1000], 99)[0];
  const s = setup({ sources: [ORIGIN, MIRROR], overrides: (p, attempt, opts, call) => (p === 'mirror.test/gh/x@tag/site/models/fake_model/core.part-01.bin' && !isProbe(call, 1000) ? { bytes: bad } : (p.startsWith('models/') ? { delayMs: 15 } : null)) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.hashMismatches, 1);
  assert.equal(r.report.sources[0].id, 'mirror');
  assert.ok(r.report.used.origin >= 1000, JSON.stringify(r.report.used));
  assert.deepEqual(s.sleeps, [], 'a hash mismatch moves on without a backoff wait');
});

test('sha256 mismatch on the only (origin) source → one cache:"reload" retry on that chunk, then MODEL_HASH when it persists', async () => {
  const bad = makeChunkBytes([1000], 99)[0];
  const s = setup({ overrides: (p) => (p.endsWith('core.part-01.bin') ? { bytes: bad } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: 1, chunkCount: 3, file: 'model' });
  const reloads = s.fetchInto.calls.filter((c) => c.cache === 'reload');
  assert.ok(reloads.length >= 1 && reloads.every((c) => c.pathname.endsWith('core.part-01.bin')), 'the reload retry hits the same chunk');
  // a corrupted intermediary copy that the reload retry gets past → success
  let served = 0;
  const s2 = setup({ overrides: (p) => (p.endsWith('core.part-01.bin') && served++ < 3 ? { bytes: bad } : null) });
  const r2 = await loadModelBytes(s2.manifest, 'fake_model', s2.deps);
  assert.deepEqual(r2.bytes, s2.expected);
  assert.equal(r2.report.hashMismatches, 1);
});

test('whole-file sha256 mismatch → MODEL_HASH { chunkIndex: -1, chunkCount, file }, nothing left in the store', async () => {
  const store = makeStoreFake();
  const s = setup({ store });
  s.manifest.models.fake_model.files.model.sha256 = 'f'.repeat(64);
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: -1, chunkCount: 3, file: 'model' });
  assert.equal(store._map.size, 0, 'the parts of a file that fails the whole-file check are dropped');
});

test('a range answered with 200 mid-download (host lost Range support) → the source switches to whole-chunk mode and completes', async () => {
  let n = 0;
  const s = setup({ overrides: (p, attempt, opts, call) => (opts.range && !isProbe(call, 1000) && n++ === 2 ? { noRange: true } : null) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.ok(s.fetchInto.calls.some((c) => !c.range), 'whole-chunk requests followed the 200');
  assert.deepEqual(s.sleeps, [BACKOFF_MS[0]]);
});

// ------------------------------------------------------------------ persistence: parts, resume, file key
test('every completed segment is persisted at once; the assembled file replaces the parts; the next load is served from the store with zero fetches', async () => {
  const store = makeStoreFake();
  const s = setup({ store });
  const sha = s.manifest.models.fake_model.files.model.sha256;
  const r1 = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r1.bytes, s.expected);
  const partPuts = store.log.filter(([op, k]) => op === 'put' && k.includes(':part-'));
  assert.equal(partPuts.length, 8, 'one put per segment');
  assert.deepEqual([...store._map.keys()], [fileKey('fake_model', sha)], 'parts deleted once the file key is stored');
  assert.equal(store._map.get(fileKey('fake_model', sha)).length, 2500);
  s.progress.length = 0;
  const calls = s.fetchInto.calls.length;
  const r2 = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r2.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, calls, 'no fetch, not even a probe');
  assert.deepEqual(s.progress.map((p) => p.stage), ['verify']);
  assert.deepEqual(r2.report.fromStore, ['fake.onnx']);
});

test('resume: stored parts are restored, only the missing segments are requested, the progress line starts at the saved bytes', async () => {
  const store = makeStoreFake();
  const s = setup({ store });
  const file = s.manifest.models.fake_model.files.model;
  for (const n of [0, 1, 3]) { const seg = s.segs[n]; await store.put(partKey('fake_model', file.sha256, n), s.expected.subarray(seg.fileOffset, seg.fileOffset + seg.length)); }
  store.log.length = 0;
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.restoredBytes, 1200);
  assert.equal(r.report.downloadedBytes, 1300);
  const dl = downloads(s.fetchInto, 1000);
  assert.equal(dl.length, 5, 'segments 2, 4, 5, 6, 7 only');
  assert.deepEqual(dl.map((c) => `${c.pathname.slice(-11)}:${c.range.start}`).sort(), ['part-00.bin:800', 'part-01.bin:400', 'part-01.bin:800', 'part-02.bin:0', 'part-02.bin:400']);
  assert.equal(s.progress.find((p) => p.stage === 'download').bytesDone, 1200, 'the line starts at the saved bytes');
});

test('a stored part with a wrong length, an out-of-range part and a chunk whose parts fail sha256 are dropped and re-fetched', async () => {
  const store = makeStoreFake();
  const s = setup({ store });
  const file = s.manifest.models.fake_model.files.model;
  await store.put(partKey('fake_model', file.sha256, 0), new Uint8Array(123));
  for (const n of [3, 4, 5]) { const seg = s.segs[n]; const b = s.expected.slice(seg.fileOffset, seg.fileOffset + seg.length); if (n === 4) b[7] ^= 0xff; await store.put(partKey('fake_model', file.sha256, n), b); }
  await store.put(partKey('fake_model', file.sha256, 99), new Uint8Array(1));
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.hashMismatches, 1);
  assert.equal(r.report.restoredBytes, 0);
  assert.equal(downloads(s.fetchInto, 1000).length, 8, 'everything re-fetched');
  assert.ok(!store._map.has(partKey('fake_model', file.sha256, 99)));
});

test('a stored assembled file that no longer matches the manifest sha256 is deleted and re-downloaded', async () => {
  const store = makeStoreFake();
  const s = setup({ store });
  const sha = s.manifest.models.fake_model.files.model.sha256;
  await store.put(fileKey('fake_model', sha), makeChunkBytes([2500], 5)[0]);
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.deepEqual(store._map.get(fileKey('fake_model', sha)), s.expected);
  assert.equal(s.progress.filter((p) => p.stage === 'verify').length, 2, 'verify of the bad entry, verify after the download');
});

test('store failures never fail the load: put / keys / get throwing → warn, bytes still returned', async () => {
  const s = setup({ store: makeStoreFake({ fail: { put: { name: 'QuotaExceededError' } } }) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.ok(s.warns.length >= 1);
  const s2 = setup({ store: makeStoreFake({ fail: { keys: {}, get: {} } }) });
  const r2 = await loadModelBytes(s2.manifest, 'fake_model', s2.deps);
  assert.deepEqual(r2.bytes, s2.expected);
  const s3 = setup({ store: null });
  assert.deepEqual((await loadModelBytes(s3.manifest, 'fake_model', s3.deps)).bytes, s3.expected);
});

test('R3 migration: an old vs-models-<version> entry that hashes to the manifest is re-stored under modelId:sha256; every old cache is deleted', async () => {
  const caches = makeCacheStorageFake({ existingNames: ['vs-models-2026-11-03.3', 'vs-models-old', 'other-app'] });
  const s = setup();
  const file = s.manifest.models.fake_model.files.model;
  const old = await caches.open('vs-models-2026-11-03.3');
  await old.put(new Request('http://localhost/models/fake_model/fake.onnx'), new Response(s.expected.slice()));
  const stale = await caches.open('vs-models-old');
  await stale.put(new Request('http://localhost/models/fake_model/fake.onnx'), new Response(new Uint8Array(2500)));
  const store = makeStoreFake();
  const m = await migrateLegacyCache(s.manifest, { caches, store, subtle, baseUrl: BASE });
  assert.deepEqual(m.migrated, [{ modelId: 'fake_model', file: 'fake.onnx', bytes: 2500 }]);
  assert.deepEqual(m.deleted.sort(), ['vs-models-2026-11-03.3', 'vs-models-old']);
  assert.deepEqual([...caches._stores.keys()], ['other-app']);
  assert.deepEqual(store._map.get(fileKey('fake_model', file.sha256)), s.expected);
  const r = await loadModelBytes(s.manifest, 'fake_model', { ...s.deps, store });
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, 0, 'the migrated entry serves the load without any fetch');
  assert.deepEqual(await migrateLegacyCache(s.manifest, { caches: null, store, subtle, baseUrl: BASE }), { migrated: [], deleted: [] });
});

test('concurrency follows the probed speed: < 512 KB/s → 1 in flight (one segment at risk), < 2 MB/s → 2, otherwise 4', async () => {
  assert.equal(concurrencyFor(27), 1);
  assert.equal(concurrencyFor(0), 1);
  assert.equal(concurrencyFor(511), 1);
  assert.equal(concurrencyFor(512), 2);
  assert.equal(concurrencyFor(2047), 2);
  assert.equal(concurrencyFor(2048), 4);
  assert.equal(concurrencyFor(50000, 3), 3);
  // a slow probe (fake clock: 3 s per now() call → ~85 KB/s) → sequential downloads
  let clock = 0;
  const s = setup();
  let inFlight = 0, maxInFlight = 0;
  const inner = s.deps.fetchInto;
  s.deps.fetchInto = async (url, target, opts) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await inner(url, target, opts); } finally { inFlight--; } };
  s.deps.now = () => { clock += 3000; return clock; };
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.report.concurrency, 1);
  assert.equal(maxInFlight, 1);
  // real clock: the 1000 B probe of the instant fake measures at most 1000 B/ms (ms floored at 1) ≈ 976 KB/s → 2
  const s2 = setup();
  assert.equal((await loadModelBytes(s2.manifest, 'fake_model', s2.deps)).report.concurrency, 2);
});

test('planSegments: 4 MiB default segments over the committed Voc_FT chunks; segment indices are global per file', () => {
  const file = readManifest().models.uvr_mdx_voc_ft.files.model;
  const segs = planSegments(file);
  assert.equal(SEGMENT_BYTES, 4194304);
  assert.equal(segs.reduce((a, s) => a + s.length, 0), file.bytes);
  assert.deepEqual(segs.map((s) => s.n), segs.map((_, i) => i));
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].fileOffset, segs[i - 1].fileOffset + segs[i - 1].length);
  assert.ok(segs.every((s) => s.length <= SEGMENT_BYTES && s.length > 0));
  assert.equal(segs.filter((s) => s.chunkIndex === 0).length, Math.ceil(file.chunks[0].bytes / SEGMENT_BYTES));
});

// ------------------------------------------------------------------ validator
const committed = readManifest();

test('validateManifest accepts the committed site/models/manifest.json and tiers.standard.wasmLow === uvr_mdxnet_9482', () => {
  const m = validateManifest(structuredClone(committed));
  assert.equal(m.tiers.standard.wasmLow, 'uvr_mdxnet_9482');
  assert.equal(m.models.uvr_mdxnet_9482.params.dimF, 2048);
  assert.ok(m.tiers.standard.webgpu && m.tiers.standard.wasm);
});

test('committed manifest (FIX-2 R1): every chunk <= 19,000,000 B, tag models-<version>, sources[0] = origin, every model has whole-file + mirror sources', () => {
  assert.equal(committed.tag, `models-${committed.version}`);
  for (const [id, m] of Object.entries(committed.models)) {
    for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) assert.ok(c.bytes <= 19000000, `${id} ${c.path} ${c.bytes}`);
    assert.ok(Array.isArray(m.sources) && m.sources.length >= 3, `${id} sources`);
    assert.deepEqual(m.sources[0], { id: 'origin', kind: 'chunks', base: './', label: '站内' });
    assert.ok(m.sources.some((s) => s.kind === 'whole'), `${id} has a whole-file source`);
    assert.ok(m.sources.some((s) => s.kind === 'chunks' && s.base.includes(`@${committed.tag}/`)), `${id} has a jsDelivr-style tag mirror`);
    assert.ok(m.sources.some((s) => s.kind === 'chunks' && s.base.includes(`/${committed.tag}/`)), `${id} has a raw-GitHub-style tag mirror`);
    for (const s of m.sources.filter((x) => x.kind === 'whole')) { assert.ok(s.urls.model.startsWith('https://')); if (m.files.externalData) assert.ok(s.urls.externalData.startsWith('https://')); }
  }
  assert.equal(committed.models.melroformer_duality_student.files.externalData.chunks.length, 12);
  assert.equal(committed.models.uvr_mdx_voc_ft.files.model.chunks.length, 4);
});

const MUTATIONS = [
  ['missing tiers.standard.wasm', (m) => { delete m.tiers.standard.wasm; }, 'tiers.standard.wasm'],
  ['missing tiers.standard.wasmLow', (m) => { delete m.tiers.standard.wasmLow; }, 'tiers.standard.wasmLow'],
  ['wasmLow → dimF 3072 model', (m) => { m.tiers.standard.wasmLow = 'uvr_mdx_voc_ft'; }, 'tiers.standard.wasmLow'],
  ['compensate 3', (m) => { m.models.uvr_mdx_voc_ft.params.compensate = 3; }, 'models.uvr_mdx_voc_ft.params.compensate'],
  ['overlap 0', (m) => { m.models.uvr_mdx_voc_ft.params.overlap = 0; }, 'models.uvr_mdx_voc_ft.params.overlap'],
  ['non-integer dimF', (m) => { m.models.uvr_mdx_voc_ft.params.dimF = 3072.5; }, 'models.uvr_mdx_voc_ft.params.dimF'],
  ['dimT ≠ segmentSize', (m) => { m.models.uvr_mdx_voc_ft.params.segmentSize = 512; }, 'models.uvr_mdx_voc_ft.params.segmentSize'],
  ['.. in a chunk path', (m) => { m.models.uvr_mdx_voc_ft.files.model.chunks[0].path = 'models/uvr_mdx_voc_ft/../x.bin'; }, 'models.uvr_mdx_voc_ft.files.model.chunks[0].path'],
  ['bad hex', (m) => { m.models.uvr_mdx_voc_ft.files.model.chunks[1].sha256 = 'XYZ'; }, 'models.uvr_mdx_voc_ft.files.model.chunks[1].sha256'],
  ['uppercase hex', (m) => { m.models.uvr_mdx_voc_ft.files.model.sha256 = m.models.uvr_mdx_voc_ft.files.model.sha256.toUpperCase(); }, 'models.uvr_mdx_voc_ft.files.model.sha256'],
  ['Σ bytes mismatch', (m) => { m.models.uvr_mdx_voc_ft.files.model.bytes += 1; }, 'models.uvr_mdx_voc_ft.files.model.bytes'],
  ['files.model.name with /', (m) => { m.models.uvr_mdx_voc_ft.files.model.name = 'a/b.onnx'; }, 'models.uvr_mdx_voc_ft.files.model.name'],
  ['files.model.name with ?', (m) => { m.models.uvr_mdx_voc_ft.files.model.name = 'a?b.onnx'; }, 'models.uvr_mdx_voc_ft.files.model.name'],
  ['model id with /', (m) => { m.models['bad/id'] = structuredClone(m.models.uvr_mdxnet_9482); }, 'models.bad/id'],
  ['schema 2', (m) => { m.schema = 2; }, 'schema'],
  ['version with a space', (m) => { m.version = 'v 1'; }, 'version'],
  ['version > 64 chars', (m) => { m.version = 'a'.repeat(65); }, 'version'],
  ['arch unknown', (m) => { m.models.uvr_mdx_voc_ft.arch = 'demucs'; }, 'models.uvr_mdx_voc_ft.arch'],
  ['backends empty', (m) => { m.models.uvr_mdxnet_9482.backends = []; }, 'models.uvr_mdxnet_9482.backends'],
  ['tier key → model lacking the backend', (m) => { m.tiers.standard.webgpu = 'uvr_mdxnet_9482'; }, 'tiers.standard.webgpu'],
  ['tier key → unknown model', (m) => { m.tiers.standard.wasm = 'nope'; }, 'tiers.standard.wasm'],
  ['nFft with prime 7', (m) => { m.models.uvr_mdx_voc_ft.params.nFft = 7168; }, 'models.uvr_mdx_voc_ft.params.nFft'],
  ['nFft odd', (m) => { m.models.uvr_mdx_voc_ft.params.nFft = 7681; }, 'models.uvr_mdx_voc_ft.params.nFft'],
  ['hop > nFft', (m) => { m.models.uvr_mdx_voc_ft.params.hop = 8000; }, 'models.uvr_mdx_voc_ft.params.hop'],
  ['dimF > nFft/2+1', (m) => { m.models.uvr_mdx_voc_ft.params.dimF = 3842; }, 'models.uvr_mdx_voc_ft.params.dimF'],
  ['zeroLowBins > dimF', (m) => { m.models.uvr_mdx_voc_ft.params.zeroLowBins = 4000; }, 'models.uvr_mdx_voc_ft.params.zeroLowBins'],
  ['overlap 0.95', (m) => { m.models.uvr_mdx_voc_ft.params.overlap = 0.95; }, 'models.uvr_mdx_voc_ft.params.overlap'],
  ['inputPeak 0', (m) => { m.models.uvr_mdx_voc_ft.params.inputPeak = 0; }, 'models.uvr_mdx_voc_ft.params.inputPeak'],
  ['outputPeak 1.5', (m) => { m.models.uvr_mdx_voc_ft.params.outputPeak = 1.5; }, 'models.uvr_mdx_voc_ft.params.outputPeak'],
  ['primaryStem instrumental', (m) => { m.models.uvr_mdx_voc_ft.params.primaryStem = 'instrumental'; }, 'models.uvr_mdx_voc_ft.params.primaryStem'],
  ['sampleRate 48000', (m) => { m.models.uvr_mdx_voc_ft.params.sampleRate = 48000; }, 'models.uvr_mdx_voc_ft.params.sampleRate'],
  ['chunk path directory ≠ id', (m) => { m.models.uvr_mdx_voc_ft.files.model.chunks[0].path = 'models/uvr_mdxnet_9482/part-00.bin'; }, 'models.uvr_mdx_voc_ft.files.model.chunks[0].path'],
  ['chunk path absolute', (m) => { m.models.uvr_mdx_voc_ft.files.model.chunks[0].path = '/models/uvr_mdx_voc_ft/part-00.bin'; }, 'models.uvr_mdx_voc_ft.files.model.chunks[0].path'],
  ['displayName empty', (m) => { m.models.uvr_mdx_voc_ft.displayName = ''; }, 'models.uvr_mdx_voc_ft.displayName'],
  ['files.model missing', (m) => { delete m.models.uvr_mdxnet_9482.files.model; }, 'models.uvr_mdxnet_9482.files.model'],
  ['NaN compensate', (m) => { m.models.uvr_mdx_voc_ft.params.compensate = NaN; }, 'models.uvr_mdx_voc_ft.params.compensate'],
  ['tiers.hq without webgpu', (m) => { m.tiers.hq = { wasm: 'uvr_mdx_voc_ft' }; }, 'tiers.hq.webgpu'],
  ['chunk > 19,000,000 B', (m) => { const f = m.models.uvr_mdx_voc_ft.files.model; f.chunks[0].bytes = 19000001; f.bytes += 1; }, 'models.uvr_mdx_voc_ft.files.model.chunks[0].bytes'],
  ['sources[0] not origin', (m) => { m.models.uvr_mdx_voc_ft.sources.shift(); }, 'models.uvr_mdx_voc_ft.sources[0]'],
  ['sources empty', (m) => { m.models.uvr_mdx_voc_ft.sources = []; }, 'models.uvr_mdx_voc_ft.sources'],
  ['duplicate source id', (m) => { m.models.uvr_mdx_voc_ft.sources.push({ ...m.models.uvr_mdx_voc_ft.sources[1] }); }, `models.uvr_mdx_voc_ft.sources[${committed.models.uvr_mdx_voc_ft.sources.length}].id`],
  ['source kind unknown', (m) => { m.models.uvr_mdx_voc_ft.sources[1].kind = 'ftp'; }, 'models.uvr_mdx_voc_ft.sources[1].kind'],
  ['chunks source base http', (m) => { const s = m.models.uvr_mdx_voc_ft.sources.find((x) => x.kind === 'chunks' && x.id !== 'origin'); s.base = 'http://cdn.example/x/'; }, `models.uvr_mdx_voc_ft.sources[${committed.models.uvr_mdx_voc_ft.sources.findIndex((x) => x.kind === 'chunks' && x.id !== 'origin')}].base`],
  ['chunks source base without trailing slash', (m) => { const s = m.models.uvr_mdx_voc_ft.sources.find((x) => x.kind === 'chunks' && x.id !== 'origin'); s.base = 'https://cdn.example/x'; }, `models.uvr_mdx_voc_ft.sources[${committed.models.uvr_mdx_voc_ft.sources.findIndex((x) => x.kind === 'chunks' && x.id !== 'origin')}].base`],
  ['whole source without urls.model', (m) => { const s = m.models.uvr_mdx_voc_ft.sources.find((x) => x.kind === 'whole'); delete s.urls.model; }, `models.uvr_mdx_voc_ft.sources[${committed.models.uvr_mdx_voc_ft.sources.findIndex((x) => x.kind === 'whole')}].urls.model`],
  ['two-file model: whole source without urls.externalData', (m) => { const s = m.models.melroformer_duality_student.sources.find((x) => x.kind === 'whole'); delete s.urls.externalData; }, `models.melroformer_duality_student.sources[${committed.models.melroformer_duality_student.sources.findIndex((x) => x.kind === 'whole')}].urls.externalData`],
  ['source label empty', (m) => { m.models.uvr_mdx_voc_ft.sources[1].label = ''; }, 'models.uvr_mdx_voc_ft.sources[1].label'],
  ['tag with a space', (m) => { m.tag = 'models 1'; }, 'tag'],
];

test(`validateManifest rejects ${MUTATIONS.length} mutations with MANIFEST naming the right path`, () => {
  for (const [label, mutate, expectedPath] of MUTATIONS) {
    const m = structuredClone(committed);
    mutate(m);
    let thrown = null;
    try { validateManifest(m); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof EngineError, `${label}: expected an EngineError`);
    assert.equal(thrown.code, 'MANIFEST', `${label}: code`);
    assert.equal(thrown.detail?.path, expectedPath, `${label}: path (${thrown.message})`);
  }
});

test('validateManifest accepts a melroformer hq tier (Tier 2 shape of §6.2)', () => {
  const m = structuredClone(committed);
  m.models.melroformer_duality_student = {
    displayName: '高质量', tier: 2, arch: 'melroformer', backends: ['webgpu'], license: 'Apache-2.0', source: 'https://huggingface.co/x',
    files: {
      model: { name: 'core.onnx', bytes: 10, sha256: 'a'.repeat(64), chunks: [{ path: 'models/melroformer_duality_student/core.part-00.bin', bytes: 10, sha256: 'b'.repeat(64) }] },
      externalData: { name: 'core.onnx.data', bytes: 20, sha256: 'c'.repeat(64), chunks: [{ path: 'models/melroformer_duality_student/data.part-00.bin', bytes: 20, sha256: 'd'.repeat(64) }] },
    },
    params: { sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 484659, stepSamples: 352800, weight: 'hamming54', inputName: 'stft_repr', outputName: 'masks', requiredFeatures: ['shader-f16'], minStorageBuffersPerShaderStage: 9, inputPeak: 0.9, outputPeak: 0.9 },
  };
  m.tiers.hq = { webgpu: 'melroformer_duality_student' };
  validateManifest(m);
  m.models.melroformer_duality_student.params.chunkSamples = 1;
  assert.throws(() => validateManifest(m), (e) => e.code === 'MANIFEST' && e.detail.path === 'models.melroformer_duality_student.params.chunkSamples');
});

test('directory ↔ manifest consistency: every site/models/<id>/ has an entry and every chunk file exists', () => {
  const modelsDir = path.join(repoRoot, 'site', 'models');
  const dirs = fs.readdirSync(modelsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const d of dirs) assert.ok(committed.models[d], `directory ${d} has no manifest entry`);
  for (const [id, m] of Object.entries(committed.models)) {
    assert.ok(dirs.includes(id), `manifest entry ${id} has no directory`);
    for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) {
      const file = path.join(repoRoot, 'site', ...c.path.split('/'));
      assert.ok(fs.existsSync(file), `missing ${c.path}`);
      assert.equal(fs.statSync(file).size, c.bytes, `size of ${c.path}`);
    }
    const listed = new Set([m.files.model, m.files.externalData].filter(Boolean).flatMap((f) => f.chunks.map((c) => c.path.split('/').pop())));
    for (const name of fs.readdirSync(path.join(modelsDir, id))) assert.ok(listed.has(name), `unlisted file site/models/${id}/${name}`);
  }
});

// ------------------------------------------------------------------ Node adapter
test('Node fetchInto adapter on a temp site tree: valid path, 404, 403 escape, overflow rule', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-site-'));
  try {
    fs.mkdirSync(path.join(root, 'models', 'm'), { recursive: true });
    const data = makeChunkBytes([1000], 5)[0];
    fs.writeFileSync(path.join(root, 'models', 'm', 'part-00.bin'), data);
    fs.writeFileSync(path.join(path.dirname(root), 'vs-outside-secret.bin'), new Uint8Array([1, 2, 3]));
    const fetchInto = makeNodeFetchInto(root);
    const slot = new Uint8Array(1000);
    let bytesSeen = 0;
    const r = await fetchInto(new URL('models/m/part-00.bin?v=1', BASE), slot, { onBytes: (n) => { bytesSeen = n; } });
    assert.deepEqual({ ok: r.ok, status: r.status, contentLength: r.contentLength, contentEncoding: r.contentEncoding, received: r.received }, { ok: true, status: 200, contentLength: 1000, contentEncoding: null, received: 1000 });
    assert.deepEqual(slot, data);
    assert.equal(bytesSeen, 1000);
    const miss = await fetchInto(new URL('models/m/part-01.bin', BASE), new Uint8Array(10));
    assert.equal(miss.ok, false); assert.equal(miss.status, 404);
    // `new URL()` resolves dot segments itself, so a URL can never carry `..`; a raw pathname (duck-typed) can
    const esc = await fetchInto({ pathname: '/models/m/../../vs-outside-secret.bin' }, new Uint8Array(10));
    assert.equal(esc.status, 403);
    const escBackslash = await fetchInto({ pathname: '/models/m/..\\..\\vs-outside-secret.bin' }, new Uint8Array(10));
    assert.equal(escBackslash.status, 403);
    const escDrive = await fetchInto({ pathname: '/C:/Windows/win.ini' }, new Uint8Array(10));
    assert.equal(escDrive.status, 403);
    const normalized = await fetchInto(new URL('http://localhost/models/m/../../vs-outside-secret.bin'), new Uint8Array(10));
    assert.equal(normalized.status, 404, 'URL-normalized path stays under the root and simply misses');
    assert.ok(fs.existsSync(path.join(path.dirname(root), 'vs-outside-secret.bin')), 'the outside file exists, so 404/403 prove the root was honoured');
    const small = new Uint8Array(999);
    const over = await fetchInto(new URL('models/m/part-00.bin', BASE), small);
    assert.equal(over.ok, true);
    assert.equal(over.received, 1000, 'received = target.length + 1 signals a longer body');
    assert.ok(small.every((b) => b === 0), 'nothing written on overflow');
    // sha256 of the slot equals the file's
    assert.equal(sha256Hex(slot), sha256Hex(data));
    // Range → 206 with the slice, Content-Range; unsatisfiable → 416
    const part = new Uint8Array(300);
    const rr = await fetchInto(new URL('models/m/part-00.bin', BASE), part, { range: { start: 200, end: 499 } });
    assert.deepEqual({ ok: rr.ok, status: rr.status, contentLength: rr.contentLength, contentRange: rr.contentRange, received: rr.received, rangeIgnored: rr.rangeIgnored }, { ok: true, status: 206, contentLength: 300, contentRange: 'bytes 200-499/1000', received: 300, rangeIgnored: false });
    assert.deepEqual(part, data.subarray(200, 500));
    const tail = await fetchInto(new URL('models/m/part-00.bin', BASE), new Uint8Array(50), { range: { start: 980, end: 5000 } });
    assert.equal(tail.received, 20, 'end clamped to the file size');
    assert.equal((await fetchInto(new URL('models/m/part-00.bin', BASE), new Uint8Array(10), { range: { start: 1000, end: 1009 } })).status, 416);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(root), 'vs-outside-secret.bin'), { force: true });
  }
});

test('loadModelBytes through the Node adapter on the committed manifest (9482, one chunk) assembles the exact bytes', { timeout: 60000 }, async () => {
  const m = validateManifest(structuredClone(committed));
  const file = m.models.uvr_mdxnet_9482.files.model;
  const chunkFile = path.join(repoRoot, 'site', ...file.chunks[0].path.split('/'));
  if (!fs.existsSync(chunkFile)) return;
  const progress = [];
  const r = await loadModelBytes(m, 'uvr_mdxnet_9482', { fetchInto: makeNodeFetchInto(path.join(repoRoot, 'site')), cache: null, subtle, baseUrl: BASE }, (e) => progress.push(e.stage));
  assert.equal(r.bytes.length, file.bytes);
  assert.equal(sha256Hex(r.bytes), file.sha256);
  assert.ok(progress.includes('download') && progress.includes('verify'));
});
