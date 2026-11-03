// tests/parity/roformer_parity.test.mjs — design §15 Tier 2 gate (a) + (b): the JS host (roformer.mjs on onnxruntime-node's
// CPU EP) vs the Python reference host (scripts/tier2_reference.py) on the window that Python chose and wrote to
// evidence/ref_tier2/window.json. Never picks its own window. Skips loudly when the Tier 2 bytes are absent; fails
// WINDOW_MISSING when window.json is absent unless parity_tier2.json records cpuEp 'unavailable' (A37 → gate (a) skipped
// with CPU_EP_UNAVAILABLE, gates (b)/(c) come from the WebGPU run). Writes every number into evidence/parity_tier2.json.
//   dB(a, b) = 10·log10(Σa² / Σb²) over both channels
//   (a)  SNR_voc = dB(ref_voc, ref_voc − ours_voc) ≥ 25 and SNR_inst likewise           (reference = Python host, same window)
//   (b-instrumental) dB(mix, ours_voc) ≥ 20 on clip20_inst.wav, mix = xN of that clip
//   (b-vocal, no NoVox) dB(ref_as′, ref_as′ − ours_voc′) ≥ 10, ref_as = audio-separator Voc_FT vocals cut to the window,
//        ′ = both peak-normalized to 0.9 over the window
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readWav } from '../../site/src/engine/wav.mjs';
import { peakOf, scaleDownToPeak } from '../../site/src/engine/normalize.mjs';
import { validateManifest, loadModelBytes } from '../../site/src/engine/model-loader.mjs';
import { createSession } from '../../site/src/engine/session.mjs';
import { separateRoformer, planRoformer } from '../../site/src/engine/roformer.mjs';
import { makeNodeFetchInto } from '../../scripts/lib/fetch_into_node.mjs';
import { snrStereoDb, snrDb, snrPeakNormalizedDb } from '../lib/snr.mjs';
import { writeWavF32 } from '../lib/wavf32.mjs';
import { fixturePath, referenceStems, modelChunksPresent, readManifest, mergeEvidenceJson, repoRoot, evidenceDir } from '../lib/fixtures.mjs';

const require = createRequire(import.meta.url);
const MODEL_ID = 'melroformer_duality_student';
const CORE_NAME = 'duality_student_core_t1100.onnx';
const DATA_NAME = 'duality_student_core_t1100.onnx.data';
const BAR = { a: 25, bInstrumental: 20, bVocal: 10 };
const refDir = path.join(evidenceDir, 'ref_tier2');

// Design §6.2 params of the Tier 2 entry (used when the model is not yet in the committed manifest).
const PARAMS = {
  sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 484659, stepSamples: 352800,
  weight: 'hamming54', inputName: 'stft_repr', outputName: 'masks', requiredFeatures: ['shader-f16'],
  minStorageBuffersPerShaderStage: 9, inputPeak: 0.9, outputPeak: 0.9,
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const dB = (a, b) => {               // 10·log10(Σa² / Σb²), a/b = [L, R]
  let num = 0, den = 0;
  for (const x of a) for (let i = 0; i < x.length; i++) num += x[i] * x[i];
  for (const x of b) for (let i = 0; i < x.length; i++) den += x[i] * x[i];
  return den === 0 ? Infinity : 10 * Math.log10(num / den);
};
const energy = (arrs) => { let e = 0; for (const x of arrs) for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e; };
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : v);

// Tier 2 bytes: the committed manifest + chunks when present (exercises the two-file loader), else models_src/ (sha256-checked).
async function loadTier2Bytes() {
  const manifest = validateManifest(readManifest());
  const entry = manifest.models[MODEL_ID];
  if (entry && modelChunksPresent(manifest, MODEL_ID)) {
    const loaded = await loadModelBytes(manifest, MODEL_ID, { fetchInto: makeNodeFetchInto(path.join(repoRoot, 'site')), cache: null, subtle: globalThis.crypto.subtle, baseUrl: 'http://localhost/' }, () => {});
    return { source: 'site/models (manifest)', bytes: loaded.bytes, externalData: loaded.externalData, params: entry.params, manifestVersion: manifest.version };
  }
  const core = path.join(repoRoot, 'models_src', CORE_NAME);
  const data = path.join(repoRoot, 'models_src', DATA_NAME);
  if (!fs.existsSync(core) || !fs.existsSync(data)) return null;
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'data', 'expected_sha256.json'), 'utf8'));
  const bytes = new Uint8Array(fs.readFileSync(core));
  const ext = new Uint8Array(fs.readFileSync(data));
  assert.equal(sha256(bytes), expected[CORE_NAME], `sha256 of models_src/${CORE_NAME}`);
  assert.equal(sha256(ext), expected[DATA_NAME], `sha256 of models_src/${DATA_NAME}`);
  return { source: 'models_src', bytes, externalData: { path: DATA_NAME, data: ext }, params: PARAMS, manifestVersion: null };
}

function readParityRecord() {
  const file = path.join(evidenceDir, 'parity_tier2.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

test('Tier 2 gate (a)+(b): roformer.mjs on the CPU EP vs the Python reference host — window from window.json', { timeout: 40 * 60 * 1000 }, async (t) => {
  const tier2 = await loadTier2Bytes();
  if (!tier2) {
    t.skip('SKIP: Tier 2 bytes missing (models_src/duality_student_core_t1100.onnx(.data) or site/models/melroformer_duality_student/) — run scripts/fetch_models.ps1 -Tier2');
    console.log('TIER2 PARITY SKIPPED: model bytes missing');
    return;
  }
  const { params } = tier2;
  const previous = readParityRecord();
  const cpuEpUnavailable = previous.cpuEp === 'unavailable';
  const windowFile = path.join(refDir, 'window.json');
  const windowPresent = fs.existsSync(windowFile);
  if (!windowPresent && !cpuEpUnavailable) {
    assert.fail(`WINDOW_MISSING: ${windowFile} — run <task>\\venv\\Scripts\\python.exe scripts\\tier2_reference.py (it picks the window once and writes it there)`);
  }
  const win = windowPresent ? JSON.parse(fs.readFileSync(windowFile, 'utf8').replace(/^\uFEFF/, '')) : null;

  // fixture + xN (joint peak, whole clip) — inputScale must match what Python used (same input on both sides)
  const fixture = readWav(new Uint8Array(fs.readFileSync(fixturePath('clip25.wav'))));
  assert.equal(fixture.sampleRate, 44100);
  const n = fixture.left.length;
  const fixturePeak = peakOf(fixture.left, fixture.right);
  const xnL = Float32Array.from(fixture.left), xnR = Float32Array.from(fixture.right);
  const inputScale = scaleDownToPeak(xnL, xnR, params.inputPeak);
  if (win) {
    assert.equal(win.clip, 'clip25.wav');
    assert.equal(win.windowLen, params.chunkSamples, 'window.json windowLen must equal chunkSamples');
    assert.ok(Number.isInteger(win.windowStart) && win.windowStart >= 0 && win.windowStart + win.windowLen <= n, `windowStart ${win.windowStart}`);
    assert.ok(Math.abs(inputScale - win.inputScale) < 1e-6, `inputScale ours ${inputScale} vs window.json ${win.inputScale}`);
  }

  const ort = require('onnxruntime-node');
  const t0 = Date.now();
  const session = await createSession(ort, { backend: 'cpu', bytes: tier2.bytes, externalData: tier2.externalData });
  const sessionMs = Date.now() - t0;
  assert.deepEqual([session.inputNames[0], session.outputNames[0]], [params.inputName, params.outputName]);
  console.log(`[tier2] bytes from ${tier2.source}; CPU session ${sessionMs} ms`);

  const record = {
    modelId: MODEL_ID, bytesSource: tier2.source, manifestVersion: tier2.manifestVersion, params,
    fixture: 'tests/fixtures/clip25.wav', fixturePeak, frames: n, inputScale,
    windowStart: win ? win.windowStart : null, windowLen: win ? win.windowLen : null,
    instrumentalClip: 'tests/fixtures/clip20_inst.wav', instrumentalSource: 'ccmixter_stems',
    formulas: {
      dB: '10·log10(Σa² / Σb²) over both channels',
      a: 'SNR_voc = dB(ref_voc, ref_voc − ours_voc) ≥ 25; SNR_inst = dB(ref_inst, ref_inst − ours_inst) ≥ 25 (ref = Python host, same window input xN[s : s + 484659])',
      bInstrumental: 'dB(mix, ours_voc) ≥ 20 on clip20_inst.wav, mix = xN of that clip',
      bVocal: "dB(ref_as′, ref_as′ − ours_voc′) ≥ 10; ref_as = audio-separator Voc_FT vocals cut to the window, ′ = peak-normalized to 0.9 over the window (both)",
    },
    bars: BAR, gates: {},
    timingsMs: { session: sessionMs },
    ortNodeVersion: require('onnxruntime-node/package.json').version, node: process.version,
  };

  // ---- gate (a): the JS host on the same window ------------------------------------------------------------------
  let oursVocWin = null;
  if (win) {
    const s = win.windowStart, L = win.windowLen;
    const wl = xnL.slice(s, s + L), wr = xnR.slice(s, s + L);
    const plan = planRoformer(L, params);
    const t1 = Date.now();
    const res = await separateRoformer({ ort, session, params, left: wl, right: wr, shouldCancel: () => false });
    record.timingsMs.window = Date.now() - t1;
    record.timingsMs.windowChunkMs = res.timings.chunkMs.map(Math.round);
    assert.equal(res.timings.chunkMs.length, plan.units.length, 'one inference per planned unit (duplicates included)');
    const refV = readWav(new Uint8Array(fs.readFileSync(path.join(refDir, 'vocals_window.wav'))));
    const refI = readWav(new Uint8Array(fs.readFileSync(path.join(refDir, 'inst_window.wav'))));
    assert.equal(refV.left.length, L); assert.equal(refI.left.length, L);
    const snrVoc = snrStereoDb(refV.left, refV.right, res.vocals[0], res.vocals[1]);
    const snrInst = snrStereoDb(refI.left, refI.right, res.instrumental[0], res.instrumental[1]);
    oursVocWin = [Float32Array.from(res.vocals[0]), Float32Array.from(res.vocals[1])];
    record.gates.a = {
      snrVocalsDb: r2(snrVoc), snrInstDb: r2(snrInst), bar: BAR.a,
      perChannelDb: { vocalsL: r2(snrDb(refV.left, res.vocals[0])), vocalsR: r2(snrDb(refV.right, res.vocals[1])), instL: r2(snrDb(refI.left, res.instrumental[0])), instR: r2(snrDb(refI.right, res.instrumental[1])) },
      peaks: { oursVocals: peakOf(res.vocals[0], res.vocals[1]), refVocals: peakOf(refV.left, refV.right), oursInst: peakOf(res.instrumental[0], res.instrumental[1]), refInst: peakOf(refI.left, refI.right) },
      units: plan.units, pass: snrVoc >= BAR.a && snrInst >= BAR.a,
    };
    console.log(`[tier2] (a) vocals ${snrVoc.toFixed(2)} dB, instrumental ${snrInst.toFixed(2)} dB (bar ${BAR.a}); window ${record.timingsMs.window} ms`);
  } else {
    record.gates.a = { skipped: 'CPU_EP_UNAVAILABLE', pass: null };
    console.log('[tier2] (a) CPU_EP_UNAVAILABLE — skipped (A37)');
  }

  // ---- gate (b-instrumental): the whole 20 s instrumental clip ----------------------------------------------------------
  const inst = readWav(new Uint8Array(fs.readFileSync(fixturePath('clip20_inst.wav'))));
  assert.equal(inst.sampleRate, 44100);
  const mixL = Float32Array.from(inst.left), mixR = Float32Array.from(inst.right);
  const instInputScale = scaleDownToPeak(mixL, mixR, params.inputPeak);
  const t2 = Date.now();
  const resI = await separateRoformer({ ort, session, params, left: Float32Array.from(mixL), right: Float32Array.from(mixR), shouldCancel: () => false });
  record.timingsMs.instClip = Date.now() - t2;
  record.timingsMs.instClipChunkMs = resI.timings.chunkMs.map(Math.round);
  const bInst = dB([mixL, mixR], [resI.vocals[0], resI.vocals[1]]);
  record.gates.bInstrumental = {
    db: r2(bInst), bar: BAR.bInstrumental, frames: inst.left.length, inputScale: instInputScale, units: planRoformer(inst.left.length, params).units,
    mixEnergy: energy([mixL, mixR]), vocalsEnergy: energy([resI.vocals[0], resI.vocals[1]]), vocalsPeak: peakOf(resI.vocals[0], resI.vocals[1]),
    pass: bInst >= BAR.bInstrumental,
  };
  const pyInst = path.join(refDir, 'inst_clip_vocals.wav');
  if (fs.existsSync(pyInst)) {
    const py = readWav(new Uint8Array(fs.readFileSync(pyInst)));
    record.gates.bInstrumental.pythonHostDb = r2(dB([mixL, mixR], [py.left, py.right]));
    record.gates.bInstrumental.jsVsPythonVocalsSnrDb = r2(snrStereoDb(py.left, py.right, resI.vocals[0], resI.vocals[1]));
  }
  console.log(`[tier2] (b-instrumental) ${bInst.toFixed(2)} dB (bar ${BAR.bInstrumental}); ${record.timingsMs.instClip} ms`);

  // ---- gate (b-vocal, no NoVox): vs audio-separator Voc_FT vocals over the window -------------------------------------------
  if (win) {
    const refs = referenceStems('uvr_mdx_voc_ft');
    const as = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
    const s = win.windowStart, L = win.windowLen;
    const asL = as.left.slice(s, s + L), asR = as.right.slice(s, s + L);
    // ′ = both peak-normalized to exactly 0.9 over the window (tests/lib/snr.mjs::snrPeakNormalizedDb, shared with the hq E2E run)
    const b = snrPeakNormalizedDb(asL, asR, oursVocWin[0], oursVocWin[1], 0.9);
    const bVoc = b.db;
    record.gates.bVocal = {
      db: r2(bVoc), bar: BAR.bVocal, reference: path.basename(refs.vocals), windowStart: s, windowLen: L,
      normalization: { refGain: b.refGain, oursGain: b.oursGain, refPeakBefore: peakOf(asL, asR), oursPeakBefore: peakOf(oursVocWin[0], oursVocWin[1]) },
      pass: bVoc >= BAR.bVocal,
    };
    console.log(`[tier2] (b-vocal, no NoVox) ${bVoc.toFixed(2)} dB vs ${path.basename(refs.vocals)} (bar ${BAR.bVocal})`);
  } else {
    record.gates.bVocal = { skipped: 'CPU_EP_UNAVAILABLE (window not chosen)', pass: null };
  }

  // ---- CPU-EP stems for the whole clip25 (for the WebGPU run's GPU-vs-CPU consistency number, §16.C hq run) ---------------
  const t3 = Date.now();
  const resFull = await separateRoformer({ ort, session, params, left: Float32Array.from(fixture.left), right: Float32Array.from(fixture.right), shouldCancel: () => false });
  record.timingsMs.fullClip = Date.now() - t3;
  record.timingsMs.fullClipChunkMs = resFull.timings.chunkMs.map(Math.round);
  fs.mkdirSync(refDir, { recursive: true });
  writeWavF32(path.join(refDir, 'clip25_cpu_vocals.wav'), resFull.vocals[0], resFull.vocals[1]);
  writeWavF32(path.join(refDir, 'clip25_cpu_inst.wav'), resFull.instrumental[0], resFull.instrumental[1]);
  record.fullClipCpu = { units: planRoformer(n, params).units.length, vocalsPeak: peakOf(resFull.vocals[0], resFull.vocals[1]), instPeak: peakOf(resFull.instrumental[0], resFull.instrumental[1]), files: ['ref_tier2/clip25_cpu_vocals.wav', 'ref_tier2/clip25_cpu_inst.wav'] };
  {
    const refs = referenceStems('uvr_mdx_voc_ft');
    const asV = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
    const asI = readWav(new Uint8Array(fs.readFileSync(refs.instrumental)));
    // informational: whole-clip agreement with Voc_FT after joint peak normalization of both (loudness conventions differ)
    record.fullClipCpu.vsVocFtDb = {
      vocals: r2(snrPeakNormalizedDb(asV.left, asV.right, resFull.vocals[0], resFull.vocals[1]).db),
      instrumental: r2(snrPeakNormalizedDb(asI.left, asI.right, resFull.instrumental[0], resFull.instrumental[1]).db),
      note: 'informational (different model), both stems peak-normalized to 0.9 over the clip',
    };
  }

  record.pass = { a: record.gates.a.pass, bInstrumental: record.gates.bInstrumental.pass, bVocal: record.gates.bVocal.pass };
  record.date = new Date().toISOString();
  mergeEvidenceJson('parity_tier2.json', { js: record });
  await session.release?.();

  if (record.gates.a.pass !== null) {
    assert.ok(record.gates.a.snrVocalsDb >= BAR.a, `(a) vocals SNR ${record.gates.a.snrVocalsDb} dB < ${BAR.a} dB (10–25 dB = plan/window/pack bug — fix the engine, never lower the bar)`);
    assert.ok(record.gates.a.snrInstDb >= BAR.a, `(a) instrumental SNR ${record.gates.a.snrInstDb} dB < ${BAR.a} dB`);
  }
  assert.ok(bInst >= BAR.bInstrumental, `(b-instrumental) ${bInst.toFixed(2)} dB < ${BAR.bInstrumental} dB`);
  if (record.gates.bVocal.pass !== null) assert.ok(record.gates.bVocal.db >= BAR.bVocal, `(b-vocal) ${record.gates.bVocal.db} dB < ${BAR.bVocal} dB`);
});
