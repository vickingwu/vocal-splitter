// tests/unit/fft.test.mjs — design §16.A row `fft.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, factorize, packRealPair, unpackRealPair, makePairWork } from '../../site/src/engine/fft.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function naiveDft(re, im) {
  const n = re.length;
  const outRe = new Float64Array(n), outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) {
      const theta = -2 * Math.PI * ((j * k) % n) / n;
      const c = Math.cos(theta), s = Math.sin(theta);
      sr += re[j] * c - im[j] * s;
      si += re[j] * s + im[j] * c;
    }
    outRe[k] = sr; outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function maxAbs(a) { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; }

const SIZES = [2048, 4096, 5120, 6144, 7680];

test('factorization prefers 8, then 4, 2, 3, 5 (or 4/2/3/5 without radix-8) and rejects other primes', () => {
  assert.deepEqual(factorize(7680), [8, 8, 8, 3, 5]);
  assert.deepEqual(factorize(6144), [8, 8, 8, 4, 3]);
  assert.deepEqual(factorize(5120), [8, 8, 8, 2, 5]);
  assert.deepEqual(factorize(4096), [8, 8, 8, 8]);
  assert.deepEqual(factorize(2048), [8, 8, 8, 4]);
  assert.deepEqual(factorize(7680, false), [4, 4, 4, 4, 2, 3, 5]);
  assert.deepEqual(factorize(6144, false), [4, 4, 4, 4, 4, 2, 3]);
  assert.deepEqual(factorize(5120, false), [4, 4, 4, 4, 4, 5]);
  assert.deepEqual(factorize(4096, false), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(factorize(2048, false), [4, 4, 4, 4, 4, 2]);
  assert.deepEqual(factorize(1), []);
  for (const bad of [7, 14, 7680 * 7, 11]) {
    assert.throws(() => new FFT(bad), (e) => e instanceof EngineError && e.code === 'FFT_SIZE');
    assert.throws(() => new FFT(bad, { useRadix8: false }), (e) => e instanceof EngineError && e.code === 'FFT_SIZE');
  }
});

for (const n of SIZES) {
  test(`radix-8 plan equals the 4/2/3/5 plan for n = ${n}`, () => {
    const rand = rng(777 + n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = rand() * 2 - 1; im[i] = rand() * 2 - 1; }
    const a = new FFT(n), b = new FFT(n, { useRadix8: false });
    assert.ok(a.radices.includes(8) && !b.radices.includes(8));
    const aRe = new Float64Array(n), aIm = new Float64Array(n), bRe = new Float64Array(n), bIm = new Float64Array(n);
    a.forward(re, im, aRe, aIm); b.forward(re, im, bRe, bIm);
    let err = 0, scale = 0;
    for (let k = 0; k < n; k++) { err = Math.max(err, Math.abs(aRe[k] - bRe[k]), Math.abs(aIm[k] - bIm[k])); scale = Math.max(scale, Math.abs(bRe[k]), Math.abs(bIm[k])); }
    assert.ok(err / scale < 1e-13, `radix-8 vs radix-4 plans differ: ${err / scale}`);
    a.inverseUnscaled(aRe, aIm, bRe, bIm);
    let rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(bRe[i] / n - re[i]), Math.abs(bIm[i] / n - im[i]));
    assert.ok(rt < 1e-9, `inverseUnscaled / n round trip ${rt}`);
  });
}

for (const n of SIZES) {
  test(`forward matches the naive DFT for n = ${n}`, () => {
    const rand = rng(1234 + n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = rand() * 2 - 1; im[i] = rand() * 2 - 1; }
    const fft = new FFT(n);
    const outRe = new Float64Array(n), outIm = new Float64Array(n);
    fft.forward(re, im, outRe, outIm);
    const ref = naiveDft(re, im);
    let maxErr = 0;
    for (let k = 0; k < n; k++) {
      const e = Math.hypot(outRe[k] - ref.re[k], outIm[k] - ref.im[k]);
      if (e > maxErr) maxErr = e;
    }
    let refMax = 0;
    for (let k = 0; k < n; k++) { const v = Math.hypot(ref.re[k], ref.im[k]); if (v > refMax) refMax = v; }
    const rel = maxErr / refMax;
    console.log(`fft n=${n}: max|X - X_dft| / max|X_dft| = ${rel.toExponential(3)}`);
    assert.ok(rel < 1e-3, `relative error ${rel} >= 1e-3`);
    assert.ok(rel < 1e-10, `relative error ${rel} unexpectedly large (expected < 1e-12 class)`);

    // round trip
    const backRe = new Float64Array(n), backIm = new Float64Array(n);
    fft.inverse(outRe, outIm, backRe, backIm);
    let rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(backRe[i] - re[i]), Math.abs(backIm[i] - im[i]));
    console.log(`fft n=${n}: round-trip max err = ${rt.toExponential(3)}`);
    assert.ok(rt < 1e-9, `round-trip error ${rt} >= 1e-9`);
  });
}

test('output aliasing the input is handled for a single-stage size', () => {
  const fft = new FFT(4);
  const re = new Float64Array([1, 2, 3, 4]), im = new Float64Array(4);
  const ref = naiveDft(re, im);
  fft.forward(re, im, re, im);
  for (let k = 0; k < 4; k++) { assert.ok(Math.abs(re[k] - ref.re[k]) < 1e-12); assert.ok(Math.abs(im[k] - ref.im[k]) < 1e-12); }
});

for (const n of [7680, 6144, 2048, 16]) {
  test(`real-pair packing equals two separate complex FFTs for n = ${n}`, () => {
    const rand = rng(99 + n);
    const l = new Float64Array(n), r = new Float64Array(n);
    for (let i = 0; i < n; i++) { l[i] = rand() * 2 - 1; r[i] = rand() * 2 - 1; }
    const fft = new FFT(n);
    const half = n / 2;
    const lRe = new Float64Array(half + 1), lIm = new Float64Array(half + 1);
    const rRe = new Float64Array(half + 1), rIm = new Float64Array(half + 1);
    const work = makePairWork(n);
    packRealPair(fft, l, r, lRe, lIm, rRe, rIm, work);

    const zero = new Float64Array(n);
    const refL = { re: new Float64Array(n), im: new Float64Array(n) };
    const refR = { re: new Float64Array(n), im: new Float64Array(n) };
    fft.forward(l, zero, refL.re, refL.im);
    fft.forward(r, zero, refR.re, refR.im);
    let err = 0;
    for (let k = 0; k <= half; k++) {
      err = Math.max(err, Math.abs(lRe[k] - refL.re[k]), Math.abs(lIm[k] - refL.im[k]),
        Math.abs(rRe[k] - refR.re[k]), Math.abs(rIm[k] - refR.im[k]));
    }
    const scale = Math.max(maxAbs(refL.re), maxAbs(refR.re));
    console.log(`pack n=${n}: max abs err = ${err.toExponential(3)} (spectrum scale ${scale.toFixed(1)})`);
    assert.ok(err / scale < 1e-12, `packing error ${err / scale} >= 1e-12 relative`);

    // inverse: unpack must reproduce l and r (Im at DC/Nyquist is already 0 for real input)
    const outL = new Float64Array(n), outR = new Float64Array(n);
    unpackRealPair(fft, lRe, lIm, rRe, rIm, outL, outR, work);
    let rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(outL[i] - l[i]), Math.abs(outR[i] - r[i]));
    assert.ok(rt < 1e-12, `unpack round trip ${rt}`);

    // irfft semantics: a non-zero Im at DC / Nyquist is ignored
    lIm[0] = 5; lIm[half] = -3; rIm[0] = 2; rIm[half] = 7;
    unpackRealPair(fft, lRe, lIm, rRe, rIm, outL, outR, work);
    rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(outL[i] - l[i]), Math.abs(outR[i] - r[i]));
    assert.ok(rt < 1e-12, `Im DC/Nyquist must be ignored: ${rt}`);
  });
}
