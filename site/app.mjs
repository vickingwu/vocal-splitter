// site/app.mjs — main thread (design §7.1, §7.2, §7.4, §10, §11, §12, §22, §23). Boot order: login form → (session or
// successful submit) → device policy + SIMD check synchronously → #app rendered → adapter probe + manifest fetch → caps-ready.
// The pure reducer in src/ui/state.mjs decides every transition; this file executes its effects and owns the runtime objects
// (decodedInput Blob, worker, stems, blob URLs, clocks). window.__vs is the E2E hook (§12.1).
import { verifyCredentials, hasSession, storeSession, clearSession, newSessionToken } from './auth.mjs';
import { devicePolicy } from './src/ui/device.mjs';
import { probeSimd, probeCaps } from './src/ui/caps.mjs';
import { createWakeLock } from './src/ui/wake.mjs';
import { classifyUrl, fetchAudioUrl, baseNameFromUrl, stripExtension } from './src/ui/url-input.mjs';
import { decodeInput, copyInput, decodeForDispatch } from './src/ui/decode.mjs';
import { reduce, createInitialState, canStart, BUSY_STATES } from './src/ui/state.mjs';
import { STATIC, codeToCopy, progress as P, backendLabel, importResult } from './src/ui/copy.mjs';
import * as dom from './src/ui/dom.mjs';
import { buildWav, encodeMp3Stems, createUrlRegistry, stemFileName } from './src/ui/encode.mjs';
import { createRateMeter, separationEta } from './src/ui/eta.mjs';
import { validateManifest } from './src/engine/model-loader.mjs';
import { createPartStore } from './src/engine/part-store.mjs';
import { importModelFiles } from './src/engine/model-import.mjs';
import { classifyAllocationFailure, EngineError } from './src/engine/errors.mjs';

export const baseUrl = new URL('./', location.href).href;

const MAX_BYTES = 200 * 1024 * 1024;
const now = () => performance.now();

const els = dom.lookup();
let s = createInitialState();

// runtime objects owned by the main thread
let decodedInput = null;                  // { blob, buffer, duration, probe, decodeMs } — the single retained input
let pendingBlob = null;                   // the File / downloaded Blob about to be decoded
let inputSource = 'file';
let inputBase = 'audio';                  // download file-name base
let inputTimings = {};
let jobTimings = {};
let stems = null;                         // [vocL, vocR, instL, instR]
let int16s = null;                        // Int16 planar copies between buildOutputs and the MP3 workers
let wavBlobs = { vocals: null, instrumental: null };
let mp3Blobs = { vocals: null, instrumental: null };
let mp3Progress = { vocals: 0, instrumental: 0 };
let pendingResult = null;
let worker = null;
let workerInited = false;
let mp3Ctl = null;
let urlAbort = null;
let inputGen = 0;
let caps = null;
let query = {};
let clockInput = 0;
let clockJob = 0;
let lastProgress = null;
let ticker = null;
let loginInFlight = false;
let importInFlight = false;
// R4/R5 estimates: download speed over the last 5 s, chunk completion times for the separation ETA
const dlMeter = createRateMeter();
let dlAsset = 'model';                    // which byte series the meter is averaging: 'runtime' (FIX-3) or 'model'
let sepStart = null;
let sepChunkEnds = [];
let sepLastIndex = -1;

const urls = createUrlRegistry();
const wake = createWakeLock({ navigatorLike: navigator, documentLike: document });

const downloadEvents = [];                                   // raw worker download progress events of this page (E2E: bytesDone never decreases)
const vs = window.__vs = {
  state: 'locked', loggedIn: false, error: null, caps: null, backend: null, isolated: crossOriginIsolated, imported: null,
  downloadEvents,
  stems: () => stems,
  wav: (stem) => wavBlobs[stem] ?? null,
  mp3: (stem) => mp3Blobs[stem] ?? null,
  timings: () => ({ ...inputTimings, ...jobTimings }),
  // the retained input (§12.1): duration, decoded length while the AudioBuffer is still resident, the source Blob
  input: () => (decodedInput ? { duration: decodedInput.duration, length: decodedInput.buffer ? decodedInput.buffer.length : null, sampleRate: decodedInput.buffer ? decodedInput.buffer.sampleRate : null, blob: decodedInput.blob } : null),
};

// ------------------------------------------------------------------------------------------------------ dispatch / render
function dispatch(event) {
  const r = reduce(s, event);
  s = r.state;
  vs.state = s.state;
  vs.loggedIn = s.loggedIn;
  vs.error = s.error;
  render();
  for (const e of r.effects) {
    try { runEffect(e); } catch (err) { console.error('[vs]', 'INTERNAL', 'effect failed', e.type, err); }
  }
}

function render() {
  dom.setStartEnabled(els, canStart(s));
  dom.setCancelVisible(els, s.state === 'fetching-url' || s.state === 'loading-model' || s.state === 'separating' || s.state === 'encoding');
  if (s.state !== 'locked' && s.state !== 'unsupported') dom.setInputsBusy(els, BUSY_STATES.has(s.state));
}

const limits = () => ({ maxBytes: MAX_BYTES, maxSeconds: s.policy ? s.policy.maxSeconds : 900 });
const secondsSince = (t0) => Math.max(0, Math.floor((now() - t0) / 1000));

function codeOf(e) {
  if (e instanceof EngineError) return e.code;
  return classifyAllocationFailure(e) ?? 'INTERNAL';
}

// --------------------------------------------------------------------------------------------------------- progress clock
function renderClock() {
  const p = lastProgress;
  if (!p) { dom.setProgress(els, ''); return; }
  const sec = p.clock === 'input' ? secondsSince(clockInput) : secondsSince(clockJob);
  let text = '';
  switch (p.kind) {
    case 'url': text = P.downloadLink(p.received, p.total, sec); break;
    case 'decoding': text = P.decoding(sec); break;
    case 'init': text = P.init(backendLabel(p.backend, p.threads), sec); break;
    case 'worker': {
      const w = p.progress;
      const runtime = w.asset === 'runtime';               // FIX-3: the ORT runtime download precedes the model download
      if (w.stage === 'download') {
        const t = now();
        if ((w.asset ?? 'model') !== dlAsset) { dlMeter.reset(); dlAsset = w.asset ?? 'model'; }   // a new byte series (runtime → model)
        dlMeter.sample(t, w.bytesDone ?? 0);               // a tick without new bytes lets the 5 s average decay
        const rate = dlMeter.rate(t);
        const eta = dlMeter.eta(t, Math.max(0, (w.bytesTotal ?? 0) - (w.bytesDone ?? 0)));
        text = runtime
          ? P.downloadRuntime({ doneBytes: w.bytesDone ?? 0, totalBytes: w.bytesTotal ?? 0, bytesPerSec: rate, etaSec: eta })
          : P.downloadModel({ doneBytes: w.bytesDone ?? 0, totalBytes: w.bytesTotal ?? 0, bytesPerSec: rate, etaSec: eta, fileIndex: w.fileIndex ?? 0, fileCount: w.fileCount ?? 1 });
      } else if (w.stage === 'verify') text = runtime ? P.verifyRuntime(sec) : P.verify(sec);
      else if (w.stage === 'session') text = P.init(backendLabel(p.backend, p.threads), sec);
      else if (w.stage === 'separate') {
        const eta = separationEta(sepChunkEnds, w.chunkCount ?? 0, sepStart ?? clockJob);
        text = P.separating((w.chunkIndex ?? 0) + 1, w.chunkCount ?? 0, p.backend === 'wasm' && p.threads === 1 ? backendLabel(p.backend, p.threads) : null, sec, eta);
      } else if (w.stage === 'finalize') text = P.finalize(sec);
      break;
    }
    case 'encoding': text = P.encoding(Math.round(mp3Progress.vocals * 100), Math.round(mp3Progress.instrumental * 100), sec); break;
    case 'done': text = P.done(p.seconds); break;
    default: text = '';
  }
  dom.setProgress(els, text);
}

function setProgressDesc(desc) {
  lastProgress = desc;
  renderClock();
  if (desc && desc.kind !== 'done') { if (!ticker) ticker = setInterval(renderClock, 1000); }
  else if (ticker) { clearInterval(ticker); ticker = null; }
}

// R5: the engine reports `separate` with the index of the chunk it is about to run, so index k > last means chunk k−1
// just finished; the completion times feed separationEta (median of the last ≤ 5 chunk durations × remaining chunks).
function noteChunkProgress(chunkIndex) {
  const t = now();
  if (sepStart === null || chunkIndex < sepLastIndex) { sepStart = t; sepChunkEnds = []; sepLastIndex = -1; }
  if (chunkIndex > sepLastIndex) {
    const finished = sepLastIndex < 0 ? chunkIndex : chunkIndex - sepLastIndex;   // several indices at once = several finished chunks
    for (let k = 0; k < finished; k++) sepChunkEnds.push(t);
    sepLastIndex = chunkIndex;
  }
}

function resetEstimates() { dlMeter.reset(); dlAsset = 'model'; sepStart = null; sepChunkEnds = []; sepLastIndex = -1; }

// --------------------------------------------------------------------------------------------------------------- effects
function runEffect(e) {
  switch (e.type) {
    case 'store session': storeSession(localStorage, newSessionToken()); return;
    case 'render app':
      dom.showApp(els);
      dom.setDropHint(els, s.policy.maxSeconds, s.policy.touch);
      return;
    case 'render app disabled':
      dom.showApp(els);
      dom.setDropHint(els, s.policy.maxSeconds, s.policy.touch);
      dom.disableAllControls(els);
      return;
    case 'render error':
      dom.setError(els, codeToCopy(e.code, e.detail));
      console.error('[vs]', e.code, e.message ?? '', e.detail);
      return;
    case 'render login error':
      dom.setLoginError(els, STATIC.loginError);
      console.error('[vs]', 'LOGIN_FAILED', '', {});
      return;
    case 'clear error': dom.setError(els, ''); return;
    case 'probe caps': runCapsProbe(); return;
    case 'render caps':
      dom.setBackendLine(els, e.backend, e.threads, e.small === true);
      dom.setModelOptions(els, e.hq);
      if (query.tier === 'hq' && e.hq) { els.modelSelect.value = 'hq'; dispatch({ type: 'tier', tier: 'hq' }); }
      els.denoise.disabled = els.modelSelect.value === 'hq';
      vs.caps = caps;
      vs.backend = { name: e.backend, threads: e.threads, tier: s.tier, modelId: null };
      return;
    case 'clear session + reload':
      clearSession(localStorage);
      location.reload();
      return;
    case 'decode file': runDecode(inputGen); return;
    case 'fetch url': runFetchUrl(e.url); return;
    case 'abort url fetch': if (urlAbort) urlAbort.abort(); return;
    case 'render progress':
      if (e.kind === 'url') setProgressDesc({ kind: 'url', received: e.received, total: e.total, clock: 'input' });
      else if (e.kind === 'decoding') setProgressDesc({ kind: 'decoding', clock: 'input' });
      else if (e.kind === 'worker') {
        if (e.progress.stage === 'separate') noteChunkProgress(e.progress.chunkIndex ?? 0);
        if (e.progress.stage === 'download' && downloadEvents.length < 20000) downloadEvents.push({ t: Math.round(now()), bytesDone: e.progress.bytesDone ?? 0, fileIndex: e.progress.fileIndex ?? 0, sourceId: e.progress.sourceId ?? null, asset: e.progress.asset ?? 'model' });
        setProgressDesc({ kind: 'worker', progress: e.progress, backend: s.job ? s.job.backend : s.backend, threads: s.job ? s.job.threads : s.threads, clock: 'job' });
      } else if (e.kind === 'encoding') setProgressDesc({ kind: 'encoding', clock: 'job' });
      return;
    case 'clear progress': setProgressDesc(null); return;
    case 'render file line': dom.setFileLine(els, e.name, e.duration); return;
    case 'drop decodedInput': decodedInput = null; return;
    case 'drop stems':
      stems = null; int16s = null; pendingResult = null;
      wavBlobs = { vocals: null, instrumental: null };
      mp3Blobs = { vocals: null, instrumental: null };
      mp3Progress = { vocals: 0, instrumental: 0 };
      return;
    case 'revoke blob urls': urls.revokeAll(); return;
    case 'unload players': dom.setPlayer(els.audioVocals, null); dom.setPlayer(els.audioInst, null); return;
    case 'disable downloads': dom.disableDownloads(els); return;
    case 'disable mp3 downloads': dom.disableMp3Downloads(els); return;
    case 'reset timings': inputTimings = {}; jobTimings = {}; return;
    case 'clear job timings': jobTimings = {}; return;
    case 'spawn worker': spawnWorker(); return;
    case 'terminate worker': terminateWorker(); return;
    case 'dispatch job': runDispatch(e.job, e.copyMode); return;
    case 'fetch manifest': runManifestForStart(); return;
    case 'acquire wake lock': wake.acquire().then((st) => { jobTimings.wakeLock = st; }, () => {}); return;
    case 'release wake lock': wake.release().catch(() => {}); return;
    case 'show keep-awake': dom.setKeepAwake(els, true); return;
    case 'hide keep-awake': dom.setKeepAwake(els, false); return;
    case 'build outputs': buildOutputs(e.timings); return;
    case 'encode mp3': startMp3(e.parallel); return;
    case 'render mp3 progress':
      mp3Progress[e.stem] = e.fraction;
      dom.setText(els.dl[e.stem].mp3, P.encodingButton(Math.round(e.fraction * 100)));
      renderClock();
      return;
    case 'enable mp3 download':
      dom.setDownload(els.dl[e.stem].mp3, { enabled: true, filename: stemFileName(inputBase, e.stem, 'mp3'), label: STATIC.dlMp3 });
      return;
    case 'terminate mp3 worker': if (mp3Ctl) mp3Ctl.cancelStem(e.stem); dom.setText(els.dl[e.stem].mp3, STATIC.dlMp3); return;
    case 'terminate mp3 workers': if (mp3Ctl) mp3Ctl.cancel(); mp3Ctl = null; return;
    case 'render done': setProgressDesc({ kind: 'done', seconds: secondsSince(clockJob) }); return;
    case 'render backend line':
      dom.setBackendLine(els, e.backend, e.threads, e.small === true);
      vs.backend = { name: e.backend, threads: e.threads, tier: s.job ? s.job.tier : s.tier, modelId: s.job ? s.job.modelId : null };
      return;
    case 'reset select to standard':
      els.modelSelect.value = 'standard';
      els.denoise.disabled = false;
      return;
    case 'log': {
      const fn = e.level === 'warn' ? console.warn : console.error;
      fn('[vs]', ...e.args);
      return;
    }
    default:
      console.warn('[vs]', 'unknown effect', e.type);
  }
}

// ----------------------------------------------------------------------------------------------------- login (§23)
els.login.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (loginInFlight) return;
  loginInFlight = true;
  els.loginSubmit.disabled = true;
  dom.setLoginError(els, '');
  try {
    const ok = await verifyCredentials(els.loginUser.value, els.loginPass.value);
    if (!ok) { dispatch({ type: 'login-fail' }); return; }
    els.loginUser.value = '';
    els.loginPass.value = '';
    afterLogin(true);
  } catch (err) {
    console.error('[vs]', 'LOGIN_FAILED', err && err.message ? err.message : String(err), {});
    dispatch({ type: 'login-fail' });
  } finally {
    loginInFlight = false;
    els.loginSubmit.disabled = false;
  }
});

function afterLogin(store) {
  const policy = devicePolicy(navigator);
  const simd = probeSimd();
  dispatch({ type: store ? 'login-ok' : 'boot-session', policy, simd });
}

els.logout.addEventListener('click', (ev) => { ev.preventDefault(); dispatch({ type: 'logout' }); });

// ------------------------------------------------------------------------------------------------ caps + manifest (§7.1)
function readQuery() {
  const p = new URLSearchParams(location.search);
  const q = {};
  const b = p.get('backend');
  if (b === 'webgpu' || b === 'wasm') q.backend = b;
  const t = p.get('tier');
  if (t === 'standard' || t === 'hq') q.tier = t;
  const m = p.get('model');
  if (m && /^[A-Za-z0-9_-]+$/.test(m)) q.model = m;
  const mc = p.get('maxChunks');
  if (mc && /^\d{1,5}$/.test(mc) && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
    const n = Number(mc);
    if (n >= 1 && n <= 10000) q.maxChunks = n;
  }
  // ?sources=<csv of manifest source ids>: restricts and orders the download sources (test hook / manual pin); the
  // same-origin source is always kept as the final fallback
  const src = p.get('sources');
  if (src) {
    const ids = src.split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 32);
    if (ids.length) q.sources = ids;
  }
  return q;
}

async function fetchManifest() {
  try {
    const r = await fetch(new URL('models/manifest.json', baseUrl), { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return validateManifest(await r.json());
  } catch (e) {
    console.warn('[vs]', 'manifest unavailable', e && e.message ? e.message : String(e));
    return null;
  }
}

async function runCapsProbe() {
  query = readQuery();
  const manifest = await fetchManifest();
  caps = await probeCaps({ navigatorLike: navigator, query, manifest, policy: s.policy, crossOriginIsolated });
  vs.caps = caps;
  vs.isolated = caps.isolated;
  dispatch({ type: 'caps-ready', backend: caps.backend, threads: caps.threads, hq: caps.hq, manifest, query });
}

async function runManifestForStart() {
  const m = await fetchManifest();
  if (m) dispatch({ type: 'manifest-ready', manifest: m });
  else dispatch({ type: 'manifest-failed', detail: {} });
}

// ------------------------------------------------------------------------------------------------------- inputs (§10)
function acceptFile(file) {
  if (!file || BUSY_STATES.has(s.state) || s.state === 'locked' || s.state === 'unsupported') return;
  inputGen++;
  pendingBlob = file;
  inputSource = 'file';
  inputBase = stripExtension(file.name || 'audio') || 'audio';
  clockInput = now();
  dispatch({ type: 'file', name: file.name || 'audio' });
}

els.dropZone.addEventListener('click', () => { if (els.dropZone.getAttribute('aria-disabled') !== 'true') els.fileInput.click(); });
els.dropZone.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && els.dropZone.getAttribute('aria-disabled') !== 'true') { ev.preventDefault(); els.fileInput.click(); }
});
els.dropZone.addEventListener('dragover', (ev) => { ev.preventDefault(); els.dropZone.classList.add('over'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('over'));
els.dropZone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  els.dropZone.classList.remove('over');
  const f = ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files[0] : null;
  acceptFile(f);
});
els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files && els.fileInput.files[0];
  acceptFile(f);
  els.fileInput.value = '';
});

function displayNameFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter((x) => x.length > 0);
    let seg = segs.length ? segs[segs.length - 1] : u.hostname;
    try { seg = decodeURIComponent(seg); } catch { /* raw */ }
    return seg || u.hostname;
  } catch { return url; }
}

function acceptUrl(text) {
  if (BUSY_STATES.has(s.state) || s.state === 'locked' || s.state === 'unsupported') return;
  const c = classifyUrl(text);
  inputGen++;
  if (c.kind === 'invalid') { dispatch({ type: 'url-invalid', code: 'URL_INVALID', detail: {} }); return; }
  if (c.kind === 'platform') { dispatch({ type: 'url-invalid', code: 'URL_PLATFORM', detail: {} }); return; }
  inputSource = 'url';
  inputBase = baseNameFromUrl(c.url);
  clockInput = now();
  dispatch({ type: 'url', url: c.url, name: displayNameFromUrl(c.url) });
}

els.urlLoad.addEventListener('click', () => acceptUrl(els.urlInput.value));
els.urlInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); acceptUrl(els.urlInput.value); } });

async function runFetchUrl(url) {
  const gen = inputGen;
  urlAbort = new AbortController();
  const signal = urlAbort.signal;
  setProgressDesc({ kind: 'url', received: 0, total: null, clock: 'input' });
  const t0 = now();
  try {
    const r = await fetchAudioUrl(url, {
      fetch: globalThis.fetch.bind(globalThis),
      userSignal: signal,
      onProgress: (p) => { if (gen === inputGen) setProgressDesc({ kind: 'url', received: p.received, total: p.total, clock: 'input' }); },
    });
    if (gen !== inputGen) return;
    inputTimings = { urlFetchMs: now() - t0, urlAttempts: r.attempts };
    pendingBlob = r.blob;
    dispatch({ type: 'url-fetched' });
    await runDecode(gen);
  } catch (e) {
    if (gen !== inputGen) return;
    dispatch({ type: 'input-error', code: codeOf(e), detail: e && e.detail !== undefined ? e.detail : {}, message: e && e.message ? e.message : String(e) });
  } finally {
    if (gen === inputGen) urlAbort = null;
  }
}

async function runDecode(gen) {
  const blob = pendingBlob;
  if (!blob) return;
  setProgressDesc({ kind: 'decoding', clock: 'input' });
  try {
    const r = await decodeInput(blob, limits(), { source: inputSource });
    if (gen !== inputGen) return;
    decodedInput = r;
    pendingBlob = null;
    inputTimings = { ...inputTimings, probeMs: r.probe.probeMs, probeKind: r.probe.probeKind, decodeMs: r.decodeMs };
    dispatch({ type: 'decoded', duration: r.duration });
  } catch (e) {
    if (gen !== inputGen) return;
    pendingBlob = null;
    if (e && e.probe) inputTimings = { ...inputTimings, probeMs: e.probe.probeMs, probeKind: e.probe.probeKind, ...(e.probe.decodeMs !== undefined ? { decodeMs: e.probe.decodeMs } : {}) };
    dispatch({ type: 'input-error', code: codeOf(e), detail: e && e.detail !== undefined ? e.detail : {}, message: e && e.message ? e.message : String(e) });
  }
}

// ------------------------------------------------------------------------------------------------------- job (§7, §12)
els.modelSelect.addEventListener('change', () => {
  dispatch({ type: 'tier', tier: els.modelSelect.value });
  els.modelSelect.value = s.tier;
  els.denoise.disabled = s.tier === 'hq';
});
els.start.addEventListener('click', () => {
  if (!canStart(s)) return;
  clockJob = now();
  resetEstimates();
  dispatch({ type: 'start', denoise: els.denoise.checked });
});
els.cancel.addEventListener('click', () => dispatch({ type: 'cancel' }));

// ------------------------------------------------------------------------------------------ offline model import, R2b
// The user picks the original .onnx / .onnx.data file(s) or our part-NN.bin chunks — and (FIX-3 R4) the ONNX Runtime files
// of site/vendor/ort/ (ort-wasm-simd-threaded[.asyncify].wasm / .mjs); they are hashed chunk by chunk against the manifest
// and written to the same part store the worker reads, so the next 开始 needs no model or runtime download.
els.importButton.addEventListener('click', () => { if (!els.importButton.disabled) els.importInput.click(); });
els.importInput.addEventListener('change', async () => {
  const picked = Array.from(els.importInput.files ?? []);
  els.importInput.value = '';
  if (!picked.length || importInFlight || BUSY_STATES.has(s.state) || s.state === 'locked' || s.state === 'unsupported') return;
  importInFlight = true;
  els.importButton.disabled = true;
  const t0 = now();
  try {
    const manifest = s.manifest ?? await fetchManifest();
    if (!manifest) { dom.setImportLine(els, codeToCopy('MANIFEST')); return; }
    const store = createPartStore({ caches: typeof caches !== 'undefined' ? caches : null, indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : null, baseUrl, warn: (...a) => console.warn(...a) });
    if (!store) { dom.setImportLine(els, codeToCopy('INTERNAL')); return; }
    const files = picked.map((f) => ({ name: f.name, size: f.size, slice: async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()) }));
    const r = await importModelFiles(manifest, files, { store, subtle: crypto.subtle, onProgress: (p) => dom.setImportLine(els, P.importing(p.doneBytes, p.totalBytes)) });
    dom.setImportLine(els, importResult(r.imported, r.mismatched.length));
    inputTimings = { ...inputTimings, importMs: now() - t0, imported: r.imported.map((m) => ({ kind: m.kind, modelId: m.modelId ?? null, backend: m.backend ?? null, bytes: m.bytes, files: m.files.length })), importMismatched: r.mismatched.length };
    vs.imported = r;
  } catch (err) {
    console.error('[vs]', 'IMPORT', err && err.message ? err.message : String(err), {});
    dom.setImportLine(els, codeToCopy(codeOf(err)));
  } finally {
    importInFlight = false;
    els.importButton.disabled = BUSY_STATES.has(s.state);
  }
});

function spawnWorker() {
  terminateWorker();
  const w = new Worker('worker.mjs', { type: 'module' });
  workerInited = false;
  w.onmessage = (ev) => {
    if (worker !== w) return;                              // a terminated worker's late message
    const msg = ev.data;
    if (msg && msg.type === 'result') pendingResult = msg;
    dispatch({ type: 'worker', msg });
  };
  w.onerror = (ev) => {
    if (worker !== w) return;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const message = ev && ev.message ? ev.message : 'worker error';
    dispatch({ type: 'worker', msg: { type: 'error', ...(s.job ? { jobId: s.job.id } : {}), code: 'WORKER', message, detail: {} } });
  };
  worker = w;
}

function terminateWorker() {
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
  worker = null;
  workerInited = false;
}

async function runDispatch(job, copyMode) {
  const w = worker;
  if (!w) return;
  if (!workerInited) {
    const initMsg = { type: 'init', backend: job.backend, threads: job.threads, baseUrl, manifest: s.manifest, fellBack: job.fellBack === true };
    if (Array.isArray(s.query.sources)) initMsg.sourceIds = s.query.sources;
    w.postMessage(initMsg);
    workerInited = true;
  }
  w.postMessage({ type: 'load-model', modelId: job.modelId });
  vs.backend = { name: job.backend, threads: job.threads, tier: job.tier, modelId: job.modelId };
  let copies;
  try {
    if (copyMode === 'buffer' && decodedInput && decodedInput.buffer) {
      setProgressDesc({ kind: 'init', backend: job.backend, threads: job.threads, clock: 'job' });
      copies = copyInput(decodedInput.buffer);
      decodedInput.buffer = null;                          // free the AudioBuffer after copying channels (brief §8.1)
    } else {
      if (!decodedInput) throw new EngineError('INTERNAL', 'no input to dispatch');
      setProgressDesc({ kind: 'decoding', clock: 'job' });
      const t0 = now();
      const r = await decodeForDispatch(decodedInput, limits());
      copies = { left: r.left, right: r.right };
      jobTimings.dispatchDecodeMs = now() - t0;
    }
  } catch (e) {
    if (!s.job || s.job.id !== job.id || worker !== w) return;
    dispatch({ type: 'job-error', code: codeOf(e), detail: e && e.detail !== undefined ? e.detail : {}, message: e && e.message ? e.message : String(e) });
    return;
  }
  if (!s.job || s.job.id !== job.id || worker !== w || s.state !== 'loading-model') return;   // cancelled or replaced meanwhile
  setProgressDesc({ kind: 'init', backend: job.backend, threads: job.threads, clock: 'job' });
  const msg = { type: 'separate', jobId: job.id, tier: job.tier, modelId: job.modelId, left: copies.left, right: copies.right, denoise: job.denoise === true };
  if (Number.isInteger(job.maxChunks) && job.maxChunks > 0) msg.maxChunks = job.maxChunks;
  w.postMessage(msg, [copies.left.buffer, copies.right.buffer]);
}

// ---------------------------------------------------------------------------------------------------- outputs (§11)
function buildOutputs(timings) {
  const r = pendingResult;
  pendingResult = null;
  jobTimings = { ...jobTimings, ...timings };
  vs.backend = { name: timings.backend, threads: timings.threads, tier: timings.tier, modelId: timings.modelId };
  if (!r) return;
  stems = [r.vocals[0], r.vocals[1], r.instrumental[0], r.instrumental[1]];
  int16s = {};
  try {
    for (const stem of ['vocals', 'instrumental']) {
      const pair = stem === 'vocals' ? [stems[0], stems[1]] : [stems[2], stems[3]];
      const { blob, int16 } = buildWav(pair, 44100);
      wavBlobs[stem] = blob;
      int16s[stem] = int16;
      dom.setPlayer(els.audio[stem], urls.playerUrl(blob));
      dom.setDownload(els.dl[stem].wav, { enabled: true, filename: stemFileName(inputBase, stem, 'wav'), label: STATIC.dlWav });
    }
  } catch (e) {
    int16s = null;
    dispatch({ type: 'job-error', code: classifyAllocationFailure(e) ?? 'INTERNAL', detail: {}, message: e && e.message ? e.message : String(e) });
  }
}

function startMp3(parallel) {
  if (!int16s) return;
  const input = int16s;
  int16s = null;
  mp3Progress = { vocals: 0, instrumental: 0 };
  mp3Ctl = encodeMp3Stems(input, {
    parallel,
    onProgress: (stem, fraction) => dispatch({ type: 'mp3-progress', stem, fraction }),
    onDone: (stem, blob, ms) => {
      mp3Blobs[stem] = blob;
      jobTimings.encodeMs = { ...(jobTimings.encodeMs ?? {}), [stem]: ms };
      dispatch({ type: 'mp3-done', stem });
    },
    onError: (stem, why) => {
      console.error('[vs]', 'MP3', why ?? '', { stem });
      dispatch({ type: 'mp3-error', stem });
    },
    now,
  });
}

// DA-6: every download anchor creates its object URL at click time (revoked 60 s later); WAV anchors included.
urls.attachDownload(els.dlVocalsMp3, () => mp3Blobs.vocals);
urls.attachDownload(els.dlInstMp3, () => mp3Blobs.instrumental);
urls.attachDownload(els.dlVocalsWav, () => wavBlobs.vocals);
urls.attachDownload(els.dlInstWav, () => wavBlobs.instrumental);
dom.disableDownloads(els);

// ---------------------------------------------------------------------------------------------------------------- boot
render();
if (hasSession(localStorage)) afterLogin(false);
