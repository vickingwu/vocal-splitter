// tests/unit/handler.test.mjs — design §7.2–§7.4 worker handler (§16.A row) with the fakes of tests/lib/fakes.mjs;
// design_accepted DA-1 acceptance (navigator.gpu absent + init.backend webgpu → backend-fallback, zero bundle loads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, validateBaseUrl } from '../../site/src/worker/handler.mjs';
import { loadModelBytes } from '../../site/src/engine/model-loader.mjs';
import { makeHandlerFixture, makeAudio, waitForPosted, settle, makeOrtFake, makeGpuFake, serveMapFor, makeFetchIntoFake } from '../lib/fakes.mjs';

const N = 10000;                       // SMALL_PARAMS: 5 planned chunks, 4 non-skipped
const NON_SKIPPED = 4;
const sep = (jobId, over = {}) => { const a = makeAudio(N); return { type: 'separate', jobId, tier: 'standard', modelId: 'fake_model', left: a.left, right: a.right, denoise: false, ...over }; };
const stages = (posted) => posted.filter((m) => m.type === 'progress').map((m) => m.stage);
const errors = (posted) => posted.filter((m) => m.type === 'error');
const untilResult = (posted) => waitForPosted(posted, (p) => p.some((m) => m.type === 'result' || m.type === 'error' || m.type === 'backend-fallback'));

test('validateBaseUrl rules', () => {
  assert.equal(validateBaseUrl('http://localhost/', 'http://localhost'), true);
  assert.equal(validateBaseUrl('http://localhost/sub/dir/', 'http://localhost'), true);
  for (const bad of ['http://localhost/?x=1', 'http://localhost/#h', 'http://localhost/dir', 'http://other.example/', 'not a url', undefined, 42]) assert.equal(validateBaseUrl(bad, 'http://localhost'), false, String(bad));
});

test('init accepted for http://localhost/ and http://localhost/sub/dir/ → ready { backend, threads, gpu: null }', async () => {
  for (const baseUrl of ['http://localhost/', 'http://localhost/sub/dir/']) {
    const f = await makeHandlerFixture();
    f.handler.onMessage(f.init({ baseUrl }));
    await waitForPosted(f.posted, (p) => p.length > 0);
    assert.deepEqual(f.posted, [{ type: 'ready', backend: 'wasm', threads: 2, gpu: null }]);
    assert.deepEqual(f.bundleCalls, ['wasm']);
  }
});

test('rejected baseUrls → no ready, zero fetchInto / bundle loads, later separate → INTERNAL field baseUrl', async () => {
  for (const baseUrl of ['http://localhost/?x=1', 'http://localhost/#h', 'http://localhost/dir', 'http://other.example/', 'not a url', undefined]) {
    const f = await makeHandlerFixture();
    f.handler.onMessage(f.init({ baseUrl }));
    f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
    f.handler.onMessage(sep('j1'));
    await waitForPosted(f.posted, (p) => p.length > 0);
    await settle();
    assert.equal(f.posted.length, 1, String(baseUrl));
    assert.equal(f.posted[0].type, 'error');
    assert.equal(f.posted[0].code, 'INTERNAL');
    assert.equal(f.posted[0].jobId, 'j1');
    assert.equal(f.posted[0].detail.field, 'baseUrl');
    assert.equal(f.fetchInto.calls.length, 0);
    assert.equal(f.bundleCalls.length, 0);
    assert.equal(f.handler.dead, true);
  }
});

test('invalid backend / threads / manifest → dead handler naming the field', async () => {
  for (const [over, field] of [[{ backend: 'cuda' }, 'backend'], [{ threads: 0 }, 'threads'], [{ threads: 65 }, 'threads'], [{ threads: 2.5 }, 'threads'], [{ manifest: { schema: 2 } }, 'manifest']]) {
    const f = await makeHandlerFixture();
    f.handler.onMessage(f.init(over));
    f.handler.onMessage(sep('j1'));
    await waitForPosted(f.posted, (p) => p.length > 0);
    assert.equal(f.posted[0].detail.field, field);
    assert.equal(f.bundleCalls.length, 0);
  }
});

test('queue order: init, load-model, separate posted synchronously → one download sequence, verify, session, separate × 4, finalize, result', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  const st = stages(f.posted);
  assert.equal(f.fetchInto.calls.length, 3, 'chunkCount fetches');
  assert.equal(st.filter((s) => s === 'verify').length, 1);
  assert.equal(st.filter((s) => s === 'session').length, 1);
  assert.equal(st.filter((s) => s === 'separate').length, NON_SKIPPED);
  assert.equal(st.filter((s) => s === 'finalize').length, 1);
  assert.ok(st.lastIndexOf('download') < st.indexOf('verify') && st.indexOf('verify') < st.indexOf('session') && st.indexOf('session') < st.indexOf('separate') && st.lastIndexOf('separate') < st.indexOf('finalize'));
  assert.equal(f.posted[0].type, 'ready');
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result');
  assert.equal(r.jobId, 'j1');
  assert.equal(r.vocals[0].length, N);
  assert.equal(r.instrumental[1].length, N);
  assert.equal(r._transfer.length, 4);
  assert.equal(r.timings.backend, 'wasm');
  assert.equal(r.timings.modelId, 'fake_model');
  assert.equal(r.timings.tier, 'standard');
  assert.equal(r.timings.threads, 2);
  assert.equal(r.timings.fellBack, false);
  assert.equal(r.timings.denoise, false);
  assert.equal(r.timings.chunkMs.length, NON_SKIPPED);
  for (const k of ['downloadMs', 'verifyMs', 'sessionMs', 'stftMs', 'istftMs', 'totalMs']) assert.equal(typeof r.timings[k], 'number', k);
  // every progress event after the separate was dequeued carries the jobId; the sequence is one job
  const withJob = f.posted.filter((m) => m.type === 'progress' && m.stage !== 'download');
  for (const m of withJob) { assert.equal(m.jobId, 'j1'); assert.equal(typeof m.elapsedMs, 'number'); }
  assert.equal(f.ort.created.length, 1);
});

const addOtherModel = (m) => {
  m.models.other = JSON.parse(JSON.stringify(m.models.fake_model));
  m.models.other.files.model.chunks = m.models.other.files.model.chunks.map((c) => ({ ...c, path: c.path.replace('fake_model', 'other') }));
};

test('memoization: a second separate for the same id → zero further fetches, one createSession; a different id → release() once', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  assert.equal(f.fetchInto.calls.length, 3);
  f.handler.onMessage(sep('j2'));
  await waitForPosted(f.posted, (p) => p.filter((m) => m.type === 'result').length === 2);
  assert.equal(f.fetchInto.calls.length, 3, 'no further fetches');
  assert.equal(f.ort.created.length, 1, 'one createSession');
  const firstResult = f.posted.findIndex((m) => m.type === 'result');
  assert.equal(stages(f.posted.slice(firstResult)).filter((s) => s === 'download' || s === 'verify' || s === 'session').length, 0, 'second job: no download/verify/session progress');
  // different id → previous session released once
  const f2 = await makeHandlerFixture({ manifestPatch: addOtherModel });
  const fetchInto2 = makeFetchIntoFake({ ...serveMapFor(f2.manifest, 'fake_model', f2.modelChunks), ...serveMapFor(f2.manifest, 'other', f2.modelChunks) });
  const posted2 = [];
  const ort2 = makeOrtFake();
  const h2 = createHandler({ post: (m) => posted2.push(m), loadBundle: async () => ort2, gpu: undefined, fetchInto: fetchInto2, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {} });
  h2.onMessage(f2.init());
  h2.onMessage(sep('j1'));
  await untilResult(posted2);
  h2.onMessage({ type: 'load-model', modelId: 'other' });
  h2.onMessage(sep('j2', { modelId: 'other' }));
  await waitForPosted(posted2, (p) => p.filter((m) => m.type === 'result').length === 2);
  assert.equal(ort2.created.length, 2);
  assert.equal(ort2.created[0].released, 1, 'first session released exactly once');
  assert.equal(ort2.created[1].released, 0);
  assert.equal(posted2.filter((m) => m.type === 'result')[1].timings.modelId, 'other');
});

test('failed prefetch (503) + separate → one download attempt, MODEL_DOWNLOAD with the separate jobId and the loader detail object; third separate re-downloads', async () => {
  let fails = 1;
  let thrown = null;
  const f = await makeHandlerFixture({ overrides: (p) => (p.endsWith('part-01.bin') && fails-- > 0 ? { status: 503 } : null) });
  const posted = [];
  const h = createHandler({
    post: (m) => posted.push(m), loadBundle: async () => f.ort, gpu: undefined, fetchInto: f.fetchInto, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {},
    loadModelBytes: async (...a) => { try { return await loadModelBytes(...a); } catch (e) { thrown = e; throw e; } },
  });
  h.onMessage(f.init());
  h.onMessage({ type: 'load-model', modelId: 'fake_model' });
  h.onMessage(sep('j1'));
  await waitForPosted(posted, (p) => p.some((m) => m.type === 'error'));
  const e = errors(posted)[0];
  assert.equal(e.code, 'MODEL_DOWNLOAD');
  assert.equal(e.jobId, 'j1');
  assert.ok(thrown);
  assert.strictEqual(e.detail, thrown.detail, 'same detail object, not re-shaped');
  assert.deepEqual(e.detail, { chunkIndex: 1, chunkCount: 3, status: 503 });
  const attemptsAfterFail = f.fetchInto.calls.filter((c) => c.pathname.endsWith('part-01.bin')).length;
  assert.equal(attemptsAfterFail, 1, 'one attempt on the failing chunk (no hash retry for a status failure)');
  const total1 = f.fetchInto.calls.length;
  assert.ok(total1 <= 3);
  h.onMessage(sep('j3'));
  await waitForPosted(posted, (p) => p.some((m) => m.type === 'result'));
  assert.ok(f.fetchInto.calls.length > total1, 'memo entry cleared → re-download');
  assert.equal(posted[posted.length - 1].jobId, 'j3');
  assert.equal(errors(posted).length, 1);
});

test('failed prefetch alone → no error message and no unhandled rejection', async () => {
  const f = await makeHandlerFixture({ overrides: (p) => (p.endsWith('part-00.bin') ? { status: 500 } : null) });
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    f.handler.onMessage(f.init());
    f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
    await waitForPosted(f.posted, (p) => p.some((m) => m.type === 'ready'));
    await settle(100);
    assert.equal(errors(f.posted).length, 0);
    assert.equal(unhandled, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('load-model / separate with an id not valid for the backend → INTERNAL with the separate jobId, nothing fetched', async () => {
  const f = await makeHandlerFixture({ manifestPatch: (m) => { m.models.gpu_only = JSON.parse(JSON.stringify(m.models.fake_model)); m.models.gpu_only.backends = ['webgpu']; m.models.gpu_only.files.model.chunks = m.models.gpu_only.files.model.chunks.map((c) => ({ ...c, path: c.path.replace('fake_model', 'gpu_only') })); } });
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'gpu_only' });
  f.handler.onMessage(sep('j1', { modelId: 'gpu_only' }));
  await waitForPosted(f.posted, (p) => p.some((m) => m.type === 'error'));
  const e = errors(f.posted)[0];
  assert.equal(e.code, 'INTERNAL');
  assert.equal(e.jobId, 'j1');
  assert.deepEqual(e.detail, { modelId: 'gpu_only', backend: 'wasm' });
  assert.equal(f.fetchInto.calls.length, 0);
  const g = await makeHandlerFixture();
  g.handler.onMessage(g.init());
  g.handler.onMessage(sep('j9', { modelId: 'unknown_model' }));
  await waitForPosted(g.posted, (p) => p.some((m) => m.type === 'error'));
  assert.equal(errors(g.posted)[0].code, 'INTERNAL');
  assert.equal(errors(g.posted)[0].jobId, 'j9');
  assert.equal(g.fetchInto.calls.length, 0);
});

test('maxChunks 2 stops after two non-skipped chunks and still returns full-length stems', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1', { maxChunks: 2 }));
  await untilResult(f.posted);
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result');
  assert.equal(r.timings.chunkMs.length, 2);
  assert.equal(stages(f.posted).filter((s) => s === 'separate').length, 2);
  assert.equal(r.vocals[0].length, N);
  assert.equal(r.vocals[1].length, N);
  assert.equal(r.instrumental[0].length, N);
});

test('invalid separate payload → INTERNAL with its jobId; unknown message type with jobId → INTERNAL; without jobId → dropped', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'separate', jobId: 'j1', tier: 'standard', modelId: 'fake_model', left: new Float32Array(10), right: new Float32Array(5) });
  f.handler.onMessage({ type: 'bogus', jobId: 'j2' });
  f.handler.onMessage({ type: 'bogus' });
  await waitForPosted(f.posted, (p) => errors(p).length >= 2);
  await settle();
  assert.equal(errors(f.posted).length, 2);
  assert.equal(errors(f.posted)[0].jobId, 'j1');
  assert.equal(errors(f.posted)[0].detail.field, 'audio');
  assert.equal(errors(f.posted)[1].jobId, 'j2');
  for (const e of errors(f.posted)) assert.equal(typeof e.jobId, 'string');
});

// --------------------------------------------------------------------------------------------------- WebGPU wire format
test('DA-1: navigator.gpu absent + init.backend webgpu → backend-fallback no-gpu-in-worker, loadBundle called 0 times, zero fetches, everything later dropped', async () => {
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu: undefined });
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
  f.handler.onMessage(sep('j1'));
  await waitForPosted(f.posted, (p) => p.length > 0);
  await settle(50);
  assert.deepEqual(f.posted, [{ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'no-gpu-in-worker' }]);
  assert.equal(f.bundleCalls.length, 0, 'bundle loader never called');
  assert.equal(f.fetchInto.calls.length, 0);
  f.handler.onMessage(sep('j2'));
  await settle(50);
  assert.equal(f.posted.length, 1, 'dropped after backend-fallback');
});

test('adapter null → no-adapter; requestDevice throwing → device (with message); both before any bundle load', async () => {
  const a = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake({ adapter: false }) });
  a.handler.onMessage(a.init());
  await waitForPosted(a.posted, (p) => p.length > 0);
  assert.deepEqual(a.posted, [{ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'no-adapter' }]);
  assert.equal(a.bundleCalls.length, 0);
  const d = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake({ deviceThrows: true }) });
  d.handler.onMessage(d.init());
  await waitForPosted(d.posted, (p) => p.length > 0);
  assert.equal(d.posted[0].type, 'backend-fallback');
  assert.equal(d.posted[0].reason, 'device');
  assert.equal(d.posted[0].message, 'requestDevice failed');
  assert.equal(d.bundleCalls.length, 0);
});

test('webgpu happy path: ready carries gpu info, createSession receives the external device with the §7.2 features/limits', async () => {
  const gpu = makeGpuFake({ features: ['shader-f16', 'subgroups', 'other'] });
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  assert.deepEqual(f.posted[0], { type: 'ready', backend: 'webgpu', threads: 2, gpu: { vendor: 'fake', architecture: 'test', f16: true } });
  assert.deepEqual(f.bundleCalls, ['webgpu']);
  const opts = f.ort.created[0].opts;
  assert.equal(opts.executionProviders[0].name, 'webgpu');
  assert.strictEqual(opts.executionProviders[0].device, gpu._device);
  assert.equal(opts.executionProviders[0].storageBufferCacheMode, 'simple');
  const r = f.posted[f.posted.length - 1];
  assert.equal(r.type, 'result');
  assert.equal(r.timings.backend, 'webgpu');
});

test('webgpu createSession rejection → exactly one backend-fallback { reason: session }, zero errors, the separate posts nothing', async () => {
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake(), ort: makeOrtFake({ createError: new Error('shader compile failed') }) });
  f.handler.onMessage(f.init());
  f.handler.onMessage({ type: 'load-model', modelId: 'fake_model' });
  f.handler.onMessage(sep('j1'));
  await waitForPosted(f.posted, (p) => p.some((m) => m.type === 'backend-fallback'));
  await settle(50);
  const fb = f.posted.filter((m) => m.type === 'backend-fallback');
  assert.equal(fb.length, 1);
  assert.deepEqual(fb[0], { type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'session', message: 'shader compile failed' });
  assert.equal(errors(f.posted).length, 0);
  assert.equal(f.posted.filter((m) => m.type === 'result').length, 0);
  f.handler.onMessage(sep('j2'));
  await settle(50);
  assert.equal(f.posted.filter((m) => m.type !== 'progress' && m.type !== 'ready').length, 1);
});

test('webgpu session.run rejection → one INFERENCE { phase: run } with jobId; a later device loss for the same job → no second message', async () => {
  const gpu = makeGpuFake();
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu, ort: makeOrtFake({ run: () => { throw new TypeError('boom'); } }) });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await waitForPosted(f.posted, (p) => errors(p).length > 0);
  const e = errors(f.posted)[0];
  assert.equal(e.code, 'INFERENCE');
  assert.equal(e.jobId, 'j1');
  assert.deepEqual(e.detail, { phase: 'run' });
  gpu._loseDevice('destroyed');
  await settle(50);
  assert.equal(errors(f.posted).length, 1, 'no second message');
  assert.equal(f.posted.filter((m) => m.type === 'result').length, 0);
});

test('device lost first, then session.run rejects → exactly one GPU_LOST { jobId }', async () => {
  const gpu = makeGpuFake();
  const ort = makeOrtFake({ run: async () => { gpu._loseDevice('unknown'); await settle(30); throw new TypeError('boom'); } });
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu, ort });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await waitForPosted(f.posted, (p) => errors(p).length > 0);
  await settle(80);
  const errs = errors(f.posted);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'GPU_LOST');
  assert.equal(errs[0].jobId, 'j1');
  assert.deepEqual(errs[0].detail, { reason: 'unknown' });
  assert.equal(f.posted.filter((m) => m.type === 'result').length, 0);
});

test('idle device loss → GPU_LOST WITHOUT jobId; every other posted error carries a jobId', async () => {
  const gpu = makeGpuFake();
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  assert.equal(f.posted[f.posted.length - 1].type, 'result');
  gpu._loseDevice('unknown');
  await settle(30);
  const e = errors(f.posted);
  assert.equal(e.length, 1);
  assert.equal(e[0].code, 'GPU_LOST');
  assert.ok(!('jobId' in e[0]));
});

test('wasm createSession rejection → SESSION { jobId }; wasm run RangeError → OOM, TypeError → INFERENCE without detail.phase', async () => {
  const s = await makeHandlerFixture({ ort: makeOrtFake({ createError: new Error('wasm oom') }) });
  s.handler.onMessage(s.init());
  s.handler.onMessage(sep('j1'));
  await untilResult(s.posted);
  const se = errors(s.posted)[0];
  assert.equal(se.code, 'SESSION');
  assert.equal(se.jobId, 'j1');
  assert.equal(s.posted.filter((m) => m.type === 'backend-fallback').length, 0);
  const o = await makeHandlerFixture({ ort: makeOrtFake({ run: () => { throw new RangeError('Array buffer allocation failed'); } }) });
  o.handler.onMessage(o.init());
  o.handler.onMessage(sep('j1'));
  await untilResult(o.posted);
  assert.equal(errors(o.posted)[0].code, 'OOM');
  assert.equal(errors(o.posted)[0].jobId, 'j1');
  const i = await makeHandlerFixture({ ort: makeOrtFake({ run: () => { throw new TypeError('boom'); } }) });
  i.handler.onMessage(i.init());
  i.handler.onMessage(sep('j1'));
  await untilResult(i.posted);
  const ie = errors(i.posted)[0];
  assert.equal(ie.code, 'INFERENCE');
  assert.equal(ie.jobId, 'j1');
  assert.ok(!(ie.detail && ie.detail.phase));
  assert.equal(errors(i.posted).length, 1);
});

test('MODEL_IO (wrong output dims) and NUMERIC are ordinary errors with jobId on both backends', async () => {
  const f = await makeHandlerFixture({ ort: makeOrtFake({ dims: [1, 4, 10, 10] }) });
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  assert.equal(errors(f.posted)[0].code, 'MODEL_IO');
  assert.equal(errors(f.posted)[0].jobId, 'j1');
  const nan = makeOrtFake({ run: (feeds, session) => { const inp = feeds[session.inputNames[0]]; const out = new Float32Array(inp.data.length); out.fill(NaN); return { output: new (Object.getPrototypeOf(inp).constructor)('float32', out, inp.dims) }; } });
  const g = await makeHandlerFixture({ ort: nan });
  g.handler.onMessage(g.init());
  g.handler.onMessage(sep('j1'));
  await untilResult(g.posted);
  assert.equal(errors(g.posted)[0].code, 'NUMERIC');
});

test('denoise with a melroformer model → one inference per unit, timings.denoise false (Tier 2 stub branch)', async () => {
  let runs = 0;
  const separateRoformer = async ({ ort, session, left, right, onProgress }) => {
    for (let u = 0; u < 2; u++) {
      await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(8), [1, 2, 2, 2]) });
      runs++;
      onProgress({ stage: 'separate', chunkIndex: u, chunkCount: 2 });
    }
    onProgress({ stage: 'finalize' });
    return { vocals: [new Float32Array(left.length), new Float32Array(right.length)], instrumental: [left, right], timings: { chunkMs: [1, 1], stftMs: 0, istftMs: 0 } };
  };
  const f = await makeHandlerFixture({ separateRoformer, manifestPatch: (m) => {
    m.models.melro = {
      displayName: '高质量', tier: 2, arch: 'melroformer', backends: ['webgpu', 'wasm'], license: 'Apache-2.0', source: 'https://example.invalid/m.onnx',
      files: { model: m.models.fake_model.files.model },
      params: { sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 441 * 1099, stepSamples: 200000, minStorageBuffersPerShaderStage: 9, weight: 'hamming54', inputName: 'input', outputName: 'output', requiredFeatures: ['shader-f16'], inputPeak: 0.9, outputPeak: 0.9 },
    };
    m.models.melro.files = { model: { ...m.models.fake_model.files.model, chunks: m.models.fake_model.files.model.chunks.map((c) => ({ ...c, path: c.path.replace('fake_model', 'melro') })) } };
    m.tiers.hq = { webgpu: 'melro', wasm: 'melro' };
  } });
  const fetchInto = makeFetchIntoFake({ ...serveMapFor(f.manifest, 'fake_model', f.modelChunks), ...serveMapFor(f.manifest, 'melro', f.modelChunks) });
  const posted = [];
  const h = createHandler({ post: (m) => posted.push(m), loadBundle: async () => f.ort, gpu: undefined, fetchInto, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {}, separateRoformer });
  h.onMessage(f.init());
  h.onMessage(sep('j1', { tier: 'hq', modelId: 'melro', denoise: true }));
  await untilResult(posted);
  const r = posted[posted.length - 1];
  assert.equal(r.type, 'result', JSON.stringify(r));
  assert.equal(runs, 2);
  assert.equal(r.timings.denoise, false);
  assert.equal(r.timings.modelId, 'melro');
  assert.equal(r.timings.tier, 'hq');
  // with the roformer engine explicitly unavailable (null) the branch is a clean INTERNAL
  const g = createHandler({ post: (m) => posted.push(m), loadBundle: async () => f.ort, gpu: undefined, fetchInto, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {}, separateRoformer: null });
  const before = posted.length;
  g.onMessage(f.init());
  g.onMessage(sep('j2', { tier: 'hq', modelId: 'melro' }));
  await waitForPosted(posted, (p) => p.slice(before).some((m) => m.type === 'error'));
  assert.equal(posted.filter((m) => m.type === 'error')[0].code, 'INTERNAL');
});

const addMelro = (m) => {
  m.models.melro = {
    displayName: '高质量', tier: 2, arch: 'melroformer', backends: ['webgpu'], license: 'Apache-2.0', source: 'https://example.invalid/m.onnx',
    files: { model: { ...m.models.fake_model.files.model, chunks: m.models.fake_model.files.model.chunks.map((c) => ({ ...c, path: c.path.replace('fake_model', 'melro') })) } },
    params: { sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 441 * 1099, stepSamples: 200000, minStorageBuffersPerShaderStage: 9, weight: 'hamming54', inputName: 'input', outputName: 'output', requiredFeatures: ['shader-f16'], inputPeak: 0.9, outputPeak: 0.9 },
  };
  m.tiers.hq = { webgpu: 'melro' };
};

test('§15: a melroformer model on a webgpu device WITHOUT shader-f16 → exactly one backend-fallback { reason: device }, zero fetches, zero errors', async () => {
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake({ features: [] }), manifestPatch: addMelro });
  const fetchInto = makeFetchIntoFake({ ...serveMapFor(f.manifest, 'fake_model', f.modelChunks), ...serveMapFor(f.manifest, 'melro', f.modelChunks) });
  const posted = [];
  const h = createHandler({ post: (m) => posted.push(m), loadBundle: async () => f.ort, gpu: makeGpuFake({ features: [] }), fetchInto, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {}, separateRoformer: async () => { throw new Error('must not run'); } });
  h.onMessage(f.init());
  h.onMessage({ type: 'load-model', modelId: 'melro' });
  h.onMessage(sep('j1', { tier: 'hq', modelId: 'melro' }));
  await untilResult(posted);
  await settle(50);
  const fb = posted.filter((m) => m.type === 'backend-fallback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].reason, 'device');
  assert.match(fb[0].message, /shader-f16/);
  assert.equal(errors(posted).length, 0);
  assert.equal(fetchInto.calls.length, 0, 'nothing is downloaded for a model the device cannot run');
  assert.equal(h.dead, true);
  // the standard model on the same device is unaffected (no requiredFeatures for mdx)
  const g = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake({ features: [] }) });
  g.handler.onMessage(g.init());
  g.handler.onMessage(sep('j1'));
  await untilResult(g.posted);
  assert.equal(g.posted[g.posted.length - 1].type, 'result');
});

test('§15: a melroformer model on a webgpu device WITH shader-f16 → createSession receives externalData and the device; denoise ignored', async () => {
  const f = await makeHandlerFixture({ backend: 'webgpu', gpu: makeGpuFake({ features: ['shader-f16'] }), manifestPatch: (m) => {
    addMelro(m);
    const ext = JSON.parse(JSON.stringify(m.models.melro.files.model));
    ext.name = 'melro.onnx.data';
    ext.chunks = ext.chunks.map((c, i) => ({ ...c, path: c.path.replace(/[^/]+$/, `data.part-0${i}.bin`) }));
    m.models.melro.files.externalData = ext;
  } });
  const serve = { ...serveMapFor(f.manifest, 'fake_model', f.modelChunks) };
  f.manifest.models.melro.files.model.chunks.forEach((c, i) => { serve[c.path] = f.modelChunks[i]; });
  f.manifest.models.melro.files.externalData.chunks.forEach((c, i) => { serve[c.path] = f.modelChunks[i]; });
  // fake clock: +100 ms per chunk fetch, nothing else advances → downloadMs must accumulate over BOTH files' downloads
  let clock = 1000;
  const fetchInto = makeFetchIntoFake(serve, () => { clock += 100; return null; });
  const posted = [];
  let engineCalls = 0;
  const separateRoformer = async ({ left, right, onProgress }) => { engineCalls++; onProgress({ stage: 'finalize' }); return { vocals: [new Float32Array(left.length), new Float32Array(right.length)], instrumental: [left, right], timings: { chunkMs: [1], stftMs: 0, istftMs: 0 } }; };
  const gpu = makeGpuFake({ features: ['shader-f16'] });
  const h = createHandler({ post: (m) => posted.push(m), loadBundle: async () => f.ort, gpu, fetchInto, caches: null, subtle: globalThis.crypto.subtle, origin: 'http://localhost', warn: () => {}, separateRoformer, now: () => clock });
  h.onMessage(f.init());
  h.onMessage(sep('j1', { tier: 'hq', modelId: 'melro', denoise: true }));
  await untilResult(posted);
  const r = posted[posted.length - 1];
  assert.equal(r.type, 'result', JSON.stringify(r));
  assert.equal(engineCalls, 1);
  assert.equal(r.timings.denoise, false);
  assert.equal(r.timings.backend, 'webgpu');
  assert.equal(fetchInto.calls.length, 2 * f.modelChunks.length, 'model + externalData chunks');
  assert.equal(r.timings.downloadMs, 100 * 2 * f.modelChunks.length, 'downloadMs covers the download phases of both files (download → verify → download → verify)');
  assert.equal(r.timings.verifyMs, 0);
  assert.equal(r.timings.sessionMs, 0);
  const opts = f.ort.created[0].opts;
  assert.equal(opts.executionProviders[0].name, 'webgpu');
  assert.equal(opts.executionProviders[0].device, gpu._device);
  assert.equal(opts.externalData.length, 1);
  assert.equal(opts.externalData[0].path, 'melro.onnx.data');
  assert.ok(opts.externalData[0].data instanceof Uint8Array);
  assert.equal(opts.externalData[0].data.length, f.manifest.models.melro.files.externalData.bytes);
});

test('mdx denoise → two inferences per non-skipped chunk and timings.denoise true', async () => {
  const f = await makeHandlerFixture();
  let runs = 0;
  const origCreate = f.ort.InferenceSession.create.bind(f.ort.InferenceSession);
  f.ort.InferenceSession.create = async (b, o) => { const s = await origCreate(b, o); const run = s.run.bind(s); s.run = (feeds) => { runs++; return run(feeds); }; return s; };
  f.handler.onMessage(f.init());
  f.handler.onMessage(sep('j1', { denoise: true }));
  await untilResult(f.posted);
  assert.equal(f.posted[f.posted.length - 1].timings.denoise, true);
  assert.equal(runs, 2 * NON_SKIPPED);
});

test('second init is ignored; init.fellBack flows into result.timings.fellBack', async () => {
  const f = await makeHandlerFixture();
  f.handler.onMessage(f.init({ fellBack: true }));
  f.handler.onMessage(f.init({ backend: 'webgpu' }));
  f.handler.onMessage(sep('j1'));
  await untilResult(f.posted);
  assert.equal(f.posted.filter((m) => m.type === 'ready').length, 1);
  assert.equal(f.posted[f.posted.length - 1].timings.fellBack, true);
  assert.equal(f.posted[f.posted.length - 1].timings.backend, 'wasm');
  assert.equal(stages(f.posted).filter((s) => s === 'download').length > 0, true);
});
