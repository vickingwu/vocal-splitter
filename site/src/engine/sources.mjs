// site/src/engine/sources.mjs — model download sources (FIX-2 R1/R2): resolution of manifest `sources` into URL builders and
// the run-time probe that ranks them by measured speed. Runtime-agnostic (fetchInto / now injected; URL only).
//
// A manifest source is { id, kind: 'chunks' | 'whole', label, base | urls }. kind 'chunks' serves the repo's own
// site/models/<id>/part-NN.bin files under `base` ('./' = same origin, resolved against baseUrl; otherwise an https
// directory URL such as a jsDelivr tag URL); kind 'whole' serves byte-identical copies of the original files
// (urls.model / urls.externalData) and must honour Range requests. Source 'origin' (same-origin chunks) is always
// present and never excluded: it is the final fallback when every mirror fails.

export const ORIGIN_SOURCE = Object.freeze({ id: 'origin', kind: 'chunks', base: './', label: '站内' });
export const PROBE_BYTES = 262144;
export const PROBE_TIMEOUT_MS = 4000;

// → [{ id, kind, label, isOrigin, urlFor(fileKey, file, chunk) }], in manifest order, filtered/ordered by `only` (ids) when
// given; 'origin' is appended when `only` leaves it out.
export function resolveSources(model, baseUrl, { only = null, version = null } = {}) {
  const list = Array.isArray(model.sources) && model.sources.length ? model.sources : [ORIGIN_SOURCE];
  let chosen = list;
  if (Array.isArray(only) && only.length) {
    chosen = only.map((id) => list.find((s) => s.id === id)).filter(Boolean);
    if (!chosen.some((s) => s.id === 'origin')) chosen.push(list.find((s) => s.id === 'origin') ?? ORIGIN_SOURCE);
  }
  return chosen.map((s) => {
    const isOrigin = s.id === 'origin';
    if (s.kind === 'chunks') {
      const base = new URL(s.base, baseUrl);
      return {
        id: s.id, kind: 'chunks', label: s.label, isOrigin,
        urlFor(fileKey, file, chunk) {
          const u = new URL(chunk.path, base);
          if (isOrigin && version) u.search = '?v=' + encodeURIComponent(version);
          return u;
        },
      };
    }
    return { id: s.id, kind: 'whole', label: s.label, isOrigin: false, urlFor(fileKey) { return s.urls && s.urls[fileKey] ? new URL(s.urls[fileKey]) : null; } };
  });
}

// `bytes a-b/total` → total (or null)
export function contentRangeTotal(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(header ?? '').trim());
  if (!m || m[3] === '*') return null;
  return Number(m[3]);
}

// Probes every source in parallel with a Range GET of the first PROBE_BYTES of the model file (chunk sources: of its first
// chunk) and a timeout; a source that delivered bytes is ranked by bytes/ms. ranges = a clean 206 (received the requested
// length, Content-Range total equal to the resource size when present, no Content-Encoding); a 200 or a dirty 206 from a
// chunk source still works in whole-chunk mode (one request per chunk), a whole-file source needs ranges. No bytes within
// the timeout, a non-2xx status or a CORS failure → excluded; 'origin' is kept last instead (ranges unknown → whole-chunk).
export async function probeSources(sources, files, { fetchInto, now, origin, timeoutMs = PROBE_TIMEOUT_MS, probeBytes = PROBE_BYTES } = {}) {
  const file = files.model;
  const results = await Promise.all(sources.map(async (src) => {
    const chunk = file.chunks[0];
    const total = src.kind === 'chunks' ? chunk.bytes : file.bytes;
    const url = src.urlFor('model', file, chunk);
    const r = { id: src.id, kind: src.kind, label: src.label, isOrigin: src.isOrigin, ok: false, ranges: false, bytes: 0, ms: 0, bytesPerMs: 0, status: null, error: null };
    if (!url) { r.error = 'no url'; return r; }
    const n = Math.min(probeBytes, total);
    const target = new Uint8Array(n);
    const controller = new AbortController();
    const t0 = now();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let res = null;
    let headers = null;                                      // arrive long before a slow body; they decide Range support
    try {
      res = await fetchInto(url, target, { signal: controller.signal, range: { start: 0, end: n - 1 }, origin, onHeaders: (h) => { headers = h; }, onBytes: (got) => { r.bytes = got; } });
      r.bytes = res.received > n ? n : res.received;
    } catch (e) {
      r.error = timedOut ? 'timeout' : `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : e}`;
    } finally { clearTimeout(timer); }
    r.ms = Math.max(1, now() - t0);
    r.bytesPerMs = r.bytes / r.ms;
    const h = res ?? headers;
    if (h) r.status = h.status;
    if (res) {
      if (!res.ok) { r.error = `HTTP ${res.status}`; return r; }
      const cleanRange = res.status === 206 && !res.rangeIgnored && res.received === n && res.contentEncoding === null
        && (res.contentRange === null || contentRangeTotal(res.contentRange) === total);
      r.ranges = cleanRange;
      if (src.kind === 'whole' && !cleanRange) { r.error = res.rangeIgnored ? 'range ignored' : 'range answer not clean'; return r; }
      r.ok = true;
      return r;
    }
    // timed out with bytes arriving (a slow link, the user's 27 KB/s): usable; Range support comes from the headers
    if (timedOut && r.bytes > 0) {
      const cleanRange = !!headers && headers.ok && headers.status === 206 && !headers.rangeIgnored && headers.contentEncoding === null
        && (headers.contentRange === null || contentRangeTotal(headers.contentRange) === total);
      if (headers && !headers.ok) { r.error = `HTTP ${headers.status}`; return r; }
      if (src.kind === 'whole' && !cleanRange) { r.error = 'timeout (range answer not clean)'; return r; }
      r.ok = true; r.ranges = cleanRange; r.error = 'timeout (partial)';
    }
    return r;
  }));
  const usable = results.filter((r) => r.ok).sort((a, b) => b.bytesPerMs - a.bytesPerMs);
  const originRes = results.find((r) => r.isOrigin);
  if (originRes && !originRes.ok) usable.push({ ...originRes, ok: true, ranges: false, keptAsFallback: true });
  const excluded = results.filter((r) => !r.ok && !r.isOrigin).map((r) => ({ id: r.id, reason: r.error ?? `status ${r.status}` }));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const ranked = usable.map((r) => ({ ...byId.get(r.id), ranges: r.ranges, probe: { bytes: r.bytes, ms: Math.round(r.ms), kBps: Math.round(r.bytesPerMs * 1000 / 1024), status: r.status, error: r.error } }));
  return { ranked, excluded, results };
}
