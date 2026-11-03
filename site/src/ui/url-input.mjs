// site/src/ui/url-input.mjs — URL classification (design §10.2), the fetch-with-proxy-fallback loop (§10.3) and the
// filename derivation (§10.3/§19). Pure over injected fetch / timers so url-input.test.mjs drives it with fakes.
import { EngineError } from '../engine/errors.mjs';

export const PLATFORM_HOSTS = Object.freeze([
  'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'music.163.com', '163cn.tv', 'y.qq.com', 'kugou.com', 'kuwo.cn',
  'spotify.com', 'douyin.com', 'iesdouyin.com', 'soundcloud.com', 'tiktok.com',
]);

// Proxy templates (pinned in FEAT-004 after tests/e2e/proxies.mjs measures them). Hosts are on the no-cdn allow-list.
export const PROXIES = Object.freeze([
  { name: 'allorigins', host: 'api.allorigins.win', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs', host: 'api.codetabs.com', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
]);

export const MAX_URL_CHARS = 2048;
export const CAP = 200 * 1024 * 1024;
export const HEADERS_MS = Object.freeze({ direct: 20_000, proxy: 40_000 });
export const STALL_MS = 30_000;

export function normalizeHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  else if (h.startsWith('m.')) h = h.slice(2);
  return h;
}

export function isPlatformHost(hostname) {
  const h = normalizeHost(hostname);
  return PLATFORM_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}

// → { kind: 'platform' | 'direct' | 'invalid', url }
export function classifyUrl(text) {
  if (typeof text !== 'string') return { kind: 'invalid', url: null };
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_URL_CHARS) return { kind: 'invalid', url: null };   // before new URL()
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : 'https://' + t;
  let u;
  try { u = new URL(withScheme); } catch { return { kind: 'invalid', url: null }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'invalid', url: null };
  if (!u.hostname) return { kind: 'invalid', url: null };
  return { kind: isPlatformHost(u.hostname) ? 'platform' : 'direct', url: u.href };
}

export function proxyUrls(url) { return PROXIES.map((p) => p.build(url)); }

const FS_INVALID = /[\\/:*?"<>|]/g;
export function safeFileName(name) { return String(name).replace(FS_INVALID, '_'); }

// Strips the extension (last '.' with <= 5 trailing characters).
export function stripExtension(name) {
  const i = name.lastIndexOf('.');
  if (i > 0 && name.length - i - 1 <= 5 && name.length - i - 1 >= 1) return name.slice(0, i);
  return name;
}

// Last non-empty path segment of the ORIGINAL url (a pasted proxy URL is unwrapped once); decodeURIComponent in a try
// (a malformed % sequence keeps the raw segment); extension stripped; filesystem characters replaced; empty → 'audio'.
export function baseNameFromUrl(url, depth = 0) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch { return 'audio'; }
  if (depth === 0 && PROXIES.some((p) => u.hostname.toLowerCase() === p.host)) {
    const inner = u.searchParams.get('url') ?? u.searchParams.get('quest');
    if (inner && /^https?:\/\//i.test(inner)) return baseNameFromUrl(inner, 1);
  }
  const segs = u.pathname.split('/').filter((s) => s.length > 0);
  let seg = segs.length ? segs[segs.length - 1] : '';
  try { seg = decodeURIComponent(seg); } catch { /* raw segment */ }
  seg = safeFileName(stripExtension(seg)).trim();
  return seg.length ? seg : 'audio';
}

// AbortSignal.any fallback for engines without it: forwards either abort to a new controller.
export function anySignal(a, b) {
  const ctl = new AbortController();
  const forward = (s) => { if (s.aborted) ctl.abort(s.reason); else s.addEventListener('abort', () => ctl.abort(s.reason), { once: true }); };
  forward(a); forward(b);
  return ctl.signal;
}

function contentTypeOf(resp) {
  try { return String(resp.headers.get('content-type') ?? '').toLowerCase(); } catch { return ''; }
}

function contentLengthOf(resp) {
  try {
    const raw = resp.headers.get('content-length');
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

// The §10.3 loop. Resolves { blob, contentType, attempts (reasons[]), kind }; rejects with EngineError
// (URL_STATUS / URL_NOT_AUDIO / URL_TOO_LARGE / URL_FETCH / CANCELLED).
export async function fetchAudioUrl(url, {
  fetch: fetchFn,
  userSignal,
  onProgress,
  setTimeout: setTimeoutFn,
  clearTimeout: clearTimeoutFn,
  abortSignalAny,
  proxies = PROXIES,
} = {}) {
  if (typeof fetchFn !== 'function') throw new EngineError('INTERNAL', 'fetchAudioUrl: fetch missing');
  const st = setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const ct = clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
  const anyFn = abortSignalAny !== undefined ? abortSignalAny
    : (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any.bind(AbortSignal) : null);
  const user = userSignal ?? new AbortController().signal;
  const cancelled = () => new EngineError('CANCELLED', 'cancelled by the user');

  const attempts = [{ kind: 'direct', url }, ...proxies.map((p) => ({ kind: 'proxy', url: p.build(url), proxy: p.name }))];
  let directStatus = null;
  const reasons = [];

  for (const attempt of attempts) {
    if (user.aborted) throw cancelled();
    const attemptCtl = new AbortController();
    const signal = anyFn ? anyFn([user, attemptCtl.signal]) : anySignal(user, attemptCtl.signal);
    let timer = st(() => attemptCtl.abort('headers'), HEADERS_MS[attempt.kind]);
    let resp;
    try {
      resp = await fetchFn(attempt.url, { mode: 'cors', signal });
    } catch (e) {
      ct(timer);
      if (user.aborted) throw cancelled();
      reasons.push(attemptCtl.signal.aborted ? 'headers-timeout' : 'network');
      void e;
      continue;
    }
    ct(timer);
    if (user.aborted) throw cancelled();

    if (!resp.ok) {
      if (attempt.kind === 'direct') {
        if (resp.status === 404 || resp.status === 410) throw new EngineError('URL_STATUS', `direct ${resp.status}`, { status: resp.status });
        directStatus = resp.status;
      }
      reasons.push('status');
      continue;
    }
    const contentType = contentTypeOf(resp);
    if (contentType.startsWith('text/html')) {
      if (attempt.kind === 'direct') throw new EngineError('URL_NOT_AUDIO', 'direct response is text/html', { contentType });
      reasons.push('html');
      continue;
    }
    const contentLength = contentLengthOf(resp);
    if (contentLength !== null && contentLength > CAP) throw new EngineError('URL_TOO_LARGE', `content-length ${contentLength}`, { bytes: contentLength });

    // stream the body; STALL_MS re-armed on every read
    const parts = [];
    let received = 0;
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // no streaming body (very old engines): read whole
      let ab;
      try { ab = await resp.arrayBuffer(); } catch (e) { if (user.aborted) throw cancelled(); reasons.push('network'); void e; continue; }
      received = ab.byteLength;
      if (received > CAP) throw new EngineError('URL_TOO_LARGE', `body ${received}`, { bytes: received });
      parts.push(new Uint8Array(ab));
    } else {
      const reader = resp.body.getReader();
      let stalled = false;
      for (;;) {
        timer = st(() => attemptCtl.abort('stall'), STALL_MS);
        let chunk;
        try { chunk = await reader.read(); } catch (e) {
          ct(timer);
          if (user.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw cancelled(); }
          try { await reader.cancel(); } catch { /* ignore */ }
          reasons.push(attemptCtl.signal.aborted ? 'stall' : 'network');
          stalled = true;
          void e;
          break;
        }
        ct(timer);
        if (user.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw cancelled(); }
        if (chunk.done) break;
        const value = chunk.value;
        received += value.length;
        if (received > CAP) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new EngineError('URL_TOO_LARGE', `body exceeded ${CAP}`, { bytes: received });
        }
        parts.push(value);
        if (onProgress) onProgress({ received, total: contentLength, kind: attempt.kind });
      }
      if (stalled) continue;
    }
    const type = contentType.startsWith('audio/') ? contentType.split(';')[0].trim() : '';
    return { blob: new Blob(parts, { type }), contentType, attempts: reasons.slice(), kind: attempt.kind, bytes: received };
  }
  if (directStatus !== null) throw new EngineError('URL_STATUS', `direct ${directStatus} and every proxy failed`, { status: directStatus, attempts: reasons.slice() });
  throw new EngineError('URL_FETCH', 'every attempt failed', { attempts: reasons.slice() });
}
