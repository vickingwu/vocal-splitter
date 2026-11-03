// site/src/engine/fft.mjs — design §4: mixed-radix Stockham autosort FFT (radices 4, 2, 3, 5), Float64.
// Decimation in frequency. At every stage the data is viewed as `s` interleaved sub-problems of length `len`
// (element p of sub-problem q at index q + s·p); a radix-R stage splits each into R problems of length len/R:
//   y[q + s·(R·p + k)] = W_len^{p·k} · Σ_r x[q + s·(p + r·m)] · W_R^{r·k},   m = len / R,  k = 0..R−1
// so the final output is in natural order without a bit-reversal pass.
// Runtime-agnostic, no globals. Throws EngineError('FFT_SIZE') for sizes with a prime factor other than 2, 3, 5.
import { EngineError } from './errors.mjs';

const SQRT3_2 = Math.sqrt(3) / 2;
const C5_1 = Math.cos(2 * Math.PI / 5), C5_2 = Math.cos(4 * Math.PI / 5);
const S5_1 = Math.sin(2 * Math.PI / 5), S5_2 = Math.sin(4 * Math.PI / 5);

// Radices in preference order 8, 4, 2, 3, 5 (radix-8 added after the §4 budget bench measured 14.8 s with 4/2/3/5 —
// the A14 fallback; `useRadix8 = false` keeps the original 4/2/3/5 plan for the bench comparison).
export function factorize(n, useRadix8 = true) {
  if (!Number.isInteger(n) || n < 1) throw new EngineError('FFT_SIZE', `FFT size must be a positive integer, got ${n}`, { n });
  const radices = [];
  let rest = n;
  if (useRadix8) while (rest % 8 === 0) { radices.push(8); rest /= 8; }
  while (rest % 4 === 0) { radices.push(4); rest /= 4; }
  if (rest % 2 === 0) { radices.push(2); rest /= 2; }
  while (rest % 3 === 0) { radices.push(3); rest /= 3; }
  while (rest % 5 === 0) { radices.push(5); rest /= 5; }
  if (rest !== 1) throw new EngineError('FFT_SIZE', `FFT size ${n} has a prime factor other than 2, 3, 5`, { n });
  return radices;
}

export class FFT {
  constructor(n, { useRadix8 = true } = {}) {
    const radices = factorize(n, useRadix8);
    this.n = n;
    this.radices = radices;
    this.stages = [];
    let len = n, s = 1;
    for (const R of radices) {
      const m = len / R;
      // twiddles W_len^{p·k} for p in [0, m), k in [1, R): cos and sin stored separately (sign applied per direction)
      const twC = new Float64Array(m * (R - 1));
      const twS = new Float64Array(m * (R - 1));
      for (let p = 0; p < m; p++) {
        for (let k = 1; k < R; k++) {
          const theta = 2 * Math.PI * ((p * k) % len) / len;
          twC[p * (R - 1) + k - 1] = Math.cos(theta);
          twS[p * (R - 1) + k - 1] = Math.sin(theta);
        }
      }
      this.stages.push({ R, m, s, twC, twS });
      len = m;
      s *= R;
    }
    this.scratchRe = [new Float64Array(n), new Float64Array(n)];
    this.scratchIm = [new Float64Array(n), new Float64Array(n)];
  }

  forward(re, im, outRe, outIm) { this._run(re, im, outRe, outIm, -1); }

  // Inverse transform scaled by 1/n.
  inverse(re, im, outRe, outIm) {
    this._run(re, im, outRe, outIm, 1);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) { outRe[i] *= inv; outIm[i] *= inv; }
  }

  // Inverse transform WITHOUT the 1/n scaling (callers fold 1/n into a later multiply).
  inverseUnscaled(re, im, outRe, outIm) { this._run(re, im, outRe, outIm, 1); }

  _run(re, im, outRe, outIm, sign) {
    const n = this.n, stages = this.stages;
    if (stages.length === 0) { outRe[0] = re[0]; outIm[0] = im[0]; return; }
    let srcRe = re, srcIm = im;
    const last = stages.length - 1;
    const aliased = stages.length === 1 && (outRe === re || outIm === im || outRe === im || outIm === re);
    for (let i = 0; i <= last; i++) {
      let dstRe, dstIm;
      if (i === last && !aliased) { dstRe = outRe; dstIm = outIm; }
      else { dstRe = this.scratchRe[i & 1]; dstIm = this.scratchIm[i & 1]; }
      const st = stages[i];
      switch (st.R) {
        case 8: stage8(st, srcRe, srcIm, dstRe, dstIm, sign); break;
        case 4: stage4(st, srcRe, srcIm, dstRe, dstIm, sign); break;
        case 2: stage2(st, srcRe, srcIm, dstRe, dstIm, sign); break;
        case 3: stage3(st, srcRe, srcIm, dstRe, dstIm, sign); break;
        default: stage5(st, srcRe, srcIm, dstRe, dstIm, sign); break;
      }
      srcRe = dstRe; srcIm = dstIm;
    }
    if (aliased) { for (let i = 0; i < n; i++) { outRe[i] = srcRe[i]; outIm[i] = srcIm[i]; } }
  }
}

function stage2(st, xr, xi, yr, yi, sign) {
  const { m, s, twC, twS } = st;
  const sm = s * m;
  for (let p = 0; p < m; p++) {
    const wr = twC[p], wi = sign * twS[p];
    const base = s * p, out = 2 * s * p;
    for (let q = 0; q < s; q++) {
      const i0 = q + base, i1 = i0 + sm;
      const ar = xr[i0], ai = xi[i0], br = xr[i1], bi = xi[i1];
      yr[q + out] = ar + br; yi[q + out] = ai + bi;
      const dr = ar - br, di = ai - bi;
      yr[q + out + s] = dr * wr - di * wi;
      yi[q + out + s] = dr * wi + di * wr;
    }
  }
}

// Radix-8 butterfly as two 4-point DFTs (even / odd inputs) combined with W_8^k:
//   y_k = E_k + W_8^k·O_k,  y_{k+4} = E_k − W_8^k·O_k  (k = 0..3);  W_8 = (√2/2)(1 + sign·i), W_8² = sign·i, W_8³ = (√2/2)(−1 + sign·i)
function stage8(st, xr, xi, yr, yi, sign) {
  const { m, s, twC, twS } = st;
  const sm = s * m;
  const h = Math.SQRT1_2;
  for (let p = 0; p < m; p++) {
    const t = 7 * p;
    const w1r = twC[t], w1i = sign * twS[t];
    const w2r = twC[t + 1], w2i = sign * twS[t + 1];
    const w3r = twC[t + 2], w3i = sign * twS[t + 2];
    const w4r = twC[t + 3], w4i = sign * twS[t + 3];
    const w5r = twC[t + 4], w5i = sign * twS[t + 4];
    const w6r = twC[t + 5], w6i = sign * twS[t + 5];
    const w7r = twC[t + 6], w7i = sign * twS[t + 6];
    const base = s * p, out = 8 * s * p;
    for (let q = 0; q < s; q++) {
      const i0 = q + base, i1 = i0 + sm, i2 = i1 + sm, i3 = i2 + sm, i4 = i3 + sm, i5 = i4 + sm, i6 = i5 + sm, i7 = i6 + sm;
      const a0r = xr[i0], a0i = xi[i0], a1r = xr[i1], a1i = xi[i1], a2r = xr[i2], a2i = xi[i2], a3r = xr[i3], a3i = xi[i3];
      const a4r = xr[i4], a4i = xi[i4], a5r = xr[i5], a5i = xi[i5], a6r = xr[i6], a6i = xi[i6], a7r = xr[i7], a7i = xi[i7];
      // even 4-point DFT of (a0, a2, a4, a6)
      const et0r = a0r + a4r, et0i = a0i + a4i, et1r = a0r - a4r, et1i = a0i - a4i;
      const et2r = a2r + a6r, et2i = a2i + a6i, et3r = sign * (a2r - a6r), et3i = sign * (a2i - a6i);
      const E0r = et0r + et2r, E0i = et0i + et2i, E2r = et0r - et2r, E2i = et0i - et2i;
      const E1r = et1r - et3i, E1i = et1i + et3r, E3r = et1r + et3i, E3i = et1i - et3r;
      // odd 4-point DFT of (a1, a3, a5, a7)
      const ot0r = a1r + a5r, ot0i = a1i + a5i, ot1r = a1r - a5r, ot1i = a1i - a5i;
      const ot2r = a3r + a7r, ot2i = a3i + a7i, ot3r = sign * (a3r - a7r), ot3i = sign * (a3i - a7i);
      const O0r = ot0r + ot2r, O0i = ot0i + ot2i, O2r = ot0r - ot2r, O2i = ot0i - ot2i;
      const O1r = ot1r - ot3i, O1i = ot1i + ot3r, O3r = ot1r + ot3i, O3i = ot1i - ot3r;
      // odd terms rotated by W_8^k
      const P1r = h * (O1r - sign * O1i), P1i = h * (O1i + sign * O1r);
      const P2r = -sign * O2i, P2i = sign * O2r;
      const P3r = h * (-O3r - sign * O3i), P3i = h * (-O3i + sign * O3r);
      const y0r = E0r + O0r, y0i = E0i + O0i, y4r = E0r - O0r, y4i = E0i - O0i;
      const y1r = E1r + P1r, y1i = E1i + P1i, y5r = E1r - P1r, y5i = E1i - P1i;
      const y2r = E2r + P2r, y2i = E2i + P2i, y6r = E2r - P2r, y6i = E2i - P2i;
      const y3r = E3r + P3r, y3i = E3i + P3i, y7r = E3r - P3r, y7i = E3i - P3i;
      const o = q + out;
      yr[o] = y0r; yi[o] = y0i;
      yr[o + s] = y1r * w1r - y1i * w1i; yi[o + s] = y1r * w1i + y1i * w1r;
      yr[o + 2 * s] = y2r * w2r - y2i * w2i; yi[o + 2 * s] = y2r * w2i + y2i * w2r;
      yr[o + 3 * s] = y3r * w3r - y3i * w3i; yi[o + 3 * s] = y3r * w3i + y3i * w3r;
      yr[o + 4 * s] = y4r * w4r - y4i * w4i; yi[o + 4 * s] = y4r * w4i + y4i * w4r;
      yr[o + 5 * s] = y5r * w5r - y5i * w5i; yi[o + 5 * s] = y5r * w5i + y5i * w5r;
      yr[o + 6 * s] = y6r * w6r - y6i * w6i; yi[o + 6 * s] = y6r * w6i + y6i * w6r;
      yr[o + 7 * s] = y7r * w7r - y7i * w7i; yi[o + 7 * s] = y7r * w7i + y7i * w7r;
    }
  }
}

function stage4(st, xr, xi, yr, yi, sign) {
  const { m, s, twC, twS } = st;
  const sm = s * m;
  for (let p = 0; p < m; p++) {
    const t = 3 * p;
    const w1r = twC[t], w1i = sign * twS[t];
    const w2r = twC[t + 1], w2i = sign * twS[t + 1];
    const w3r = twC[t + 2], w3i = sign * twS[t + 2];
    const base = s * p, out = 4 * s * p;
    for (let q = 0; q < s; q++) {
      const i0 = q + base, i1 = i0 + sm, i2 = i1 + sm, i3 = i2 + sm;
      const a0r = xr[i0], a0i = xi[i0], a1r = xr[i1], a1i = xi[i1];
      const a2r = xr[i2], a2i = xi[i2], a3r = xr[i3], a3i = xi[i3];
      const t0r = a0r + a2r, t0i = a0i + a2i, t1r = a0r - a2r, t1i = a0i - a2i;
      const t2r = a1r + a3r, t2i = a1i + a3i, t3r = a1r - a3r, t3i = a1i - a3i;
      // y1 = t1 + sign·i·t3 ; y3 = t1 − sign·i·t3   (i·t3 = (−t3i, t3r))
      const y1r = t1r - sign * t3i, y1i = t1i + sign * t3r;
      const y2r = t0r - t2r, y2i = t0i - t2i;
      const y3r = t1r + sign * t3i, y3i = t1i - sign * t3r;
      const o = q + out;
      yr[o] = t0r + t2r; yi[o] = t0i + t2i;
      yr[o + s] = y1r * w1r - y1i * w1i; yi[o + s] = y1r * w1i + y1i * w1r;
      yr[o + 2 * s] = y2r * w2r - y2i * w2i; yi[o + 2 * s] = y2r * w2i + y2i * w2r;
      yr[o + 3 * s] = y3r * w3r - y3i * w3i; yi[o + 3 * s] = y3r * w3i + y3i * w3r;
    }
  }
}

function stage3(st, xr, xi, yr, yi, sign) {
  const { m, s, twC, twS } = st;
  const sm = s * m;
  const s3 = sign * SQRT3_2;
  for (let p = 0; p < m; p++) {
    const t = 2 * p;
    const w1r = twC[t], w1i = sign * twS[t];
    const w2r = twC[t + 1], w2i = sign * twS[t + 1];
    const base = s * p, out = 3 * s * p;
    for (let q = 0; q < s; q++) {
      const i0 = q + base, i1 = i0 + sm, i2 = i1 + sm;
      const a0r = xr[i0], a0i = xi[i0], a1r = xr[i1], a1i = xi[i1], a2r = xr[i2], a2i = xi[i2];
      const tr = a1r + a2r, ti = a1i + a2i, ur = a1r - a2r, ui = a1i - a2i;
      const mr = a0r - 0.5 * tr, mi = a0i - 0.5 * ti;
      // y1 = m + s3·i·u ; y2 = m − s3·i·u   (i·u = (−ui, ur))
      const y1r = mr - s3 * ui, y1i = mi + s3 * ur;
      const y2r = mr + s3 * ui, y2i = mi - s3 * ur;
      const o = q + out;
      yr[o] = a0r + tr; yi[o] = a0i + ti;
      yr[o + s] = y1r * w1r - y1i * w1i; yi[o + s] = y1r * w1i + y1i * w1r;
      yr[o + 2 * s] = y2r * w2r - y2i * w2i; yi[o + 2 * s] = y2r * w2i + y2i * w2r;
    }
  }
}

function stage5(st, xr, xi, yr, yi, sign) {
  const { m, s, twC, twS } = st;
  const sm = s * m;
  const s1 = sign * S5_1, s2 = sign * S5_2;
  for (let p = 0; p < m; p++) {
    const t = 4 * p;
    const w1r = twC[t], w1i = sign * twS[t];
    const w2r = twC[t + 1], w2i = sign * twS[t + 1];
    const w3r = twC[t + 2], w3i = sign * twS[t + 2];
    const w4r = twC[t + 3], w4i = sign * twS[t + 3];
    const base = s * p, out = 5 * s * p;
    for (let q = 0; q < s; q++) {
      const i0 = q + base, i1 = i0 + sm, i2 = i1 + sm, i3 = i2 + sm, i4 = i3 + sm;
      const a0r = xr[i0], a0i = xi[i0];
      const a1r = xr[i1], a1i = xi[i1], a2r = xr[i2], a2i = xi[i2];
      const a3r = xr[i3], a3i = xi[i3], a4r = xr[i4], a4i = xi[i4];
      const t1r = a1r + a4r, t1i = a1i + a4i, t2r = a2r + a3r, t2i = a2i + a3i;
      const u1r = a1r - a4r, u1i = a1i - a4i, u2r = a2r - a3r, u2i = a2i - a3i;
      const b1r = a0r + C5_1 * t1r + C5_2 * t2r, b1i = a0i + C5_1 * t1i + C5_2 * t2i;
      const b2r = a0r + C5_2 * t1r + C5_1 * t2r, b2i = a0i + C5_2 * t1i + C5_1 * t2i;
      // v1 = s1·u1 + s2·u2 ; v2 = s2·u1 − s1·u2 ; y1 = b1 + i·v1, y4 = b1 − i·v1, y2 = b2 + i·v2, y3 = b2 − i·v2
      const v1r = s1 * u1r + s2 * u2r, v1i = s1 * u1i + s2 * u2i;
      const v2r = s2 * u1r - s1 * u2r, v2i = s2 * u1i - s1 * u2i;
      const y1r = b1r - v1i, y1i = b1i + v1r;
      const y4r = b1r + v1i, y4i = b1i - v1r;
      const y2r = b2r - v2i, y2i = b2i + v2r;
      const y3r = b2r + v2i, y3i = b2i - v2r;
      const o = q + out;
      yr[o] = a0r + t1r + t2r; yi[o] = a0i + t1i + t2i;
      yr[o + s] = y1r * w1r - y1i * w1i; yi[o + s] = y1r * w1i + y1i * w1r;
      yr[o + 2 * s] = y2r * w2r - y2i * w2i; yi[o + 2 * s] = y2r * w2i + y2i * w2r;
      yr[o + 3 * s] = y3r * w3r - y3i * w3i; yi[o + 3 * s] = y3r * w3i + y3i * w3r;
      yr[o + 4 * s] = y4r * w4r - y4i * w4i; yi[o + 4 * s] = y4r * w4i + y4i * w4r;
    }
  }
}

// §4 real-pair packing: z = l + i·r, Z = FFT(z); X_L[k] = (Z[k] + conj Z[N−k]) / 2, X_R[k] = (Z[k] − conj Z[N−k]) / (2i)
// for k = 0..N/2. `l`, `r` are real sequences of length N (any array type); outputs are Float64Array(N/2 + 1).
// `work` is { re: Float64Array(N), im: Float64Array(N), zRe, zIm } scratch owned by the caller (see makePairWork).
export function makePairWork(n) {
  return { re: new Float64Array(n), im: new Float64Array(n), zRe: new Float64Array(n), zIm: new Float64Array(n) };
}

export function packRealPair(fft, l, r, outLRe, outLIm, outRRe, outRIm, work) {
  const n = fft.n, half = n >> 1;
  const { re, im, zRe, zIm } = work;
  // callers may fill work.re / work.im directly (l === work.re, r === work.im) to skip the copy
  if (l !== re) for (let i = 0; i < n; i++) re[i] = l[i];
  if (r !== im) for (let i = 0; i < n; i++) im[i] = r[i];
  fft.forward(re, im, zRe, zIm);
  for (let k = 0; k <= half; k++) {
    const j = k === 0 ? 0 : n - k;
    const a = zRe[k], b = zIm[k], c = zRe[j], d = zIm[j];
    outLRe[k] = 0.5 * (a + c); outLIm[k] = 0.5 * (b - d);
    outRRe[k] = 0.5 * (b + d); outRIm[k] = 0.5 * (c - a);
  }
}

// Inverse of packRealPair with irfft semantics: Im X[0] and Im X[N/2] are ignored (treated as 0);
// Z[k] = X_L[k] + i·X_R[k] for k <= N/2, Z[k] = conj X_L[N−k] + i·conj X_R[N−k] for k > N/2; l = Re IFFT(Z), r = Im IFFT(Z).
// `unscaled = true` skips the 1/n factor (the caller folds it into a later multiply).
export function unpackRealPair(fft, lRe, lIm, rRe, rIm, outL, outR, work, unscaled = false) {
  const n = fft.n, half = n >> 1;
  const { re, im, zRe, zIm } = work;
  for (let k = 0; k <= half; k++) {
    const li = (k === 0 || k === half) ? 0 : lIm[k];
    const ri = (k === 0 || k === half) ? 0 : rIm[k];
    // (lr + i·li) + i·(rr + i·ri) = (lr − ri) + i·(li + rr)
    zRe[k] = lRe[k] - ri; zIm[k] = li + rRe[k];
  }
  for (let k = half + 1; k < n; k++) {
    const j = n - k;
    // conj(X_L[j]) + i·conj(X_R[j]) = (lr − i·li) + i·(rr − i·ri) = (lr + ri) + i·(rr − li)
    zRe[k] = lRe[j] + rIm[j]; zIm[k] = rRe[j] - lIm[j];
  }
  if (unscaled) fft.inverseUnscaled(zRe, zIm, re, im);
  else fft.inverse(zRe, zIm, re, im);
  // callers may pass outL === work.re, outR === work.im to skip the copy
  if (outL !== re) for (let i = 0; i < n; i++) outL[i] = re[i];
  if (outR !== im) for (let i = 0; i < n; i++) outR[i] = im[i];
}
