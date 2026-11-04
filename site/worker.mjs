// site/worker.mjs — thin module-worker shell (design §7.2). Wires handler.mjs to the real dependencies; holds the ONLY
// two dynamic imports of the ORT bundles (two literal call sites, no-cdn rule) and the ONLY ort.env writes in the code base.
import { createHandler } from './src/worker/handler.mjs';
import { fetchInto } from './src/worker/fetch-into.mjs';
import { createPartStore } from './src/engine/part-store.mjs';

async function loadBundle(backend, { baseUrl, threads }) {
  let ort;
  if (backend === 'webgpu') ort = await import(new URL('vendor/ort/ort.webgpu.min.mjs', baseUrl).href);
  else ort = await import(new URL('vendor/ort/ort.wasm.min.mjs', baseUrl).href);
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', baseUrl).href;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  return ort;
}

const warn = (...a) => console.warn('[vs]', ...a);
const cachesRef = typeof caches !== 'undefined' ? caches : null;
const idbRef = typeof indexedDB !== 'undefined' ? indexedDB : null;

const handler = createHandler({
  post: (msg, transfer) => (transfer ? self.postMessage(msg, transfer) : self.postMessage(msg)),
  loadBundle,
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
