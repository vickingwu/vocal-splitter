// scripts/lib/fetch_into_http.mjs — the §5 fetchInto contract for Node over http(s) (global fetch, Node 20+), the same
// semantics as site/src/worker/fetch-into.mjs: the body streams into `target` from offset 0, a longer body stops the read and
// reports received = target.length + 1, opts.range adds `Range: bytes=start-end`, a 200 answer to a Range request is
// reported as rangeIgnored (read up to target.length, then cancelled), every reported byte is in `target`. No `mode` /
// `credentials` (Node has no document origin); `Accept-Encoding: identity` so Content-Length is the chunk size and the
// loader can treat the source as range-capable. makeFetchInto(root) dispatches http(s) URLs here and everything else to the
// file-system adapter (scripts/lib/fetch_into_node.mjs), so one loader call works for a local site/ or a remote tag URL.
import { makeNodeFetchInto } from './fetch_into_node.mjs';

export async function fetchIntoHttp(url, target, { signal, onBytes, onHeaders, range } = {}) {
  const headers = { 'Accept-Encoding': 'identity' };
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  const resp = await fetch(url instanceof URL ? url.href : String(url), { signal, headers, redirect: 'follow' });
  const contentLength = resp.headers.has('content-length') ? Number(resp.headers.get('content-length')) : null;
  const out = {
    ok: resp.ok, status: resp.status,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    contentEncoding: resp.headers.get('content-encoding'),
    contentRange: resp.headers.get('content-range'),
    received: 0, rangeIgnored: false,
  };
  if (range && resp.status === 200) out.rangeIgnored = true;
  onHeaders?.({ ...out });
  if (!resp.ok || !resp.body) { try { await resp.body?.cancel(); } catch { /* ignore */ } return out; }
  const reader = resp.body.getReader();
  let last = 0;
  let written = 0;
  let reported = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (out.received + value.length > target.length) {
        if (out.rangeIgnored) { target.set(value.subarray(0, target.length - out.received), out.received); out.received = written = target.length; await reader.cancel(); break; }
        out.received = target.length + 1;
        await reader.cancel();
        return out;
      }
      target.set(value, out.received);
      out.received += value.length;
      written = out.received;
      if (out.rangeIgnored && out.received === target.length) { await reader.cancel(); break; }
      const now = performance.now();
      if (onBytes && now - last >= 100) { last = now; reported = written; onBytes(written); }
    }
  } finally {
    if (onBytes && written !== reported) onBytes(written);
  }
  return out;
}

// http(s) → fetchIntoHttp; anything else (the loader's URLs under a `http://localhost/` baseUrl, file paths) → the fs adapter rooted at `root`.
export function makeFetchInto(root) {
  const fsFetch = makeNodeFetchInto(root);
  return function fetchInto(url, target, opts) {
    const u = url instanceof URL ? url : new URL(String(url));
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== 'localhost') return fetchIntoHttp(u, target, opts);
    return fsFetch(u, target, opts);
  };
}
