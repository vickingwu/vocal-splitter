// scripts/lib/fetch_into_node.mjs — the Node implementation of the §5 fetchInto contract over the file system.
// url.pathname (query ignored) is mapped under the site root (default <repo>/site); paths that escape the root →
// { ok:false, status:403 }; a missing file → { ok:false, status:404 }; the same overflow rule as the browser adapter
// (received = target.length + 1 when the body is longer than the slot); contentLength = file size, contentEncoding null.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');

export function makeNodeFetchInto(root = defaultRoot, { basePath = '/' } = {}) {
  const rootResolved = path.resolve(root);
  const base = basePath.endsWith('/') ? basePath : basePath + '/';
  const forbidden = { ok: false, status: 403, contentLength: null, contentEncoding: null, received: 0 };
  return async function fetchInto(url, target, { signal, onBytes, onHeaders, range } = {}) {
    // a URL object (its parser already resolves dot segments) or any object exposing a raw `pathname`
    const rawPath = typeof url === 'string' ? new URL(url).pathname : String(url.pathname);
    if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return { ...forbidden, status: 404 }; }
    if (pathname.startsWith(base)) pathname = pathname.slice(base.length);
    else if (pathname.startsWith('/')) pathname = pathname.slice(1);
    const segments = pathname.split('/');
    if (segments.some((s) => s === '..' || s.includes('\\') || s.includes(':') || s === '')) return { ...forbidden };
    const file = path.resolve(rootResolved, ...segments);
    const rel = path.relative(rootResolved, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ...forbidden };
    let stat;
    try { stat = await fs.promises.stat(file); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { ok: false, status: 404, contentLength: null, contentEncoding: null, received: 0 };
      throw e;
    }
    if (!stat.isFile()) return { ok: false, status: 404, contentLength: null, contentEncoding: null, received: 0 };
    let data = await fs.promises.readFile(file);
    const out = { ok: true, status: 200, contentLength: stat.size, contentEncoding: null, contentRange: null, received: 0, rangeIgnored: false };
    if (range) {                                       // the same semantics as a 206 from a static host
      const start = Math.max(0, Number(range.start) || 0);
      const end = Math.min(Number(range.end), data.length - 1);
      if (!(start <= end) || start >= data.length) return { ok: false, status: 416, contentLength: null, contentEncoding: null, contentRange: `bytes */${data.length}`, received: 0, rangeIgnored: false };
      data = data.subarray(start, end + 1);
      out.status = 206;
      out.contentLength = data.length;
      out.contentRange = `bytes ${start}-${end}/${stat.size}`;
    }
    onHeaders?.({ ...out });
    if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (data.length > target.length) { out.received = target.length + 1; return out; }
    target.set(data, 0);
    out.received = data.length;
    onBytes?.(out.received);
    return out;
  };
}

export const fetchInto = makeNodeFetchInto();
