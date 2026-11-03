// tests/unit/model-loader.test.mjs — design §16.A row `model-loader.test.mjs` (§6.2 validator, §6.3 loader, Node adapter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, loadModelBytes } from '../../site/src/engine/model-loader.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';
import { makeNodeFetchInto } from '../../scripts/lib/fetch_into_node.mjs';
import { makeChunkBytes, concatBytes, makeManifest, makeFetchIntoFake, makeCacheStorageFake, sha256Hex } from '../lib/fakes.mjs';
import { readManifest, repoRoot } from '../lib/fixtures.mjs';

const subtle = globalThis.crypto.subtle;
const BASE = 'http://localhost/';

function serveMap(manifest, modelId, chunkArrays) {
  const m = manifest.models[modelId];
  const serve = {};
  let k = 0;
  for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) serve[c.path] = chunkArrays[k++];
  return serve;
}

function setup({ sizes = [1000, 1000, 500], externalSizes = null, overrides, cache = null, warn } = {}) {
  const modelChunks = makeChunkBytes(sizes, 1);
  const externalChunks = externalSizes ? makeChunkBytes(externalSizes, 2) : null;
  const manifest = validateManifest(makeManifest({ modelChunks, externalChunks }));
  const serve = serveMap(manifest, 'fake_model', [...modelChunks, ...(externalChunks ?? [])]);
  const fetchInto = makeFetchIntoFake(serve, overrides);
  const warns = [];
  const progress = [];
  const deps = { fetchInto, cache, subtle, baseUrl: BASE, warn: warn ?? ((...a) => warns.push(a)) };
  return { manifest, modelChunks, externalChunks, fetchInto, deps, warns, progress, onProgress: (e) => progress.push(e), expected: concatBytes(modelChunks) };
}

async function expectEngineError(promise, code) {
  try { await promise; } catch (e) {
    assert.ok(e instanceof EngineError, `expected EngineError, got ${e && e.stack}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected ${code} to be thrown`);
}

// ------------------------------------------------------------------ loader happy path
test('3 fake chunks → assembled bytes, download/verify progress, 6-wide pool, ?v= query, no cache', async () => {
  const s = setup();
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(r.externalData, undefined);
  assert.equal(s.fetchInto.calls.length, 3);
  for (const c of s.fetchInto.calls) { assert.equal(c.query, '?v=test-1'); assert.equal(c.cache, undefined); assert.equal(c.attempt, 1); }
  const stages = s.progress.map((p) => p.stage);
  assert.ok(stages.includes('download') && stages.includes('verify'));
  assert.equal(stages.lastIndexOf('download') < stages.indexOf('verify'), true);
  const last = s.progress.filter((p) => p.stage === 'download').pop();
  assert.deepEqual(last, { stage: 'download', bytesDone: 2500, bytesTotal: 2500, chunksDone: 3, chunkCount: 3 });
  assert.equal(s.warns.length, 0);
});

test('corrupted chunk → one retry with cache "reload" → MODEL_HASH { chunkIndex: 1, chunkCount: 3, file: "model" }', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-01.bin') ? { bytes: makeChunkBytes([1000], 99)[0] } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: 1, chunkCount: 3, file: 'model' });
  const retries = s.fetchInto.calls.filter((c) => c.pathname.endsWith('part-01.bin'));
  assert.equal(retries.length, 2);
  assert.equal(retries[0].cache, undefined);
  assert.equal(retries[1].cache, 'reload');
});

test('gzip contentEncoding with a wrong contentLength is accepted', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-00.bin') ? { contentEncoding: 'gzip', contentLength: 123 } : null) });
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, 3);
});

test('identity encoding with a wrong contentLength is a length mismatch → retry → MODEL_HASH', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-00.bin') ? { contentLength: 999 } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: 0, chunkCount: 3, file: 'model' });
  assert.equal(s.fetchInto.calls.filter((c) => c.pathname.endsWith('part-00.bin')).length, 2);
});

test('overflow body (received = len + 1, neighbouring slot untouched) → retry → MODEL_HASH', async () => {
  let slotAfter = null;
  const s = setup({ overrides: (p, attempt, opts) => (p.endsWith('part-01.bin') ? { overflow: true } : null) });
  // wrap fetchInto to capture the assembled view of chunk 2 right after chunk 1's overflow returns
  const inner = s.deps.fetchInto;
  s.deps.fetchInto = async (url, target, opts) => {
    const r = await inner(url, target, opts);
    if (String(url).includes('part-01.bin')) slotAfter = new Uint8Array(target.buffer, target.byteOffset + target.length, 500).slice();
    return r;
  };
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: 1, chunkCount: 3, file: 'model' });
  assert.equal(inner.calls.filter((c) => c.pathname.endsWith('part-01.bin')).length, 2);
  // the neighbouring slot either still holds chunk 2's bytes (if it finished) or zeros — never garbage from the overflow
  const ok = slotAfter.every((b) => b === 0) || Buffer.compare(Buffer.from(slotAfter), Buffer.from(s.modelChunks[2])) === 0;
  assert.ok(ok, 'bytes were written past the chunk slot');
});

test('short body → retry → MODEL_HASH', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-02.bin') ? { short: 300 } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: 2, chunkCount: 3, file: 'model' });
});

test('status 503 on chunk 2 → MODEL_DOWNLOAD detail deepEqual { chunkIndex: 1, chunkCount: 3, status: 503 }', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-01.bin') ? { status: 503 } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_DOWNLOAD');
  assert.deepEqual(e.detail, { chunkIndex: 1, chunkCount: 3, status: 503 });
  assert.equal(s.fetchInto.calls.filter((c) => c.pathname.endsWith('part-01.bin')).length, 1, 'no retry on an HTTP status');
});

test('rejected fetchInto (TypeError) → MODEL_DOWNLOAD status 0', async () => {
  const s = setup({ overrides: (p) => (p.endsWith('part-00.bin') ? { reject: new TypeError('Failed to fetch') } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_DOWNLOAD');
  assert.deepEqual(e.detail, { chunkIndex: 0, chunkCount: 3, status: 0 });
});

test('two-file manifest (2 + 3 chunks): first externalData chunk failing → chunkIndex 2, chunkCount 5; progress chunkCount 5', async () => {
  const s = setup({ sizes: [800, 700], externalSizes: [600, 500, 400], overrides: (p) => (p.endsWith('/data.part-00.bin') ? { status: 500 } : null) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress), 'MODEL_DOWNLOAD');
  assert.deepEqual(e.detail, { chunkIndex: 2, chunkCount: 5, status: 500 });
  for (const p of s.progress.filter((x) => x.stage === 'download')) { assert.equal(p.chunkCount, 5); assert.equal(p.bytesTotal, 3000); }
  // happy path of the same manifest returns externalData { path, data }
  const s2 = setup({ sizes: [800, 700], externalSizes: [600, 500, 400] });
  const r = await loadModelBytes(s2.manifest, 'fake_model', s2.deps, s2.onProgress);
  assert.deepEqual(r.bytes, s2.expected);
  assert.equal(r.externalData.path, 'fake.onnx.data');
  assert.deepEqual(r.externalData.data, concatBytes(s2.externalChunks));
  const last = s2.progress.filter((p) => p.stage === 'download').pop();
  assert.deepEqual(last, { stage: 'download', bytesDone: 3000, bytesTotal: 3000, chunksDone: 5, chunkCount: 5 });
  assert.equal(s2.progress.filter((p) => p.stage === 'verify').length, 2);
});

test('whole-file sha256 mismatch → MODEL_HASH { chunkIndex: -1, chunkCount, file }', async () => {
  const s = setup();
  s.manifest.models.fake_model.files.model.sha256 = 'f'.repeat(64);
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_HASH');
  assert.deepEqual(e.detail, { chunkIndex: -1, chunkCount: 3, file: 'model' });
});

test('first failure aborts in-flight siblings; only the first failure is reported', async () => {
  const s = setup({ sizes: [1000, 1000, 1000, 1000], overrides: (p) => (p.endsWith('part-00.bin') ? { status: 503 } : { delayMs: 30 }) });
  const e = await expectEngineError(loadModelBytes(s.manifest, 'fake_model', s.deps), 'MODEL_DOWNLOAD');
  assert.deepEqual(e.detail, { chunkIndex: 0, chunkCount: 4, status: 503 });
  // the siblings started concurrently (pool) and saw the abort signal fire
  const siblings = s.fetchInto.calls.filter((c) => !c.pathname.endsWith('part-00.bin'));
  assert.ok(siblings.length >= 1);
  assert.ok(siblings.every((c) => c.signal.aborted), 'sibling signals were aborted');
  assert.ok(siblings.some((c) => c.abortedMidBody), 'at least one sibling observed the abort mid-body');
});

// ------------------------------------------------------------------ cache paths
test('cache hit path: second load served from cache, zero fetchInto calls, verify progress emitted', async () => {
  const caches = makeCacheStorageFake();
  const s = setup({ cache: caches });
  const r1 = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r1.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, 3);
  assert.ok(caches.log.some(([op]) => op === 'put'));
  const store = caches._stores.get('vs-models-test-1');
  assert.equal(store.size, 1);
  assert.equal([...store.keys()][0], 'http://localhost/models/fake_model/fake.onnx');
  s.progress.length = 0;
  const r2 = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r2.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, 3, 'no new downloads');
  assert.deepEqual(s.progress.map((p) => p.stage), ['verify']);
  assert.equal(s.warns.length, 0);
});

test('corruption in cache → delete + re-download', async () => {
  const caches = makeCacheStorageFake();
  const s = setup({ cache: caches });
  await loadModelBytes(s.manifest, 'fake_model', s.deps);
  const store = caches._stores.get('vs-models-test-1');
  const entry = store.get('http://localhost/models/fake_model/fake.onnx');
  entry.body[10] ^= 0xFF;
  const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
  assert.deepEqual(r.bytes, s.expected);
  assert.equal(s.fetchInto.calls.length, 6);
  assert.ok(caches.log.some(([op, url]) => op === 'delete' && url === 'http://localhost/models/fake_model/fake.onnx'));
  assert.equal(s.warns.length, 0);
});

test('startup cleanup deletes other vs-models-* caches and keeps foreign ones', async () => {
  const caches = makeCacheStorageFake({ existingNames: ['vs-models-old-1', 'vs-models-old-2', 'other-app'] });
  const s = setup({ cache: caches });
  await loadModelBytes(s.manifest, 'fake_model', s.deps);
  assert.deepEqual([...caches._stores.keys()].sort(), ['other-app', 'vs-models-test-1']);
});

for (const [label, make] of Object.entries({
  'cache null': () => null,
  'open() rejecting SecurityError': () => makeCacheStorageFake({ fail: { open: { name: 'SecurityError' } } }),
  'match() rejecting': () => makeCacheStorageFake({ fail: { match: { name: 'InvalidStateError' } } }),
  'keys() rejecting': () => makeCacheStorageFake({ fail: { keys: { name: 'SecurityError' } } }),
  'put() rejecting QuotaExceededError': () => makeCacheStorageFake({ fail: { put: { name: 'QuotaExceededError' } } }),
  'put() rejecting generic Error': () => makeCacheStorageFake({ fail: { put: { name: 'Error' } } }),
})) {
  test(`degrade case — ${label}: bytes returned, normal progress, exactly one warn (or none for null), never INTERNAL`, async () => {
    const s = setup({ cache: make() });
    const r = await loadModelBytes(s.manifest, 'fake_model', s.deps, s.onProgress);
    assert.deepEqual(r.bytes, s.expected);
    const stages = s.progress.map((p) => p.stage);
    assert.ok(stages.includes('download') && stages.includes('verify'));
    assert.equal(s.warns.length, label === 'cache null' ? 0 : 1, `warns: ${JSON.stringify(s.warns.map((w) => w[0]))}`);
    assert.equal(s.fetchInto.calls.length, 3);
  });
}

// ------------------------------------------------------------------ validator
const committed = readManifest();

test('validateManifest accepts the committed site/models/manifest.json and tiers.standard.wasmLow === uvr_mdxnet_9482', () => {
  const m = validateManifest(structuredClone(committed));
  assert.equal(m.tiers.standard.wasmLow, 'uvr_mdxnet_9482');
  assert.equal(m.models.uvr_mdxnet_9482.params.dimF, 2048);
  assert.ok(m.tiers.standard.webgpu && m.tiers.standard.wasm);
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
