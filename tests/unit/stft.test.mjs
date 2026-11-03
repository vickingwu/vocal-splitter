// tests/unit/stft.test.mjs — design §16.A row `stft.test.mjs`: torch STFT/iSTFT semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stftStereo, istftStereo, stftFrames, hannPeriodic } from '../../site/src/engine/stft.mjs';

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

function noise(n, seed) {
  const r = rng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
  return x;
}

function snrDb(ref, ours) {
  let num = 0, den = 0;
  for (let i = 0; i < ref.length; i++) { num += ref[i] * ref[i]; const d = ref[i] - ours[i]; den += d * d; }
  return den === 0 ? Infinity : 10 * Math.log10(num / den);
}

// Reference STFT written out longhand: reflect pad, periodic Hann, naive DFT per frame.
function naiveStft(x, nFft, hop) {
  const L = x.length, pad = nFft / 2, frames = 1 + Math.floor(L / hop), nBins = pad + 1;
  const padded = new Float64Array(L + nFft);
  for (let i = 0; i < pad; i++) padded[i] = x[pad - i];
  for (let i = 0; i < L; i++) padded[pad + i] = x[i];
  for (let j = 0; j < pad; j++) padded[pad + L + j] = x[L - 2 - j];
  const w = hannPeriodic(nFft);
  const re = new Float64Array(nBins * frames), im = new Float64Array(nBins * frames);
  for (let t = 0; t < frames; t++) {
    for (let f = 0; f < nBins; f++) {
      let sr = 0, si = 0;
      for (let n = 0; n < nFft; n++) {
        const v = padded[t * hop + n] * w[n];
        const th = -2 * Math.PI * f * n / nFft;
        sr += v * Math.cos(th); si += v * Math.sin(th);
      }
      re[f * frames + t] = sr; im[f * frames + t] = si;
    }
  }
  return { re, im, frames, nBins };
}

const GEOMS = [
  { name: 'Voc_FT', nFft: 7680, hop: 1024, samples: 261120, frames: 256 },
  { name: 'Tier 2', nFft: 2048, hop: 441, samples: 484659, frames: 1100 },
];

for (const g of GEOMS) {
  test(`${g.name} geometry: ${g.samples} samples → ${g.frames} frames and round trip > 60 dB`, () => {
    assert.equal(stftFrames(g.samples, g.hop), g.frames);
    const left = noise(g.samples, 7), right = noise(g.samples, 8);
    const spec = stftStereo(left, right, { nFft: g.nFft, hop: g.hop, frames: g.frames });
    assert.equal(spec.frames, g.frames);
    assert.equal(spec.nBins, g.nFft / 2 + 1);
    assert.equal(spec.re[0].length, spec.nBins * g.frames);
    const [outL, outR] = istftStereo(spec.re, spec.im, { nFft: g.nFft, hop: g.hop, frames: g.frames });
    assert.equal(outL.length, g.samples);
    assert.equal(outR.length, g.samples);
    const sL = snrDb(left, outL), sR = snrDb(right, outR);
    console.log(`stft ${g.name}: round-trip SNR L=${sL.toFixed(1)} dB R=${sR.toFixed(1)} dB`);
    assert.ok(sL > 60 && sR > 60, `round-trip SNR too low: ${sL}, ${sR}`);
    assert.ok(sL > 120 && sR > 120, `round-trip SNR unexpectedly low for Float32 output: ${sL}, ${sR}`);
  });
}

test('frames is derived when omitted and rejected when inconsistent', () => {
  const x = noise(261120, 1);
  const spec = stftStereo(x, x, { nFft: 7680, hop: 1024 });
  assert.equal(spec.frames, 256);
  assert.throws(() => stftStereo(x, x, { nFft: 7680, hop: 1024, frames: 255 }), /frames/);
});

test('16-point / hop-4 golden: reflect pad + periodic Hann + DFT computed longhand', () => {
  const nFft = 16, hop = 4, L = 40;
  const left = noise(L, 21), right = noise(L, 22);
  const frames = 1 + L / hop; // 11
  const ours = stftStereo(left, right, { nFft, hop, frames });
  const refL = naiveStft(left, nFft, hop), refR = naiveStft(right, nFft, hop);
  assert.equal(ours.frames, frames);
  assert.equal(refL.frames, frames);
  let err = 0;
  for (let i = 0; i < refL.re.length; i++) {
    err = Math.max(err, Math.abs(ours.re[0][i] - refL.re[i]), Math.abs(ours.im[0][i] - refL.im[i]),
      Math.abs(ours.re[1][i] - refR.re[i]), Math.abs(ours.im[1][i] - refR.im[i]));
  }
  console.log(`stft 16/4 golden max err = ${err.toExponential(3)}`);
  assert.ok(err < 1e-12, `golden error ${err}`);

  // inverse of the golden reproduces the input (Float32 output → ≈ 1e-7)
  const [outL, outR] = istftStereo(ours.re, ours.im, { nFft, hop, frames });
  let rt = 0;
  for (let i = 0; i < L; i++) rt = Math.max(rt, Math.abs(outL[i] - left[i]), Math.abs(outR[i] - right[i]));
  assert.ok(rt < 1e-6, `16/4 round trip ${rt}`);
});

test('reflect padding uses torch semantics (x[pad − i] on the left, x[L − 2 − j] on the right)', () => {
  // With a window of ones the first frame's DC bin equals the sum of the padded frame; build the signal so the
  // reflected samples are distinguishable: x = [0,1,2,...]; frame 0 covers padded [0, 16) = x[8..1], x[0..7].
  const nFft = 16, hop = 4, L = 32;
  const x = new Float32Array(L);
  for (let i = 0; i < L; i++) x[i] = i;
  const ref = naiveStft(x, nFft, hop);
  const ours = stftStereo(x, x, { nFft, hop });
  // last frame reaches the right padding: padded index pad+L+j = x[L−2−j]
  let err = 0;
  for (let i = 0; i < ref.re.length; i++) err = Math.max(err, Math.abs(ours.re[0][i] - ref.re[i]), Math.abs(ours.im[0][i] - ref.im[i]));
  assert.ok(err < 1e-9, `reflect semantics mismatch ${err}`);
});
