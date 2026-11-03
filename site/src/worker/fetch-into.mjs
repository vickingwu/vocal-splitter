// site/src/worker/fetch-into.mjs — browser implementation of the §5 fetchInto contract (design §5 snippet).
// Streams the response body into `target` from offset 0 and never beyond target.length; a longer body stops the read,
// cancels it and reports received = target.length + 1 (the caller treats any received !== target.length as a mismatch).
export async function fetchInto(url, target, { signal, cache = 'default', onBytes } = {}) {
  const resp = await fetch(url, { signal, cache, mode: 'same-origin' });
  const contentLength = resp.headers.has('content-length') ? Number(resp.headers.get('content-length')) : null;
  const out = {
    ok: resp.ok, status: resp.status,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    contentEncoding: resp.headers.get('content-encoding'), received: 0,
  };
  if (!resp.ok || !resp.body) return out;                      // caller decides (status → MODEL_DOWNLOAD)
  const reader = resp.body.getReader();
  let last = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (out.received + value.length > target.length) {           // overflow guard: never write past the chunk slot
      out.received = target.length + 1;
      await reader.cancel();
      return out;
    }
    target.set(value, out.received);
    out.received += value.length;
    const now = performance.now();
    if (onBytes && now - last >= 100) { last = now; onBytes(out.received); }
  }
  onBytes?.(out.received);
  return out;
}
