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
export function makeManifest({ modelId = 'fake_model', version = 'test-1', modelChunks, externalChunks = null, params } = {}) {
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
        files, uvrHash: '0'.repeat(32),
        params: params ?? { sampleRate: 44100, nFft: 6144, hop: 1024, dimF: 2048, dimT: 256, segmentSize: 256, overlap: 0.25, compensate: 1.035, primaryStem: 'vocals', zeroLowBins: 3, inputPeak: 0.9, outputPeak: 0.9 },
      },
    },
  };
}

// In-memory fetchInto with the §5 return shape. `serve` maps chunk path → bytes. `overrides(pathname, attempt, opts)` may
// return { bytes } | { status } | { reject: Error } | { overflow: true } | { short: n } | { contentLength, contentEncoding } | null.
export function makeFetchIntoFake(serve, overrides = () => null) {
  const calls = [];
  const attempts = new Map();
  const fake = async function fetchInto(url, target, opts = {}) {
    const u = url instanceof URL ? url : new URL(String(url));
    const pathname = u.pathname.replace(/^\//, '');
    const attempt = (attempts.get(pathname) ?? 0) + 1;
    attempts.set(pathname, attempt);
    const call = { url: u.href, pathname, query: u.search, attempt, cache: opts.cache, signal: opts.signal, aborted: !!opts.signal?.aborted, targetLength: target.length };
    calls.push(call);
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const ov = overrides(pathname, attempt, opts) || {};
    if (ov.reject) throw ov.reject;
    if (ov.status !== undefined && (ov.status < 200 || ov.status >= 300)) return { ok: false, status: ov.status, contentLength: null, contentEncoding: null, received: 0 };
    let bytes = ov.bytes ?? serve[pathname];
    if (!bytes) return { ok: false, status: 404, contentLength: null, contentEncoding: null, received: 0 };
    const out = { ok: true, status: 200, contentLength: ov.contentLength !== undefined ? ov.contentLength : bytes.length, contentEncoding: ov.contentEncoding ?? null, received: 0 };
    if (ov.overflow) { out.received = target.length + 1; return out; }           // nothing written past the slot
    if (ov.short !== undefined) bytes = bytes.subarray(0, ov.short);
    if (bytes.length > target.length) { out.received = target.length + 1; return out; }
    // stream in 2 pieces to exercise onBytes
    const half = bytes.length >> 1;
    target.set(bytes.subarray(0, half), 0); out.received = half; opts.onBytes?.(out.received);
    if (ov.delayMs) await new Promise((r) => setTimeout(r, ov.delayMs));
    if (opts.signal?.aborted) { call.abortedMidBody = true; const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    target.set(bytes.subarray(half), half); out.received = bytes.length; opts.onBytes?.(out.received);
    return out;
  };
  fake.calls = calls;
  return fake;
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
export function makeFetchFake(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await script(String(url), init, calls.length);
    if (r instanceof Error) throw r;
    const headers = new Headers(r.headers ?? {});
    const chunks = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
    let i = 0;
    const body = chunks.length === 0 ? null : {
      getReader() {
        return {
          async read() { if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } if (i < chunks.length) return { value: chunks[i++], done: false }; return { value: undefined, done: true }; },
          async cancel() { calls[calls.length - 1].cancelled = true; },
        };
      },
    };
    return { ok: r.status >= 200 && r.status < 300, status: r.status ?? 200, headers, body, url: String(url) };
  };
  fetch.calls = calls;
  return fetch;
}
