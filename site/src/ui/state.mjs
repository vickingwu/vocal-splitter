// site/src/ui/state.mjs — the pure UI state machine of design §12.1 (+ §7.1 resolveModelId, §7.4 fallback rule, §23 login
// gate, §22 device-policy effects, design_accepted DA-5 post-login ordering). reduce(state, event) → { state, effects }.
// Effects are plain objects { type, ...payload } that app.mjs executes; the reducer never touches the DOM or the worker.

export const GPU_FALLBACK_CODES = new Set(['INFERENCE', 'GPU_LOST', 'NUMERIC']);
export const BUSY_STATES = new Set(['fetching-url', 'decoding', 'loading-model', 'separating', 'encoding']);
const INPUT_OK_STATES = new Set(['idle', 'ready', 'done', 'error']);

// §7.1: tier → model id for the backend; ?model= override only when valid for this backend; iOS WASM → wasmLow.
// FIX-2 R5 threads rule: a single-threaded WASM run (not crossOriginIsolated) on any device also resolves to wasmLow —
// Voc_FT needs 28–52 s per chunk on one thread, the small model a fraction of that; the manifest is unchanged.
export function resolveModelId(manifest, tier, backend, queryModel, lowMemory, threads) {
  if (!manifest || !manifest.tiers || !manifest.models) return undefined;
  if (queryModel && manifest.models[queryModel] && Array.isArray(manifest.models[queryModel].backends)
      && manifest.models[queryModel].backends.includes(backend)) return queryModel;
  const t = manifest.tiers[tier];
  if (!t) return undefined;
  if (backend === 'wasm' && (lowMemory || threads === 1)) return t.wasmLow ?? t.wasm;
  return t[backend];
}

// 「· 小模型」 on the backend line: the standard tier resolves to tiers.standard.wasmLow on this WASM run while the
// desktop model would have been another one — the threads rule, or a `?model=` pin of the small model; never on the iOS
// policy (where the small model is the only one). `?model=` pinning the desktop model on one thread → no label.
export function smallModelLabel(s, backend, threads) {
  if (backend !== 'wasm') return false;
  const lowMemory = !!(s.policy && s.policy.lowMemory === true);
  if (lowMemory) return false;
  const m = s.manifest;
  if (!m || !m.tiers || !m.tiers.standard || !m.models) return threads === 1;     // manifest not loaded yet: the threads rule alone
  const id = resolveModelId(m, 'standard', 'wasm', s.query ? s.query.model : undefined, lowMemory, threads);
  return id !== undefined && id === m.tiers.standard.wasmLow && id !== m.tiers.standard.wasm;
}

export function createInitialState() {
  return {
    state: 'locked',
    loggedIn: false,
    error: null,
    policy: null,
    simd: null,
    capsReady: false,
    backend: null,
    threads: 1,
    hq: false,
    manifest: null,
    query: {},
    tier: 'standard',
    decodedInput: false,
    hasBuffer: false,
    inputName: null,
    job: null,
    workerAlive: false,
    mp3: null,
    mp3Failed: null,
    jobSeq: 0,
  };
}

export function canStart(s) {
  return (s.state === 'ready' || s.state === 'done' || s.state === 'error') && s.decodedInput === true && s.capsReady === true;
}

const fx = (type, extra) => (extra ? { type, ...extra } : { type });
const touchOf = (s) => !!(s.policy && s.policy.touch);

function releaseEffects(s, effects) {
  effects.push(fx('release wake lock'));
  if (touchOf(s)) effects.push(fx('hide keep-awake'));
}

function inputCleanup(effects) {
  for (const t of ['drop decodedInput', 'drop stems', 'revoke blob urls', 'unload players', 'disable downloads', 'clear error', 'reset timings']) effects.push(fx(t));
}

function jobCleanup(effects) {
  for (const t of ['drop stems', 'revoke blob urls', 'unload players', 'disable downloads', 'clear error', 'clear job timings']) effects.push(fx(t));
}

function terminateWorker(s, effects) {
  if (s.workerAlive) { effects.push(fx('terminate worker')); s.workerAlive = false; }
}

function jobError(s, code, detail, effects, message) {
  s.state = 'error';
  s.error = { code, detail: detail === undefined ? {} : detail };
  s.job = null;
  s.mp3 = null;
  effects.push(fx('clear progress'));
  effects.push(fx('render error', { code, detail: s.error.detail, ...(message !== undefined ? { message } : {}) }));
  terminateWorker(s, effects);
  releaseEffects(s, effects);
}

function gpuOnlyModel(s, reason, effects) {
  s.state = 'ready';
  s.tier = 'standard';
  s.job = null;
  s.error = { code: 'GPU_ONLY_MODEL', detail: { reason } };
  effects.push(fx('clear progress'));
  effects.push(fx('render error', { code: 'GPU_ONLY_MODEL', detail: s.error.detail }));
  effects.push(fx('reset select to standard'));
  releaseEffects(s, effects);
}

// Spawns/reuses the worker and dispatches the job (first dispatch copies the AudioBuffer; later ones re-decode the Blob).
function dispatch(s, effects) {
  if (!s.workerAlive) { effects.push(fx('spawn worker')); s.workerAlive = true; }
  effects.push(fx('dispatch job', { job: { ...s.job }, copyMode: s.hasBuffer ? 'buffer' : 'redecode' }));
  s.hasBuffer = false;
}

function startJob(s, effects) {
  const modelId = resolveModelId(s.manifest, s.job.tier, s.job.backend, s.query.model, s.policy ? s.policy.lowMemory : false, s.job.threads);
  if (modelId === undefined) { gpuOnlyModel(s, 'no-model', effects); return; }
  s.job.modelId = modelId;
  s.state = 'loading-model';
  dispatch(s, effects);
}

// FIX-3 R3: the message of a `session` failure that is really a network failure — ORT fetched its own .wasm (an old
// worker.mjs, or a runtime it was not handed) and the fetch died. Such a failure is NOT a GPU problem: it must never turn
// into GPU_ONLY_MODEL or a WASM fallback (the other backend needs its own 14.8 MB over the same link).
export const NETWORK_FAILURE_RE = /XMLHttpRequest|NetworkError|Failed to (load|fetch)|net::ERR_|ERR_(CONNECTION|NETWORK|INTERNET|CONTENT_DECODING|TIMED_OUT)|network error|Load failed/i;
export function isNetworkFailureMessage(message) {
  return typeof message === 'string' && NETWORK_FAILURE_RE.test(message);
}

function webgpuFailure(s, reason, message, effects, info) {
  effects.push(fx('log', { level: 'error', args: ['webgpu-fallback', reason, message ?? ''] }));
  if (!s.job) { terminateWorker(s, effects); return; }
  if (reason === 'session' && isNetworkFailureMessage(message)) {
    // the runtime bytes were handed to ORT (runtimeLoaded) → the network words are not about the runtime: an ordinary
    // SESSION error; otherwise ORT's own download failed → RUNTIME_DOWNLOAD (no saved-bytes figure is known here)
    if (info && info.runtimeLoaded === true) jobError(s, 'SESSION', { reason: 'session', network: true }, effects, message);
    else jobError(s, 'RUNTIME_DOWNLOAD', { reason: 'session', network: true }, effects, message);
    return;
  }
  if (s.job.fellBack) { jobError(s, 'INTERNAL', { reason: 'second fallback' }, effects); return; }
  terminateWorker(s, effects);
  const modelId = resolveModelId(s.manifest, s.job.tier, 'wasm', s.query.model, s.policy ? s.policy.lowMemory : false, s.threads);
  if (modelId === undefined) { gpuOnlyModel(s, reason, effects); return; }
  s.job = { ...s.job, backend: 'wasm', threads: s.threads, modelId, fellBack: true };
  s.state = 'loading-model';
  dispatch(s, effects);
  effects.push(fx('render backend line', { backend: 'wasm', threads: s.threads, small: smallModelLabel(s, 'wasm', s.threads) }));
}

function finishEncoding(s, effects) {
  s.state = 'done';
  s.mp3Failed = { vocals: s.mp3.vocals === 'failed', instrumental: s.mp3.instrumental === 'failed' };
  s.job = null;
  effects.push(fx('render done'));
  releaseEffects(s, effects);
}

function onWorker(s, msg, effects) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ready':
      effects.push(fx('render backend line', { backend: msg.backend, threads: msg.threads, small: smallModelLabel(s, msg.backend, msg.threads) }));
      return;
    case 'progress':
      if (!s.job) return;
      if (msg.jobId !== undefined && msg.jobId !== s.job.id) return;
      if (msg.stage === 'separate' && s.state === 'loading-model') s.state = 'separating';
      effects.push(fx('render progress', { kind: 'worker', progress: msg }));
      return;
    case 'result': {
      if (!s.job || msg.jobId !== s.job.id) { effects.push(fx('log', { level: 'warn', args: ['stale result', msg.jobId] })); return; }
      s.state = 'encoding';
      s.mp3 = { vocals: 'pending', instrumental: 'pending' };
      s.mp3Failed = null;
      effects.push(fx('build outputs', { timings: msg.timings }));
      effects.push(fx('encode mp3', { parallel: !(s.policy && s.policy.parallelEncode === false) }));
      effects.push(fx('render progress', { kind: 'encoding' }));
      if (s.policy && s.policy.keepWorkerAfterResult === false) terminateWorker(s, effects);
      return;
    }
    case 'backend-fallback':
      webgpuFailure(s, msg.reason, msg.message, effects, { runtimeLoaded: msg.runtimeLoaded });
      return;
    case 'error': {
      if (msg.jobId === undefined) {
        if (msg.code === 'GPU_LOST' && !s.job) {
          effects.push(fx('log', { level: 'error', args: ['GPU_LOST', msg.message ?? ''] }));
          terminateWorker(s, effects);
          return;
        }
        effects.push(fx('log', { level: 'error', args: ['INTERNAL', 'error without jobId', msg.code] }));
        return;
      }
      if (!s.job || msg.jobId !== s.job.id) { effects.push(fx('log', { level: 'warn', args: ['stale error', msg.jobId, msg.code] })); return; }
      if (s.job.backend === 'webgpu' && !s.job.fellBack && GPU_FALLBACK_CODES.has(msg.code)) { webgpuFailure(s, msg.code, msg.message, effects); return; }
      jobError(s, msg.code, msg.detail, effects, msg.message);
      return;
    }
    default:
      effects.push(fx('log', { level: 'warn', args: ['unknown worker message', msg.type] }));
  }
}

export function reduce(prev, event) {
  const s = { ...prev, query: prev.query, job: prev.job ? { ...prev.job } : null, mp3: prev.mp3 ? { ...prev.mp3 } : null };
  const effects = [];
  const type = event && event.type;

  // ---- locked: only the login events do anything (§23)
  if (s.state === 'locked') {
    if (type === 'login-ok' || type === 'boot-session') {
      s.loggedIn = true;
      s.policy = event.policy ?? null;
      s.simd = event.simd === true;
      if (type === 'login-ok') effects.push(fx('store session'));
      if (!s.simd) {
        s.state = 'unsupported';
        s.error = { code: 'UNSUPPORTED', detail: {} };
        effects.push(fx('render app disabled'));
        effects.push(fx('render error', { code: 'UNSUPPORTED', detail: {} }));
      } else {
        s.state = 'idle';
        s.error = null;
        effects.push(fx('render app'));
        effects.push(fx('probe caps'));
      }
      return { state: s, effects };
    }
    if (type === 'login-fail') {
      s.error = { code: 'LOGIN_FAILED', detail: {} };
      effects.push(fx('render login error'));
      return { state: s, effects };
    }
    return { state: s, effects };
  }

  if (type === 'logout') { effects.push(fx('clear session + reload')); return { state: s, effects }; }
  if (s.state === 'unsupported') return { state: s, effects };

  switch (type) {
    case 'caps-ready':
      s.capsReady = true;
      s.backend = event.backend;
      s.threads = Number.isInteger(event.threads) && event.threads > 0 ? event.threads : 1;
      s.hq = event.hq === true;
      s.manifest = event.manifest ?? null;
      s.query = event.query ?? {};
      if (s.tier === 'hq' && !s.hq) s.tier = 'standard';
      effects.push(fx('render caps', { backend: s.backend, threads: s.threads, hq: s.hq, small: smallModelLabel(s, s.backend, s.threads) }));
      return { state: s, effects };

    case 'tier':
      if (event.tier === 'hq' && s.hq) s.tier = 'hq';
      else s.tier = 'standard';
      return { state: s, effects };

    case 'file':
    case 'url':
    case 'url-invalid': {
      if (!INPUT_OK_STATES.has(s.state)) return { state: s, effects };
      inputCleanup(effects);
      s.decodedInput = false;
      s.hasBuffer = false;
      s.error = null;
      s.job = null;
      s.mp3 = null;
      s.mp3Failed = null;
      if (type === 'url-invalid') {
        s.state = 'error';
        s.inputName = null;
        s.error = { code: event.code, detail: event.detail ?? {} };
        effects.push(fx('render error', { code: event.code, detail: s.error.detail }));
        return { state: s, effects };
      }
      s.inputName = event.name ?? null;
      effects.push(fx('render file line', { name: s.inputName, duration: null }));
      if (type === 'file') { s.state = 'decoding'; effects.push(fx('decode file')); }
      else { s.state = 'fetching-url'; effects.push(fx('fetch url', { url: event.url })); }
      return { state: s, effects };
    }

    case 'url-progress':
      if (s.state === 'fetching-url') effects.push(fx('render progress', { kind: 'url', received: event.received, total: event.total ?? null }));
      return { state: s, effects };

    case 'url-fetched':
      if (s.state !== 'fetching-url') return { state: s, effects };
      s.state = 'decoding';
      effects.push(fx('render progress', { kind: 'decoding' }));
      return { state: s, effects };

    case 'decoded':
      if (s.state !== 'decoding') return { state: s, effects };
      s.state = 'ready';
      s.decodedInput = true;
      s.hasBuffer = true;
      effects.push(fx('clear progress'));
      effects.push(fx('render file line', { name: s.inputName, duration: event.duration }));
      return { state: s, effects };

    case 'input-error':
      if (s.state !== 'fetching-url' && s.state !== 'decoding') return { state: s, effects };
      s.state = 'error';
      s.decodedInput = false;
      s.hasBuffer = false;
      s.error = { code: event.code, detail: event.detail === undefined ? {} : event.detail };
      effects.push(fx('clear progress'));
      effects.push(fx('render error', { code: event.code, detail: s.error.detail, ...(event.message !== undefined ? { message: event.message } : {}) }));
      return { state: s, effects };

    case 'start': {
      if (!canStart(s)) return { state: s, effects };
      s.jobSeq = prev.jobSeq + 1;
      s.error = null;
      s.mp3 = null;
      s.mp3Failed = null;
      s.job = { id: 'j' + s.jobSeq, tier: s.tier, modelId: null, backend: s.backend, threads: s.threads, fellBack: false, denoise: event.denoise === true, maxChunks: s.query.maxChunks };
      jobCleanup(effects);
      effects.push(fx('acquire wake lock'));
      if (touchOf(s)) effects.push(fx('show keep-awake'));
      if (!s.manifest) { s.state = 'loading-model'; effects.push(fx('fetch manifest')); return { state: s, effects }; }
      startJob(s, effects);
      return { state: s, effects };
    }

    case 'manifest-ready':
      if (s.state !== 'loading-model' || !s.job || s.job.modelId !== null) return { state: s, effects };
      s.manifest = event.manifest;
      startJob(s, effects);
      return { state: s, effects };

    case 'manifest-failed':
      if (s.state !== 'loading-model' || !s.job) return { state: s, effects };
      jobError(s, 'MANIFEST', event.detail ?? {}, effects);
      return { state: s, effects };

    case 'job-error':
      if (!s.job || (s.state !== 'loading-model' && s.state !== 'separating' && s.state !== 'encoding')) return { state: s, effects };
      if (s.state === 'encoding') effects.push(fx('terminate mp3 workers'));
      jobError(s, event.code, event.detail, effects, event.message);
      return { state: s, effects };

    case 'worker':
      onWorker(s, event.msg, effects);
      return { state: s, effects };

    case 'mp3-progress':
      if (s.state === 'encoding') effects.push(fx('render mp3 progress', { stem: event.stem, fraction: event.fraction }));
      return { state: s, effects };

    case 'mp3-done':
      if (s.state !== 'encoding' || !s.mp3 || s.mp3[event.stem] !== 'pending') return { state: s, effects };
      s.mp3[event.stem] = 'done';
      effects.push(fx('enable mp3 download', { stem: event.stem }));
      if (s.mp3.vocals !== 'pending' && s.mp3.instrumental !== 'pending') finishEncoding(s, effects);
      return { state: s, effects };

    case 'mp3-error':
      if (s.state !== 'encoding' || !s.mp3 || s.mp3[event.stem] !== 'pending') return { state: s, effects };
      s.mp3[event.stem] = 'failed';
      s.error = { code: 'MP3', detail: { stem: event.stem } };
      effects.push(fx('terminate mp3 worker', { stem: event.stem }));
      effects.push(fx('render error', { code: 'MP3', detail: { stem: event.stem } }));
      if (s.mp3.vocals !== 'pending' && s.mp3.instrumental !== 'pending') finishEncoding(s, effects);
      return { state: s, effects };

    case 'cancel':
      switch (s.state) {
        case 'fetching-url':
          s.state = 'idle';
          s.decodedInput = false;
          s.hasBuffer = false;
          s.error = { code: 'CANCELLED', detail: {} };
          effects.push(fx('abort url fetch'));
          effects.push(fx('clear progress'));
          effects.push(fx('render error', { code: 'CANCELLED', detail: {} }));
          return { state: s, effects };
        case 'loading-model':
        case 'separating':
          s.state = 'ready';
          s.job = null;
          s.error = { code: 'CANCELLED', detail: {} };
          terminateWorker(s, effects);
          releaseEffects(s, effects);
          effects.push(fx('clear progress'));
          effects.push(fx('render error', { code: 'CANCELLED', detail: {} }));
          return { state: s, effects };
        case 'encoding':
          s.state = 'done';
          s.job = null;
          for (const k of ['vocals', 'instrumental']) if (s.mp3 && s.mp3[k] === 'pending') s.mp3[k] = 'cancelled';
          s.mp3Failed = { vocals: s.mp3 ? s.mp3.vocals === 'failed' : false, instrumental: s.mp3 ? s.mp3.instrumental === 'failed' : false };
          effects.push(fx('terminate mp3 workers'));
          effects.push(fx('disable mp3 downloads'));
          releaseEffects(s, effects);
          effects.push(fx('render done'));
          return { state: s, effects };
        default:
          return { state: s, effects };
      }

    default:
      return { state: s, effects };
  }
}
