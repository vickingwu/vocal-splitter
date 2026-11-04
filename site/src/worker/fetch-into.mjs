// site/src/worker/fetch-into.mjs — browser implementation of the §5 fetchInto contract (design §5 snippet; FIX-2 R2: Range
// requests and cross-origin sources). Streams the response body into `target` from offset 0 and never beyond target.length;
// a longer body stops the read, cancels it and reports received = target.length + 1 (the caller treats any received !==
// target.length as a mismatch). opts.range = { start, end } (inclusive) adds `Range: bytes=start-end` — a CORS-safelisted
// header for this simple form, so no preflight; a 200 answer to a Range request means the host ignored it: the body is
// cancelled unread and `rangeIgnored: true` is reported. Cross-origin URLs are fetched with mode 'cors' / credentials 'omit'
// (the sources in the manifest answer with Access-Control-Allow-Origin); same-origin ones stay mode 'same-origin'.
export async function fetchInto(url, target, { signal, cache = 'default', onBytes, onHeaders, range, origin } = {}) {
  const u = url instanceof URL ? url : new URL(String(url));
  const sameOrigin = origin === undefined ? true : u.origin === origin;
  const init = { signal, cache, mode: sameOrigin ? 'same-origin' : 'cors', credentials: sameOrigin ? 'same-origin' : 'omit' };
  if (range) init.headers = { Range: `bytes=${range.start}-${range.end}` };
  const resp = await fetch(url, init);
  const contentLength = resp.headers.has('content-length') ? Number(resp.headers.get('content-length')) : null;
  const out = {
    ok: resp.ok, status: resp.status,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    contentEncoding: resp.headers.get('content-encoding'),
    contentRange: resp.headers.get('content-range'),
    received: 0, rangeIgnored: false,
  };
  // a 200 for a Range request: the host ignored the range; the body (the whole resource) is read only up to target.length
  // so the probe can still measure the link, then cancelled — the caller treats the source as range-less.
  if (range && resp.status === 200) out.rangeIgnored = true;
  onHeaders?.({ ...out });                                     // the probe decides range support from the headers alone (a slow body may time out)
  if (!resp.ok || !resp.body) { try { await resp.body?.cancel(); } catch { /* ignore */ } return out; }   // caller decides (status → MODEL_DOWNLOAD)
  const reader = resp.body.getReader();
  let last = 0;
  let written = 0;                                               // bytes placed into target (never the overflow marker)
  let reported = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (out.received + value.length > target.length) {
        if (out.rangeIgnored) { target.set(value.subarray(0, target.length - out.received), out.received); out.received = written = target.length; await reader.cancel(); break; }
        out.received = target.length + 1;                           // overflow guard: never write past the chunk slot
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
    // the final count is reported even when read() rejects (connection reset, abort): every reported byte is in `target`,
    // so a caller that resumes after the reported count loses nothing to the 100 ms report interval
    if (onBytes && written !== reported) onBytes(written);
  }
  return out;
}
