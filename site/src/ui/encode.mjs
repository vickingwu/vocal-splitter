// site/src/ui/encode.mjs — output encoding (design §11): WAV Blob per stem, MP3 workers (parallel or sequential per the
// device policy), file names, and the blob-URL lifecycle of design_accepted DA-6 (every download anchor creates its object
// URL at click time and revokes it 60 s later; the players get their own URLs, revoked by the job-level cleanup).
import { toInt16Planar, writeWav16 } from '../engine/wav.mjs';

const FS_INVALID = /[\\/:*?"<>|]/g;
export const STEM_LABEL = Object.freeze({ vocals: '人声', instrumental: '伴奏' });

export function safeFileName(name) { return String(name).replace(FS_INVALID, '_'); }

export function stemFileName(base, stem, ext) {
  return `${safeFileName(base)}_${STEM_LABEL[stem]}.${ext}`;
}

// [L, R] Float32 → { blob: WAV Blob, int16: [Int16Array, Int16Array] }; the ArrayBuffer reference is dropped once the Blob exists.
export function buildWav(stem, sampleRate = 44100) {
  const [l, r] = toInt16Planar(stem[0], stem[1]);
  let ab = writeWav16(l, r, sampleRate);
  const blob = new Blob([ab], { type: 'audio/wav' });
  ab = null;
  return { blob, int16: [l, r] };
}

// Drives one classic Worker('mp3-worker.js') per stem. `stems` = { vocals: [Int16, Int16], instrumental: [Int16, Int16] }.
// Callbacks: onProgress(stem, fraction), onDone(stem, blob), onError(stem). Returns { cancel(), cancelStem(stem) }.
export function encodeMp3Stems(stems, { parallel = true, onProgress, onDone, onError, createWorker, now = () => Date.now() } = {}) {
  const spawn = createWorker ?? (() => new Worker('mp3-worker.js'));
  const running = new Map();
  const order = ['vocals', 'instrumental'];
  let cancelled = false;

  const finish = (stem) => {
    const w = running.get(stem);
    if (w) { try { w.terminate(); } catch { /* ignore */ } running.delete(stem); }
  };

  const startStem = (stem) => new Promise((resolve) => {
    if (cancelled || !stems[stem]) { resolve(); return; }
    let worker;
    try { worker = spawn(); } catch (e) { void e; onError?.(stem, 'spawn'); resolve(); return; }
    running.set(stem, worker);
    const t0 = now();
    let settled = false;
    const settle = () => { if (!settled) { settled = true; finish(stem); resolve(); } };
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') { onProgress?.(stem, m.fraction); return; }
      if (m.type === 'done') {
        const bytes = m.bytes;
        if (!bytes || bytes.byteLength === 0) { onError?.(stem, 'empty'); settle(); return; }
        onDone?.(stem, new Blob([bytes], { type: 'audio/mpeg' }), now() - t0);
        settle();
        return;
      }
      if (m.type === 'error') { onError?.(stem, m.message); settle(); }
    };
    worker.onerror = (e) => { onError?.(stem, e && e.message ? e.message : 'worker error'); settle(); };
    const [l, r] = stems[stem];
    try { worker.postMessage({ left: l, right: r }, [l.buffer, r.buffer]); } catch (e) { onError?.(stem, e && e.message ? e.message : 'post'); settle(); }
  });

  let done;
  if (parallel) done = Promise.all(order.map((s) => startStem(s)));
  else done = (async () => { for (const s of order) await startStem(s); })();

  return {
    done,
    cancel() { cancelled = true; for (const stem of [...running.keys()]) finish(stem); },
    cancelStem(stem) { finish(stem); },
  };
}

// Object-URL registry: player URLs live until revokeAll(); download anchors create a URL per click, revoked 60 s later (DA-6).
export function createUrlRegistry({ urlApi = URL, setTimeout: st = (fn, ms) => globalThis.setTimeout(fn, ms), revokeMs = 60_000 } = {}) {
  const live = new Set();
  const revoke = (u) => { try { urlApi.revokeObjectURL(u); } catch { /* ignore */ } live.delete(u); };
  return {
    playerUrl(blob) { const u = urlApi.createObjectURL(blob); live.add(u); return u; },
    attachDownload(anchor, getBlob) {
      anchor.addEventListener('click', (e) => {
        if (anchor.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
        const blob = getBlob();
        if (!blob) { e.preventDefault(); return; }
        const u = urlApi.createObjectURL(blob);
        live.add(u);
        anchor.href = u;                                   // synchronously, so the native download navigation uses it
        st(() => revoke(u), revokeMs);
      });
    },
    revokeAll() { for (const u of [...live]) revoke(u); },
    get size() { return live.size; },
  };
}
