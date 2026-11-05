// site/src/worker/handler.mjs — the worker state machine of design §7.2–§7.4. All decisions live here; worker.mjs only
// wires real dependencies. One async FIFO queue, memoized ensureModel, one terminal message per job, dead-handler rules,
// the §7.4 failure table and design_accepted DA-1 (navigator.gpu is probed BEFORE the ORT bundle is imported).
// FIX-3 R2: before the first model download the ONNX Runtime files of the backend (manifest.runtime.<backend>) go through
// the same loader (ensureRuntime, once per worker) and are handed to ORT via the injected `configureRuntime` (worker.mjs
// sets env.wasm.wasmBinary + blob: wasmPaths), so ORT itself never fetches; a terminal failure is RUNTIME_DOWNLOAD with the
// job id; a later webgpu session failure says whether the runtime bytes were in place (`runtimeLoaded`).
import { EngineError, classifyAllocationFailure } from '../engine/errors.mjs';
import { validateManifest, loadModelBytes as defaultLoadModelBytes, loadRuntimeBytes as defaultLoadRuntimeBytes, migrateLegacyCache, sweepStaleEntries } from '../engine/model-loader.mjs';
import { createSession as defaultCreateSession } from '../engine/session.mjs';
import { separateMdx as defaultSeparateMdx } from '../engine/mdx.mjs';
import { separateRoformer as defaultSeparateRoformer } from '../engine/roformer.mjs';

const LIMIT_KEYS = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxUniformBufferBindingSize'];

class RunError extends Error {
  constructor(cause) { super(cause && cause.message ? cause.message : String(cause)); this.name = 'RunError'; this.cause = cause; }
}

// init.baseUrl rules (§7.3): parses, same origin, pathname ends with '/', no search, no hash.
export function validateBaseUrl(baseUrl, origin) {
  if (typeof baseUrl !== 'string') return false;
  let u;
  try { u = new URL(baseUrl); } catch { return false; }
  if (u.origin !== origin) return false;
  if (!u.pathname.endsWith('/')) return false;
  if (u.search !== '' || u.hash !== '') return false;
  return true;
}

export function createHandler(deps) {
  const {
    post, loadBundle, gpu, fetchInto, caches = null, store: storeDep = null, subtle, origin,
    now = () => Date.now(),
    warn = (...a) => console.warn('[vs]', ...a),
    loadModelBytes = defaultLoadModelBytes,
    loadRuntimeBytes = defaultLoadRuntimeBytes,
    configureRuntime = null,   // (ort, { backend, wasm, glue, names }) → hands the loaded runtime bytes to ORT (worker.mjs); null = ORT fetches by itself
    createSession = defaultCreateSession,
    separateMdx = defaultSeparateMdx,
    separateRoformer = defaultSeparateRoformer,   // tests may pass null to exercise the "engine unavailable" INTERNAL path
  } = deps;
  // `store` = the part store of part-store.mjs (persisted parts + assembled files), given directly or as a factory
  // `(baseUrl) => store` resolved at init; `caches` = the CacheStorage, used once to migrate entries of the old
  // per-version caches (R3) before the first model load.
  let store = typeof storeDep === 'function' ? null : storeDep;
  let migration = null;

  const queue = [];
  let draining = false;
  let dead = false;          // after a failed init or a backend-fallback nothing is processed any more
  let deadField = null;      // failed init → later jobs answered INTERNAL { field }
  let init = null;
  let ort = null;
  let device = null;
  let gpuInfo = null;
  let fellBack = false;

  let currentJobId = null;
  let jobStart = 0;
  let jobFailed = false;     // terminal message of the current job already posted
  let jobErrored = false;    // the last terminal message was an error (main never reuses this worker)

  const memo = new Map();    // modelId → Promise<{ session, params, arch, modelId, load: { downloadMs, verifyMs, sessionMs } }>
  let loadedId = null;
  let runtimeLoad = null;    // once per worker: Promise<{ report, downloadMs, configureMs } | null> (null = no manifest.runtime for the backend)
  let runtimeLoaded = false; // the runtime bytes were handed to ORT (a later session failure is then not a download problem)
  let runtimeRelease = null; // configureRuntime's release hook, called once the first session exists (the .wasm blob: URL is not needed after instantiation)

  const jobIdField = () => (currentJobId !== null ? { jobId: currentJobId } : {});
  const progress = (evt) => post({ type: 'progress', ...jobIdField(), elapsedMs: currentJobId !== null ? now() - jobStart : 0, ...evt });

  function postFallback(reason, message, extra) {
    post({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason, ...(message !== undefined ? { message } : {}), ...(extra ?? {}) });
    dead = true;
  }

  // FIX-3 R2: the backend's runtime files through the loader (progress events tagged asset: 'runtime'), then to ORT. A failed
  // load is retried by the next job (the memo is cleared); the bytes already stored are not fetched again.
  function ensureRuntime() {
    if (runtimeLoad) return runtimeLoad;
    const rt = init.manifest.runtime ? init.manifest.runtime[init.backend] : undefined;
    if (!rt) { runtimeLoad = Promise.resolve(null); return runtimeLoad; }
    const p = (async () => {
      const t0 = now();
      const r = await loadRuntimeBytes(init.manifest, init.backend, { fetchInto, store, subtle, baseUrl: init.baseUrl, origin, warn, sourceIds: init.sourceIds, now }, (evt) => progress({ ...evt, asset: 'runtime' }));
      const t1 = now();
      if (typeof configureRuntime === 'function') {
        const handle = await configureRuntime(ort, { backend: init.backend, wasm: r.wasm, glue: r.glue, names: { wasm: rt.wasm.name, glue: rt.glue.name } });
        if (handle && typeof handle.release === 'function') runtimeRelease = () => handle.release();
      }
      runtimeLoaded = true;
      return { report: r.report, downloadMs: t1 - t0, configureMs: now() - t1 };
    })();
    p.catch(() => { if (runtimeLoad === p) runtimeLoad = null; });
    runtimeLoad = p;
    return p;
  }

  function onDeviceLost(info) {
    if (jobErrored) return;                                // the run rejection already reported this job
    if (currentJobId !== null) { jobFailed = true; jobErrored = true; }
    post({ type: 'error', ...jobIdField(), code: 'GPU_LOST', message: info && info.message ? info.message : 'device lost', detail: { reason: info && info.reason ? info.reason : 'unknown' } });
  }

  async function createDevice() {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { fallback: 'no-adapter' };
    let dev;
    try {
      const features = ['shader-f16', 'subgroups'].filter((f) => adapter.features && typeof adapter.features.has === 'function' && adapter.features.has(f));
      const limits = {};
      for (const k of LIMIT_KEYS) if (adapter.limits && adapter.limits[k] !== undefined) limits[k] = adapter.limits[k];
      dev = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: limits });
      if (!('adapterInfo' in dev)) Object.defineProperty(dev, 'adapterInfo', { value: adapter.info });
      const info = adapter.info ?? dev.adapterInfo ?? {};
      gpuInfo = { vendor: info.vendor ?? '', architecture: info.architecture ?? '', f16: features.includes('shader-f16') };
    } catch (e) {
      return { fallback: 'device', message: e && e.message ? e.message : String(e) };
    }
    if (dev.lost && typeof dev.lost.then === 'function') dev.lost.then(onDeviceLost, () => {});
    return { device: dev };
  }

  async function handleInit(m) {
    if (init !== null) return;                             // once per worker
    const field = (m.backend !== 'webgpu' && m.backend !== 'wasm') ? 'backend'
      : (!Number.isInteger(m.threads) || m.threads < 1 || m.threads > 64) ? 'threads'
        : !validateBaseUrl(m.baseUrl, origin) ? 'baseUrl'
          : null;
    if (field) { dead = true; deadField = field; return; }
    try { validateManifest(m.manifest); } catch (e) { dead = true; deadField = 'manifest'; void e; return; }
    const sourceIds = Array.isArray(m.sourceIds) && m.sourceIds.every((s) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s)) && m.sourceIds.length ? m.sourceIds : null;
    init = { backend: m.backend, threads: m.threads, baseUrl: m.baseUrl, manifest: m.manifest, sourceIds };
    if (typeof storeDep === 'function') { try { store = storeDep(init.baseUrl) ?? null; } catch (e) { warn('part store unavailable', e); store = null; } }
    fellBack = m.fellBack === true;
    if (init.backend === 'webgpu') {
      if (!gpu) { postFallback('no-gpu-in-worker'); return; }     // DA-1: before any bundle import or fetch
      let r;
      try { r = await createDevice(); } catch (e) { r = { fallback: 'device', message: e && e.message ? e.message : String(e) }; }
      if (r.fallback) { postFallback(r.fallback, r.message); return; }
      device = r.device;
    }
    try { ort = await loadBundle(init.backend, { baseUrl: init.baseUrl, threads: init.threads }); } catch (e) {
      warn('bundle import failed', e);
      dead = true; deadField = 'bundle';
      return;
    }
    post({ type: 'ready', backend: init.backend, threads: init.threads, gpu: gpuInfo });
  }

  // §15: a melroformer model needs every params.requiredFeatures (shader-f16 for the fp16 graph) on the worker's device;
  // a device without them is a `device` fallback (→ GPU_ONLY_MODEL on main for tier hq), checked before any download.
  function missingDeviceFeatures(model) {
    if (init.backend !== 'webgpu' || model.arch !== 'melroformer') return [];
    const required = Array.isArray(model.params?.requiredFeatures) ? model.params.requiredFeatures : [];
    const has = (f) => !!device && !!device.features && typeof device.features.has === 'function' && device.features.has(f);
    return required.filter((f) => !has(f));
  }

  async function loadAndCreate(modelId, model) {
    const missing = missingDeviceFeatures(model);
    if (missing.length) throw new EngineError('FALLBACK', `device lacks required features: ${missing.join(', ')}`, { reason: 'device', missing });
    // once per worker: R3 key migration of the old per-version caches, then the sweep of store keys no manifest file owns
    if (!migration) {
      migration = (async () => {
        const m = await migrateLegacyCache(init.manifest, { caches, store, subtle, baseUrl: init.baseUrl, warn });
        const swept = await sweepStaleEntries(init.manifest, { store, warn });
        return { ...m, swept: swept.deleted };
      })().catch((e) => { warn('legacy cache migration failed', e); return null; });
    }
    const migrated = await migration;
    // FIX-3: the runtime first (28.7 MB for WebGPU, 14.8 MB for WASM), so ORT instantiates from bytes the loader verified
    const runtime = await ensureRuntime();
    const t0 = now();
    // downloadMs / verifyMs accumulate over the loader's phases (the model's; the runtime has its own timings.runtime): a
    // two-file model (Tier 2) runs download → verify → download → verify, a cache hit runs verify only; the phase switches on
    // the progress stage and the open phase closes at t1.
    let phase = 'download', phaseStart = t0, downloadMs = 0, verifyMs = 0;
    const { bytes, externalData, report } = await loadModelBytes(init.manifest, modelId, { fetchInto, store, subtle, baseUrl: init.baseUrl, origin, warn, sourceIds: init.sourceIds, now }, (evt) => {
      if ((evt.stage === 'verify' || evt.stage === 'download') && evt.stage !== phase) {
        const t = now();
        if (phase === 'download') downloadMs += t - phaseStart; else verifyMs += t - phaseStart;
        phase = evt.stage; phaseStart = t;
      }
      progress(evt);
    });
    const t1 = now();
    if (phase === 'download') downloadMs += t1 - phaseStart; else verifyMs += t1 - phaseStart;
    const download = report ? { ...report, migrated: migrated ? migrated.migrated.length : 0, swept: migrated ? migrated.swept.length : 0 } : null;
    progress({ stage: 'session' });
    let session;
    try {
      session = await createSession(ort, { backend: init.backend, bytes, externalData, ...(device ? { device } : {}) });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      if (init.backend === 'webgpu') throw new EngineError('FALLBACK', message, { reason: 'session', runtimeLoaded });
      throw new EngineError('SESSION', message, { runtimeLoaded });
    }
    const t2 = now();
    if (runtimeRelease) { const rel = runtimeRelease; runtimeRelease = null; try { rel(); } catch (e) { warn('runtime release failed', e); } }
    return { session, params: model.params, arch: model.arch, modelId, load: { downloadMs, verifyMs, sessionMs: t2 - t1, download, runtime: runtime ?? null } };
  }

  function ensureModel(modelId) {
    const existing = memo.get(modelId);
    if (existing) return existing;
    if (loadedId !== null && loadedId !== modelId) {
      const prev = memo.get(loadedId);
      memo.delete(loadedId);
      if (prev) prev.then((l) => { try { const r = l.session.release?.(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } }, () => {});
    }
    loadedId = modelId;
    const model = init.manifest.models[modelId];
    let p;
    if (!model || !Array.isArray(model.backends) || !model.backends.includes(init.backend)) {
      p = Promise.reject(new EngineError('INTERNAL', 'model not valid for backend', { modelId, backend: init.backend }));
    } else {
      p = loadAndCreate(modelId, model);
    }
    p.catch(() => { if (memo.get(modelId) === p) memo.delete(modelId); });   // the user's retry downloads again
    memo.set(modelId, p);
    return p;
  }

  function handleLoadModel(m) {
    if (typeof m.modelId !== 'string') return;
    ensureModel(m.modelId);                                // prefetch hint, no reply
  }

  function wrapSession(session) {
    return {
      get inputNames() { return session.inputNames; },
      get outputNames() { return session.outputNames; },
      async run(feeds) { try { return await session.run(feeds); } catch (e) { throw new RunError(e); } },
    };
  }

  function mapFailure(e) {
    if (e instanceof EngineError) return { code: e.code, message: e.message, detail: e.detail };
    if (e instanceof RunError) {
      const cause = e.cause;
      if (init.backend === 'webgpu') return { code: 'INFERENCE', message: e.message, detail: { phase: 'run' } };
      const code = classifyAllocationFailure(cause) ?? 'INFERENCE';
      return { code, message: e.message };
    }
    const oom = classifyAllocationFailure(e);
    return { code: oom ?? 'INTERNAL', message: e && e.message ? e.message : String(e) };
  }

  async function handleSeparate(m) {
    const jobId = m.jobId;
    if (typeof jobId !== 'string') return;
    currentJobId = jobId;
    jobStart = now();
    jobFailed = false;
    jobErrored = false;
    const fail = (code, message, detail) => {
      if (jobFailed) { warn('dropped second failure for job', jobId, code); return; }
      jobFailed = true; jobErrored = true;
      post({ type: 'error', jobId, code, message, ...(detail !== undefined ? { detail } : {}) });
    };
    try {
      if (!init) throw new EngineError('INTERNAL', 'separate before init', { field: 'init' });
      const { left, right } = m;
      if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length || left.length === 0) {
        throw new EngineError('INTERNAL', 'separate: left/right must be equal-length non-empty Float32Arrays', { field: 'audio' });
      }
      if (typeof m.modelId !== 'string') throw new EngineError('INTERNAL', 'separate: modelId missing', { field: 'modelId' });
      const loaded = await ensureModel(m.modelId);
      if (jobFailed) return;                               // device lost while loading
      const session = wrapSession(loaded.session);
      const common = { ort, session, params: loaded.params, left, right, onProgress: progress };
      const t0 = now();
      let out;
      let denoise;
      if (loaded.arch === 'melroformer') {
        if (typeof separateRoformer !== 'function') throw new EngineError('INTERNAL', 'roformer engine not available', { arch: loaded.arch });
        denoise = false;                                   // Tier 2 has no denoise pass (§15)
        out = await separateRoformer(common);
      } else {
        denoise = m.denoise === true;
        const maxChunks = Number.isInteger(m.maxChunks) && m.maxChunks > 0 ? m.maxChunks : Infinity;
        out = await separateMdx({ ...common, denoise, maxChunks });
      }
      if (jobFailed) return;                               // GPU_LOST already posted for this job
      const totalMs = now() - t0;
      const [vocL, vocR] = out.vocals;
      const [instL, instR] = out.instrumental;
      const timings = {
        downloadMs: loaded.load.downloadMs, verifyMs: loaded.load.verifyMs, sessionMs: loaded.load.sessionMs, download: loaded.load.download ?? null,
        runtime: loaded.load.runtime ?? null,   // FIX-3: { report, downloadMs, configureMs } of the runtime load, null without manifest.runtime
        chunkMs: out.timings.chunkMs ?? [], stftMs: out.timings.stftMs ?? 0, istftMs: out.timings.istftMs ?? 0, totalMs,
        tier: m.tier, modelId: loaded.modelId, backend: init.backend, threads: init.threads, fellBack, denoise,
      };
      jobFailed = true;
      post({ type: 'result', jobId, vocals: [vocL, vocR], instrumental: [instL, instR], timings }, [vocL.buffer, vocR.buffer, instL.buffer, instR.buffer]);
    } catch (e) {
      if (e instanceof EngineError && e.code === 'FALLBACK') {
        if (!jobFailed) {
          jobFailed = true; jobErrored = true;
          const extra = e.detail && typeof e.detail.runtimeLoaded === 'boolean' ? { runtimeLoaded: e.detail.runtimeLoaded } : undefined;
          postFallback(e.detail && e.detail.reason ? e.detail.reason : 'session', e.message, extra);
        }
        return;
      }
      const f = mapFailure(e);
      fail(f.code, f.message, f.detail);
    } finally {
      currentJobId = null;
    }
  }

  async function handle(m) {
    if (!m || typeof m !== 'object') return;
    if (dead) {
      if (deadField !== null && typeof m.jobId === 'string') {
        post({ type: 'error', jobId: m.jobId, code: 'INTERNAL', message: `init rejected: ${deadField}`, detail: { field: deadField } });
      }
      return;
    }
    switch (m.type) {
      case 'init': return handleInit(m);
      case 'load-model': return handleLoadModel(m);
      case 'separate': return handleSeparate(m);
      default:
        if (typeof m.jobId === 'string') post({ type: 'error', jobId: m.jobId, code: 'INTERNAL', message: `unknown message type ${m.type}`, detail: { field: 'type' } });
    }
  }

  async function drain() {
    draining = true;
    while (queue.length) {
      const m = queue.shift();
      try { await handle(m); } catch (e) { warn('handler failure', e); }
    }
    draining = false;
  }

  return {
    onMessage(msg) { queue.push(msg); if (!draining) drain(); },
    get dead() { return dead; },
  };
}
