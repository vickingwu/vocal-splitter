// site/worker.mjs — thin module-worker shell (design §7.2). Wires handler.mjs to the real dependencies; holds the ONLY
// two dynamic imports of the ORT bundles (two literal call sites, no-cdn rule) and the ONLY ort.env writes in the code base.
import { createHandler } from './src/worker/handler.mjs';
import { fetchInto } from './src/worker/fetch-into.mjs';
import { createPartStore } from './src/engine/part-store.mjs';

// FIX-3 R2: the 70 KB bundle import is retried (3 attempts, 1 / 2 s back-off) — on the user's resetting link a module fetch
// can fail once; the big files never come through here (see configureRuntime).
const BUNDLE_ATTEMPTS = 3;
const BUNDLE_BACKOFF_MS = [1000, 2000];
async function importBundle(backend, baseUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < BUNDLE_ATTEMPTS; attempt++) {
    try {
      if (backend === 'webgpu') return await import(new URL('vendor/ort/ort.webgpu.min.mjs', baseUrl).href);
      return await import(new URL('vendor/ort/ort.wasm.min.mjs', baseUrl).href);
    } catch (e) {
      lastError = e;
      warn('bundle import failed', attempt + 1, e && e.message ? e.message : String(e));
      if (attempt + 1 < BUNDLE_ATTEMPTS) await new Promise((r) => setTimeout(r, BUNDLE_BACKOFF_MS[Math.min(attempt, BUNDLE_BACKOFF_MS.length - 1)]));
    }
  }
  throw lastError;
}

async function loadBundle(backend, { baseUrl, threads }) {
  const ort = await importBundle(backend, baseUrl);
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', baseUrl).href;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  return ort;
}

// FIX-3 R2: the runtime bytes the loader downloaded and verified (manifest.runtime.<backend>) are handed to ORT, which then
// makes no network request of its own: env.wasm.wasmBinary is the .wasm (onnxruntime-web 1.31.1 passes it to the Emscripten
// factory as Module.wasmBinary — `g.wasmBinary&&(ta=g.wasmBinary)` in the glue — and sets locateFile to the identity), and
// env.wasm.wasmPaths = { mjs, wasm } names blob: URLs of the glue and the .wasm (the bundle reads `wasmPaths.mjs` /
// `wasmPaths.wasm` and imports the glue from that URL; the .wasm URL is only reached by a glue that ignores wasmBinary).
// The glue's blob: URL stays alive for the worker's lifetime: Emscripten spawns its pthread workers from the glue's
// import.meta.url (lazily, with the compiled WebAssembly.Module posted to them — no second download).
// release() (called by the handler once the first session exists) revokes the .wasm blob: URL — its 28 MB copy is not needed
// after instantiation; the glue URL is kept.
async function configureRuntime(ort, { wasm, glue, names }) {
  const exact = wasm.byteOffset === 0 && wasm.byteLength === wasm.buffer.byteLength;
  ort.env.wasm.wasmBinary = exact ? wasm.buffer : wasm.slice().buffer;
  const mjs = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  ort.env.wasm.wasmPaths = { mjs, wasm: wasmUrl };
  return { mjs, wasm: wasmUrl, names, release() { URL.revokeObjectURL(wasmUrl); } };
}

const warn = (...a) => console.warn('[vs]', ...a);
const cachesRef = typeof caches !== 'undefined' ? caches : null;
const idbRef = typeof indexedDB !== 'undefined' ? indexedDB : null;

const handler = createHandler({
  post: (msg, transfer) => (transfer ? self.postMessage(msg, transfer) : self.postMessage(msg)),
  loadBundle,
  configureRuntime,
  gpu: typeof navigator !== 'undefined' ? navigator.gpu : undefined,
  fetchInto,
  caches: cachesRef,
  // the part store is keyed under init.baseUrl (the same keys as the main thread's offline import in app.mjs)
  store: (baseUrl) => createPartStore({ caches: cachesRef, indexedDB: idbRef, baseUrl, warn }),
  subtle: crypto.subtle,
  origin: self.location.origin,
  now: () => performance.now(),
  warn,
});

self.onmessage = (ev) => handler.onMessage(ev.data);
