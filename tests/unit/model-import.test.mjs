// tests/unit/model-import.test.mjs — FIX-2 R2b: offline import matching (whole .onnx / .onnx.data, part-NN.bin chunks,
// mismatches, same-size candidates resolved by sha256), parts written under the loader's keys, and a following
// loadModelBytes that assembles the model with ZERO network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importModelFiles, candidatesForSize } from '../../site/src/engine/model-import.mjs';
import { validateManifest, loadModelBytes, planSegments } from '../../site/src/engine/model-loader.mjs';
import { partKey, fileKey } from '../../site/src/engine/part-store.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';
import { makeChunkBytes, concatBytes, makeManifest, makeStoreFake } from '../lib/fakes.mjs';
import { readManifest } from '../lib/fixtures.mjs';

const subtle = globalThis.crypto.subtle;
const asFile = (name, bytes) => ({ name, size: bytes.length, slice: async (a, b) => bytes.slice(a, b) });

function fixture() {
  const modelChunks = makeChunkBytes([1000, 1000, 500], 1);
  const externalChunks = makeChunkBytes([900, 300], 2);
  const manifest = validateManifest(makeManifest({ modelChunks, externalChunks }));
  return { manifest, modelChunks, externalChunks, model: concatBytes(modelChunks), external: concatBytes(externalChunks), file: manifest.models.fake_model.files.model, ext: manifest.models.fake_model.files.externalData };
}

test('candidatesForSize: whole files and chunks by byte count over the committed manifest', () => {
  const m = readManifest();
  const voc = m.models.uvr_mdx_voc_ft.files.model;
  assert.deepEqual(candidatesForSize(m, voc.bytes).map((c) => [c.kind, c.modelId, c.fileKey]), [['whole', 'uvr_mdx_voc_ft', 'model']]);
  const nineteen = candidatesForSize(m, 19000000);
  assert.ok(nineteen.length >= 3 && nineteen.every((c) => c.kind === 'chunk'), 'every 19,000,000 B chunk of every model is a candidate (resolved by sha256)');
  assert.deepEqual(candidatesForSize(m, 12345), []);
  const data = m.models.melroformer_duality_student.files.externalData;
  assert.deepEqual(candidatesForSize(m, data.bytes).map((c) => c.fileKey), ['externalData']);
});

test('whole .onnx + .onnx.data import: chunk-by-chunk hashing (<= one chunk in memory), parts under the loader keys, progress, result', async () => {
  const f = fixture();
  const store = makeStoreFake();
  const progress = [];
  const r = await importModelFiles(f.manifest, [asFile('fake.onnx', f.model), asFile('fake.onnx.data', f.external)], { store, subtle, onProgress: (p) => progress.push(p) });
  assert.deepEqual(r.mismatched, []);
  assert.equal(r.imported.length, 1);
  assert.equal(r.imported[0].modelId, 'fake_model');
  assert.equal(r.imported[0].displayName, '测试');
  assert.equal(r.imported[0].bytes, 2500 + 1200);
  assert.equal(r.imported[0].files.length, 2);
  const segsM = planSegments(f.file), segsE = planSegments(f.ext);
  assert.deepEqual([...store._map.keys()].sort(), [...segsM.map((s) => partKey('fake_model', f.file.sha256, s.n)), ...segsE.map((s) => partKey('fake_model', f.ext.sha256, s.n))].sort());
  for (const s of segsM) assert.deepEqual(store._map.get(partKey('fake_model', f.file.sha256, s.n)), f.model.slice(s.fileOffset, s.fileOffset + s.length));
  assert.deepEqual(progress[0], { doneBytes: 0, totalBytes: 3700 });
  assert.deepEqual(progress[progress.length - 1], { doneBytes: 3700, totalBytes: 3700 });
  assert.ok(progress.every((p, i) => i === 0 || p.doneBytes >= progress[i - 1].doneBytes), 'monotonic');
  // the loader assembles the imported model without touching the network (a throwing fetchInto)
  const loaded = await loadModelBytes(f.manifest, 'fake_model', { fetchInto: () => { throw new Error('network used'); }, store, subtle, baseUrl: 'http://localhost/', warn: () => {}, sleep: async () => {} });
  assert.deepEqual(loaded.bytes, f.model);
  assert.deepEqual(loaded.externalData.data, f.external);
  assert.equal(loaded.report.restoredBytes, 3700);
  assert.equal(loaded.report.downloadedBytes, 0);
  assert.equal(loaded.report.sources, null, 'no probe either');
  assert.ok(store._map.has(fileKey('fake_model', f.file.sha256)) && store._map.has(fileKey('fake_model', f.ext.sha256)), 'assembled files stored, parts dropped');
  assert.equal([...store._map.keys()].filter((k) => k.includes(':part-')).length, 0);
});

test('part-NN.bin import: chunk files matched by size + sha256 (one of them corrupted → mismatch), the loader then fetches only the missing chunk', async () => {
  const f = fixture();
  const store = makeStoreFake();
  const bad = f.modelChunks[1].slice(); bad[3] ^= 0xff;
  const r = await importModelFiles(f.manifest, [asFile('core.part-00.bin', f.modelChunks[0]), asFile('whatever.bin', bad), asFile('core.part-02.bin', f.modelChunks[2])], { store, subtle });
  assert.deepEqual(r.mismatched, ['whatever.bin']);
  assert.equal(r.imported[0].bytes, 1500);
  assert.equal(r.imported[0].files.length, 2);
  assert.match(r.imported[0].files[0].matched, /fake\.onnx chunk 1\/3/);
  const { makeFetchIntoFake, serveMapFor } = await import('../lib/fakes.mjs');
  const fetchInto = makeFetchIntoFake(serveMapFor(f.manifest, 'fake_model', [...f.modelChunks, ...f.externalChunks]));
  // the loader keeps the default 4 MiB segments: the import wrote its parts with the same plan (one part per chunk here)
  const loaded = await loadModelBytes(f.manifest, 'fake_model', { fetchInto, store, subtle, baseUrl: 'http://localhost/', warn: () => {}, sleep: async () => {} });
  assert.deepEqual(loaded.bytes, f.model);
  assert.equal(loaded.report.restoredBytes, 1500);
  assert.equal(loaded.report.downloadedBytes, 1000 + 1200, 'chunk 1 of the model + the whole externalData');
  const [probeCall, ...rest] = fetchInto.calls;
  assert.ok(probeCall.pathname.endsWith('core.part-00.bin'), 'the probe reads the first chunk');
  const modelDownloads = rest.filter((c) => c.pathname.includes('core.part-'));
  assert.equal(modelDownloads.length, 1);
  assert.ok(modelDownloads.every((c) => c.pathname.endsWith('core.part-01.bin')), 'only the missing chunk is fetched');
});

test('mismatches: unknown size, right size wrong bytes (its partial parts are removed), empty list', async () => {
  const f = fixture();
  const store = makeStoreFake();
  const wrongBytes = makeChunkBytes([2500], 9)[0];
  const r = await importModelFiles(f.manifest, [asFile('a.onnx', new Uint8Array(777)), asFile('b.onnx', wrongBytes)], { store, subtle });
  assert.deepEqual(r.imported, []);
  assert.deepEqual(r.mismatched, ['a.onnx', 'b.onnx']);
  assert.equal(store._map.size, 0, 'nothing left from the rejected whole-file candidate');
  const empty = await importModelFiles(f.manifest, [], { store, subtle });
  assert.deepEqual(empty, { imported: [], mismatched: [], totalBytes: 0 });
  await assert.rejects(importModelFiles(f.manifest, [], { store: null, subtle }), /store missing/);
});

test('a part file is read and hashed once however many same-size chunks the manifest has (the committed manifest has 15 of 19,000,000 B)', async () => {
  const f = fixture();
  // make every 1000 B chunk of the fixture a candidate: model chunks 0/1 are 1000 B, so a 1000 B file has two chunk candidates
  assert.equal(candidatesForSize(f.manifest, 1000).length, 2);
  let slices = 0;
  const file = { name: 'core.part-01.bin', size: 1000, slice: async (a, b) => { slices++; return f.modelChunks[1].slice(a, b); } };
  const store = makeStoreFake();
  const r = await importModelFiles(f.manifest, [file], { store, subtle });
  assert.equal(r.imported[0].bytes, 1000);
  assert.match(r.imported[0].files[0].matched, /chunk 2\/3/);
  assert.equal(slices, 1, 'one read, one sha256, compared with every candidate');
  slices = 0;
  const miss = await importModelFiles(f.manifest, [{ ...file, name: 'x.bin', slice: async (a, b) => { slices++; return makeChunkBytes([1000], 42)[0].slice(a, b); } }], { store, subtle });
  assert.deepEqual(miss.mismatched, ['x.bin']);
  assert.equal(slices, 1);
});

test('a store that cannot take the bytes (put → false from the exhausted facade, or a throwing put) → IMPORT_STORE, nothing reported as imported, written keys removed', async () => {
  const f = fixture();
  // the facade's shape: `false` once every backend failed (never throws)
  const dead = makeStoreFake();
  dead.put = async (key, bytes) => { dead.log.push(['put', key, bytes.length]); return false; };
  await assert.rejects(importModelFiles(f.manifest, [asFile('fake.onnx', f.model)], { store: dead, subtle }), (e) => e instanceof EngineError && e.code === 'IMPORT_STORE' && /store put failed/.test(e.message));
  assert.equal(dead._map.size, 0);
  // a backend that starts failing after some parts: the parts already written are deleted (best effort), the import fails
  const flaky = makeStoreFake();
  let puts = 0;
  const realPut = flaky.put.bind(flaky);
  flaky.put = async (key, bytes) => { if (++puts > 2) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); return realPut(key, bytes); };
  await assert.rejects(importModelFiles(f.manifest, [asFile('fake.onnx', f.model)], { store: flaky, subtle }), (e) => e.code === 'IMPORT_STORE' && /quota/.test(e.message));
  assert.equal(flaky._map.size, 0, 'the two stored parts were removed');
  assert.ok(flaky.log.filter(([op]) => op === 'delete').length >= 2);
  // the loader's own store rule is unchanged: a failing put only warns there
  const warns = [];
  const loaded = await loadModelBytes(f.manifest, 'fake_model', { fetchInto: (await import('../lib/fakes.mjs')).makeFetchIntoFake((await import('../lib/fakes.mjs')).serveMapFor(f.manifest, 'fake_model', [...f.modelChunks, ...f.externalChunks])), store: makeStoreFake({ fail: { put: {} } }), subtle, baseUrl: 'http://localhost/', warn: (...a) => warns.push(a), sleep: async () => {} });
  assert.deepEqual(loaded.bytes, f.model);
  assert.ok(warns.length >= 1);
});

test('a file the store already holds assembled is verified but not written again: no parts beside the file, still 已导入', async () => {
  const f = fixture();
  const store = makeStoreFake();
  // the loader stored the model file on an earlier run; only the externalData file is missing
  await store.put(fileKey('fake_model', f.file.sha256), f.model);
  store.log.length = 0;
  const r = await importModelFiles(f.manifest, [asFile('fake.onnx', f.model), asFile('fake.onnx.data', f.external)], { store, subtle });
  assert.deepEqual(r.mismatched, []);
  assert.equal(r.imported.length, 1);
  assert.equal(r.imported[0].bytes, 2500 + 1200, 'the stored file still counts as imported');
  assert.deepEqual(r.imported[0].files.map((x) => [x.name, x.alreadyStored, x.chunks]), [['fake.onnx', true, 0], ['fake.onnx.data', false, planSegments(f.ext).length]]);
  const puts = store.log.filter(([op]) => op === 'put').map(([, k]) => k);
  assert.ok(puts.every((k) => k.startsWith(fileKey('fake_model', f.ext.sha256) + ':part-')), `only the data file's parts were written: ${JSON.stringify(puts)}`);
  assert.equal([...store._map.keys()].filter((k) => k.startsWith(fileKey('fake_model', f.file.sha256) + ':part-')).length, 0, 'no parts beside the assembled model file');
  // a part file of the stored model: matched by sha256, nothing written
  const r2 = await importModelFiles(f.manifest, [asFile('core.part-01.bin', f.modelChunks[1])], { store, subtle });
  assert.equal(r2.imported[0].bytes, 1000);
  assert.deepEqual(r2.imported[0].files.map((x) => [x.alreadyStored, x.chunks]), [[true, 0]]);
  assert.equal([...store._map.keys()].filter((k) => k.startsWith(fileKey('fake_model', f.file.sha256) + ':part-')).length, 0);
  // a wrong file of the right size is still a mismatch, even when a file of that size is stored
  const wrong = f.model.slice(); wrong[5] ^= 0xff;
  const r3 = await importModelFiles(f.manifest, [asFile('other.onnx', wrong)], { store, subtle });
  assert.deepEqual(r3.mismatched, ['other.onnx']);
  assert.equal(r3.imported.length, 0);
});

test('same-size candidates are told apart by sha256 (two models with equal file sizes)', async () => {
  const f = fixture();
  const other = structuredClone(f.manifest.models.fake_model);
  const otherChunks = makeChunkBytes([1000, 1000, 500], 7);
  const all = concatBytes(otherChunks);
  const { sha256Hex } = await import('../lib/fakes.mjs');
  other.files.model = { ...other.files.model, sha256: sha256Hex(all), chunks: other.files.model.chunks.map((c, i) => ({ ...c, path: c.path.replace('fake_model', 'other_model'), sha256: sha256Hex(otherChunks[i]) })) };
  other.files.externalData = { ...other.files.externalData, chunks: other.files.externalData.chunks.map((c) => ({ ...c, path: c.path.replace('fake_model', 'other_model') })) };
  f.manifest.models.other_model = other;
  validateManifest(f.manifest);
  assert.equal(candidatesForSize(f.manifest, 2500).length, 2);
  const store = makeStoreFake();
  const r = await importModelFiles(f.manifest, [asFile('x.onnx', all)], { store, subtle });
  assert.deepEqual(r.imported.map((m) => m.modelId), ['other_model']);
  assert.ok([...store._map.keys()].every((k) => k.startsWith(`other_model:${sha256Hex(all)}:part-`)));
});
