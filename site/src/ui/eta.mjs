// site/src/ui/eta.mjs — speed and remaining-time estimates for the progress line (FIX-2 R4/R5). Pure: callers pass the clock.
//
// createRateMeter: byte-count samples (t ms, bytesDone) → moving-average speed over the last `windowMs` (5 s) and an ETA
// that is reported only after `warmupMs` (3 s) of samples. separationEta: once >= 2 chunks are done, the median of the last
// <= 5 chunk durations times the remaining chunk count.

export function createRateMeter({ windowMs = 5000, warmupMs = 3000 } = {}) {
  const samples = [];                       // [{ t, bytes }] within the window, oldest first
  let first = null;
  return {
    sample(t, bytes) {
      if (first === null) first = t;
      const last = samples[samples.length - 1];
      if (last && bytes < last.bytes) { samples.length = 0; first = t; }   // a restart (new file / resumed job) resets the window
      samples.push({ t, bytes });
      // keep one sample just outside the window so the average always spans >= windowMs once that much history exists
      while (samples.length > 2 && t - samples[1].t > windowMs) samples.shift();
    },
    // bytes per second over the window (null before two samples or zero elapsed)
    rate(t) {
      if (samples.length < 2) return null;
      const a = samples[0], b = samples[samples.length - 1];
      const dt = (t ?? b.t) - a.t;
      if (dt <= 0) return null;
      // a stalled link decays: elapsed time keeps growing while the byte count does not
      return (b.bytes - a.bytes) / (dt / 1000);
    },
    // seconds remaining, or null before warm-up / without a positive rate
    eta(t, remainingBytes) {
      if (first === null || t - first < warmupMs) return null;
      const r = this.rate(t);
      if (!r || r <= 0) return null;
      return remainingBytes / r;
    },
    reset() { samples.length = 0; first = null; },
  };
}

export function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// chunkEndsMs: completion times of the chunks done so far (ms, same clock), startMs: when the first chunk started.
// → seconds remaining for the (chunkCount − done) chunks still to run, or null before 2 chunks are done.
export function separationEta(chunkEndsMs, chunkCount, startMs) {
  const done = chunkEndsMs.length;
  if (done < 2 || !Number.isFinite(chunkCount) || chunkCount <= done) return done >= 2 && chunkCount === done ? 0 : null;
  const durations = [];
  for (let i = 0; i < done; i++) durations.push(chunkEndsMs[i] - (i === 0 ? startMs : chunkEndsMs[i - 1]));
  const recent = durations.slice(-5);
  const m = median(recent);
  if (!(m > 0)) return null;
  return ((chunkCount - done) * m) / 1000;
}
