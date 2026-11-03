// tests/unit/state.test.mjs — design §12.1 reducer (§16.A state rows), §7.1 resolveModelId, §7.4 fallback rule, §23 login gate,
// §22 device-policy effects, design_accepted DA-5 (start disabled until caps-ready; login-ok → idle | unsupported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, createInitialState, canStart, resolveModelId, GPU_FALLBACK_CODES } from '../../site/src/ui/state.mjs';
import { devicePolicy } from '../../site/src/ui/device.mjs';
import { readManifest } from '../lib/fixtures.mjs';

const DESKTOP = devicePolicy({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156', maxTouchPoints: 0 });
const IOS = devicePolicy({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', maxTouchPoints: 5 });
const MANIFEST = readManifest();
const MANIFEST_9482 = { ...MANIFEST, tiers: { standard: { ...MANIFEST.tiers.standard, wasm: 'uvr_mdxnet_9482' } } };
const MANIFEST_HQ = { ...MANIFEST, tiers: { ...MANIFEST.tiers, hq: { webgpu: 'uvr_mdx_voc_ft' } } };
const NO_LOW = { ...MANIFEST, tiers: { standard: { webgpu: 'uvr_mdx_voc_ft', wasm: 'uvr_mdx_voc_ft' } } };
const NO_HQ = { ...MANIFEST, tiers: { standard: MANIFEST.tiers.standard } };   // the committed manifest may or may not ship tiers.hq

const types = (effects) => effects.map((e) => e.type);
const has = (effects, type) => effects.some((e) => e.type === type);
const find = (effects, type) => effects.find((e) => e.type === type);

function run(state, ...events) {
  let s = state;
  let effects = [];
  for (const ev of events) { const r = reduce(s, ev); s = r.state; effects = r.effects; }
  return { state: s, effects };
}

function boot({ policy = DESKTOP, simd = true, backend = 'wasm', manifest = MANIFEST, hq = false, threads = 8, query = {} } = {}) {
  return run(createInitialState(), { type: 'login-ok', policy, simd }, { type: 'caps-ready', backend, threads, hq, manifest, query }).state;
}
const toReady = (s, name = 'song.mp3') => run(s, { type: 'file', name }, { type: 'decoded', duration: 25 }).state;
const started = (s, extra = {}) => run(s, { type: 'start', denoise: false, ...extra });
const worker = (msg) => ({ type: 'worker', msg });
const jobOf = (s) => s.job;
const result = (s, timings = {}) => worker({ type: 'result', jobId: s.job.id, timings: { backend: s.job.backend, modelId: s.job.modelId, tier: s.job.tier, chunkMs: [1, 2], fellBack: false, threads: 8, ...timings } });
const toDone = (s) => {
  const a = started(s).state;
  return run(a, worker({ type: 'progress', jobId: a.job.id, stage: 'separate', chunkIndex: 0, chunkCount: 6 }), result(a), { type: 'mp3-done', stem: 'vocals' }, { type: 'mp3-done', stem: 'instrumental' }).state;
};

// -------------------------------------------------------------------------------------------------------- login gate
test('initial state is locked with loggedIn false; login-ok → idle with store session / probe caps / render app', () => {
  const s0 = createInitialState();
  assert.equal(s0.state, 'locked');
  assert.equal(s0.loggedIn, false);
  assert.equal(s0.error, null);
  const r = reduce(s0, { type: 'login-ok', policy: DESKTOP, simd: true });
  assert.equal(r.state.state, 'idle');
  assert.equal(r.state.loggedIn, true);
  assert.deepEqual(types(r.effects).sort(), ['probe caps', 'render app', 'store session']);
  assert.equal(canStart(r.state), false);
});

test('login-fail stays locked with LOGIN_FAILED and no fetch/probe/worker effect', () => {
  const r = reduce(createInitialState(), { type: 'login-fail' });
  assert.equal(r.state.state, 'locked');
  assert.deepEqual(r.state.error, { code: 'LOGIN_FAILED', detail: {} });
  assert.deepEqual(types(r.effects), ['render login error']);
});

test('boot-session with a stored token → idle without the form and without store session', () => {
  const r = reduce(createInitialState(), { type: 'boot-session', policy: DESKTOP, simd: true });
  assert.equal(r.state.state, 'idle');
  assert.ok(!has(r.effects, 'store session'));
  assert.ok(has(r.effects, 'render app') && has(r.effects, 'probe caps'));
});

test('every input/start/worker event in locked is a no-op (no effects)', () => {
  const s0 = createInitialState();
  for (const ev of [{ type: 'file', name: 'x' }, { type: 'url', url: 'https://a/b' }, { type: 'start' }, { type: 'caps-ready', backend: 'wasm', manifest: MANIFEST }, worker({ type: 'ready' }), { type: 'cancel' }, { type: 'decoded' }, { type: 'logout' }]) {
    const r = reduce(s0, ev);
    assert.equal(r.state.state, 'locked', ev.type);
    assert.deepEqual(r.effects, [], ev.type);
  }
});

test('logout from any state after locked → the single effect clear session + reload', () => {
  for (const s of [boot(), toReady(boot()), toDone(toReady(boot())), boot({ simd: false }), started(toReady(boot())).state]) {
    const r = reduce(s, { type: 'logout' });
    assert.deepEqual(types(r.effects), ['clear session + reload']);
  }
});

// ------------------------------------------------------------------------------------------------- DA-5 / capability
test('DA-5: login-ok with simd false → unsupported, render app disabled + UNSUPPORTED copy; every later event a no-op', () => {
  const r = reduce(createInitialState(), { type: 'login-ok', policy: DESKTOP, simd: false });
  assert.equal(r.state.state, 'unsupported');
  assert.deepEqual(r.state.error, { code: 'UNSUPPORTED', detail: {} });
  assert.deepEqual(types(r.effects), ['store session', 'render app disabled', 'render error']);
  assert.equal(find(r.effects, 'render error').code, 'UNSUPPORTED');
  assert.ok(!has(r.effects, 'probe caps'));
  for (const ev of [{ type: 'caps-ready', backend: 'wasm', threads: 8, hq: false, manifest: MANIFEST }, { type: 'file', name: 'x' }, { type: 'start' }, worker({ type: 'ready' })]) {
    const r2 = reduce(r.state, ev);
    assert.equal(r2.state.state, 'unsupported');
    assert.deepEqual(r2.effects, []);
  }
});

test('DA-5: start before caps-ready is a no-op; caps-ready enables start', () => {
  const idle = reduce(createInitialState(), { type: 'login-ok', policy: DESKTOP, simd: true }).state;
  const ready = toReady(idle);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.decodedInput, true);
  assert.equal(canStart(ready), false);
  const r = reduce(ready, { type: 'start', denoise: false });
  assert.equal(r.state.state, 'ready');
  assert.deepEqual(r.effects, []);
  const r2 = reduce(ready, { type: 'caps-ready', backend: 'wasm', threads: 8, hq: false, manifest: MANIFEST, query: {} });
  assert.equal(r2.state.capsReady, true);
  assert.equal(canStart(r2.state), true);
  assert.deepEqual(types(r2.effects), ['render caps']);
  const r3 = reduce(r2.state, { type: 'start', denoise: false });
  assert.equal(r3.state.state, 'loading-model');
});

// --------------------------------------------------------------------------------------------------- device policy
test('start on a touch policy emits acquire wake lock + show keep-awake; result/error/cancel release + hide; desktop never shows keep-awake', () => {
  const ios = toReady(boot({ policy: IOS }));
  const st = started(ios);
  assert.ok(has(st.effects, 'acquire wake lock') && has(st.effects, 'show keep-awake'));
  const err = reduce(st.state, worker({ type: 'error', jobId: st.state.job.id, code: 'INFERENCE', message: 'x' }));
  assert.ok(has(err.effects, 'release wake lock') && has(err.effects, 'hide keep-awake'));
  const can = reduce(st.state, { type: 'cancel' });
  assert.ok(has(can.effects, 'release wake lock') && has(can.effects, 'hide keep-awake'));
  const res = run(st.state, result(st.state), { type: 'mp3-done', stem: 'vocals' }, { type: 'mp3-done', stem: 'instrumental' });
  assert.ok(has(res.effects, 'release wake lock') && has(res.effects, 'hide keep-awake'));
  const desk = started(toReady(boot()));
  assert.ok(has(desk.effects, 'acquire wake lock'));
  assert.ok(!has(desk.effects, 'show keep-awake'));
  const deskDone = run(desk.state, result(desk.state), { type: 'mp3-done', stem: 'vocals' }, { type: 'mp3-done', stem: 'instrumental' });
  assert.ok(!has(deskDone.effects, 'hide keep-awake'));
});

test('result on keepWorkerAfterResult false (iOS) emits terminate worker; desktop keeps the worker', () => {
  const ios = started(toReady(boot({ policy: IOS }))).state;
  const r = reduce(ios, result(ios));
  assert.equal(r.state.state, 'encoding');
  assert.ok(has(r.effects, 'terminate worker'));
  assert.equal(r.state.workerAlive, false);
  assert.equal(find(r.effects, 'encode mp3').parallel, false);
  const desk = started(toReady(boot())).state;
  const r2 = reduce(desk, result(desk));
  assert.ok(!has(r2.effects, 'terminate worker'));
  assert.equal(find(r2.effects, 'encode mp3').parallel, true);
});

test('TOO_LONG effect carries maxSeconds from the policy-driven detail', () => {
  const s = run(boot({ policy: IOS }), { type: 'file', name: 'long.wav' }).state;
  const r = reduce(s, { type: 'input-error', code: 'TOO_LONG', detail: { seconds: 452, maxSeconds: 360 } });
  assert.equal(r.state.state, 'error');
  assert.deepEqual(find(r.effects, 'render error').detail, { seconds: 452, maxSeconds: 360 });
  assert.equal(r.state.decodedInput, false);
  assert.equal(canStart(r.state), false);
});

// --------------------------------------------------------------------------------------------------- retained input
test('hasBuffer: true after decoded, false after the first start (copyMode buffer), the second start re-decodes', () => {
  const ready = toReady(boot());
  assert.equal(ready.hasBuffer, true);
  const a = started(ready);
  assert.equal(a.state.hasBuffer, false);
  assert.deepEqual(find(a.effects, 'dispatch job').copyMode, 'buffer');
  assert.ok(has(a.effects, 'spawn worker'));
  const done = toDone(ready);
  assert.equal(done.state, 'done');
  assert.equal(done.hasBuffer, false);
  const b = started(done);
  assert.equal(b.state.state, 'loading-model');
  assert.equal(find(b.effects, 'dispatch job').copyMode, 'redecode');
  assert.ok(!has(b.effects, 'spawn worker'), 'desktop keeps the worker across jobs');
});

// --------------------------------------------------------------------------------------------- WebGPU fallback rule
test('GPU_FALLBACK_CODES is exactly {INFERENCE, GPU_LOST, NUMERIC}', () => {
  assert.deepEqual([...GPU_FALLBACK_CODES].sort(), ['GPU_LOST', 'INFERENCE', 'NUMERIC']);
});

for (const code of ['INFERENCE', 'GPU_LOST', 'NUMERIC']) {
  test(`error ${code} from a webgpu worker → loading-model with the re-resolved WASM model; terminate, spawn, redecode, re-send`, () => {
    for (const [manifest, expected, policy] of [[MANIFEST, 'uvr_mdx_voc_ft', DESKTOP], [MANIFEST_9482, 'uvr_mdxnet_9482', DESKTOP], [MANIFEST, 'uvr_mdxnet_9482', IOS]]) {
      const s = started(toReady(boot({ backend: 'webgpu', manifest, policy, threads: 4 }))).state;
      assert.equal(s.job.backend, 'webgpu');
      assert.equal(s.job.modelId, 'uvr_mdx_voc_ft');
      const sep = reduce(s, worker({ type: 'progress', jobId: s.job.id, stage: 'separate', chunkIndex: 0, chunkCount: 6 })).state;
      assert.equal(sep.state, 'separating');
      const r = reduce(sep, worker({ type: 'error', jobId: s.job.id, code, message: 'boom', detail: code === 'INFERENCE' ? { phase: 'run' } : {} }));
      assert.equal(r.state.state, 'loading-model');
      assert.equal(r.state.job.id, s.job.id, 'same jobId');
      assert.equal(r.state.job.backend, 'wasm');
      assert.equal(r.state.job.modelId, expected);
      assert.equal(r.state.job.fellBack, true);
      assert.equal(r.state.error, null);
      const t = types(r.effects);
      assert.ok(t.includes('terminate worker') && t.includes('spawn worker') && t.includes('dispatch job') && t.includes('render backend line'), t.join());
      assert.equal(find(r.effects, 'dispatch job').copyMode, 'redecode');
      assert.equal(find(r.effects, 'dispatch job').job.backend, 'wasm');
      assert.equal(find(r.effects, 'render backend line').backend, 'wasm');
      assert.ok(!has(r.effects, 'render error'));
      assert.equal(find(r.effects, 'log').args[0], 'webgpu-fallback');
      // a second error for the same jobId after the fallback: the job is now wasm → ordinary error path, never a 2nd fallback
      const again = reduce(r.state, worker({ type: 'error', jobId: s.job.id, code: 'INFERENCE', message: 'again' }));
      assert.equal(again.state.state, 'error');
      assert.ok(!has(again.effects, 'spawn worker'));
    }
  });
}

test('MODEL_DOWNLOAD / MODEL_IO / INTERNAL from a webgpu worker → error, no fallback; INFERENCE from a wasm worker → error', () => {
  for (const code of ['MODEL_DOWNLOAD', 'MODEL_IO', 'INTERNAL', 'MODEL_HASH', 'MANIFEST']) {
    const s = started(toReady(boot({ backend: 'webgpu' }))).state;
    const r = reduce(s, worker({ type: 'error', jobId: s.job.id, code, message: 'x', detail: { chunkIndex: 1, chunkCount: 3, status: 503 } }));
    assert.equal(r.state.state, 'error', code);
    assert.equal(r.state.error.code, code);
    assert.ok(has(r.effects, 'terminate worker') && has(r.effects, 'render error') && !has(r.effects, 'spawn worker'));
    assert.equal(canStart(r.state), true);
  }
  const w = started(toReady(boot({ backend: 'wasm' }))).state;
  const r = reduce(w, worker({ type: 'error', jobId: w.job.id, code: 'INFERENCE', message: 'x' }));
  assert.equal(r.state.state, 'error');
  assert.deepEqual(r.state.error, { code: 'INFERENCE', detail: {} });
  assert.ok(has(r.effects, 'terminate worker'));
});

test('stale error (unknown or finished jobId) → no state change, log only', () => {
  const s = started(toReady(boot())).state;
  const r = reduce(s, worker({ type: 'error', jobId: 'nope', code: 'INFERENCE', message: 'x' }));
  assert.equal(r.state.state, 'loading-model');
  assert.deepEqual(types(r.effects), ['log']);
  const done = toDone(toReady(boot()));
  const r2 = reduce(done, worker({ type: 'error', jobId: 'j1', code: 'INFERENCE', message: 'x' }));
  assert.equal(r2.state.state, 'done');
  assert.deepEqual(types(r2.effects), ['log']);
});

test('backend-fallback with tier hq → ready + GPU_ONLY_MODEL + reset select to standard; run-time INFERENCE with hq → same', () => {
  const b = boot({ backend: 'webgpu', manifest: MANIFEST_HQ, hq: true });
  const ready = run(toReady(b), { type: 'tier', tier: 'hq' }).state;
  assert.equal(ready.tier, 'hq');
  const s = started(ready).state;
  assert.equal(s.job.tier, 'hq');
  const r = reduce(s, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'no-adapter' }));
  assert.equal(r.state.state, 'ready');
  assert.deepEqual(r.state.error, { code: 'GPU_ONLY_MODEL', detail: { reason: 'no-adapter' } });
  assert.equal(r.state.tier, 'standard');
  assert.equal(r.state.job, null);
  assert.ok(has(r.effects, 'reset select to standard') && has(r.effects, 'terminate worker') && has(r.effects, 'release wake lock'));
  assert.equal(find(r.effects, 'render error').code, 'GPU_ONLY_MODEL');
  assert.equal(canStart(r.state), true);
  const s2 = started(ready).state;
  const r2 = reduce(s2, worker({ type: 'error', jobId: s2.job.id, code: 'INFERENCE', message: 'x', detail: { phase: 'run' } }));
  assert.equal(r2.state.state, 'ready');
  assert.equal(r2.state.error.code, 'GPU_ONLY_MODEL');
  assert.equal(r2.state.error.detail.reason, 'INFERENCE');
  // start after GPU_ONLY_MODEL leaves error null
  const r3 = reduce(r.state, { type: 'start', denoise: false });
  assert.equal(r3.state.error, null);
  assert.equal(r3.state.state, 'loading-model');
  assert.equal(r3.state.job.tier, 'standard');
});

test('backend-fallback with tier standard (no-gpu-in-worker) → wasm re-dispatch with wasmLow on iOS', () => {
  const s = started(toReady(boot({ backend: 'webgpu', policy: IOS }))).state;
  const r = reduce(s, worker({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason: 'no-gpu-in-worker' }));
  assert.equal(r.state.state, 'loading-model');
  assert.equal(r.state.job.modelId, 'uvr_mdxnet_9482');
  assert.equal(r.state.job.fellBack, true);
  assert.equal(find(r.effects, 'log').args[1], 'no-gpu-in-worker');
});

// ------------------------------------------------------------------------------------------------- MP3 / encoding
test('encoding → done after one stem MP3 failure: mp3Failed flags, error MP3 with state done', () => {
  const s = started(toReady(boot())).state;
  const enc = reduce(s, result(s)).state;
  assert.equal(enc.state, 'encoding');
  const f = reduce(enc, { type: 'mp3-error', stem: 'vocals' });
  assert.equal(f.state.state, 'encoding');
  assert.deepEqual(f.state.error, { code: 'MP3', detail: { stem: 'vocals' } });
  assert.ok(has(f.effects, 'terminate mp3 worker') && has(f.effects, 'render error'));
  const d = reduce(f.state, { type: 'mp3-done', stem: 'instrumental' });
  assert.equal(d.state.state, 'done');
  assert.deepEqual(d.state.mp3Failed, { vocals: true, instrumental: false });
  assert.deepEqual(d.state.error, { code: 'MP3', detail: { stem: 'vocals' } });
  assert.ok(has(d.effects, 'enable mp3 download') && has(d.effects, 'render done') && has(d.effects, 'release wake lock'));
  const prog = reduce(enc, { type: 'mp3-progress', stem: 'vocals', fraction: 0.43 });
  assert.deepEqual(types(prog.effects), ['render mp3 progress']);
});

// ------------------------------------------------------------------------------------------- new input / cleanup
const CLEANUP = ['drop decodedInput', 'drop stems', 'revoke blob urls', 'unload players', 'disable downloads', 'clear error', 'reset timings'];
test('new input from ready / done / error → cleanup effects incl. drop decodedInput; file → decoding, URL → fetching-url', () => {
  const ready = toReady(boot());
  const done = toDone(ready);
  const err = reduce(started(ready).state, worker({ type: 'error', jobId: started(ready).state.job.id, code: 'SESSION', message: 'x' })).state;
  for (const s of [ready, done, err]) {
    const f = reduce(s, { type: 'file', name: 'new.wav' });
    assert.equal(f.state.state, 'decoding');
    for (const t of CLEANUP) assert.ok(has(f.effects, t), `${s.state}: ${t}`);
    assert.ok(has(f.effects, 'decode file'));
    assert.equal(f.state.decodedInput, false);
    assert.equal(f.state.error, null);
    assert.equal(f.state.inputName, 'new.wav');
    const u = reduce(s, { type: 'url', url: 'https://example.com/a.mp3', name: 'a.mp3' });
    assert.equal(u.state.state, 'fetching-url');
    assert.equal(find(u.effects, 'fetch url').url, 'https://example.com/a.mp3');
    for (const t of CLEANUP) assert.ok(has(u.effects, t));
  }
  const idle = boot();
  const f = reduce(idle, { type: 'file', name: 'x.wav' });
  assert.equal(f.state.state, 'decoding');
});

test('new input in the five busy states is a no-op; no cancel in decoding', () => {
  const ready = toReady(boot());
  const fetching = reduce(ready, { type: 'url', url: 'https://example.com/a.mp3', name: 'a' }).state;
  const decoding = reduce(ready, { type: 'file', name: 'x' }).state;
  const loading = started(ready).state;
  const separating = reduce(loading, worker({ type: 'progress', jobId: loading.job.id, stage: 'separate', chunkIndex: 0, chunkCount: 6 })).state;
  const encoding = reduce(loading, result(loading)).state;
  for (const s of [fetching, decoding, loading, separating, encoding]) {
    for (const ev of [{ type: 'file', name: 'y' }, { type: 'url', url: 'https://example.com/b.mp3', name: 'b' }, { type: 'url-invalid', code: 'URL_INVALID' }]) {
      const r = reduce(s, ev);
      assert.equal(r.state.state, s.state, `${s.state} ${ev.type}`);
      assert.deepEqual(r.effects, []);
    }
  }
  const c = reduce(decoding, { type: 'cancel' });
  assert.equal(c.state.state, 'decoding');
  assert.deepEqual(c.effects, []);
});

test('url-invalid → error with URL_INVALID / URL_PLATFORM and the cleanup; url-progress / url-fetched flow', () => {
  const ready = toReady(boot());
  const r = reduce(ready, { type: 'url-invalid', code: 'URL_PLATFORM' });
  assert.equal(r.state.state, 'error');
  assert.equal(r.state.error.code, 'URL_PLATFORM');
  assert.equal(r.state.decodedInput, false);
  assert.ok(has(r.effects, 'drop decodedInput'));
  const f = reduce(boot(), { type: 'url', url: 'https://example.com/a.mp3', name: 'a.mp3' }).state;
  const p = reduce(f, { type: 'url-progress', received: 1000, total: 5000 });
  assert.deepEqual(types(p.effects), ['render progress']);
  const d = reduce(f, { type: 'url-fetched' });
  assert.equal(d.state.state, 'decoding');
  const ok = reduce(d.state, { type: 'decoded', duration: 25 });
  assert.equal(ok.state.state, 'ready');
  assert.equal(find(ok.effects, 'render file line').duration, 25);
});

// -------------------------------------------------------------------------------------------------------- canStart
test('canStart: true in error after MODEL_DOWNLOAD/SESSION/INFERENCE with a decoded input (start spawns a worker); false after pre-decode TOO_LONG or URL_FETCH', () => {
  for (const code of ['MODEL_DOWNLOAD', 'SESSION', 'INFERENCE']) {
    const s = started(toReady(boot())).state;
    const e = reduce(s, worker({ type: 'error', jobId: s.job.id, code, message: 'x', detail: { chunkIndex: 0, chunkCount: 2, status: 503 } })).state;
    assert.equal(e.state, 'error');
    assert.equal(canStart(e), true, code);
    const r = reduce(e, { type: 'start', denoise: false });
    assert.equal(r.state.state, 'loading-model');
    assert.ok(has(r.effects, 'spawn worker'), 'the old worker is gone');
    assert.equal(r.state.error, null);
  }
  const tooLong = reduce(reduce(boot(), { type: 'file', name: 'x' }).state, { type: 'input-error', code: 'TOO_LONG', detail: { seconds: 1052, maxSeconds: 900 } }).state;
  assert.equal(tooLong.state, 'error');
  assert.equal(canStart(tooLong), false);
  assert.deepEqual(reduce(tooLong, { type: 'start' }).effects, []);
  const urlFetch = reduce(reduce(boot(), { type: 'url', url: 'https://e/x.mp3', name: 'x' }).state, { type: 'input-error', code: 'URL_FETCH', detail: { attempts: ['network'] } }).state;
  assert.equal(canStart(urlFetch), false);
});

test('start from done emits the job-level cleanup and leaves decodedInput set (hasBuffer aside)', () => {
  const done = toDone(toReady(boot()));
  assert.equal(done.decodedInput, true);
  const r = reduce(done, { type: 'start', denoise: true });
  for (const t of ['drop stems', 'revoke blob urls', 'unload players', 'disable downloads', 'clear error', 'clear job timings']) assert.ok(has(r.effects, t), t);
  assert.ok(!has(r.effects, 'drop decodedInput') && !has(r.effects, 'reset timings'));
  assert.equal(r.state.decodedInput, true);
  assert.equal(r.state.inputName, 'song.mp3');
  assert.equal(r.state.job.denoise, true);
  assert.equal(r.state.error, null);
  assert.equal(r.state.job.id !== done.job?.id, true);
});

test('job error emits terminate worker; the next start from error spawns', () => {
  const s = started(toReady(boot())).state;
  assert.equal(s.workerAlive, true);
  const r = reduce(s, worker({ type: 'error', jobId: s.job.id, code: 'OOM', message: 'x' }));
  assert.ok(has(r.effects, 'terminate worker'));
  assert.equal(r.state.workerAlive, false);
  assert.equal(r.state.job, null);
});

// ---------------------------------------------------------------------------------------------------- __vs.error pairs
test('__vs.error pairs: CANCELLED/ready, CANCELLED/idle, MP3/done, GPU_ONLY_MODEL/ready, null after start or new input', () => {
  const ready = toReady(boot());
  const sep = run(ready, { type: 'start', denoise: false }).state;
  const c1 = reduce(sep, { type: 'cancel' });
  assert.equal(c1.state.state, 'ready');
  assert.deepEqual(c1.state.error, { code: 'CANCELLED', detail: {} });
  assert.ok(has(c1.effects, 'terminate worker') && has(c1.effects, 'release wake lock') && has(c1.effects, 'render error'));
  assert.equal(canStart(c1.state), true);
  const fetching = reduce(ready, { type: 'url', url: 'https://example.com/a.mp3', name: 'a' }).state;
  const c2 = reduce(fetching, { type: 'cancel' });
  assert.equal(c2.state.state, 'idle');
  assert.deepEqual(c2.state.error, { code: 'CANCELLED', detail: {} });
  assert.ok(has(c2.effects, 'abort url fetch'));
  const enc = reduce(sep, result(sep)).state;
  const mp3 = run(enc, { type: 'mp3-error', stem: 'instrumental' }, { type: 'mp3-done', stem: 'vocals' }).state;
  assert.equal(mp3.state, 'done');
  assert.deepEqual(mp3.error, { code: 'MP3', detail: { stem: 'instrumental' } });
  const after = reduce(mp3, { type: 'start', denoise: false }).state;
  assert.equal(after.error, null);
  const fresh = reduce(mp3, { type: 'file', name: 'n.wav' }).state;
  assert.equal(fresh.error, null);
});

test('idle GPU_LOST (error without jobId, no job) → state unchanged, terminate worker + one log effect, no copy', () => {
  const done = toDone(toReady(boot()));
  assert.equal(done.workerAlive, true);
  const r = reduce(done, worker({ type: 'error', code: 'GPU_LOST', message: 'device lost', detail: { reason: 'unknown' } }));
  assert.equal(r.state.state, 'done');
  assert.deepEqual(types(r.effects).sort(), ['log', 'terminate worker']);
  assert.equal(r.state.workerAlive, false);
  assert.ok(!has(r.effects, 'render error'));
  const next = reduce(r.state, { type: 'start', denoise: false });
  assert.ok(has(next.effects, 'spawn worker'));
  // any other jobId-less error → log only, no state change, worker kept
  const r2 = reduce(done, worker({ type: 'error', code: 'INTERNAL', message: 'x' }));
  assert.deepEqual(types(r2.effects), ['log']);
  assert.equal(r2.state.workerAlive, true);
});

// -------------------------------------------------------------------------------------------------------- cancel table
test('cancel table: encoding → done with MP3 downloads disabled; loading-model/separating → ready; nothing elsewhere', () => {
  const s = started(toReady(boot())).state;
  const enc = reduce(s, result(s)).state;
  const r = reduce(enc, { type: 'cancel' });
  assert.equal(r.state.state, 'done');
  assert.ok(has(r.effects, 'terminate mp3 workers') && has(r.effects, 'disable mp3 downloads') && has(r.effects, 'render done') && has(r.effects, 'release wake lock'));
  assert.equal(r.state.error, null);
  assert.ok(!has(r.effects, 'render error'));
  const sep = reduce(s, worker({ type: 'progress', jobId: s.job.id, stage: 'separate', chunkIndex: 1, chunkCount: 6 })).state;
  assert.equal(reduce(sep, { type: 'cancel' }).state.state, 'ready');
  for (const st of [boot(), toReady(boot()), toDone(toReady(boot()))]) {
    const c = reduce(st, { type: 'cancel' });
    assert.equal(c.state.state, st.state);
    assert.deepEqual(c.effects, []);
  }
});

// ----------------------------------------------------------------------------------------- manifest at start (§12.1)
test('start with manifest null → fetch manifest; manifest-ready dispatches; manifest-failed → MANIFEST error with canStart', () => {
  const ready = toReady(boot({ manifest: null }));
  const r = reduce(ready, { type: 'start', denoise: false });
  assert.equal(r.state.state, 'loading-model');
  assert.ok(has(r.effects, 'fetch manifest') && !has(r.effects, 'dispatch job'));
  const ok = reduce(r.state, { type: 'manifest-ready', manifest: MANIFEST });
  assert.ok(has(ok.effects, 'spawn worker') && has(ok.effects, 'dispatch job'));
  assert.equal(ok.state.job.modelId, 'uvr_mdx_voc_ft');
  const bad = reduce(r.state, { type: 'manifest-failed', detail: {} });
  assert.equal(bad.state.state, 'error');
  assert.equal(bad.state.error.code, 'MANIFEST');
  assert.equal(canStart(bad.state), true);
});

test('worker ready/progress/result wiring: progress separate moves loading-model → separating; result → encoding with build outputs', () => {
  const s = started(toReady(boot())).state;
  const rd = reduce(s, worker({ type: 'ready', backend: 'wasm', threads: 8, gpu: null }));
  assert.deepEqual(types(rd.effects), ['render backend line']);
  const dl = reduce(s, worker({ type: 'progress', jobId: s.job.id, stage: 'download', bytesDone: 1, bytesTotal: 2, chunksDone: 0, chunkCount: 2 }));
  assert.equal(dl.state.state, 'loading-model');
  const sep = reduce(s, worker({ type: 'progress', jobId: s.job.id, stage: 'separate', chunkIndex: 0, chunkCount: 6 }));
  assert.equal(sep.state.state, 'separating');
  const res = reduce(sep.state, result(sep.state, { chunkMs: [1, 2, 3] }));
  assert.equal(res.state.state, 'encoding');
  assert.deepEqual(find(res.effects, 'build outputs').timings.chunkMs, [1, 2, 3]);
  const stale = reduce(sep.state, worker({ type: 'result', jobId: 'other', timings: {} }));
  assert.equal(stale.state.state, 'separating');
  assert.deepEqual(types(stale.effects), ['log']);
});

test('query ?model= override and ?maxChunks flow into the job; tier hq only when offered', () => {
  const s = started(toReady(boot({ query: { model: 'uvr_mdxnet_9482', maxChunks: 2 } }))).state;
  assert.equal(s.job.modelId, 'uvr_mdxnet_9482');
  assert.equal(s.job.maxChunks, 2);
  const g = started(toReady(boot({ backend: 'webgpu', query: { model: 'uvr_mdxnet_9482' } }))).state;
  assert.equal(g.job.modelId, 'uvr_mdx_voc_ft', '9482 has no webgpu backend → override dropped');
  const t = reduce(toReady(boot()), { type: 'tier', tier: 'hq' }).state;
  assert.equal(t.tier, 'standard');
});

// ----------------------------------------------------------------------------------------------- resolveModelId table
test('resolveModelId table (§7.1)', () => {
  assert.equal(resolveModelId(MANIFEST, 'standard', 'webgpu', undefined, false), 'uvr_mdx_voc_ft');
  assert.equal(resolveModelId(MANIFEST, 'standard', 'wasm', undefined, false), 'uvr_mdx_voc_ft');
  assert.equal(resolveModelId(MANIFEST_9482, 'standard', 'wasm', undefined, false), 'uvr_mdxnet_9482');
  assert.equal(resolveModelId(MANIFEST, 'standard', 'wasm', undefined, true), 'uvr_mdxnet_9482');
  assert.equal(resolveModelId(MANIFEST_9482, 'standard', 'wasm', undefined, true), 'uvr_mdxnet_9482');
  assert.equal(resolveModelId(NO_LOW, 'standard', 'wasm', undefined, true), 'uvr_mdx_voc_ft', 'defensive fallback to wasm');
  assert.equal(resolveModelId(MANIFEST_HQ, 'hq', 'webgpu', undefined, false), 'uvr_mdx_voc_ft');
  assert.equal(resolveModelId(MANIFEST_HQ, 'hq', 'wasm', undefined, false), undefined);
  assert.equal(resolveModelId(MANIFEST_HQ, 'hq', 'wasm', undefined, true), undefined);
  assert.equal(resolveModelId(NO_HQ, 'hq', 'webgpu', undefined, false), undefined);
  assert.equal(resolveModelId(MANIFEST, 'hq', 'webgpu', undefined, false), MANIFEST.tiers.hq ? MANIFEST.tiers.hq.webgpu : undefined, 'the committed manifest: hq resolves to its webgpu entry iff tiers.hq is shipped');
  assert.equal(resolveModelId(MANIFEST, 'hq', 'wasm', undefined, true), undefined, 'hq never resolves on wasm/lowMemory (DA-7)');
  assert.equal(resolveModelId(MANIFEST, 'standard', 'wasm', 'uvr_mdxnet_9482', false), 'uvr_mdxnet_9482');
  assert.equal(resolveModelId(MANIFEST, 'standard', 'webgpu', 'uvr_mdxnet_9482', false), 'uvr_mdx_voc_ft');
  assert.equal(resolveModelId(MANIFEST, 'standard', 'wasm', 'nope', false), 'uvr_mdx_voc_ft');
  assert.equal(resolveModelId(null, 'standard', 'wasm', undefined, false), undefined);
});
