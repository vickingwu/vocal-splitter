// site/src/engine/part-store.mjs — persistent byte store for model parts and assembled files (FIX-2 R2/R3).
// Keys are logical strings: `${modelId}:${sha256}` for an assembled file and `${modelId}:${sha256}:part-<n>` for one
// downloaded part (n = segment index within the file). Two backends behind one interface { get, put, delete, keys }:
// Cache Storage (key → a same-origin URL under .vs-store/) and IndexedDB (one object store, key = the string). createPartStore
// prefers Cache Storage and switches to IndexedDB for the rest of the session when a `put` throws (quota, private mode);
// reads consult both. Runtime-agnostic: `caches`, `indexedDB`, `baseUrl`, `warn` are injected; no globals besides URL,
// Request, Response, Uint8Array.

export const fileKey = (modelId, sha256) => `${modelId}:${sha256}`;
export const partKey = (modelId, sha256, n) => `${modelId}:${sha256}:part-${n}`;
export const PART_SUFFIX_RE = /:part-(\d+)$/;

const STORE_PATH = '.vs-store/';

export function createCacheStore({ caches, baseUrl, cacheName = 'vs-store' }) {
  if (!caches || typeof caches.open !== 'function') throw new TypeError('createCacheStore: caches missing');
  if (typeof baseUrl !== 'string' || !baseUrl.endsWith('/')) throw new TypeError('createCacheStore: baseUrl must be a directory URL string');
  const prefix = new URL(STORE_PATH, baseUrl).href;
  const urlOf = (key) => prefix + encodeURIComponent(key);
  const keyOf = (url) => (url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : null);
  let cachePromise = null;
  const cache = () => { if (!cachePromise) cachePromise = caches.open(cacheName); return cachePromise; };
  return {
    name: 'cache',
    async get(key) {
      const hit = await (await cache()).match(new Request(urlOf(key)));
      if (!hit) return null;
      return new Uint8Array(await hit.arrayBuffer());
    },
    async put(key, bytes) {
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await (await cache()).put(new Request(urlOf(key)), new Response(body, { headers: { 'Content-Length': String(body.byteLength), 'Content-Type': 'application/octet-stream' } }));
    },
    async delete(key) { await (await cache()).delete(new Request(urlOf(key))); },
    async keys(keyPrefix = '') {
      const reqs = await (await cache()).keys();
      const out = [];
      for (const r of reqs) { const k = keyOf(r.url); if (k !== null && k.startsWith(keyPrefix)) out.push(k); }
      return out;
    },
  };
}

function idbRequest(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed')); });
}

export function createIdbStore({ indexedDB, dbName = 'vs-store', storeName = 'parts' }) {
  if (!indexedDB || typeof indexedDB.open !== 'function') throw new TypeError('createIdbStore: indexedDB missing');
  let dbPromise = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  };
  const tx = async (mode, fn) => {
    const d = await db();
    const t = d.transaction(storeName, mode);
    const result = await fn(t.objectStore(storeName));
    await new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed')); t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted')); });
    return result;
  };
  return {
    name: 'idb',
    async get(key) {
      const v = await tx('readonly', (s) => idbRequest(s.get(key)));
      if (v === undefined || v === null) return null;
      return v instanceof Uint8Array ? v : new Uint8Array(v);
    },
    // a view is sliced first: structured clone would otherwise copy the whole underlying buffer (the assembled file)
    async put(key, bytes) { const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice(); await tx('readwrite', (s) => idbRequest(s.put(copy, key))); },
    async delete(key) { await tx('readwrite', (s) => idbRequest(s.delete(key))); },
    async keys(keyPrefix = '') {
      const all = await tx('readonly', (s) => idbRequest(s.getAllKeys()));
      return all.map(String).filter((k) => k.startsWith(keyPrefix));
    },
  };
}

// Cache Storage first; IndexedDB after the first failing put (or from the start when caches is absent); reads consult both.
// `backends` ([primary, secondary]) replaces the construction from globals (tests).
export function createPartStore({ caches = null, indexedDB = null, baseUrl, warn = () => {}, backends = null } = {}) {
  let primary = null, secondary = null;
  if (backends) { [primary = null, secondary = null] = backends; } else {
    try { if (caches) primary = createCacheStore({ caches, baseUrl }); } catch (e) { warn('[vs] cache store unavailable', e); }
    try { if (indexedDB) secondary = createIdbStore({ indexedDB }); } catch (e) { warn('[vs] idb store unavailable', e); }
  }
  if (!primary && !secondary) return null;
  // reads consult every backend that exists; writes go to `writer`, which moves to the next backend after a failing put
  const readers = [primary, secondary].filter(Boolean);
  let writerIndex = 0;
  let warned = false;
  const writer = () => readers[writerIndex] ?? null;
  const demote = (e) => {
    const from = writer();
    writerIndex++;
    if (!warned) { warned = true; warn('[vs] part store: ' + (from ? from.name : '?') + ' put failed, switching to ' + (writer() ? writer().name : 'memory only'), e); }
  };
  const stores = () => readers;
  return {
    get name() { const w = writer(); return w ? w.name : 'none'; },
    async get(key) {
      for (const s of stores()) { try { const v = await s.get(key); if (v) return v; } catch (e) { warn('[vs] part store get failed', e); } }
      return null;
    },
    async put(key, bytes) {
      for (;;) {
        const w = writer();
        if (!w) return false;
        try { await w.put(key, bytes); return true; } catch (e) { demote(e); }
      }
    },
    async delete(key) { for (const s of stores()) { try { await s.delete(key); } catch (e) { warn('[vs] part store delete failed', e); } } },
    async keys(keyPrefix = '') {
      const seen = new Set();
      for (const s of stores()) { try { for (const k of await s.keys(keyPrefix)) seen.add(k); } catch (e) { warn('[vs] part store keys failed', e); } }
      return [...seen];
    },
  };
}
