// site/src/ui/decode.mjs — input decode flow (design §10.1): size check → one byte read → pre-decode duration probe →
// decodeAudioData → post-decode duration check → resample guard; copyInput / decodeForDispatch for the per-dispatch planar
// copies (§12.1 retained-input rule). No top-level browser access: Node imports it and injects fakes.
import { EngineError, classifyAllocationFailure } from '../engine/errors.mjs';
import { sniffContainer } from '../engine/sniff.mjs';
import { mpegDuration } from '../engine/mp3frames.mjs';
import { readWavHeader } from '../engine/wav.mjs';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// <audio preload="metadata"> probe for FLAC / MP4 / OGG (container duration fields). Browser only; null on any failure.
export function audioElementDuration(blob, timeoutMs = 10000) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let url = null;
    let el = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { if (el) { el.removeAttribute('src'); el.load(); } } catch { /* ignore */ }
      try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ }
      resolve(v);
    };
    try {
      el = document.createElement('audio');
      el.preload = 'metadata';
      url = URL.createObjectURL(blob);
      const timer = setTimeout(() => finish(null), timeoutMs);
      el.addEventListener('loadedmetadata', () => { clearTimeout(timer); const d = el.duration; finish(Number.isFinite(d) && d >= 0 ? d : null); });
      el.addEventListener('error', () => { clearTimeout(timer); finish(null); });
      el.src = url;
    } catch { finish(null); }
  });
}

// → { seconds, exact, kind } | null. Never throws.
export async function probeDuration(blob, ab, timeoutMs = 10000, { audioDuration = audioElementDuration } = {}) {
  try {
    const bytes = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
    switch (sniffContainer(bytes)) {
      case 'mpeg': { const d = mpegDuration(bytes); return d === null ? null : { seconds: d.seconds, exact: true, kind: 'mpeg' }; }
      case 'wav': { const h = readWavHeader(bytes); return h === null ? null : { seconds: h.frames / h.sampleRate, exact: true, kind: 'wav' }; }
      case 'flac': case 'mp4': case 'ogg': { const d = await audioDuration(blob, timeoutMs); return d === null ? null : { seconds: d, exact: false, kind: 'audio-element' }; }
      default: return null;
    }
  } catch { return null; }
}

// Step 3 / step 5 decision: TOO_LONG detail or null (continue). Exact probes are held to maxSeconds, inexact to 2·maxSeconds.
export function durationVerdict(probe, maxSeconds) {
  if (!probe || typeof probe.seconds !== 'number' || !Number.isFinite(probe.seconds)) return null;
  const limit = probe.exact ? maxSeconds : 2 * maxSeconds;
  return probe.seconds > limit ? { seconds: probe.seconds, maxSeconds } : null;
}

// Browser decoder: decodeAudioData at 44.1 kHz plus the resample guard for engines that keep the source rate (A43).
export async function browserDecode(ab) {
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const buf = await ctx.decodeAudioData(ab);
  if (buf.sampleRate === 44100) return buf;
  return resampleTo44100(buf);
}

export async function resampleTo44100(buf) {
  const frames = Math.max(1, Math.ceil(buf.duration * 44100));
  const channels = Math.max(1, Math.min(32, buf.numberOfChannels));
  const ctx = new OfflineAudioContext(channels, frames, 44100);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

function mapDecodeError(e) {
  if (e instanceof EngineError) return e;
  const oom = classifyAllocationFailure(e);
  if (oom) return new EngineError('OOM', e && e.message ? e.message : 'allocation failed', { phase: 'decode' });
  return new EngineError('DECODE', e && e.message ? e.message : String(e), { name: e && e.name ? e.name : 'Error' });
}

// decodedInput = { blob, buffer, duration, probe: { probeMs, probeKind }, decodeMs }
export async function decodeInput(blob, limits, { decode = browserDecode, source = 'file' } = {}) {
  const maxBytes = limits.maxBytes;
  const maxSeconds = limits.maxSeconds;
  if (typeof blob.size === 'number' && blob.size > maxBytes) {
    throw new EngineError(source === 'url' ? 'URL_TOO_LARGE' : 'TOO_LARGE', `size ${blob.size} > ${maxBytes}`, { bytes: blob.size, maxBytes });
  }
  const ab = await blob.arrayBuffer();
  const p0 = nowMs();
  const probe = await probeDuration(blob, ab);
  const probeMs = nowMs() - p0;
  const probeInfo = { probeMs, probeKind: probe ? probe.kind : 'none' };
  // Errors raised after the probe carry its timing as `probe` (not in `detail`) so the UI can record probeMs/probeKind
  // for a refused input — the §16.D cases assert that a TOO_LONG came from the pre-decode probe (decodeMs undefined).
  const withProbe = (err, decodeMs) => { err.probe = decodeMs === undefined ? probeInfo : { ...probeInfo, decodeMs }; return err; };
  const verdict = durationVerdict(probe, maxSeconds);
  if (verdict) throw withProbe(new EngineError('TOO_LONG', `probed ${verdict.seconds}s > ${maxSeconds}s`, verdict));
  const d0 = nowMs();
  let buffer;
  try { buffer = await decode(ab); } catch (e) { throw withProbe(mapDecodeError(e)); }
  const decodeMs = nowMs() - d0;
  if (buffer.duration > maxSeconds) {
    throw withProbe(new EngineError('TOO_LONG', `decoded ${buffer.duration}s > ${maxSeconds}s`, { seconds: buffer.duration, maxSeconds }), decodeMs);
  }
  return { blob, buffer, duration: buffer.duration, probe: probeInfo, decodeMs };
}

// Planar copies per dispatch (step 6 channel mapping): mono duplicated, > 2 channels → channels 0 and 1. Fresh buffers.
export function copyInput(buffer) {
  const n = buffer.length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  if (n > 0) {
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, buffer.numberOfChannels === 1 ? 0 : 1);
  }
  return { left, right };
}

// Re-decode from the retained Blob (the AudioBuffer was freed at the first dispatch), copy, drop the temporary buffer.
export async function decodeForDispatch(decodedInput, limits, { decode = browserDecode } = {}) {
  void limits;
  const t0 = nowMs();
  let ab = await decodedInput.blob.arrayBuffer();
  let buffer;
  try { buffer = await decode(ab); } catch (e) { throw mapDecodeError(e); }
  ab = null;
  let copies;
  try { copies = copyInput(buffer); } catch (e) {
    const oom = classifyAllocationFailure(e);
    throw oom ? new EngineError('OOM', e.message, { phase: 'copy' }) : e;
  }
  buffer = null;
  return { left: copies.left, right: copies.right, decodeMs: nowMs() - t0 };
}
