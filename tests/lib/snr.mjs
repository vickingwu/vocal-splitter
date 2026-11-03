// tests/lib/snr.mjs — raw SNR, least-squares gain, fitted SNR, max abs error (design §16.B). Index through the views.
export function snrDb(ref, ours) {
  const n = Math.min(ref.length, ours.length);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const r = ref[i]; num += r * r; const d = r - ours[i]; den += d * d; }
  if (den === 0) return Infinity;
  return 10 * Math.log10(num / den);
}

// g minimizing Σ(ref − g·ours)²
export function fittedGain(ref, ours) {
  const n = Math.min(ref.length, ours.length);
  let xy = 0, xx = 0;
  for (let i = 0; i < n; i++) { xy += ref[i] * ours[i]; xx += ours[i] * ours[i]; }
  return xx === 0 ? 0 : xy / xx;
}

export function snrFittedDb(ref, ours) {
  const g = fittedGain(ref, ours);
  const n = Math.min(ref.length, ours.length);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const r = ref[i]; num += r * r; const d = r - g * ours[i]; den += d * d; }
  return { gain: g, snrDb: den === 0 ? Infinity : 10 * Math.log10(num / den) };
}

export function maxAbsErr(ref, ours) {
  const n = Math.min(ref.length, ours.length);
  let m = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(ref[i] - ours[i]); if (d > m) m = d; }
  return m;
}

export function maxAbs(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}

// Stereo helpers: both channels concatenated into one comparison.
export function snrStereoDb(refL, refR, ourL, ourR) {
  let num = 0, den = 0;
  for (const [ref, ours] of [[refL, ourL], [refR, ourR]]) {
    const n = Math.min(ref.length, ours.length);
    for (let i = 0; i < n; i++) { const r = ref[i]; num += r * r; const d = r - ours[i]; den += d * d; }
  }
  return den === 0 ? Infinity : 10 * Math.log10(num / den);
}

// Design §15 (b-vocal, no NoVox): both stereo signals peak-normalized to exactly `peak` (joint over L/R, up or down), then
// 10·log10(Σref′² / Σ(ref′ − ours′)²). Inputs are copied; returns the dB value and the two gains applied.
export function snrPeakNormalizedDb(refL, refR, ourL, ourR, peak = 0.9) {
  const norm = (l, r) => {
    const a = Float64Array.from(l), b = Float64Array.from(r);
    let p = 0;
    for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p && v < Infinity) p = v; }
    for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]); if (v > p && v < Infinity) p = v; }
    const g = p > 0 ? peak / p : 1;
    for (let i = 0; i < a.length; i++) a[i] *= g;
    for (let i = 0; i < b.length; i++) b[i] *= g;
    return { l: a, r: b, g };
  };
  const ref = norm(refL, refR), ours = norm(ourL, ourR);
  return { db: snrStereoDb(ref.l, ref.r, ours.l, ours.r), refGain: ref.g, oursGain: ours.g };
}

export function fittedStereo(refL, refR, ourL, ourR) {
  let xy = 0, xx = 0;
  for (const [ref, ours] of [[refL, ourL], [refR, ourR]]) {
    const n = Math.min(ref.length, ours.length);
    for (let i = 0; i < n; i++) { xy += ref[i] * ours[i]; xx += ours[i] * ours[i]; }
  }
  const g = xx === 0 ? 0 : xy / xx;
  let num = 0, den = 0;
  for (const [ref, ours] of [[refL, ourL], [refR, ourR]]) {
    const n = Math.min(ref.length, ours.length);
    for (let i = 0; i < n; i++) { const r = ref[i]; num += r * r; const d = r - g * ours[i]; den += d * d; }
  }
  return { gain: g, snrDb: den === 0 ? Infinity : 10 * Math.log10(num / den) };
}
