// site/src/engine/normalize.mjs — design §3.4 (spec_utils.normalize, joint peak over both channels).
// All functions take BOTH channels: audio-separator's normalize() computes max|x| over the whole [2, n] array
// and scales both channels by the same factor. Runtime-agnostic, pure.

// Joint max|x| over left and right; NaN and ±Infinity are treated as 0 (ignored).
export function peakOf(left, right) {
  let p = 0;
  for (let i = 0; i < left.length; i++) {
    const v = left[i];
    const a = v < 0 ? -v : v;
    if (a > p && a < Infinity) p = a;
  }
  for (let i = 0; i < right.length; i++) {
    const v = right[i];
    const a = v < 0 ? -v : v;
    if (a > p && a < Infinity) p = a;
  }
  return p;
}

// In-place `normalize(stem, max_peak=p)`: scales both channels by p/peak when the joint peak exceeds p.
// No-op when peak <= p or peak === 0. Returns the factor applied (1 for a no-op).
export function scaleDownToPeak(left, right, p) {
  const peak = peakOf(left, right);
  if (peak === 0 || peak <= p) return 1;
  const scale = p / peak;
  for (let i = 0; i < left.length; i++) left[i] *= scale;
  for (let i = 0; i < right.length; i++) right[i] *= scale;
  return scale;
}

// Replaces NaN/±Infinity with 0 in place; returns the number of samples replaced.
export function scrubNonFinite(arr) {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== v || v === Infinity || v === -Infinity) { arr[i] = 0; count++; }
  }
  return count;
}
