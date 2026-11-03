// tests/unit/roformer-plan.test.mjs — design §15 / §16.A: planRoformer vs a direct re-implementation of musetric's
// unit_plan.rs::vocals loop (duplicate anchored units KEPT), the VocalsV1 Hamming table, the pack/mask layout and an
// identity fold (Float32 target/counter, f64 intermediate) that must reconstruct the input within 1e-6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoformer, hamming54Table, packRoformer, applyMasks, foldUnit, finalizeFold, separateRoformer } from '../../site/src/engine/roformer.mjs';
import { allocSpectrum } from '../../site/src/engine/stft.mjs';
import { makeOrtFake } from '../lib/fakes.mjs';

const PARAMS = {
  sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 484659, stepSamples: 352800,
  weight: 'hamming54', inputName: 'stft_repr', outputName: 'masks', requiredFeatures: ['shader-f16'],
  minStorageBuffersPerShaderStage: 9, inputPeak: 0.9, outputPeak: 0.9,
};

// unit_plan.rs::vocals, transcribed line by line (u64 arithmetic → plain integers here).
function rustVocalsPlan(samples, chunkSamples = 484659, sampleRate = 44100) {
  const step = Math.min(8 * sampleRate, chunkSamples);
  const units = [];
  let offset = 0;
  while (offset < samples) {
    let unit;
    if (offset + chunkSamples <= samples) unit = { start: offset, length: chunkSamples };
    else if (samples >= chunkSamples) unit = { start: samples - chunkSamples, length: chunkSamples };
    else unit = { start: 0, length: samples };
    units.push(unit);
    offset += step;
  }
  return units;
}

test('planRoformer equals the Rust loop for the §15 lengths (duplicate anchored units kept)', () => {
  for (const n of [0, 1, 1000, 484658, 484659, 484660, 1000000, 1102500, 1323000, 10584000]) {
    const plan = planRoformer(n, PARAMS);
    const rust = rustVocalsPlan(n);
    assert.equal(plan.step, 352800);
    assert.equal(plan.chunkSamples, 484659);
    assert.deepEqual(plan.units.map((u) => [u.start, u.len]), rust.map((u) => [u.start, u.length]), `n = ${n}`);
    for (const u of plan.units) { assert.ok(u.start >= 0 && u.len >= 1 && u.start + u.len <= Math.max(n, 0), `n = ${n}: unit ${JSON.stringify(u)}`); }
  }
});

test('25 s clip (1,102,500 samples) → 4 units, units 3 and 4 both anchored at [617841, 1102500)', () => {
  const { units } = planRoformer(1102500, PARAMS);
  assert.deepEqual(units, [
    { start: 0, len: 484659 },
    { start: 352800, len: 484659 },
    { start: 617841, len: 484659 },
    { start: 617841, len: 484659 },
  ]);
  assert.equal(units[2].start + units[2].len, 1102500);
});

test('short inputs: one unit per offset (offsets 0 and 352800 both exist once n > step, so n ≤ chunk yields the same unit twice — the Rust loop does this); n == chunk + 1 → the second unit is anchored at 1', () => {
  assert.deepEqual(planRoformer(1000, PARAMS).units, [{ start: 0, len: 1000 }]);
  assert.deepEqual(planRoformer(352800, PARAMS).units, [{ start: 0, len: 352800 }]);
  assert.deepEqual(planRoformer(352801, PARAMS).units, [{ start: 0, len: 352801 }, { start: 0, len: 352801 }]);
  assert.deepEqual(planRoformer(484658, PARAMS).units, [{ start: 0, len: 484658 }, { start: 0, len: 484658 }]);
  assert.deepEqual(planRoformer(484659, PARAMS).units, [{ start: 0, len: 484659 }, { start: 0, len: 484659 }]);
  assert.deepEqual(planRoformer(484660, PARAMS).units, [{ start: 0, len: 484659 }, { start: 1, len: 484659 }]);
  assert.deepEqual(planRoformer(1000000, PARAMS).units, [{ start: 0, len: 484659 }, { start: 352800, len: 484659 }, { start: 515341, len: 484659 }]);
});

test('step is min(stepSamples, chunkSamples)', () => {
  const p = { ...PARAMS, stepSamples: 600000, chunkSamples: 484659 };
  assert.equal(planRoformer(1102500, p).step, 484659);
  assert.deepEqual(planRoformer(1102500, p).units.map((u) => u.start), [0, 484659, 617841]);
});

test('hamming54Table: 0.54 − 0.46·cos(2π·pos/chunk) as f32, w(0) = 0.08, w(chunk/2) = 1.0', () => {
  const w = hamming54Table(484659);
  assert.equal(w.length, 484659);
  assert.ok(Math.abs(w[0] - 0.08) < 1e-7);
  const mid = w[Math.round(484659 / 2)];
  assert.ok(Math.abs(mid - 1.0) < 1e-6, String(mid));
  for (let i = 0; i < 484659; i += 977) assert.equal(w[i], Math.fround(0.54 - 0.46 * Math.cos(2 * Math.PI * i / 484659)));
});

test('identity fold over the 25 s plan reconstructs the input within 1e-6 (Float32 target/counter, duplicate unit included)', () => {
  const n = 1102500;
  const { units, chunkSamples } = planRoformer(n, PARAMS);
  const table = hamming54Table(chunkSamples);
  const x = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { x[0][i] = Math.sin(i * 0.01) * 0.7; x[1][i] = Math.cos(i * 0.013) * 0.5; }
  const target = [new Float32Array(n), new Float32Array(n)];
  const counter = new Float32Array(n);
  const part = [new Float32Array(chunkSamples), new Float32Array(chunkSamples)];
  for (const u of units) {
    part[0].fill(0); part[1].fill(0);
    part[0].set(x[0].subarray(u.start, u.start + u.len)); part[1].set(x[1].subarray(u.start, u.start + u.len));
    foldUnit(target, counter, part, u, table);
  }
  for (let i = 0; i < n; i++) assert.ok(counter[i] > 0, `counter[${i}] = ${counter[i]}`);
  // the duplicate anchored unit doubles the weight on [617841, 1102500) and keeps the overlap with unit 2 consistent
  const kDup = 700000 - 617841;
  assert.ok(Math.abs(counter[700000] - (2 * table[kDup] + table[700000 - 352800])) < 1e-6);
  finalizeFold(target, counter);
  let maxErr = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(target[c][i] - x[c][i]));
  assert.ok(maxErr < 1e-6, `identity fold max error ${maxErr}`);
});

test('packRoformer layout: packed = freq·2 + channel, [re, im] interleaved; applyMasks is the complex product', () => {
  const nBins = 3, frames = 2;
  const spec = allocSpectrum(nBins, frames);
  // re[c][f·frames + t]
  for (let c = 0; c < 2; c++) for (let f = 0; f < nBins; f++) for (let t = 0; t < frames; t++) {
    spec.re[c][f * frames + t] = 100 * c + 10 * f + t;
    spec.im[c][f * frames + t] = -(100 * c + 10 * f + t) - 0.5;
  }
  const out = packRoformer(spec, new Float32Array(2 * nBins * frames * 2));
  for (let f = 0; f < nBins; f++) for (let c = 0; c < 2; c++) for (let t = 0; t < frames; t++) {
    const idx = (((f * 2 + c) * frames) + t) * 2;
    assert.equal(out[idx], 100 * c + 10 * f + t);
    assert.equal(out[idx + 1], -(100 * c + 10 * f + t) - 0.5);
  }
  // masks = (0 + 1i) everywhere → multiply by i: (a + bi)·i = −b + ai
  const masks = new Float32Array(2 * nBins * frames * 2);
  for (let k = 0; k < masks.length; k += 2) { masks[k] = 0; masks[k + 1] = 1; }
  const before = { re: spec.re.map((a) => Float64Array.from(a)), im: spec.im.map((a) => Float64Array.from(a)) };
  applyMasks(spec, masks);
  for (let c = 0; c < 2; c++) for (let k = 0; k < nBins * frames; k++) {
    assert.equal(spec.re[c][k], -before.im[c][k]);
    assert.equal(spec.im[c][k], before.re[c][k]);
  }
  assert.throws(() => packRoformer(spec, new Float32Array(5)), /packRoformer/);
  assert.throws(() => applyMasks(spec, new Float32Array(5)), /applyMasks/);
});

test('separateRoformer with an identity mask (1 + 0i) returns the normalized input as vocals, zero instrumental, one run per unit, no denoise parameter', async () => {
  const n = 1102500 >> 2;                                           // 275,625 samples → one unit [0, n) zero-padded
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = Math.sin(i * 0.02); right[i] = 0.5 * Math.sin(i * 0.031 + 1); }
  const xL = Float32Array.from(left), xR = Float32Array.from(right);
  let runs = 0;
  const ort = makeOrtFake({
    inputNames: ['stft_repr'], outputNames: ['masks'],
    run: (feeds) => {
      runs++;
      const inp = feeds.stft_repr;
      assert.deepEqual(inp.dims, [1, 2050, 1100, 2]);
      const m = new Float32Array(inp.data.length);
      for (let k = 0; k < m.length; k += 2) m[k] = 1;
      return { masks: { data: m, dims: [1, 2050, 1100, 2] } };
    },
  });
  const session = await ort.InferenceSession.create(new Uint8Array(1), {});
  const progress = [];
  const r = await separateRoformer({ ort, session, params: PARAMS, left, right, onProgress: (e) => progress.push(e), shouldCancel: () => false });
  assert.equal(runs, 1);
  assert.deepEqual(progress.map((p) => p.stage), ['separate', 'finalize']);
  assert.deepEqual(progress[0], { stage: 'separate', chunkIndex: 0, chunkCount: 1 });
  assert.equal(r.timings.chunkMs.length, 1);
  assert.equal(r.vocals[0].length, n);
  assert.ok(r.instrumental[0] === left && r.instrumental[1] === right, 'instrumental reuses the input buffers');
  // xN = x·0.9/peak (joint peak 1.0 → 0.9); identity mask → raw ≈ xN; vocals = scaleDownToPeak(raw) = raw (peak 0.9)
  let maxErr = 0, maxInst = 0;
  for (let i = 0; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(r.vocals[0][i] - 0.9 * xL[i]), Math.abs(r.vocals[1][i] - 0.9 * xR[i]));
    maxInst = Math.max(maxInst, Math.abs(r.instrumental[0][i]), Math.abs(r.instrumental[1][i]));
  }
  assert.ok(maxErr < 1e-4, `vocals vs 0.9·input max error ${maxErr}`);
  assert.ok(maxInst < 1e-4, `instrumental max |x| ${maxInst}`);
});

test('separateRoformer: output dims mismatch → MODEL_IO; cancel between units → CANCELLED; silent input → zeros without a run', async () => {
  const n = 1102500;
  const audio = () => { const l = new Float32Array(n), r = new Float32Array(n); for (let i = 0; i < n; i++) { l[i] = Math.sin(i * 0.05); r[i] = l[i]; } return [l, r]; };
  const bad = makeOrtFake({ inputNames: ['stft_repr'], outputNames: ['masks'], dims: [1, 2050, 1100, 1] });
  const [l1, r1] = audio();
  await assert.rejects(separateRoformer({ ort: bad, session: await bad.InferenceSession.create(new Uint8Array(1), {}), params: PARAMS, left: l1, right: r1 }), (e) => e.code === 'MODEL_IO');
  let runs = 0;
  const ok = makeOrtFake({ inputNames: ['stft_repr'], outputNames: ['masks'], run: (feeds) => { runs++; return { masks: { data: new Float32Array(feeds.stft_repr.data.length), dims: [1, 2050, 1100, 2] } }; } });
  const [l2, r2] = audio();
  await assert.rejects(separateRoformer({ ort: ok, session: await ok.InferenceSession.create(new Uint8Array(1), {}), params: PARAMS, left: l2, right: r2, shouldCancel: () => runs >= 1 }), (e) => e.code === 'CANCELLED' && e.detail.chunkIndex === 1 && e.detail.chunkCount === 4);
  assert.equal(runs, 1);
  const silent = await separateRoformer({ ort: ok, session: await ok.InferenceSession.create(new Uint8Array(1), {}), params: PARAMS, left: new Float32Array(1000), right: new Float32Array(1000) });
  assert.equal(runs, 1, 'silent input runs no inference');
  assert.equal(silent.vocals[0].length, 1000);
  assert.equal(silent.timings.chunkMs.length, 0);
});
