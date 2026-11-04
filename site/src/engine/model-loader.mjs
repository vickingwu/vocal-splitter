// site/src/engine/model-loader.mjs — design §6.2 (validateManifest) and §6.3 (loadModelBytes), rewritten for FIX-2 R2/R3:
// resumable, persistent, multi-source download. Runtime-agnostic: fetchInto / store / subtle / baseUrl / warn / now / sleep
// are injected; no globals besides URL, Request, Response, AbortController, Uint8Array (browsers and Node 18+).
//
// Download model: a file is the manifest's chunk list (<= 19,000,000 B each, sha256 per chunk); every chunk is split into
// SEGMENT_BYTES (4 MiB) segments. Segments are fetched from the best probed source (Range request on the chunk URL or on the
// whole-file URL; sources without Range support are streamed one chunk per request) with up to CONCURRENCY in flight, and
// EVERY completed segment is persisted at once under `${modelId}:${sha256}:part-<n>` so a reset, a reload or a crash
// never costs more than one segment. A request error or a stall (no bytes for STALL_MS) retries the same segment after
// 1, 2, 4, 8, 16 s (the ladder is indexed by the segment's attempt count, 16 s from the fifth failure on); after two
// failures on the same source the segment moves to the next-ranked source; when every source has failed twice the
// segment's failure counts are cleared and a new round starts, up to MAX_ROUNDS rounds; there is no total timeout. A
// segment is terminal (MODEL_DOWNLOAD { bytesSaved, bytesTotal }) only when every source failed for it in every round.
// A whole-file source that stops honouring Range is excluded for the rest of the load (it cannot serve a chunk slot).
// Chunk sha256 is verified when a chunk is complete, the whole-file sha256 always; a mismatch discards the chunk's segments,
// marks every source that contributed bytes to the chunk as poisoned for it and re-fetches from the next source (one
// `cache: 'reload'` retry on the same origin first). The assembled file is stored under `${modelId}:${sha256}` and served
// from there on the next load; keys whose `${modelId}:${sha256}` prefix is not in the manifest are swept once per load.
import { EngineError } from './errors.mjs';
import { resolveSources, probeSources } from './sources.mjs';
import { fileKey as fileKeyOf, partKey as partKeyOf, PART_SUFFIX_RE } from './part-store.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^[A-Za-z0-9._-]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const CHUNK_PATH_RE = /^models\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_.-]+\.bin$/;
const BACKENDS = ['webgpu', 'wasm'];
const ARCHES = ['mdx', 'melroformer'];
const SOURCE_KINDS = ['chunks', 'whole'];
export const MAX_CHUNK_BYTES = 19_000_000;

function fail(path, msg) { throw new EngineError('MANIFEST', `${path}: ${msg}`, { path }); }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

function primeFactorsIn235(n) {
  let r = n;
  for (const p of [2, 3, 5]) while (r % p === 0) r /= p;
  return r === 1;
}

function validateFile(file, path) {
  if (!isObj(file)) fail(path, 'must be an object');
  if (!nonEmptyStr(file.name) || !NAME_RE.test(file.name)) fail(`${path}.name`, 'must match ^[A-Za-z0-9_.-]+$');
  if (!isInt(file.bytes) || file.bytes <= 0) fail(`${path}.bytes`, 'must be a positive integer');
  if (typeof file.sha256 !== 'string' || !HEX64_RE.test(file.sha256)) fail(`${path}.sha256`, 'must be 64 lowercase hex chars');
  if (!Array.isArray(file.chunks) || file.chunks.length === 0) fail(`${path}.chunks`, 'must be a non-empty array');
  let sum = 0;
  file.chunks.forEach((c, i) => {
    const cp = `${path}.chunks[${i}]`;
    if (!isObj(c)) fail(cp, 'must be an object');
    if (typeof c.path !== 'string' || !CHUNK_PATH_RE.test(c.path)) fail(`${cp}.path`, 'must match ^models/<id>/<name>.bin$');
    if (c.path.split('/').includes('..')) fail(`${cp}.path`, 'must be relative');
    if (!isInt(c.bytes) || c.bytes <= 0) fail(`${cp}.bytes`, 'must be a positive integer');
    if (c.bytes > MAX_CHUNK_BYTES) fail(`${cp}.bytes`, `must be <= ${MAX_CHUNK_BYTES} (jsDelivr mirror limit)`);
    if (typeof c.sha256 !== 'string' || !HEX64_RE.test(c.sha256)) fail(`${cp}.sha256`, 'must be 64 lowercase hex chars');
    sum += c.bytes;
  });
  if (sum !== file.bytes) fail(`${path}.bytes`, `must equal the sum of chunk bytes (${sum})`);
}

const isHttpsUrl = (v) => { if (typeof v !== 'string') return false; try { const u = new URL(v); return u.protocol === 'https:' && u.hash === ''; } catch { return false; } };

// §6.2 + FIX-2 R1: sources[0] is the same-origin chunk directory; ids unique; chunks → base './' or an https directory URL;
// whole → urls.model (+ urls.externalData for a two-file model), https.
function validateSources(sources, path, hasExternalData) {
  if (!Array.isArray(sources) || sources.length === 0) fail(path, 'must be a non-empty array');
  const ids = new Set();
  sources.forEach((s, i) => {
    const sp = `${path}[${i}]`;
    if (!isObj(s)) fail(sp, 'must be an object');
    if (!nonEmptyStr(s.id) || !ID_RE.test(s.id)) fail(`${sp}.id`, 'must match ^[A-Za-z0-9_-]+$');
    if (ids.has(s.id)) fail(`${sp}.id`, `duplicate source id ${s.id}`);
    ids.add(s.id);
    if (!SOURCE_KINDS.includes(s.kind)) fail(`${sp}.kind`, `must be one of ${SOURCE_KINDS.join(', ')}`);
    if (!nonEmptyStr(s.label)) fail(`${sp}.label`, 'must be a non-empty string');
    if (s.kind === 'chunks') {
      if (s.base !== './' && !(isHttpsUrl(s.base) && s.base.endsWith('/') && !s.base.includes('?'))) fail(`${sp}.base`, "must be './' or an https directory URL ending with '/'");
    } else {
      if (!isObj(s.urls) || !isHttpsUrl(s.urls.model)) fail(`${sp}.urls.model`, 'must be an https URL');
      if (hasExternalData && !isHttpsUrl(s.urls.externalData)) fail(`${sp}.urls.externalData`, 'must be an https URL for a two-file model');
    }
  });
  const first = sources[0];
  if (first.id !== 'origin' || first.kind !== 'chunks' || first.base !== './') fail(`${path}[0]`, "must be the same-origin source { id: 'origin', kind: 'chunks', base: './' }");
}

function validateMdxParams(p, path) {
  if (!isObj(p)) fail(path, 'must be an object');
  for (const k of ['sampleRate', 'nFft', 'hop', 'dimF', 'dimT', 'segmentSize', 'zeroLowBins', 'overlap', 'compensate', 'inputPeak', 'outputPeak']) {
    if (!isNum(p[k])) fail(`${path}.${k}`, 'must be a finite number');
  }
  if (p.sampleRate !== 44100) fail(`${path}.sampleRate`, 'must be 44100');
  if (!isInt(p.nFft) || p.nFft % 2 !== 0 || p.nFft < 1024 || p.nFft > 16384 || !primeFactorsIn235(p.nFft)) fail(`${path}.nFft`, 'must be an even integer in [1024, 16384] with prime factors in {2, 3, 5}');
  if (!isInt(p.hop) || p.hop < 64 || p.hop > p.nFft) fail(`${path}.hop`, 'must be an integer in [64, nFft]');
  if (!isInt(p.dimF) || p.dimF < 1 || p.dimF > p.nFft / 2 + 1) fail(`${path}.dimF`, 'must be an integer in [1, nFft/2 + 1]');
  if (!isInt(p.dimT) || p.dimT < 16 || p.dimT > 4096) fail(`${path}.dimT`, 'must be an integer in [16, 4096]');
  if (p.segmentSize !== p.dimT) fail(`${path}.segmentSize`, 'must equal dimT');
  if (!isInt(p.zeroLowBins) || p.zeroLowBins < 0 || p.zeroLowBins > p.dimF) fail(`${path}.zeroLowBins`, 'must be an integer in [0, dimF]');
  if (!(p.overlap > 0 && p.overlap < 0.95)) fail(`${path}.overlap`, 'must be in (0, 0.95)');
  if (!(p.compensate >= 0.5 && p.compensate <= 2)) fail(`${path}.compensate`, 'must be in [0.5, 2]');
  if (!(p.inputPeak > 0 && p.inputPeak <= 1)) fail(`${path}.inputPeak`, 'must be in (0, 1]');
  if (!(p.outputPeak > 0 && p.outputPeak <= 1)) fail(`${path}.outputPeak`, 'must be in (0, 1]');
  if (p.primaryStem !== 'vocals') fail(`${path}.primaryStem`, "must be 'vocals'");
  const chunkSize = p.hop * (p.dimT - 1);
  const step = Math.trunc((1 - p.overlap) * chunkSize);
  if (step < 1) fail(`${path}.overlap`, 'derived step must be >= 1');
}

function validateMelroformerParams(p, path) {
  if (!isObj(p)) fail(path, 'must be an object');
  for (const k of ['sampleRate', 'nFft', 'hop', 'frames', 'chunkSamples', 'stepSamples', 'minStorageBuffersPerShaderStage', 'inputPeak', 'outputPeak']) {
    if (!isNum(p[k])) fail(`${path}.${k}`, 'must be a finite number');
  }
  if (p.sampleRate !== 44100) fail(`${path}.sampleRate`, 'must be 44100');
  if (!isInt(p.nFft) || p.nFft % 2 !== 0 || p.nFft < 256 || p.nFft > 8192) fail(`${path}.nFft`, 'must be an even integer in [256, 8192]');
  if (!isInt(p.hop) || p.hop < 64 || p.hop > p.nFft) fail(`${path}.hop`, 'must be an integer in [64, nFft]');
  if (!isInt(p.frames) || p.frames < 16 || p.frames > 8192) fail(`${path}.frames`, 'must be an integer in [16, 8192]');
  if (p.chunkSamples !== p.hop * (p.frames - 1)) fail(`${path}.chunkSamples`, 'must equal hop·(frames − 1)');
  if (!isInt(p.stepSamples) || p.stepSamples < 1 || p.stepSamples > p.chunkSamples) fail(`${path}.stepSamples`, 'must be an integer in [1, chunkSamples]');
  if (!isInt(p.minStorageBuffersPerShaderStage) || p.minStorageBuffersPerShaderStage < 1 || p.minStorageBuffersPerShaderStage > 64) fail(`${path}.minStorageBuffersPerShaderStage`, 'must be an integer in [1, 64]');
  if (p.weight !== 'hamming54') fail(`${path}.weight`, "must be 'hamming54'");
  if (!nonEmptyStr(p.inputName)) fail(`${path}.inputName`, 'must be a non-empty string');
  if (!nonEmptyStr(p.outputName)) fail(`${path}.outputName`, 'must be a non-empty string');
  if (!Array.isArray(p.requiredFeatures) || !p.requiredFeatures.every((f) => typeof f === 'string')) fail(`${path}.requiredFeatures`, 'must be an array of strings');
  if (!(p.inputPeak > 0 && p.inputPeak <= 1)) fail(`${path}.inputPeak`, 'must be in (0, 1]');
  if (!(p.outputPeak > 0 && p.outputPeak <= 1)) fail(`${path}.outputPeak`, 'must be in (0, 1]');
}

export function validateManifest(json) {
  if (!isObj(json)) fail('', 'manifest must be an object');
  if (json.schema !== 1) fail('schema', 'must be 1');
  if (!nonEmptyStr(json.version) || json.version.length > 64 || !VERSION_RE.test(json.version)) fail('version', 'must be a non-empty string <= 64 chars matching ^[A-Za-z0-9._-]+$');
  if (json.tag !== undefined && (!nonEmptyStr(json.tag) || json.tag.length > 80 || !VERSION_RE.test(json.tag))) fail('tag', 'must be a non-empty string <= 80 chars matching ^[A-Za-z0-9._-]+$');
  if (!isObj(json.models)) fail('models', 'must be an object');
  const ids = Object.keys(json.models);
  if (ids.length === 0) fail('models', 'must have at least one model');
  for (const id of ids) {
    const mp = `models.${id}`;
    if (!ID_RE.test(id)) fail(mp, 'model id must match ^[A-Za-z0-9_-]+$');
    const m = json.models[id];
    if (!isObj(m)) fail(mp, 'must be an object');
    if (!nonEmptyStr(m.displayName)) fail(`${mp}.displayName`, 'must be a non-empty string');
    if (!ARCHES.includes(m.arch)) fail(`${mp}.arch`, `must be one of ${ARCHES.join(', ')}`);
    if (!Array.isArray(m.backends) || m.backends.length === 0 || !m.backends.every((b) => BACKENDS.includes(b)) || new Set(m.backends).size !== m.backends.length) {
      fail(`${mp}.backends`, 'must be a non-empty subset of {webgpu, wasm}');
    }
    if (!isObj(m.files)) fail(`${mp}.files`, 'must be an object');
    if (!isObj(m.files.model)) fail(`${mp}.files.model`, 'is required');
    validateFile(m.files.model, `${mp}.files.model`);
    if (m.files.externalData !== undefined) validateFile(m.files.externalData, `${mp}.files.externalData`);
    for (const fk of ['model', 'externalData']) {
      const f = m.files[fk];
      if (!f) continue;
      f.chunks.forEach((c, i) => {
        const dir = CHUNK_PATH_RE.exec(c.path)[1];
        if (dir !== id) fail(`${mp}.files.${fk}.chunks[${i}].path`, `directory must equal the model id (${id})`);
      });
    }
    if (m.sources !== undefined) validateSources(m.sources, `${mp}.sources`, m.files.externalData !== undefined);
    if (m.arch === 'mdx') validateMdxParams(m.params, `${mp}.params`);
    else validateMelroformerParams(m.params, `${mp}.params`);
  }
  if (!isObj(json.tiers)) fail('tiers', 'must be an object');
  if (!isObj(json.tiers.standard)) fail('tiers.standard', 'is required');
  const keyBackend = { webgpu: 'webgpu', wasm: 'wasm', wasmLow: 'wasm' };
  const checkTierKey = (tier, key, required) => {
    const path = `tiers.${tier}.${key}`;
    const v = json.tiers[tier][key];
    if (v === undefined) { if (required) fail(path, 'is required'); return; }
    if (typeof v !== 'string' || !json.models[v]) fail(path, 'must name an existing model id');
    if (!json.models[v].backends.includes(keyBackend[key])) fail(path, `model ${v} does not support backend ${keyBackend[key]}`);
  };
  for (const k of ['webgpu', 'wasm', 'wasmLow']) checkTierKey('standard', k, true);
  const low = json.models[json.tiers.standard.wasmLow];
  if (low.arch !== 'mdx') fail('tiers.standard.wasmLow', "must name an 'mdx' model");
  if (low.params.dimF > 2048) fail('tiers.standard.wasmLow', 'must name a model with dimF <= 2048');
  for (const tier of Object.keys(json.tiers)) {
    if (tier === 'standard') continue;
    if (!isObj(json.tiers[tier])) fail(`tiers.${tier}`, 'must be an object');
    checkTierKey(tier, 'webgpu', true);
    checkTierKey(tier, 'wasm', false);
    checkTierKey(tier, 'wasmLow', false);
  }
  return json;
}


// ---------------------------------------------------------------------------------------------------------------
// §6.3 loader (FIX-2 R2/R3)

function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

async function sha256Hex(subtle, bytes) {
  return hexOf(await subtle.digest('SHA-256', bytes));
}

export const SEGMENT_BYTES = 4 * 1024 * 1024;
export const CONCURRENCY = 4;
// in-flight requests by the probed speed of the best source: a slow link gains nothing from parallel ranges and would lose
// up to 4 partial segments on a reset/reload, so it runs one segment at a time (loss <= one 4 MiB segment)
export const CONCURRENCY_KBPS = Object.freeze([512, 2048]);   // < 512 KB/s → 1, < 2048 KB/s → 2, otherwise CONCURRENCY
export function concurrencyFor(kBps, max = CONCURRENCY) {
  if (!(kBps > 0)) return 1;
  if (kBps < CONCURRENCY_KBPS[0]) return 1;
  if (kBps < CONCURRENCY_KBPS[1]) return Math.min(2, max);
  return max;
}
export const STALL_MS = 20000;
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
// a round = every usable source failed FAILURES_PER_SOURCE times for the same segment; the failure counts are then cleared
// and the segment is retried (waiting 16 s between attempts by then) until MAX_ROUNDS rounds are spent → MODEL_DOWNLOAD.
// One source: 6 attempts, waits 1 + 2 + 4 + 8 + 16 s; four sources: 24 attempts over ~5.5 min of waits.
export const FAILURES_PER_SOURCE = 2;
export const MAX_ROUNDS = 3;

// a file's chunks split into <= segmentBytes segments: [{ n, chunkIndex, fileOffset, chunkOffset, length }]
export function planSegments(file, segmentBytes = SEGMENT_BYTES) {
  const segs = [];
  let fileOff = 0;
  file.chunks.forEach((c, chunkIndex) => {
    for (let o = 0; o < c.bytes; o += segmentBytes) {
      const length = Math.min(segmentBytes, c.bytes - o);
      segs.push({ n: segs.length, chunkIndex, fileOffset: fileOff + o, chunkOffset: o, length });
    }
    fileOff += c.bytes;
  });
  return segs;
}

const defaultNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMessage = (e) => (e && e.message ? e.message : String(e));

// R3 migration: entries of the old per-version caches (`vs-models-<version>`, key = models/<id>/<file name>) that still
// hash to the manifest are re-stored under `${modelId}:${sha256}` in `store`; every old cache is deleted afterwards.
export async function migrateLegacyCache(manifest, { caches, store, subtle, baseUrl, warn = () => {} }) {
  const out = { migrated: [], deleted: [] };
  if (!caches || typeof caches.keys !== 'function') return out;
  let names;
  try { names = (await caches.keys()).filter((k) => k.startsWith('vs-models-')); } catch (e) { warn('[vs] legacy cache keys failed', e); return out; }
  for (const name of names) {
    try {
      const cache = await caches.open(name);
      if (store) {
        for (const [modelId, model] of Object.entries(manifest.models)) {
          for (const file of [model.files.model, model.files.externalData].filter(Boolean)) {
            const hit = await cache.match(new Request(new URL('models/' + modelId + '/' + file.name, baseUrl)));
            if (!hit) continue;
            const buf = new Uint8Array(await hit.arrayBuffer());
            if (buf.length === file.bytes && await sha256Hex(subtle, buf) === file.sha256) {
              const fKey = fileKeyOf(modelId, file.sha256);
              // existence by key listing: `get` would load a second copy of a file this size
              if (!(await store.keys(fKey)).includes(fKey)) await store.put(fKey, buf);
              out.migrated.push({ modelId, file: file.name, bytes: buf.length });
            }
          }
        }
      }
      await caches.delete(name);
      out.deleted.push(name);
    } catch (e) { warn('[vs] legacy cache migration failed', name, e); }
  }
  return out;
}

// Store garbage collection: parts and assembled files whose `${modelId}:${sha256}` prefix names no file of the manifest (an
// abandoned download of a previous model version, a removed model) are deleted. Run once per load, after the migration.
export async function sweepStaleEntries(manifest, { store, warn = () => {} }) {
  const out = { deleted: [] };
  if (!store) return out;
  const live = new Set();
  for (const [modelId, model] of Object.entries(manifest.models)) {
    for (const file of [model.files.model, model.files.externalData].filter(Boolean)) live.add(fileKeyOf(modelId, file.sha256));
  }
  let keys;
  try { keys = await store.keys(''); } catch (e) { warn('[vs] store sweep: keys failed', e); return out; }
  for (const k of keys) {
    if (live.has(k.replace(PART_SUFFIX_RE, ''))) continue;
    try { await store.delete(k); out.deleted.push(k); } catch (e) { warn('[vs] store sweep: delete failed', k, e); }
  }
  return out;
}

export async function loadModelBytes(manifest, modelId, deps, onProgress) {
  const { fetchInto, subtle, baseUrl } = deps;
  const warn = deps.warn ?? ((...a) => console.warn(...a));
  if (typeof fetchInto !== 'function') throw new EngineError('INTERNAL', 'loadModelBytes: fetchInto missing');
  if (!subtle || typeof subtle.digest !== 'function') throw new EngineError('INTERNAL', 'loadModelBytes: subtle missing');
  if (typeof baseUrl !== 'string' || !baseUrl.endsWith('/')) throw new EngineError('INTERNAL', 'loadModelBytes: baseUrl must be a directory URL string', { baseUrl });
  const model = manifest.models[modelId];
  if (!model) throw new EngineError('INTERNAL', `loadModelBytes: unknown model ${modelId}`, { modelId });
  const store = deps.store ?? null;
  const now = deps.now ?? defaultNow;
  const sleep = deps.sleep ?? defaultSleep;
  const origin = deps.origin ?? new URL(baseUrl).origin;
  const limits = { segmentBytes: SEGMENT_BYTES, concurrency: CONCURRENCY, stallMs: STALL_MS, backoffMs: BACKOFF_MS, failuresPerSource: FAILURES_PER_SOURCE, rounds: MAX_ROUNDS, probeTimeoutMs: undefined, probeBytes: undefined, ...(deps.limits ?? {}) };
  const progress = (evt) => { if (onProgress) onProgress(evt); };

  const files = [{ key: 'model', file: model.files.model }];
  if (model.files.externalData) files.push({ key: 'externalData', file: model.files.externalData });
  const chunkCount = files.reduce((a, f) => a + f.file.chunks.length, 0);
  const bytesTotal = files.reduce((a, f) => a + f.file.bytes, 0);
  const report = { sources: null, excluded: null, concurrency: null, used: {}, restoredBytes: 0, downloadedBytes: 0, failures: 0, stalls: 0, hashMismatches: 0, poisoned: [], fromStore: [], storeName: store ? store.name : 'none' };
  const out = {};
  let bytesDoneBefore = 0;
  let chunksDoneBefore = 0;
  let ranked = null;          // probed once per load, shared by the two files of a Tier 2 model

  const storeGet = async (key) => { if (!store) return null; try { return await store.get(key); } catch (e) { warn('[vs] store get failed', e); return null; } };
  const storePut = async (key, bytes) => { if (!store) return false; try { return await store.put(key, bytes); } catch (e) { warn('[vs] store put failed', e); return false; } };
  const storeDelete = async (key) => { if (!store) return; try { await store.delete(key); } catch (e) { warn('[vs] store delete failed', e); } };
  const storeKeys = async (prefix) => { if (!store) return []; try { return await store.keys(prefix); } catch (e) { warn('[vs] store keys failed', e); return []; } };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const { key, file } = files[fileIndex];
    const fKey = fileKeyOf(modelId, file.sha256);
    const partPrefix = fKey + ':part-';
    let assembled = null;

    // 1 — the assembled file is already stored
    const whole = await storeGet(fKey);
    if (whole) {
      progress({ stage: 'verify' });
      if (whole.length === file.bytes && await sha256Hex(subtle, whole) === file.sha256) { assembled = whole; report.fromStore.push(file.name); }
      else await storeDelete(fKey);
    }

    if (!assembled) {
      assembled = new Uint8Array(file.bytes);
      const chunks = file.chunks;
      const chunkOffsets = [];
      for (let off = 0, i = 0; i < chunks.length; i++) { chunkOffsets.push(off); off += chunks[i].bytes; }
      const segs = planSegments(file, limits.segmentBytes);
      const present = new Uint8Array(segs.length);        // 1 = bytes in `assembled`
      const persisted = new Uint8Array(segs.length);      // 1 = stored under its part key
      const chunkVerified = new Uint8Array(chunks.length);
      const segsOfChunk = chunks.map((_, ci) => segs.filter((s) => s.chunkIndex === ci));
      const inflight = new Map();                           // n → bytes received so far for the progress line
      let lastEmit = -Infinity;
      const presentBytes = () => { let b = 0; for (const s of segs) if (present[s.n]) b += s.length; return b; };
      const emit = (force, sourceId) => {
        const t = now();
        if (!force && t - lastEmit < 100) return;
        lastEmit = t;
        let done = presentBytes();
        for (const v of inflight.values()) done += v;
        let chunksDone = 0;
        for (let i = 0; i < chunks.length; i++) if (chunkVerified[i]) chunksDone++;
        progress({ stage: 'download', bytesDone: Math.min(bytesDoneBefore + done, bytesTotal), bytesTotal, chunksDone: chunksDoneBefore + chunksDone, chunkCount, fileIndex, fileCount: files.length, ...(sourceId ? { sourceId } : {}) });
      };
      const chunkSlice = (ci) => assembled.subarray(chunkOffsets[ci], chunkOffsets[ci] + chunks[ci].bytes);
      const verifyChunk = async (ci) => {
        if (await sha256Hex(subtle, chunkSlice(ci)) === chunks[ci].sha256) { chunkVerified[ci] = 1; return true; }
        return false;
      };
      const segSource = segs.map(() => null);              // n → id of the source whose bytes fill the segment (null = restored from the store)
      const discardChunk = async (ci) => {
        for (const s of segsOfChunk[ci]) { present[s.n] = 0; segSource[s.n] = null; if (persisted[s.n]) { persisted[s.n] = 0; await storeDelete(partKeyOf(modelId, file.sha256, s.n)); } }
        chunkVerified[ci] = 0;
      };

      // 2 — restore persisted parts, verify the chunks they complete
      const keys = await storeKeys(partPrefix);
      for (const k of keys) {
        const m = PART_SUFFIX_RE.exec(k);
        const n = m ? Number(m[1]) : NaN;
        if (!Number.isInteger(n) || n < 0 || n >= segs.length) { await storeDelete(k); continue; }
        const bytes = await storeGet(k);
        if (bytes && bytes.length === segs[n].length) { assembled.set(bytes, segs[n].fileOffset); present[n] = 1; persisted[n] = 1; }
        else await storeDelete(k);
      }
      for (let ci = 0; ci < chunks.length; ci++) {
        if (segsOfChunk[ci].every((s) => present[s.n])) { if (!(await verifyChunk(ci))) { report.hashMismatches++; await discardChunk(ci); } }
      }
      report.restoredBytes += presentBytes();
      emit(true);

      // 3 — download what is missing
      const pending = segs.filter((s) => !present[s.n]).map((s) => s.n);
      if (pending.length) {
        if (!ranked) {
          const sources = resolveSources(model, baseUrl, { only: deps.sourceIds ?? null, version: manifest.version });
          const probed = await probeSources(sources, model.files, { fetchInto, now, origin, timeoutMs: limits.probeTimeoutMs, probeBytes: limits.probeBytes });
          ranked = probed.ranked;
          report.sources = ranked.map((s) => ({ id: s.id, kind: s.kind, ranges: s.ranges, ...s.probe }));
          report.excluded = probed.excluded;
          report.concurrency = concurrencyFor(ranked[0] && ranked[0].probe ? ranked[0].probe.kBps : 0, limits.concurrency);
        }
        const concurrency = report.concurrency ?? limits.concurrency;
        const segFailures = segs.map(() => new Map());      // n → (sourceId → failures in the current round)
        const attempts = new Uint32Array(segs.length);       // n → failed attempts so far (indexes the backoff ladder)
        const rounds = new Uint8Array(segs.length);          // n → rounds spent (every usable source failed twice)
        const chunkPoison = chunks.map(() => new Set());     // sources whose bytes failed the chunk sha256
        const reloadNext = new Uint8Array(chunks.length);    // one cache:'reload' retry on the origin per chunk
        const globalFails = new Map();
        let cursor = 0;
        let terminal = null;
        const active = new Set();
        const busy = new Set();                              // segment indices a worker is processing right now
        const puts = new Set();
        const persist = (n) => {
          if (persisted[n] || !store) return;
          persisted[n] = 1;
          const s = segs[n];
          const p = storePut(partKeyOf(modelId, file.sha256, n), assembled.subarray(s.fileOffset, s.fileOffset + s.length)).then((ok) => { if (!ok) persisted[n] = 0; }).finally(() => puts.delete(p));
          puts.add(p);
        };
        const usable = () => ranked.filter((x) => !x.excluded);
        const advanceCursor = () => {
          for (let i = 1; i <= ranked.length; i++) {
            const next = (cursor + i) % ranked.length;
            if (!ranked[next].excluded) { cursor = next; globalFails.set(ranked[cursor].id, 0); return; }
          }
        };
        // a source dropped for the rest of this load (a whole-file source that stopped honouring Range cannot fill a chunk slot)
        const excludeSource = (src, reason) => {
          if (src.excluded) return;
          src.excluded = reason;
          report.excluded = [...(report.excluded ?? []), { id: src.id, reason }];
          if (ranked[cursor] === src) advanceCursor();
        };
        const pickSource = (n) => {
          const f = segFailures[n];
          const ci = segs[n].chunkIndex;
          for (let i = 0; i < ranked.length; i++) {
            const src = ranked[(cursor + i) % ranked.length];
            if (src.excluded) continue;
            if ((f.get(src.id) ?? 0) >= limits.failuresPerSource) continue;
            if (chunkPoison[ci].has(src.id)) continue;
            return src;
          }
          return null;
        };
        const noteFailure = (src, n, why) => {
          report.failures++;
          if (why === 'stall') report.stalls++;
          const f = segFailures[n];
          f.set(src.id, (f.get(src.id) ?? 0) + 1);
          attempts[n]++;
          globalFails.set(src.id, (globalFails.get(src.id) ?? 0) + 1);
          if (ranked[cursor].id === src.id && globalFails.get(src.id) >= limits.failuresPerSource && usable().length > 1) advanceCursor();
        };
        // a mismatched chunk poisons every source that contributed bytes to it (a range-less whole-chunk stream and range
        // siblings may write the same chunk from different sources); the origin gets one cache:'reload' retry first
        const poisonChunk = (ci, completing) => {
          const contributors = new Set(segsOfChunk[ci].map((s) => segSource[s.n]).filter(Boolean));
          contributors.add(completing.id);
          report.poisoned.push({ chunkIndex: chunksDoneBefore + ci, sources: [...contributors].sort() });
          for (const id of contributors) {
            if (id === 'origin' && !chunkPoison[ci].has('origin:reload')) { chunkPoison[ci].add('origin:reload'); reloadNext[ci] = 1; }
            else chunkPoison[ci].add(id);
          }
          return usable().every((x) => chunkPoison[ci].has(x.id));
        };

        // one request: a Range for segment n (range-capable source) or the whole chunk (range-less chunk source, filling
        // every claimed segment; segments completed by the stream are persisted while it runs)
        const fetchUnit = async (src, n, claimed, useRange) => {
          const s = segs[n];
          const ci = s.chunkIndex;
          const chunk = chunks[ci];
          const url = src.urlFor(key, file, chunk);
          if (!url) return { ok: false, why: 'no url' };
          const controller = new AbortController();
          active.add(controller);
          let stallTimer = null;
          let stalled = false;
          const armStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalled = true; controller.abort(); }, limits.stallMs); };
          const opts = { signal: controller.signal, origin };
          if (src.isOrigin && reloadNext[ci]) { opts.cache = 'reload'; reloadNext[ci] = 0; }
          let target;
          if (useRange) {
            const start = src.kind === 'whole' ? s.fileOffset : s.chunkOffset;
            opts.range = { start, end: start + s.length - 1 };
            target = assembled.subarray(s.fileOffset, s.fileOffset + s.length);
            opts.onBytes = (got) => { armStall(); inflight.set(n, Math.min(got, s.length)); emit(false, src.id); };
          } else {
            target = chunkSlice(ci);
            const claimedSegs = claimed.map((m) => segs[m]);
            opts.onBytes = (got) => {
              armStall();
              let inMissing = 0;
              for (const cs of claimedSegs) {
                const have = Math.max(0, Math.min(got - cs.chunkOffset, cs.length));
                if (have === cs.length) { if (!present[cs.n]) { present[cs.n] = 1; segSource[cs.n] = src.id; persist(cs.n); } }   // counted by presentBytes from here on
                else inMissing += have;
              }
              inflight.set(n, inMissing);
              emit(false, src.id);
            };
          }
          armStall();
          let r;
          // the in-flight count is cleared only once the bytes are either marked present or given up, so the progress line never dips
          const give = (ret) => { inflight.delete(n); return ret; };
          try { r = await fetchInto(url, target, opts); } catch (e) {
            return give({ ok: false, why: stalled ? 'stall' : (terminal ? 'cancelled' : 'error'), message: errMessage(e) });
          } finally { clearTimeout(stallTimer); active.delete(controller); }
          if (!r.ok) return give({ ok: false, why: 'status', message: `HTTP ${r.status}`, status: r.status });
          if (useRange) {
            if (r.rangeIgnored || r.status !== 206) {
              src.ranges = false;
              // a whole-file URL cannot be streamed into a chunk slot: the source is out for the rest of the load
              if (src.kind === 'whole') excludeSource(src, `range ignored (status ${r.status})`);
              return give({ ok: false, why: 'range ignored', message: `status ${r.status}` });
            }
            if (r.received !== s.length) return give({ ok: false, why: 'length', message: `received ${r.received} of ${s.length}` });
            present[n] = 1;
            segSource[n] = src.id;
            inflight.delete(n);
            persist(n);
            report.used[src.id] = (report.used[src.id] ?? 0) + s.length;
            report.downloadedBytes += s.length;
          } else {
            if (r.received !== chunk.bytes) return give({ ok: false, why: 'length', message: `received ${r.received} of ${chunk.bytes}` });
            for (const m of claimed) { if (!present[m]) { present[m] = 1; segSource[m] = src.id; } persist(m); report.used[src.id] = (report.used[src.id] ?? 0) + segs[m].length; report.downloadedBytes += segs[m].length; }
            inflight.delete(n);
          }
          emit(true, src.id);
          // chunk complete → sha256; a mismatch discards the chunk, poisons its contributors and moves it to the next source
          if (segsOfChunk[ci].every((x) => present[x.n]) && !chunkVerified[ci]) {
            if (!(await verifyChunk(ci))) {
              report.hashMismatches++;
              const everyPoisoned = poisonChunk(ci, src);
              await discardChunk(ci);
              if (everyPoisoned) {
                terminal = new EngineError('MODEL_HASH', `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch from every source`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key });
                for (const c of active) c.abort();
                return { ok: false, why: 'cancelled', message: `chunk ${ci + 1} sha256 mismatch from every source` };
              }
              return { ok: false, why: 'hash', message: `chunk ${ci + 1} sha256 mismatch` };
            }
            emit(true, src.id);
          }
          return { ok: true };
        };

        const takePendingOfChunk = (ci) => {
          const taken = [];
          for (let i = pending.length - 1; i >= 0; i--) if (segs[pending[i]].chunkIndex === ci) taken.push(...pending.splice(i, 1));
          return taken;
        };

        const processSegment = async (n) => {
          busy.add(n);
          try { await processSegmentInner(n); } finally { busy.delete(n); }
        };
        // the next source for segment n; when every usable source failed twice in this round, a new round (failure counts
        // cleared) while rounds remain; null = terminal
        const nextSource = (n) => {
          const src = pickSource(n);
          if (src || rounds[n] + 1 >= limits.rounds) return src;
          rounds[n]++;
          segFailures[n].clear();
          return pickSource(n);
        };
        const processSegmentInner = async (n) => {
          for (;;) {
            if (terminal) return;
            if (present[n]) return;                          // filled by a whole-chunk request of a sibling
            const src = nextSource(n);
            if (!src) {
              const ci = segs[n].chunkIndex;
              const live = usable();
              const saved = bytesDoneBefore + presentBytes();
              const detail = { bytesSaved: saved, bytesTotal, chunkIndex: chunksDoneBefore + ci, chunkCount, sources: ranked.map((x) => x.id), attempts: attempts[n], rounds: rounds[n] + 1 };
              terminal = live.length && live.every((x) => chunkPoison[ci].has(x.id))
                ? new EngineError('MODEL_HASH', `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch from every source`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key })
                : new EngineError('MODEL_DOWNLOAD', `${file.name}: segment ${n + 1}/${segs.length} failed on every source (${attempts[n]} attempts)`, detail);
              for (const c of active) c.abort();
              return;
            }
            const ci = segs[n].chunkIndex;
            const useRange = src.ranges;                    // the mode is fixed per request: a 200 mid-flight flips src.ranges for later requests only
            const claimed = useRange ? [n] : [n, ...takePendingOfChunk(ci)];
            const r = await fetchUnit(src, n, claimed, useRange);
            if (r.ok) return;
            // give back every segment of the chunk that is neither present nor queued (claimed siblings of a failed
            // whole-chunk request, segments discarded by a sha256 mismatch); n itself is retried by this loop
            for (const s of segsOfChunk[ci]) if (s.n !== n && !present[s.n] && !busy.has(s.n) && !pending.includes(s.n)) pending.unshift(s.n);
            if (terminal || r.why === 'cancelled') return;
            if (r.why === 'hash') continue;                  // the next source is picked without a wait
            noteFailure(src, n, r.why);
            warn('[vs] download retry', file.name, 'segment', n, src.id, r.why, r.message ?? '', `attempt ${attempts[n]}`);
            if (!pickSource(n) && rounds[n] + 1 >= limits.rounds) continue;   // nothing left to try: terminal at the loop head, no wait
            await sleep(limits.backoffMs[Math.min(attempts[n] - 1, limits.backoffMs.length - 1)]);
          }
        };
        const worker = async () => {
          while (!terminal) {
            const n = pending.shift();
            if (n === undefined) return;
            await processSegment(n);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
        await Promise.allSettled([...puts]);
        if (terminal) throw terminal;
        for (let ci = 0; ci < chunks.length; ci++) if (!chunkVerified[ci]) {
          if (!(await verifyChunk(ci))) throw new EngineError('MODEL_HASH', `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key });
        }
      }

      // 4 — whole-file verify, store the assembled file, drop its parts
      progress({ stage: 'verify' });
      if (await sha256Hex(subtle, assembled) !== file.sha256) {
        for (const s of segs) if (persisted[s.n]) await storeDelete(partKeyOf(modelId, file.sha256, s.n));
        throw new EngineError('MODEL_HASH', `${file.name}: whole-file sha256 mismatch`, { chunkIndex: -1, chunkCount, file: key });
      }
      if (await storePut(fKey, assembled)) { for (const s of segs) if (persisted[s.n]) await storeDelete(partKeyOf(modelId, file.sha256, s.n)); }
    }

    out[key] = assembled;
    bytesDoneBefore += file.bytes;
    chunksDoneBefore += file.chunks.length;
  }

  // 5
  const result = { bytes: out.model, report };
  if (model.files.externalData) result.externalData = { path: model.files.externalData.name, data: out.externalData };
  return result;
}
