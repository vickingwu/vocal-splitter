// tests/lib/fakes.mjs — shared fakes with the §5 return shapes (model-loader, handler, url-input, copy tests).
import { createHash } from 'node:crypto';

export function sha256Hex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

// Deterministic chunk bytes: `sizes` = byte counts; returns Uint8Array[]
export function makeChunkBytes(sizes, seed = 1) {
  return sizes.map((size, idx) => {
    const b = new Uint8Array(size);
    let s = (seed * 2654435761 + idx * 40503) >>> 0;
    for (let i = 0; i < size; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = s >>> 24; }
    return b;
  });
}

export function concatBytes(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Builds a manifest for one mdx model whose `model` file (and optional `externalData`) consists of the given chunk arrays.
export function makeManifest({ modelId = 'fake_model', version = 'test-1', modelChunks, externalChunks = null, params, sources = undefined } = {}) {
  const file = (name, prefix, chunks) => {
    const all = concatBytes(chunks);
    return {
      name, bytes: all.length, sha256: sha256Hex(all),
      chunks: chunks.map((c, i) => ({ path: `models/${modelId}/${prefix}.part-${String(i).padStart(2, '0')}.bin`, bytes: c.length, sha256: sha256Hex(c) })),
    };
  };
  const files = { model: file('fake.onnx', 'core', modelChunks) };
  if (externalChunks) files.externalData = file('fake.onnx.data', 'data', externalChunks);
  return {
    schema: 1, version,
    tiers: { standard: { webgpu: modelId, wasm: modelId, wasmLow: modelId } },
    models: {
      [modelId]: {
        displayName: '测试', tier: 1, arch: 'mdx', backends: ['webgpu', 'wasm'], license: 'MIT', source: 'https://example.invalid/x.onnx',
        files, ...(sources ? { sources } : {}), uvrHash: '0'.repeat(32),
        params: params ?? { sampleRate: 44100, nFft: 6144, hop: 1024, dimF: 2048, dimT: 256, segmentSize: 256, overlap: 0.25, compensate: 1.035, primaryStem: 'vocals', zeroLowBins: 3, inputPeak: 0.9, outputPeak: 0.9 },
      },
    },
  };
}

// FIX-3: a manifest `runtime` section for both backends (the real file names, fake bytes) + what a fetchInto fake must serve.
// → { section, bytes: { webgpu: { wasm, glue }, wasm: { wasm, glue } }, serve: { 'vendor/ort/<name>': Uint8Array } }
export const RUNTIME_NAMES = Object.freeze({
  webgpu: { wasm: 'ort-wasm-simd-threaded.asyncify.wasm', glue: 'ort-wasm-simd-threaded.asyncify.mjs' },
  wasm: { wasm: 'ort-wasm-simd-threaded.wasm', glue: 'ort-wasm-simd-threaded.mjs' },
});
export function makeRuntime({ wasmSize = 3000, glueSize = 300, seed = 5, sources = undefined } = {}) {
  const section = {}, bytes = {}, serve = {};
  let k = 0;
  for (const backend of ['webgpu', 'wasm']) {
    const [w, g] = makeChunkBytes([wasmSize, glueSize], seed + k++);
    const names = RUNTIME_NAMES[backend];
    section[backend] = {
      wasm: { name: names.wasm, bytes: w.length, sha256: sha256Hex(w) },
      glue: { name: names.glue, bytes: g.length, sha256: sha256Hex(g) },
      ...(sources ? { sources: typeof sources === 'function' ? sources(backend, names) : sources } : {}),
    };
    bytes[backend] = { wasm: w, glue: g };
    serve[`vendor/ort/${names.wasm}`] = w;
    serve[`vendor/ort/${names.glue}`] = g;
  }
  return { section, bytes, serve };
}

// In-memory fetchInto with the §5 return shape (FIX-2: Range requests). `serve` maps a pathname (same-origin chunk path, or
// `<host>/<path>` for an absolute URL of another origin) → bytes. `overrides(pathname, attempt, opts, call)` may return
// { bytes } | { status } | { reject: Error } | { overflow: true } | { short: n } | { contentLength, contentEncoding } |
// { delayMs } (between the two body halves) | { firstByteDelayMs } (before the headers) | { hang: true } (never resolves
// until the signal aborts) | { noRange: true } (200 to a Range request) | { resetAfterHalf: true } (half the body, then a
// network error) | null.
// options.ranges false → the host ignores Range for every path (200, whole body).
export function makeFetchIntoFake(serve, overrides = () => null, { ranges = true } = {}) {
  const calls = [];
  const attempts = new Map();
  const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
  const fake = async function fetchInto(url, target, opts = {}) {
    const u = url instanceof URL ? url : new URL(String(url));
    const sameOrigin = u.origin === 'http://localhost';
    const pathname = sameOrigin ? u.pathname.replace(/^\//, '') : u.host + u.pathname;
    const attempt = (attempts.get(pathname) ?? 0) + 1;
    attempts.set(pathname, attempt);
    const call = { url: u.href, pathname, query: u.search, attempt, cache: opts.cache, signal: opts.signal, aborted: !!opts.signal?.aborted, targetLength: target.length, range: opts.range ? { ...opts.range } : null, origin: opts.origin };
    calls.push(call);
    if (opts.signal?.aborted) throw abortError();
    const ov = overrides(pathname, attempt, opts, call) || {};
    if (ov.hang) { await new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true })); }
    // time to first byte (headers and body both wait); an abort during the wait rejects like a cancelled fetch
    if (ov.firstByteDelayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ov.firstByteDelayMs);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
      });
    }
    if (ov.reject) throw ov.reject;
    if (ov.status !== undefined && (ov.status < 200 || ov.status >= 300)) return { ok: false, status: ov.status, contentLength: null, contentEncoding: null, contentRange: null, received: 0, rangeIgnored: false };
    let bytes = ov.bytes ?? serve[pathname];
    if (!bytes) return { ok: false, status: 404, contentLength: null, contentEncoding: null, contentRange: null, received: 0, rangeIgnored: false };
    const total = bytes.length;
    const out = { ok: true, status: 200, contentLength: ov.contentLength !== undefined ? ov.contentLength : bytes.length, contentEncoding: ov.contentEncoding ?? null, contentRange: null, received: 0, rangeIgnored: false };
    const honourRange = opts.range && ranges && !ov.noRange;
    if (opts.range && !honourRange) {
      // the host ignored the range: the browser adapter reads up to target.length of the whole body, then cancels
      out.rangeIgnored = true;
      bytes = bytes.subarray(0, Math.min(bytes.length, target.length));
    } else if (honourRange) {
      const start = opts.range.start, end = Math.min(opts.range.end, total - 1);
      if (start > end || start >= total) return { ok: false, status: 416, contentLength: null, contentEncoding: null, contentRange: `bytes */${total}`, received: 0, rangeIgnored: false };
      bytes = bytes.subarray(start, end + 1);
      out.status = 206;
      out.contentLength = ov.contentLength !== undefined ? ov.contentLength : bytes.length;
      out.contentRange = `bytes ${start}-${end}/${total}`;
    }
    if (ov.contentRange !== undefined) out.contentRange = ov.contentRange;      // e.g. a compressed representation's total
    opts.onHeaders?.({ ...out });
    if (ov.overflow) { out.received = target.length + 1; return out; }           // nothing written past the slot
    if (ov.short !== undefined) bytes = bytes.subarray(0, ov.short);
    if (bytes.length > target.length) { out.received = target.length + 1; return out; }
    // stream in 2 pieces to exercise onBytes
    const half = bytes.length >> 1;
    target.set(bytes.subarray(0, half), 0); out.received = half; opts.onBytes?.(out.received);
    if (ov.delayMs) await new Promise((r) => setTimeout(r, ov.delayMs));
    if (opts.signal?.aborted) { call.abortedMidBody = true; throw abortError(); }
    if (ov.resetAfterHalf) { call.reset = true; throw new TypeError('network error'); }
    target.set(bytes.subarray(half), half); out.received = bytes.length; opts.onBytes?.(out.received);
    return out;
  };
  fake.calls = calls;
  return fake;
}

// In-memory part store with the part-store.mjs interface and failure injection: options.fail = { put?, get?, keys?, delete? }
// (Error to throw), options.failPutTimes = n → the first n puts throw. Exposes _map and log.
export function makeStoreFake(options = {}) {
  const fail = options.fail ?? {};
  let failPutTimes = options.failPutTimes ?? 0;
  const map = new Map(options.initial ?? []);
  const log = [];
  const err = (name) => { const e = new Error(`${name} failure`); e.name = fail[name]?.name ?? 'Error'; return e; };
  return {
    name: options.name ?? 'fake',
    async get(key) { log.push(['get', key]); if (fail.get) throw err('get'); const v = map.get(key); return v ? v.slice() : null; },
    async put(key, bytes) { log.push(['put', key, bytes.length]); if (fail.put || failPutTimes-- > 0) throw err('put'); map.set(key, bytes.slice()); return true; },
    async delete(key) { log.push(['delete', key]); if (fail.delete) throw err('delete'); map.delete(key); },
    async keys(prefix = '') { log.push(['keys', prefix]); if (fail.keys) throw err('keys'); return [...map.keys()].filter((k) => k.startsWith(prefix)); },
    _map: map, log,
  };
}

// Fake CacheStorage (`caches`) with per-method failure injection: options.fail = { open?, keys?, match?, put?, delete? } → Error to reject with.
export function makeCacheStorageFake(options = {}) {
  const fail = options.fail ?? {};
  const stores = new Map();           // cacheName → Map<url, { body: Uint8Array, headers }>
  for (const name of options.existingNames ?? []) stores.set(name, new Map());
  const log = [];
  const err = (name) => { const e = new Error(`${name} failure`); e.name = fail[name]?.name ?? 'Error'; if (fail[name]?.message) e.message = fail[name].message; return e; };
  const cacheFor = (name) => {
    const store = stores.get(name);
    return {
      async match(req) { log.push(['match', req.url]); if (fail.match) throw err('match'); const hit = store.get(req.url); return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined; },
      async put(req, resp) { log.push(['put', req.url]); if (fail.put) throw err('put'); store.set(req.url, { body: new Uint8Array(await resp.arrayBuffer()), headers: Object.fromEntries(resp.headers.entries()) }); },
      async delete(req) { log.push(['delete', req.url]); if (fail.delete) throw err('delete'); return store.delete(req.url); },
      async keys() { log.push(['cacheKeys', name]); if (fail.cacheKeys) throw err('cacheKeys'); return [...store.keys()].map((u) => new Request(u)); },
      _store: store,
    };
  };
  const caches = {
    async open(name) { log.push(['open', name]); if (fail.open) throw err('open'); if (!stores.has(name)) stores.set(name, new Map()); return cacheFor(name); },
    async keys() { log.push(['keys']); if (fail.keys) throw err('keys'); return [...stores.keys()]; },
    async delete(name) { log.push(['deleteCache', name]); if (fail.deleteCache) throw err('deleteCache'); return stores.delete(name); },
    _stores: stores, log,
  };
  return caches;
}

// Fake `ort` whose InferenceSession returns an identity-shaped output ([1,4,dimF,dimT] zeros unless `run` is injected).
export function makeOrtFake({ inputNames = ['input'], outputNames = ['output'], run, createError, dims } = {}) {
  const created = [];
  class Tensor { constructor(type, data, d) { this.type = type; this.data = data; this.dims = d; } }
  const ort = {
    Tensor,
    InferenceSession: {
      async create(bytes, opts) {
        if (createError) throw createError;
        const session = {
          inputNames, outputNames, opts, bytes, released: 0,
          async run(feeds) {
            if (run) return run(feeds, session);
            const input = feeds[inputNames[0]];
            const outDims = dims ?? input.dims;
            return { [outputNames[0]]: new Tensor('float32', new Float32Array(input.data.length), outDims) };
          },
          async release() { session.released++; },
        };
        created.push(session);
        return session;
      },
    },
    env: { wasm: {}, logLevel: undefined },
    created,
  };
  return ort;
}

// Fake navigator.gpu with adapter/device behaviour switches.
export function makeGpuFake({ adapter = true, deviceThrows = false, features = ['shader-f16'], limits = {}, info = { vendor: 'fake', architecture: 'test' } } = {}) {
  let lostResolve;
  const lost = new Promise((r) => { lostResolve = r; });
  const device = { features: new Set(features), limits, lost, destroy() {}, adapterInfo: info };
  const adapterObj = {
    features: new Set(features), limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 - 4, maxStorageBuffersPerShaderStage: 16, maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupsPerDimension: 65535, maxUniformBufferBindingSize: 65536, ...limits },
    info,
    async requestDevice() { if (deviceThrows) throw new Error('requestDevice failed'); return device; },
  };
  return { async requestAdapter() { return adapter ? adapterObj : null; }, _device: device, _loseDevice: (reason = 'unknown') => lostResolve({ reason, message: 'device lost' }) };
}

// Fake fetch for url-input tests: `script(url, init)` returns { status, headers, body: Uint8Array | chunks[], type? } or throws.
// A body chunk may be a function `(signal) => Promise<Uint8Array>` (slow / stalling bodies); the reader rejects with
// AbortError when the request signal aborts while such a chunk is pending.
export function makeFetchFake(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), init, reads: 0, cancelled: false };
    calls.push(call);
    const r = await script(String(url), init, calls.length);
    if (r instanceof Error) throw r;
    const headers = new Headers(r.headers ?? {});
    const chunks = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
    let i = 0;
    const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
    const body = chunks.length === 0 ? null : {
      getReader() {
        return {
          async read() {
            call.reads++;
            if (init.signal?.aborted) throw abortError();
            if (i >= chunks.length) return { value: undefined, done: true };
            const c = chunks[i++];
            if (typeof c !== 'function') return { value: c, done: false };
            const value = await new Promise((resolve, reject) => {
              const onAbort = () => reject(abortError());
              init.signal?.addEventListener('abort', onAbort, { once: true });
              Promise.resolve(c(init.signal)).then((v) => { init.signal?.removeEventListener('abort', onAbort); resolve(v); }, (e) => { init.signal?.removeEventListener('abort', onAbort); reject(e); });
            });
            if (init.signal?.aborted) throw abortError();
            return { value, done: false };
          },
          async cancel() { call.cancelled = true; },
        };
      },
    };
    return { ok: r.status >= 200 && r.status < 300, status: r.status ?? 200, headers, body, url: String(url) };
  };
  fetch.calls = calls;
  return fetch;
}

// ---------------------------------------------------------------------------------------------------- handler fixture
// Small MDX geometry (nFft 1024, hop 256, dimT 16 → chunkSize 3840, trim 512, gen 2816, step 2880) so handler tests run in ms.
export const SMALL_PARAMS = Object.freeze({ sampleRate: 44100, nFft: 1024, hop: 256, dimF: 513, dimT: 16, segmentSize: 16, overlap: 0.25, compensate: 1.0, primaryStem: 'vocals', zeroLowBins: 3, inputPeak: 0.9, outputPeak: 0.9 });

export function makeAudio(n, seed = 7) {
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100 + seed); right[i] = 0.4 * Math.sin(2 * Math.PI * 660 * i / 44100); }
  return { left, right };
}

export function serveMapFor(manifest, modelId, chunkArrays) {
  const m = manifest.models[modelId];
  const serve = {};
  let k = 0;
  for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) serve[c.path] = chunkArrays[k++];
  return serve;
}

// Builds a handler wired to fakes. `extraModels` adds manifest models; `manifestPatch(manifest)` may mutate the manifest.
// FIX-3: `runtime` (makeRuntime() result) adds manifest.runtime + its served files and records configureRuntime calls;
// `store` (makeStoreFake()) is passed to the handler as the part store.
export async function makeHandlerFixture({ backend = 'wasm', gpu, sizes = [1000, 1000, 500], params = SMALL_PARAMS, overrides, ort, loadBundle, origin = 'http://localhost', separateRoformer, manifestPatch, warn, runtime = null, store = null, configureRuntime, loadModelBytes, loadRuntimeBytes } = {}) {
  const { createHandler } = await import('../../site/src/worker/handler.mjs');
  const modelChunks = makeChunkBytes(sizes, 1);
  const manifest = makeManifest({ modelChunks, params });
  if (runtime) manifest.runtime = runtime.section;
  if (manifestPatch) manifestPatch(manifest, modelChunks);
  const serve = { ...serveMapFor(manifest, 'fake_model', modelChunks), ...(runtime ? runtime.serve : {}) };
  const fetchInto = makeFetchIntoFake(serve, overrides);
  const posted = [];
  const ortFake = ort ?? makeOrtFake();
  const bundleCalls = [];
  const warns = [];
  const runtimeCalls = [];
  const released = [];
  const handler = createHandler({
    post: (m, transfer) => posted.push(transfer ? { ...m, _transfer: transfer } : m),
    loadBundle: loadBundle ?? (async (b) => { bundleCalls.push(b); return ortFake; }),
    configureRuntime: configureRuntime === undefined
      ? async (o, args) => { runtimeCalls.push({ ort: o, ...args }); return { release() { released.push(args.backend); } }; }
      : configureRuntime,
    gpu, fetchInto, caches: null, store, subtle: globalThis.crypto.subtle, origin,
    warn: warn ?? ((...a) => warns.push(a)),
    separateRoformer,
    ...(loadModelBytes ? { loadModelBytes } : {}),
    ...(loadRuntimeBytes ? { loadRuntimeBytes } : {}),
  });
  const init = (over = {}) => ({ type: 'init', backend, threads: 2, baseUrl: 'http://localhost/', manifest, ...over });
  return { handler, posted, manifest, fetchInto, ort: ortFake, bundleCalls, warns, modelId: 'fake_model', init, modelChunks, runtimeCalls, released, serve };
}

// Polls until `pred(posted)` is true (or the timeout elapses). Returns the posted array.
export async function waitForPosted(posted, pred, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!pred(posted)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForPosted timeout; posted types: ${posted.map((m) => m.type + (m.code ? ':' + m.code : '')).join(',')}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return posted;
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
