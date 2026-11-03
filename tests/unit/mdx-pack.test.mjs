// tests/unit/mdx-pack.test.mjs — design §16.A row `mdx-pack.test.mjs`: the model-input packing of mixture chunk 0 of
// clip25 against audio-separator's STFT golden (tests/fixtures/golden/stft_chunk0_uvr_mdx_voc_ft.bin).
// A failure here with stft.test.mjs passing points at packing/padding/zeroing; a parity failure with this passing points
// at plan/compensation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planMdx, packSpectrum, unpackSpectrum } from '../../site/src/engine/mdx.mjs';
import { stftStereo, allocSpectrum } from '../../site/src/engine/stft.mjs';
import { readWav } from '../../site/src/engine/wav.mjs';
import { peakOf } from '../../site/src/engine/normalize.mjs';
import { fixturePath, readManifest, mergeEvidenceJson } from '../lib/fixtures.mjs';

const manifest = readManifest();
const goldenBin = fixturePath('golden/stft_chunk0_uvr_mdx_voc_ft.bin');
const goldenJson = fixturePath('golden/stft_chunk0_uvr_mdx_voc_ft.json');

test('packSpectrum / unpackSpectrum layout: flat index ((ch·dimF)+f)·dimT + t with ch = [L_re, L_im, R_re, R_im]', () => {
  const dimF = 5, dimT = 4, nBins = 7;
  const spec = allocSpectrum(nBins, dimT);
  for (let c = 0; c < 2; c++) for (let f = 0; f < nBins; f++) for (let t = 0; t < dimT; t++) {
    spec.re[c][f * dimT + t] = 1000 * c + 10 * f + t;          // re: distinguishable value per (c, f, t)
    spec.im[c][f * dimT + t] = -(1000 * c + 10 * f + t) - 0.5; // im: negative
  }
  const out = packSpectrum(spec, dimF, dimT, new Float32Array(4 * dimF * dimT));
  for (let f = 0; f < dimF; f++) for (let t = 0; t < dimT; t++) {
    assert.equal(out[((0 * dimF) + f) * dimT + t], 10 * f + t, 'L_re');
    assert.equal(out[((1 * dimF) + f) * dimT + t], -(10 * f + t) - 0.5, 'L_im');
    assert.equal(out[((2 * dimF) + f) * dimT + t], 1000 + 10 * f + t, 'R_re');
    assert.equal(out[((3 * dimF) + f) * dimT + t], -(1000 + 10 * f + t) - 0.5, 'R_im');
  }
  // bins >= dimF are not packed
  assert.equal(out.length, 4 * dimF * dimT);
  // unpack: bins dimF..nBins−1 zero, the rest restored
  const back = allocSpectrum(nBins, dimT);
  back.re[0].fill(99); back.im[1].fill(99);
  unpackSpectrum(out, dimF, dimT, nBins, back);
  for (let c = 0; c < 2; c++) for (let f = 0; f < nBins; f++) for (let t = 0; t < dimT; t++) {
    const idx = f * dimT + t;
    if (f < dimF) { assert.equal(back.re[c][idx], spec.re[c][idx]); assert.equal(back.im[c][idx], spec.im[c][idx]); }
    else { assert.equal(back.re[c][idx], 0); assert.equal(back.im[c][idx], 0); }
  }
});

test('chunk 0 packing of clip25 matches the audio-separator STFT golden (relative bound 1e-5)', () => {
  assert.ok(fs.existsSync(goldenBin), `golden missing: ${goldenBin}`);
  const meta = JSON.parse(fs.readFileSync(goldenJson, 'utf8'));
  const golden = new Float32Array(fs.readFileSync(goldenBin).buffer.slice(0));
  assert.equal(golden.length, 4 * meta.bins * meta.frames);
  assert.equal(meta.layout, 'ch,bin,frame');
  const params = manifest.models[meta.modelId].params;
  assert.equal(params.nFft, meta.nFft); assert.equal(params.dimF, meta.dimF); assert.equal(params.hop, meta.hop); assert.equal(params.dimT, meta.dimT);

  const { sampleRate, left, right } = readWav(new Uint8Array(fs.readFileSync(fixturePath('clip25.wav'))));
  assert.equal(sampleRate, 44100);
  const n = left.length;
  // D1 pre-scale (== audio-separator's normalize(0.9) because the fixture peak is ≈ 1)
  const peak0 = peakOf(left, right);
  assert.ok(Math.abs(peak0 - meta.fixturePeak) < 1e-9, `fixture peak ${peak0} vs golden ${meta.fixturePeak}`);
  const scale = params.inputPeak / peak0;
  assert.ok(Math.abs(scale - meta.inputScale) < 1e-12, `inputScale ${scale} vs golden ${meta.inputScale}`);
  for (let i = 0; i < n; i++) { left[i] *= scale; right[i] *= scale; }

  const plan = planMdx(n, params);
  assert.equal(plan.trim, meta.trim); assert.equal(plan.chunkSize, meta.chunkSize); assert.equal(plan.gen, meta.genSize);
  assert.equal(plan.pad, meta.pad); assert.equal(plan.mixtureLen, meta.mixtureLen);
  const c0 = plan.chunks[meta.chunkIndex];
  assert.equal(c0.start, meta.chunkStart);

  // mixture chunk 0 = zeros(trim) ++ xN[0 : chunkSize − trim]
  const partL = new Float32Array(plan.chunkSize), partR = new Float32Array(plan.chunkSize);
  const from = Math.max(c0.start, plan.trim), to = Math.min(c0.end, plan.trim + n);
  partL.set(left.subarray(from - plan.trim, to - plan.trim), from - c0.start);
  partR.set(right.subarray(from - plan.trim, to - plan.trim), from - c0.start);
  const spec = stftStereo(partL, partR, { nFft: params.nFft, hop: params.hop, frames: params.dimT });
  for (let c = 0; c < 2; c++) { spec.re[c].fill(0, 0, params.zeroLowBins * params.dimT); spec.im[c].fill(0, 0, params.zeroLowBins * params.dimT); }
  const input = packSpectrum(spec, params.dimF, params.dimT, new Float32Array(4 * params.dimF * params.dimT));

  let maxAbsErr = 0, maxGolden = 0, worst = null;
  for (let ch = 0; ch < 4; ch++) for (let f = 0; f < meta.bins; f++) for (let t = 0; t < meta.frames; t++) {
    const g = golden[(ch * meta.bins + f) * meta.frames + t];
    const o = input[((ch * params.dimF) + f) * params.dimT + t];
    const e = Math.abs(o - g);
    if (e > maxAbsErr) { maxAbsErr = e; worst = { ch, f, t, ours: o, golden: g }; }
    if (Math.abs(g) > maxGolden) maxGolden = Math.abs(g);
  }
  assert.ok(Math.abs(maxGolden - meta.maxAbs) < 1e-3, `golden max|.| ${maxGolden} vs sidecar ${meta.maxAbs}`);
  const ratio = maxAbsErr / maxGolden;
  console.log(`mdx-pack golden: maxAbsErr=${maxAbsErr.toExponential(3)} max|golden|=${maxGolden.toFixed(3)} ratio=${ratio.toExponential(3)} worst=${JSON.stringify(worst)}`);
  // the zeroed low bins must be exactly zero on both sides
  // (torch's `*= 0` leaves −0 on negative values, so compare with == rather than strict/Object.is)
  for (let ch = 0; ch < 4; ch++) for (let f = 0; f < params.zeroLowBins; f++) for (let t = 0; t < meta.frames; t++) {
    assert.ok(golden[(ch * meta.bins + f) * meta.frames + t] == 0);
    assert.ok(input[((ch * params.dimF) + f) * params.dimT + t] == 0);
  }
  mergeEvidenceJson('parity_mdx.json', { packGolden: { modelId: meta.modelId, maxAbsErr, maxGolden, ratio, bound: 1e-5, worst, date: new Date().toISOString() } });
  assert.ok(ratio <= 1e-5, `packing error ratio ${ratio} > 1e-5`);
});
