// site/src/engine/model-loader.mjs — design §6.2 (validateManifest) and §6.3 (loadModelBytes), rewritten for FIX-2 R2/R3:
// resumable, persistent, multi-source download. Runtime-agnostic: fetchInto / store / subtle / baseUrl / warn / now / sleep
// are injected; no globals besides URL, Request, Response, AbortController, Uint8Array (browsers and Node 18+).
//
// Download model: a file is the manifest's chunk list (<= 19,000,000 B each, sha256 per chunk); every chunk is split into
// SEGMENT_BYTES (4 MiB) segments. Segments are fetched from the best probed source (Range request on the chunk URL or on the
// whole-file URL; sources without Range support are streamed one chunk per request) with up to CONCURRENCY in flight, and
// EVERY completed segment is persisted at once under `${modelId}:${sha256}:part-<n>` so a reset, a reload or a crash
// never costs more than one segment. A request error or a stall (no bytes for STALL_MS) keeps the bytes it delivered —
// the next Range request for the segment starts after them (resume per byte, not per segment) — and, when it delivered
// fewer than PROGRESS_BYTES new ones, retries after 1, 2, 4, 8, 16 s (the ladder is indexed by the segment's attempt count,
// 16 s from the fifth failure on); after two such failures on the same source the segment moves to the next-ranked
// source; when every source has failed twice the segment's failure counts are cleared and a new round starts, up to
// MAX_ROUNDS rounds; a failure that did deliver PROGRESS_BYTES restarts the segment's ladder (a flaky link is not a dead
// source) — every PROGRESS_STREAK-th consecutive one still counts against its source, so a source that always delivers a
// little and then stalls is left like a failing one; there is no total timeout. The bytes a failed request left in place
// are persisted too (a prefix under the segment's part key), so a terminal error or a reload resumes after them. A segment
// is terminal (MODEL_DOWNLOAD { bytesSaved, bytesTotal }) only when every source failed for it in every round. The source
// the new segments go to (the cursor) moves on after two failures and returns to the best source after
// CURSOR_RETRY_MS (doubling per demotion of that source); the in-flight count follows the link rate the probe measured,
// capped at CONCURRENCY × the best source's own rate. A whole-file source that stops honouring Range is excluded for the
// rest of the load (it cannot serve a chunk slot).
// Chunk sha256 is verified when a chunk is complete, the whole-file sha256 always; a mismatch discards the chunk's segments,
// marks every source that contributed bytes to the chunk as poisoned for it and re-fetches from the next source (one
// `cache: 'reload'` retry on the same origin first). The assembled file is stored under `${modelId}:${sha256}` and served
// from there on the next load; keys whose `${modelId}:${sha256}` prefix is not in the manifest are swept once per load.
//
// FIX-3 R1/R2: the ONNX Runtime files (per backend one Emscripten glue `.mjs` and one `.wasm`, vendored under
// site/vendor/ort/) are managed assets too: `manifest.runtime.<backend>` lists them with bytes / sha256 / sources exactly
// like a model, and loadRuntimeBytes() runs them through the same loader (one chunk per file at vendor/ort/<name>; keys
// `runtime:<name>:<sha256>`), so a 28.7 MB download that used to be one XHR inside ORT becomes resumable and multi-source.
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
// runtime files: { wasm: { name, bytes, sha256 }, glue: { name, bytes, sha256 } } per backend, served from vendor/ort/<name>
export const RUNTIME_DIR = 'vendor/ort/';
export const RUNTIME_FILE_KEYS = ['wasm', 'glue'];
const RUNTIME_EXT = { wasm: '.wasm', glue: '.mjs' };
// store key prefix of a runtime file: `runtime:<name>` (→ `runtime:<name>:<sha256>` / `…:part-<n>`)
export const runtimeFileId = (name) => `runtime:${name}`;

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
// whole → one https URL per file key in `wholeKeys` (['model'] / ['model', 'externalData'] for a model, ['wasm', 'glue']
// for a runtime).
function validateSources(sources, path, wholeKeys) {
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
      if (!isObj(s.urls)) fail(`${sp}.urls`, 'must be an object');
      for (const k of wholeKeys) if (!isHttpsUrl(s.urls[k])) fail(`${sp}.urls.${k}`, k === 'externalData' ? 'must be an https URL for a two-file model' : 'must be an https URL');
    }
  });
  const first = sources[0];
  if (first.id !== 'origin' || first.kind !== 'chunks' || first.base !== './') fail(`${path}[0]`, "must be the same-origin source { id: 'origin', kind: 'chunks', base: './' }");
}

// FIX-3 R1: manifest.runtime.<backend> = { wasm: { name, bytes, sha256 }, glue: { name, bytes, sha256 }, sources? } — the
// vendored onnxruntime-web files of that backend, served at vendor/ort/<name> (one chunk each; no chunk list in the manifest).
function validateRuntimeFile(file, path, key) {
  if (!isObj(file)) fail(path, 'must be an object');
  if (!nonEmptyStr(file.name) || !NAME_RE.test(file.name) || !file.name.endsWith(RUNTIME_EXT[key])) fail(`${path}.name`, `must match ^[A-Za-z0-9_.-]+$ and end with ${RUNTIME_EXT[key]}`);
  if (!isInt(file.bytes) || file.bytes <= 0) fail(`${path}.bytes`, 'must be a positive integer');
  if (typeof file.sha256 !== 'string' || !HEX64_RE.test(file.sha256)) fail(`${path}.sha256`, 'must be 64 lowercase hex chars');
}

function validateRuntime(runtime) {
  if (!isObj(runtime)) fail('runtime', 'must be an object');
  const backends = Object.keys(runtime);
  if (backends.length === 0) fail('runtime', 'must list at least one backend');
  for (const b of backends) {
    const rp = `runtime.${b}`;
    if (!BACKENDS.includes(b)) fail(rp, `backend must be one of ${BACKENDS.join(', ')}`);
    const rt = runtime[b];
    if (!isObj(rt)) fail(rp, 'must be an object');
    for (const k of RUNTIME_FILE_KEYS) validateRuntimeFile(rt[k], `${rp}.${k}`, k);
    if (rt.wasm.name === rt.glue.name) fail(`${rp}.glue.name`, 'must differ from the wasm file name');
    if (rt.sources !== undefined) validateSources(rt.sources, `${rp}.sources`, RUNTIME_FILE_KEYS);
  }
}

// the runtime files of `backend` in loader shape ([{ key, file }] with a one-chunk `chunks` list at vendor/ort/<name>), or
// null when the manifest has no runtime section for it (ORT then fetches its own files, the pre-FIX-3 behaviour)
export function runtimeFiles(manifest, backend) {
  const rt = manifest && isObj(manifest.runtime) ? manifest.runtime[backend] : undefined;
  if (!rt) return null;
  return RUNTIME_FILE_KEYS.map((key) => ({ key, file: { ...rt[key], chunks: [{ path: RUNTIME_DIR + rt[key].name, bytes: rt[key].bytes, sha256: rt[key].sha256 }] } }));
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
    if (m.sources !== undefined) validateSources(m.sources, `${mp}.sources`, m.files.externalData !== undefined ? ['model', 'externalData'] : ['model']);
    if (m.arch === 'mdx') validateMdxParams(m.params, `${mp}.params`);
    else validateMelroformerParams(m.params, `${mp}.params`);
  }
  if (json.runtime !== undefined) validateRuntime(json.runtime);
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
// a failed request that delivered at least this many new bytes counts as progress (the bytes stay, the segment resumes after
// them, its ladder restarts) rather than as a failed attempt — a link that resets every few MB still finishes a 209 MB model
export const PROGRESS_BYTES = 262144;
// every PROGRESS_STREAK-th consecutive progressed failure of a segment also counts as a failure of its source: a source that
// always delivers a little and then stalls (~300 KB per 21 s) would otherwise hold the segment — and the cursor — for ever
export const PROGRESS_STREAK = 3;
// a round = every usable source failed FAILURES_PER_SOURCE times for the same segment; the failure counts are then cleared
// and the segment is retried (waiting 16 s between attempts by then) until MAX_ROUNDS rounds are spent → MODEL_DOWNLOAD.
// One source: 6 attempts, waits 1 + 2 + 4 + 8 + 16 s; four sources: 24 attempts over ~5.5 min of waits.
export const FAILURES_PER_SOURCE = 2;
export const MAX_ROUNDS = 3;
// the cursor (the source new segments are fetched from) leaves a source after FAILURES_PER_SOURCE failures and comes back
// to the best usable source after CURSOR_RETRY_MS × 2^(demotions of the source it left − 1), at most 16×: two 503s on a
// 6 MB/s mirror must not send the rest of a 209 MB download to a 100 KB/s source
export const CURSOR_RETRY_MS = 60000;
export const CURSOR_RETRY_MAX_DOUBLINGS = 4;

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

// Store garbage collection: parts and assembled files whose `${modelId}:${sha256}` (or `runtime:<name>:<sha256>`) prefix
// names no file of the manifest (an abandoned download of a previous model version, a removed model, the runtime of an
// earlier onnxruntime-web) are deleted. Run once per load, after the migration.
export async function sweepStaleEntries(manifest, { store, warn = () => {} }) {
  const out = { deleted: [] };
  if (!store) return out;
  const live = new Set();
  for (const [modelId, model] of Object.entries(manifest.models)) {
    for (const file of [model.files.model, model.files.externalData].filter(Boolean)) live.add(fileKeyOf(modelId, file.sha256));
  }
  for (const backend of BACKENDS) for (const { file } of runtimeFiles(manifest, backend) ?? []) live.add(fileKeyOf(runtimeFileId(file.name), file.sha256));
  let keys;
  try { keys = await store.keys(''); } catch (e) { warn('[vs] store sweep: keys failed', e); return out; }
  for (const k of keys) {
    if (live.has(k.replace(PART_SUFFIX_RE, ''))) continue;
    try { await store.delete(k); out.deleted.push(k); } catch (e) { warn('[vs] store sweep: delete failed', k, e); }
  }
  return out;
}

export async function loadModelBytes(manifest, modelId, deps, onProgress) {
  const model = manifest.models[modelId];
  if (!model) throw new EngineError('INTERNAL', `loadModelBytes: unknown model ${modelId}`, { modelId });
  const files = [{ key: 'model', keyId: modelId, file: model.files.model }];
  if (model.files.externalData) files.push({ key: 'externalData', keyId: modelId, file: model.files.externalData });
  const { out, report } = await loadFiles({ files, sources: model, version: manifest.version, probeKey: 'model', allowRangelessWhole: false, codes: { download: 'MODEL_DOWNLOAD', hash: 'MODEL_HASH' }, who: 'loadModelBytes' }, deps, onProgress);
  const result = { bytes: out.model, report };
  if (model.files.externalData) result.externalData = { path: model.files.externalData.name, data: out.externalData };
  return result;
}

// FIX-3 R2: the ORT runtime of `backend` (its .wasm first — the probe runs on it — then the glue .mjs) through the same
// loader; keys `runtime:<name>:<sha256>`; terminal codes RUNTIME_DOWNLOAD / RUNTIME_HASH. Every runtime file is one chunk,
// so a whole-file source that cannot serve clean ranges still works, streamed once (allowRangelessWhole).
// → { wasm: Uint8Array, glue: Uint8Array, report }, or null when the manifest has no runtime for the backend.
export async function loadRuntimeBytes(manifest, backend, deps, onProgress) {
  const rf = runtimeFiles(manifest, backend);
  if (!rf) return null;
  const files = rf.map((f) => ({ ...f, keyId: runtimeFileId(f.file.name) }));
  const { out, report } = await loadFiles({ files, sources: manifest.runtime[backend], version: manifest.version, probeKey: 'wasm', allowRangelessWhole: true, codes: { download: 'RUNTIME_DOWNLOAD', hash: 'RUNTIME_HASH' }, who: 'loadRuntimeBytes' }, deps, onProgress);
  return { wasm: out.wasm, glue: out.glue, report };
}

// The loader proper, shared by models and the runtime. spec = { files: [{ key, keyId, file }], sources: <object with
// `.sources`>, version, probeKey, allowRangelessWhole, codes: { download, hash }, who }.
async function loadFiles(spec, deps, onProgress) {
  const { fetchInto, subtle, baseUrl } = deps;
  const warn = deps.warn ?? ((...a) => console.warn(...a));
  const who = spec.who ?? 'loadFiles';
  if (typeof fetchInto !== 'function') throw new EngineError('INTERNAL', `${who}: fetchInto missing`);
  if (!subtle || typeof subtle.digest !== 'function') throw new EngineError('INTERNAL', `${who}: subtle missing`);
  if (typeof baseUrl !== 'string' || !baseUrl.endsWith('/')) throw new EngineError('INTERNAL', `${who}: baseUrl must be a directory URL string`, { baseUrl });
  const store = deps.store ?? null;
  const now = deps.now ?? defaultNow;
  const sleep = deps.sleep ?? defaultSleep;
  const origin = deps.origin ?? new URL(baseUrl).origin;
  const limits = { segmentBytes: SEGMENT_BYTES, concurrency: CONCURRENCY, stallMs: STALL_MS, backoffMs: BACKOFF_MS, failuresPerSource: FAILURES_PER_SOURCE, rounds: MAX_ROUNDS, progressBytes: PROGRESS_BYTES, progressStreak: PROGRESS_STREAK, cursorRetryMs: CURSOR_RETRY_MS, probeTimeoutMs: undefined, probeBytes: undefined, ...(deps.limits ?? {}) };
  const progress = (evt) => { if (onProgress) onProgress(evt); };
  const CODES = spec.codes;
  const allowRangelessWhole = spec.allowRangelessWhole === true;

  const files = spec.files;
  const filesByKey = Object.fromEntries(files.map((f) => [f.key, f.file]));
  const chunkCount = files.reduce((a, f) => a + f.file.chunks.length, 0);
  const bytesTotal = files.reduce((a, f) => a + f.file.bytes, 0);
  const report = { sources: null, excluded: null, concurrency: null, linkKBps: null, concurrencyKBps: null, probeExtended: false, used: {}, restoredBytes: 0, downloadedBytes: 0, resumedBytes: 0, resumeResets: 0, failures: 0, progressedFailures: 0, streakFailures: 0, cursorReturns: 0, stalls: 0, hashMismatches: 0, poisoned: [], fromStore: [], storeName: store ? store.name : 'none' };
  const out = {};
  let bytesDoneBefore = 0;
  let bytesSavedBefore = 0;   // bytes of the previous files that are in the store (the terminal copy's 已保存)
  let chunksDoneBefore = 0;
  let ranked = null;          // probed once per load, shared by the two files of a Tier 2 model

  const storeGet = async (key) => { if (!store) return null; try { return await store.get(key); } catch (e) { warn('[vs] store get failed', e); return null; } };
  const storePut = async (key, bytes) => { if (!store) return false; try { return await store.put(key, bytes); } catch (e) { warn('[vs] store put failed', e); return false; } };
  const storeDelete = async (key) => { if (!store) return; try { await store.delete(key); } catch (e) { warn('[vs] store delete failed', e); } };
  const storeKeys = async (prefix) => { if (!store) return []; try { return await store.keys(prefix); } catch (e) { warn('[vs] store keys failed', e); return []; } };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const { key, keyId, file } = files[fileIndex];
    const fKey = fileKeyOf(keyId, file.sha256);
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
      const persisted = new Uint8Array(segs.length);      // 1 = stored whole under its part key
      const partial = new Uint32Array(segs.length);       // n → leading bytes of a not-yet-present segment already in `assembled` (an interrupted request; the next one resumes there)
      const persistedPartial = new Uint32Array(segs.length);   // n → length of the prefix stored under the part key (a failed request's bytes, kept across reloads)
      const segSources = segs.map(() => new Set());       // n → ids of the sources whose bytes fill the segment (empty = restored from the store)
      const chunkVerified = new Uint8Array(chunks.length);
      const segsOfChunk = chunks.map((_, ci) => segs.filter((s) => s.chunkIndex === ci));
      const inflight = new Map();                           // n → bytes received by the current request beyond partial[n] (progress line)
      let lastEmit = -Infinity;
      const presentBytes = () => { let b = 0; for (const s of segs) b += present[s.n] ? s.length : partial[s.n]; return b; };
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
      const discardChunk = async (ci) => {
        for (const s of segsOfChunk[ci]) {
          present[s.n] = 0; partial[s.n] = 0; segSources[s.n].clear();
          if (persisted[s.n] || persistedPartial[s.n]) { persisted[s.n] = 0; persistedPartial[s.n] = 0; await storeDelete(partKeyOf(keyId, file.sha256, s.n)); }
        }
        chunkVerified[ci] = 0;
      };
      // bytes in the store: whole parts plus the persisted prefixes of interrupted segments (what the next load resumes from)
      const savedBytes = () => { let b = bytesSavedBefore; for (const s of segs) b += persisted[s.n] ? s.length : persistedPartial[s.n]; return b; };

      // 2 — restore persisted parts (a shorter entry is the prefix a failed request left: the download resumes after it),
      // verify the chunks they complete
      const keys = await storeKeys(partPrefix);
      for (const k of keys) {
        const m = PART_SUFFIX_RE.exec(k);
        const n = m ? Number(m[1]) : NaN;
        if (!Number.isInteger(n) || n < 0 || n >= segs.length) { await storeDelete(k); continue; }
        const bytes = await storeGet(k);
        if (bytes && bytes.length === segs[n].length) { assembled.set(bytes, segs[n].fileOffset); present[n] = 1; persisted[n] = 1; }
        else if (bytes && bytes.length > 0 && bytes.length < segs[n].length) { assembled.set(bytes, segs[n].fileOffset); partial[n] = bytes.length; persistedPartial[n] = bytes.length; }
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
          const sources = resolveSources(spec.sources, baseUrl, { only: deps.sourceIds ?? null, version: spec.version });
          const probed = await probeSources(sources, filesByKey, { fetchInto, now, origin, timeoutMs: limits.probeTimeoutMs, probeBytes: limits.probeBytes, probeKey: spec.probeKey, allowRangelessWhole });
          ranked = probed.ranked;
          report.sources = ranked.map((s) => ({ id: s.id, kind: s.kind, ranges: s.ranges, ...s.probe }));
          report.excluded = probed.excluded;
          // in flight by the link rate (the sum of the measured probe rates — every source was competing in the probe), capped
          // at CONCURRENCY × the best source's own rate: every request goes to one source, and a reload loses what is in flight
          report.linkKBps = probed.linkKBps;
          report.probeExtended = probed.extended === true;
          const best = ranked.length && !ranked[0].probe.unmeasured ? ranked[0].probe.kBps : 0;
          report.concurrencyKBps = Math.min(probed.linkKBps, limits.concurrency * best);
          report.concurrency = concurrencyFor(report.concurrencyKBps, limits.concurrency);
        }
        const concurrency = report.concurrency ?? limits.concurrency;
        const segFailures = segs.map(() => new Map());      // n → (sourceId → failures in the current round)
        const attempts = new Uint32Array(segs.length);       // n → failed attempts without progress so far (indexes the backoff ladder)
        const streak = new Uint32Array(segs.length);         // n → consecutive progressed failures
        const rounds = new Uint8Array(segs.length);          // n → rounds spent (every usable source failed twice)
        const chunkPoison = chunks.map(() => new Set());     // sources whose bytes failed the chunk sha256
        const reloadNext = new Uint8Array(chunks.length);    // one cache:'reload' retry on the origin per chunk
        const globalFails = new Map();
        const demotions = new Map();                         // sourceId → times the cursor left it for failures
        let cursor = 0;
        let cursorRetryAt = null;                            // when set, the cursor returns to the best usable source at this time
        let terminal = null;
        const active = new Set();
        const busy = new Set();                              // segment indices a worker is processing right now (incl. the siblings a whole-chunk stream fills)
        const puts = new Set();
        const persist = (n) => {
          if (persisted[n] || !store) return;
          persisted[n] = 1;
          const s = segs[n];
          const p = storePut(partKeyOf(keyId, file.sha256, n), assembled.subarray(s.fileOffset, s.fileOffset + s.length)).then((ok) => { if (!ok) persisted[n] = 0; }).finally(() => puts.delete(p));
          puts.add(p);
        };
        // the prefix a failed request left in place goes to the store under the same part key (a complete part overwrites it
        // later), so a terminal error, a reload or a crash resumes after it; awaited, so the segment's next request — and its
        // complete part — come after this write
        const persistPartial = async (n) => {
          if (!store || present[n] || partial[n] <= persistedPartial[n]) return;
          const s = segs[n];
          const len = partial[n];
          if (await storePut(partKeyOf(keyId, file.sha256, n), assembled.subarray(s.fileOffset, s.fileOffset + len))) persistedPartial[n] = Math.max(persistedPartial[n], len);
        };
        const accept = (src, bytes) => { if (bytes > 0) { report.used[src.id] = (report.used[src.id] ?? 0) + bytes; report.downloadedBytes += bytes; } };
        const usable = () => ranked.filter((x) => !x.excluded);
        const firstUsable = () => ranked.findIndex((x) => !x.excluded);
        const advanceCursor = (demoted = false) => {
          const left = ranked[cursor];
          for (let i = 1; i <= ranked.length; i++) {
            const next = (cursor + i) % ranked.length;
            if (!ranked[next].excluded) { cursor = next; globalFails.set(ranked[cursor].id, 0); break; }
          }
          if (!demoted) return;
          // bounded demotion: the cursor comes back to the best usable source after 1, 2, 4, 8, 16, 16 … minutes
          const d = (demotions.get(left.id) ?? 0) + 1;
          demotions.set(left.id, d);
          cursorRetryAt = now() + limits.cursorRetryMs * 2 ** Math.min(d - 1, CURSOR_RETRY_MAX_DOUBLINGS);
        };
        const maybeReturnCursor = () => {
          if (cursorRetryAt === null || now() < cursorRetryAt) return;
          cursorRetryAt = null;
          const first = firstUsable();
          if (first < 0 || first === cursor) return;
          cursor = first;
          globalFails.clear();
          report.cursorReturns++;
        };
        // a source dropped for the rest of this load (a whole-file source that stopped honouring Range cannot fill a chunk slot)
        const excludeSource = (src, reason) => {
          if (src.excluded) return;
          src.excluded = reason;
          report.excluded = [...(report.excluded ?? []), { id: src.id, reason }];
          if (ranked[cursor] === src) advanceCursor(false);
        };
        const pickSource = (n) => {
          maybeReturnCursor();
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
        // one failure of `src` for segment n: the segment leaves the source after failuresPerSource of them, the cursor moves
        // on (demoted) when its source reaches that count and another source is usable
        const countAgainst = (src, n) => {
          const f = segFailures[n];
          f.set(src.id, (f.get(src.id) ?? 0) + 1);
          globalFails.set(src.id, (globalFails.get(src.id) ?? 0) + 1);
          if (ranked[cursor].id === src.id && globalFails.get(src.id) >= limits.failuresPerSource && usable().length > 1) advanceCursor(true);
        };
        // a failed request that still delivered >= progressBytes new bytes (kept in place, the next request resumes after
        // them) is a flaky link, not a dead source: the segment's ladder restarts and the cursor stays — except that every
        // progressStreak-th consecutive progressed failure also counts against the source (a source that always delivers a
        // little and then stalls must not hold the segment at its pace for ever); attempts without progress climb the
        // ladder and spend the rounds
        const noteFailure = (src, n, why, progressed) => {
          report.failures++;
          if (why === 'stall') report.stalls++;
          if (progressed) {
            report.progressedFailures++;
            attempts[n] = 0;
            streak[n]++;
            if (streak[n] % limits.progressStreak === 0) { report.streakFailures++; countAgainst(src, n); }
            return true;
          }
          streak[n] = 0;
          attempts[n]++;
          countAgainst(src, n);
          return false;
        };
        // a mismatched chunk poisons every source that contributed bytes to it (a range-less whole-chunk stream, range
        // siblings and the resumed tail of a segment may come from different sources); the origin gets one cache:'reload' retry first
        const poisonChunk = (ci, completing) => {
          const contributors = new Set();
          for (const s of segsOfChunk[ci]) for (const id of segSources[s.n]) contributors.add(id);
          contributors.add(completing.id);
          report.poisoned.push({ chunkIndex: chunksDoneBefore + ci, sources: [...contributors].sort() });
          for (const id of contributors) {
            if (id === 'origin' && !chunkPoison[ci].has('origin:reload')) { chunkPoison[ci].add('origin:reload'); reloadNext[ci] = 1; }
            else chunkPoison[ci].add(id);
          }
          return usable().every((x) => chunkPoison[ci].has(x.id));
        };

        // one request: a Range for segment n (range-capable source; it starts after the partial[n] bytes an interrupted
        // request left in place) or the whole chunk (range-less chunk source, filling every claimed segment; segments
        // completed by the stream are persisted while it runs). A failed request keeps the bytes it delivered: in range mode
        // they become the segment's resume point, in whole-chunk mode the longest prefix of each claimed segment stays.
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
          // FIX-3: never through the browser's HTTP cache. Chromium stitches a cached 206 together with a later answer for the
          // same URL, and when the server's representation differs (GitHub Pages: uncompressed Range answers, gzip whole
          // bodies) the stitched body is silently cut short (evidence/runtime_cache_quirk.json: 262,144 B of a 14.8 MB file
          // with status 200). The part store is the cache; the probe, the segments and the whole-chunk streams are no-store.
          const opts = { signal: controller.signal, origin, cache: 'no-store' };
          if (src.isOrigin && reloadNext[ci]) { opts.cache = 'reload'; reloadNext[ci] = 0; }
          let target;
          const skip = useRange ? partial[n] : 0;             // range mode: resume after the bytes already in place
          const expected = useRange ? s.length - skip : chunk.bytes;
          let lastGot = 0;                                     // bytes of this request, as last reported by fetchInto (all written)
          let compressed = false;                              // the answer carried Content-Encoding: its byte offsets are not the file's
          const claimedSegs = claimed.map((m) => segs[m]);
          if (useRange) {
            const start = (src.kind === 'whole' ? s.fileOffset : s.chunkOffset) + skip;
            opts.range = { start, end: start + expected - 1 };
            target = assembled.subarray(s.fileOffset + skip, s.fileOffset + s.length);
            // a 200 to the Range fills the slot with the start of the whole resource: those bytes are discarded below, so they
            // are never shown in flight (the progress line would dip when the slot is given up)
            let ignored = false;
            opts.onHeaders = (h) => { if (h.rangeIgnored) ignored = true; if (h.contentEncoding) compressed = true; };
            opts.onBytes = (got) => { armStall(); if (ignored) return; lastGot = Math.min(got, expected); inflight.set(n, lastGot); emit(false, src.id); };
          } else {
            target = chunkSlice(ci);
            opts.onBytes = (got) => {
              armStall();
              lastGot = Math.min(got, chunk.bytes);
              let inMissing = 0;
              for (const cs of claimedSegs) {
                const have = Math.max(0, Math.min(got - cs.chunkOffset, cs.length));
                // counted by presentBytes from here on; partial[] stays until the completion below counts the new bytes (length − prefix)
                if (have === cs.length) { if (!present[cs.n]) { present[cs.n] = 1; segSources[cs.n].add(src.id); persist(cs.n); } }
                else inMissing += Math.max(0, have - partial[cs.n]);                                                             // presentBytes counts the partial prefix already
              }
              inflight.set(n, inMissing);
              emit(false, src.id);
            };
          }
          armStall();
          let r = null;
          let failure = null;
          try { r = await fetchInto(url, target, opts); } catch (e) {
            failure = { ok: false, why: stalled ? 'stall' : (terminal ? 'cancelled' : 'error'), message: errMessage(e) };
          } finally { clearTimeout(stallTimer); active.delete(controller); }
          if (!failure && !r.ok) failure = { ok: false, why: 'status', message: `HTTP ${r.status}`, status: r.status, keep: false };
          if (useRange) {
            if (!failure && (r.rangeIgnored || r.status !== 206)) {
              src.ranges = false;
              // a whole-file URL cannot be streamed into a chunk slot: the source is out for the rest of the load
              if (src.kind === 'whole' && !allowRangelessWhole) excludeSource(src, `range ignored (status ${r.status})`);
              failure = { ok: false, why: 'range ignored', message: `status ${r.status}`, keep: false };      // the slot holds the start of the whole resource, not the range
            }
            if (!failure && r.received !== expected) failure = { ok: false, why: 'length', message: `received ${r.received} of ${expected}`, keep: r.received < expected };
            // the in-flight count is cleared only once the bytes are either marked present/partial or given up, so the progress line never dips
            const got = failure ? (failure.keep === false ? 0 : lastGot) : expected;
            inflight.delete(n);
            if (got > 0) segSources[n].add(src.id);
            accept(src, got);
            if (failure && got < expected) {
              if (got > 0) { partial[n] += got; report.resumedBytes += got; failure.progressed = got >= limits.progressBytes; }
              // FIX-3: a host that answers a Range on a compressed representation (the ORT glue .mjs on most mirrors, Pages
              // for .wasm) counts offsets in compressed bytes, so a resume point inside the segment is not usable there: the
              // next request asks for the segment from its start (a 416 says the same about the offset we asked for). The
              // bytes already in place are kept only until that request overwrites them; the line may step back by them.
              if ((compressed || failure.status === 416) && partial[n] > 0) { report.resumeResets++; partial[n] = 0; }
              return failure;
            }
            // every byte is in place (a complete answer, or a stream that broke only after its last byte)
            present[n] = 1;
            partial[n] = 0;
            persist(n);
          } else {
            if (!failure && r.received !== chunk.bytes) failure = { ok: false, why: 'length', message: `received ${r.received} of ${chunk.bytes}`, keep: r.received < chunk.bytes };
            const got = failure ? (failure.keep === false ? 0 : lastGot) : chunk.bytes;
            inflight.delete(n);
            let newBytes = 0;
            for (const cs of claimedSegs) {
              const have = Math.max(0, Math.min(got - cs.chunkOffset, cs.length));
              if (have === cs.length) { if (!present[cs.n]) { present[cs.n] = 1; segSources[cs.n].add(src.id); } newBytes += cs.length - partial[cs.n]; partial[cs.n] = 0; persist(cs.n); }
              else if (have > 0) { segSources[cs.n].add(src.id); if (have > partial[cs.n]) { newBytes += have - partial[cs.n]; partial[cs.n] = have; } }   // the longest prefix stays (both prefixes are the chunk's bytes; sha256 settles a liar)
            }
            accept(src, newBytes);
            if (failure && got < chunk.bytes) { failure.progressed = newBytes >= limits.progressBytes; return failure; }
          }
          emit(true, src.id);
          // chunk complete → sha256; a mismatch discards the chunk, poisons its contributors and moves it to the next source
          if (segsOfChunk[ci].every((x) => present[x.n]) && !chunkVerified[ci]) {
            if (!(await verifyChunk(ci))) {
              report.hashMismatches++;
              const everyPoisoned = poisonChunk(ci, src);
              await discardChunk(ci);
              if (everyPoisoned) {
                terminal = new EngineError(CODES.hash, `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch from every source`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key });
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
              // bytesSaved = what the store holds (whole parts + persisted prefixes); refreshed once every worker has stopped
              const detail = { bytesSaved: savedBytes(), bytesTotal, chunkIndex: chunksDoneBefore + ci, chunkCount, sources: ranked.map((x) => x.id), attempts: attempts[n], rounds: rounds[n] + 1 };
              terminal = live.length && live.every((x) => chunkPoison[ci].has(x.id))
                ? new EngineError(CODES.hash, `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch from every source`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key })
                : new EngineError(CODES.download, `${file.name}: segment ${n + 1}/${segs.length} failed on every source (${attempts[n]} attempts)`, detail);
              for (const c of active) c.abort();
              return;
            }
            const ci = segs[n].chunkIndex;
            const useRange = src.ranges;                    // the mode is fixed per request: a 200 mid-flight flips src.ranges for later requests only
            const claimed = useRange ? [n] : [n, ...takePendingOfChunk(ci)];
            // the siblings a whole-chunk stream fills are busy for its lifetime (another worker failing on the chunk must not re-queue them)
            for (const m of claimed) busy.add(m);
            let r;
            try { r = await fetchUnit(src, n, claimed, useRange); } finally { for (const m of claimed) if (m !== n) busy.delete(m); }
            if (r.ok) return;
            // the bytes the failed request left in place (this segment's, and the claimed siblings' prefixes in whole-chunk
            // mode) go to the store before anything else happens to the chunk — a terminal error or a reload resumes after them
            for (const s of segsOfChunk[ci]) if (s.n === n || !busy.has(s.n)) await persistPartial(s.n);
            // give back every segment of the chunk that is neither present nor queued (claimed siblings of a failed
            // whole-chunk request, segments discarded by a sha256 mismatch); n itself is retried by this loop
            for (const s of segsOfChunk[ci]) if (s.n !== n && !present[s.n] && !busy.has(s.n) && !pending.includes(s.n)) pending.unshift(s.n);
            if (terminal || r.why === 'cancelled') return;
            if (r.why === 'hash') continue;                  // the next source is picked without a wait
            const progressed = noteFailure(src, n, r.why, r.progressed === true);
            warn('[vs] download retry', file.name, 'segment', n, src.id, r.why, r.message ?? '', progressed ? `resumes at ${partial[n]}` : `attempt ${attempts[n]}`);
            if (progressed) { await sleep(limits.backoffMs[0]); continue; }   // the link delivered: same source, first rung, resume
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
        if (terminal) {
          if (terminal.detail && 'bytesSaved' in terminal.detail) terminal.detail.bytesSaved = savedBytes();   // incl. the prefixes the aborted requests persisted
          throw terminal;
        }
        for (let ci = 0; ci < chunks.length; ci++) if (!chunkVerified[ci]) {
          if (!(await verifyChunk(ci))) throw new EngineError(CODES.hash, `${file.name}: chunk ${ci + 1}/${chunks.length} sha256 mismatch`, { chunkIndex: chunksDoneBefore + ci, chunkCount, file: key });
        }
      }

      // 4 — whole-file verify, store the assembled file, drop its parts
      progress({ stage: 'verify' });
      const stored = (s) => persisted[s.n] || persistedPartial[s.n];
      if (await sha256Hex(subtle, assembled) !== file.sha256) {
        for (const s of segs) if (stored(s)) await storeDelete(partKeyOf(keyId, file.sha256, s.n));
        throw new EngineError(CODES.hash, `${file.name}: whole-file sha256 mismatch`, { chunkIndex: -1, chunkCount, file: key });
      }
      if (await storePut(fKey, assembled)) {
        for (const s of segs) if (stored(s)) await storeDelete(partKeyOf(keyId, file.sha256, s.n));
        bytesSavedBefore += file.bytes;
      } else bytesSavedBefore = savedBytes();
    } else bytesSavedBefore += file.bytes;

    out[key] = assembled;
    bytesDoneBefore += file.bytes;
    chunksDoneBefore += file.chunks.length;
  }

  // 5
  return { out, report };
}
