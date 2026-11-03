// site/src/worker/handler.mjs — the worker state machine of design §7.2–§7.4. All decisions live here; worker.mjs only
// wires real dependencies. One async FIFO queue, memoized ensureModel, one terminal message per job, dead-handler rules,
// the §7.4 failure table and design_accepted DA-1 (navigator.gpu is probed BEFORE the ORT bundle is imported).
import { EngineError, classifyAllocationFailure } from '../engine/errors.mjs';
import { validateManifest, loadModelBytes as defaultLoadModelBytes } from '../engine/model-loader.mjs';
import { createSession as defaultCreateSession } from '../engine/session.mjs';
import { separateMdx as defaultSeparateMdx } from '../engine/mdx.mjs';

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
    post, loadBundle, gpu, fetchInto, caches = null, subtle, origin,
    now = () => Date.now(),
    warn = (...a) => console.warn('[vs]', ...a),
    loadModelBytes = defaultLoadModelBytes,
    createSession = defaultCreateSession,
    separateMdx = defaultSeparateMdx,
    separateRoformer = null,
  } = deps;

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

  const jobIdField = () => (currentJobId !== null ? { jobId: currentJobId } : {});
  const progress = (evt) => post({ type: 'progress', ...jobIdField(), elapsedMs: currentJobId !== null ? now() - jobStart : 0, ...evt });

  function postFallback(reason, message) {
    post({ type: 'backend-fallback', from: 'webgpu', to: 'wasm', reason, ...(message !== undefined ? { message } : {}) });
    dead = true;
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
    init = { backend: m.backend, threads: m.threads, baseUrl: m.baseUrl, manifest: m.manifest };
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

  async function loadAndCreate(modelId, model) {
    const t0 = now();
    let tVerify = null;
    const { bytes, externalData } = await loadModelBytes(init.manifest, modelId, { fetchInto, cache: caches ?? null, subtle, baseUrl: init.baseUrl, warn }, (evt) => {
      if (evt.stage === 'verify' && tVerify === null) tVerify = now();
      progress(evt);
    });
    const t1 = now();
    progress({ stage: 'session' });
    let session;
    try {
      session = await createSession(ort, { backend: init.backend, bytes, externalData, ...(device ? { device } : {}) });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      if (init.backend === 'webgpu') throw new EngineError('FALLBACK', message, { reason: 'session' });
      throw new EngineError('SESSION', message);
    }
    const t2 = now();
    const downloadMs = (tVerify ?? t1) - t0;
    return { session, params: model.params, arch: model.arch, modelId, load: { downloadMs, verifyMs: t1 - (tVerify ?? t1), sessionMs: t2 - t1 } };
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
        downloadMs: loaded.load.downloadMs, verifyMs: loaded.load.verifyMs, sessionMs: loaded.load.sessionMs,
        chunkMs: out.timings.chunkMs ?? [], stftMs: out.timings.stftMs ?? 0, istftMs: out.timings.istftMs ?? 0, totalMs,
        tier: m.tier, modelId: loaded.modelId, backend: init.backend, threads: init.threads, fellBack, denoise,
      };
      jobFailed = true;
      post({ type: 'result', jobId, vocals: [vocL, vocR], instrumental: [instL, instR], timings }, [vocL.buffer, vocR.buffer, instL.buffer, instR.buffer]);
    } catch (e) {
      if (e instanceof EngineError && e.code === 'FALLBACK') {
        if (!jobFailed) { jobFailed = true; jobErrored = true; postFallback('session', e.message); }
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
