// site/src/engine/model-loader.mjs — design §6.2 (validateManifest) and §6.3 (loadModelBytes).
// Runtime-agnostic: fetchInto / cache / subtle / baseUrl / warn are injected; no globals besides URL, Request,
// Response, AbortController, Uint8Array (available in browsers and Node 18+).
import { EngineError } from './errors.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^[A-Za-z0-9._-]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const CHUNK_PATH_RE = /^models\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_.-]+\.bin$/;
const BACKENDS = ['webgpu', 'wasm'];
const ARCHES = ['mdx', 'melroformer'];

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
    if (typeof c.sha256 !== 'string' || !HEX64_RE.test(c.sha256)) fail(`${cp}.sha256`, 'must be 64 lowercase hex chars');
    sum += c.bytes;
  });
  if (sum !== file.bytes) fail(`${path}.bytes`, `must equal the sum of chunk bytes (${sum})`);
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
// §6.3 loader

function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

async function sha256Hex(subtle, bytes) {
  return hexOf(await subtle.digest('SHA-256', bytes));
}

const POOL = 6;

export async function loadModelBytes(manifest, modelId, deps, onProgress) {
  const { fetchInto, subtle, baseUrl } = deps;
  const warn = deps.warn ?? ((...a) => console.warn(...a));
  if (typeof fetchInto !== 'function') throw new EngineError('INTERNAL', 'loadModelBytes: fetchInto missing');
  if (!subtle || typeof subtle.digest !== 'function') throw new EngineError('INTERNAL', 'loadModelBytes: subtle missing');
  if (typeof baseUrl !== 'string' || !baseUrl.endsWith('/')) throw new EngineError('INTERNAL', 'loadModelBytes: baseUrl must be a directory URL string', { baseUrl });
  const model = manifest.models[modelId];
  if (!model) throw new EngineError('INTERNAL', `loadModelBytes: unknown model ${modelId}`, { modelId });
  const progress = (evt) => { if (onProgress) onProgress(evt); };

  // step 1 — cache handle; any rejection → warn once → cache = null
  let cache = null;
  let warned = false;
  const degrade = (err) => { if (!warned) { warned = true; warn('[vs] cache unavailable', err); } cache = null; };
  const caches = deps.cache ?? null;
  if (caches) {
    try {
      const name = 'vs-models-' + manifest.version;
      cache = await caches.open(name);
      const keys = await caches.keys();
      for (const k of keys) {
        if (k.startsWith('vs-models-') && k !== name) {
          try { await caches.delete(k); } catch (e) { warn('[vs] cache delete failed', e); }
        }
      }
    } catch (e) { degrade(e); }
  }

  const files = [{ key: 'model', file: model.files.model }];
  if (model.files.externalData) files.push({ key: 'externalData', file: model.files.externalData });
  const chunkCount = files.reduce((a, f) => a + f.file.chunks.length, 0);
  const bytesTotal = files.reduce((a, f) => a + f.file.bytes, 0);
  let chunkBase = 0;         // global chunk index offset of the current file
  let bytesDoneBefore = 0;   // bytes of files already finished
  let chunksDoneBefore = 0;
  const out = {};

  for (const { key, file } of files) {
    const cacheKey = new Request(new URL('models/' + modelId + '/' + file.name, baseUrl));
    let assembled = null;

    // step 2 — cache hit
    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const buf = new Uint8Array(await hit.arrayBuffer());
          progress({ stage: 'verify' });
          if (buf.length === file.bytes && await sha256Hex(subtle, buf) === file.sha256) assembled = buf;
          else { try { await cache.delete(cacheKey); } catch (e) { degrade(e); } }
        }
      } catch (e) { degrade(e); }
    }

    // step 3 — download
    if (!assembled) {
      assembled = new Uint8Array(file.bytes);
      const chunks = file.chunks;
      const perChunk = new Array(chunks.length).fill(0);
      let chunksDone = 0;
      let lastEmit = -Infinity;
      const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
      const emit = (force) => {
        const t = nowMs();
        if (!force && t - lastEmit < 100) return;
        lastEmit = t;
        const done = bytesDoneBefore + perChunk.reduce((a, b) => a + b, 0);
        progress({ stage: 'download', bytesDone: Math.min(done, bytesTotal), bytesTotal, chunksDone: chunksDoneBefore + chunksDone, chunkCount });
      };
      emit(true);
      const controller = new AbortController();
      let firstError = null;
      const offsets = [];
      let off = 0;
      for (const c of chunks) { offsets.push(off); off += c.bytes; }

      const fetchOne = async (i, cacheMode) => {
        const c = chunks[i];
        const slot = assembled.subarray(offsets[i], offsets[i] + c.bytes);
        const url = new URL(c.path + '?v=' + encodeURIComponent(manifest.version), baseUrl);
        const opts = { signal: controller.signal, onBytes: (n) => { perChunk[i] = Math.min(n, c.bytes); emit(false); } };
        if (cacheMode) opts.cache = cacheMode;
        let r;
        try { r = await fetchInto(url, slot, opts); } catch (e) {
          if (controller.signal.aborted && firstError) throw e;   // a consequence, not a cause
          throw new EngineError('MODEL_DOWNLOAD', `chunk ${chunkBase + i + 1}/${chunkCount}: ${e && e.message ? e.message : e}`, { chunkIndex: chunkBase + i, chunkCount, status: 0 });
        }
        if (!r.ok) throw new EngineError('MODEL_DOWNLOAD', `chunk ${chunkBase + i + 1}/${chunkCount}: HTTP ${r.status}`, { chunkIndex: chunkBase + i, chunkCount, status: r.status });
        let okLen = r.received === c.bytes;
        if (okLen && r.contentEncoding === null && r.contentLength !== null && r.contentLength !== c.bytes) okLen = false;
        if (!okLen) return false;
        if (await sha256Hex(subtle, slot) !== c.sha256) return false;
        perChunk[i] = c.bytes;
        return true;
      };

      const worker = async (i) => {
        if (firstError) return;
        let ok = await fetchOne(i, undefined);
        if (!ok) {
          perChunk[i] = 0;
          ok = await fetchOne(i, 'reload');     // one retry defeating a corrupted intermediary copy
          if (!ok) throw new EngineError('MODEL_HASH', `chunk ${chunkBase + i + 1}/${chunkCount}: length/sha256 mismatch after retry`, { chunkIndex: chunkBase + i, chunkCount, file: key });
        }
        chunksDone++;
        emit(true);
      };

      let next = 0;
      const runPool = async () => {
        while (next < chunks.length) {
          const i = next++;
          if (firstError) return;
          try { await worker(i); } catch (e) {
            if (!firstError) { firstError = e; controller.abort(); }
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(POOL, chunks.length) }, () => runPool()));
      if (firstError) throw firstError;

      // step 4 — whole-file verify + cache put
      progress({ stage: 'verify' });
      if (await sha256Hex(subtle, assembled) !== file.sha256) {
        throw new EngineError('MODEL_HASH', `${file.name}: whole-file sha256 mismatch`, { chunkIndex: -1, chunkCount, file: key });
      }
      if (cache) {
        try {
          await cache.put(cacheKey, new Response(assembled, { headers: { 'Content-Length': String(file.bytes), 'Content-Type': 'application/octet-stream' } }));
        } catch (e) { warn('[vs] cache put failed', e); }
      }
    }

    out[key] = assembled;
    chunkBase += file.chunks.length;
    bytesDoneBefore += file.bytes;
    chunksDoneBefore += file.chunks.length;
  }

  // step 5
  const result = { bytes: out.model };
  if (model.files.externalData) result.externalData = { path: model.files.externalData.name, data: out.externalData };
  return result;
}
