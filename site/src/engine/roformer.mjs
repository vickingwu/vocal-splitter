// site/src/engine/roformer.mjs — design §15: musetric's Mel-Band RoFormer vocals host (unit_plan.rs::vocals,
// frame/pack/applyMasks/overlapAdd shaders, unit_fold.rs, stem_signal.rs) replicated for the duality-student core.
//   planRoformer(n, params)  → { units:[{start,len}], chunkSamples, step }   — the Rust loop, duplicate anchored units KEPT
//   separateRoformer({...})  → { vocals:[L,R], instrumental:[L,R], timings:{ chunkMs:[], stftMs, istftMs } } (same shape as separateMdx)
// Every constant comes from manifest.params (nFft, hop, frames, chunkSamples, stepSamples, inputName, outputName, inputPeak,
// outputPeak). No denoise parameter exists for this architecture. Runtime-agnostic: `ort` is injected, no globals.
import { EngineError } from './errors.mjs';
import { peakOf, scaleDownToPeak, scrubNonFinite } from './normalize.mjs';
import { stftStereo, istftStereo, allocSpectrum } from './stft.mjs';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// unit_plan.rs::vocals: step = min(stepSamples, chunkSamples); for offset = 0, step, 2·step, … while offset < n:
// the unit at `offset` if it fits, else (n ≥ chunk) the unit anchored at n − chunk — emitted again for EVERY later offset,
// never deduplicated — else (n < chunk) one unit [0, n) that the caller zero-pads to chunkSamples.
export function planRoformer(n, params) {
  const { chunkSamples, stepSamples } = params;
  if (!Number.isInteger(n) || n < 0) throw new EngineError('INTERNAL', `planRoformer: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(chunkSamples) || chunkSamples < 1) throw new EngineError('INTERNAL', `planRoformer: chunkSamples must be a positive integer, got ${chunkSamples}`);
  if (!Number.isInteger(stepSamples) || stepSamples < 1) throw new EngineError('INTERNAL', `planRoformer: stepSamples must be a positive integer, got ${stepSamples}`);
  const step = Math.min(stepSamples, chunkSamples);
  const units = [];
  for (let offset = 0; offset < n; offset += step) {
    if (offset + chunkSamples <= n) units.push({ start: offset, len: chunkSamples });
    else if (n >= chunkSamples) units.push({ start: n - chunkSamples, len: chunkSamples });
    else units.push({ start: 0, len: n });
  }
  return { units, chunkSamples, step };
}

// PlanRules::VocalsV1 table: w(pos) = 0.54 − 0.46·cos(2π·pos/chunkSamples), stored as f32 (Rust `as f32`), period = the
// FULL chunk even for a shorter last unit (its weights are the prefix of this table).
export function hamming54Table(chunkSamples) {
  const w = new Float32Array(chunkSamples);
  for (let i = 0; i < chunkSamples; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / chunkSamples);
  return w;
}

// pack.wgsl.ts: stft_repr [1, 2·nBins, frames, 2] with packed = freq·2 + channel and [re, im] at ((packed·frames + frame)·2 + {0, 1}).
// All bins, no zeroing, no normalization. `spec` is the bin-major Float64 spectrum of stft.mjs (re[c][f·frames + t]).
export function packRoformer(spec, out) {
  const { nBins, frames } = spec;
  if (out.length !== 2 * nBins * frames * 2) throw new EngineError('INTERNAL', `packRoformer: buffer length ${out.length} != ${2 * nBins * frames * 2}`);
  for (let f = 0; f < nBins; f++) {
    for (let c = 0; c < 2; c++) {
      const re = spec.re[c], im = spec.im[c];
      const src = f * frames;
      let dst = ((f * 2 + c) * frames) * 2;
      for (let t = 0; t < frames; t++, dst += 2) { out[dst] = re[src + t]; out[dst + 1] = im[src + t]; }
    }
  }
  return out;
}

// applyMasks.wgsl.ts: out = stft ⊙ mask (complex multiply per bin/frame/channel), written back into `spec` in place.
export function applyMasks(spec, masks) {
  const { nBins, frames } = spec;
  if (masks.length !== 2 * nBins * frames * 2) throw new EngineError('INTERNAL', `applyMasks: masks length ${masks.length} != ${2 * nBins * frames * 2}`);
  for (let f = 0; f < nBins; f++) {
    for (let c = 0; c < 2; c++) {
      const re = spec.re[c], im = spec.im[c];
      const base = f * frames;
      let m = ((f * 2 + c) * frames) * 2;
      for (let t = 0; t < frames; t++, m += 2) {
        const sr = re[base + t], si = im[base + t];
        const mr = masks[m], mi = masks[m + 1];
        re[base + t] = sr * mr - si * mi;
        im[base + t] = sr * mi + si * mr;
      }
    }
  }
  return spec;
}

// unit_fold.rs: target += sample·weight; counter += weight (f64 intermediate, f32 store — Float32Array arithmetic in JS).
export function foldUnit(target, counter, samples, unit, table) {
  const { start, len } = unit;
  const [tL, tR] = target;
  const [sL, sR] = samples;
  for (let k = 0; k < len; k++) {
    const w = table[k];
    tL[start + k] += sL[k] * w;
    tR[start + k] += sR[k] * w;
    counter[start + k] += w;
  }
}

// finalize: target / max(counter, 1e-10), in place in `target`.
export function finalizeFold(target, counter) {
  const [tL, tR] = target;
  for (let i = 0; i < counter.length; i++) {
    const d = counter[i] > 1e-10 ? counter[i] : 1e-10;
    tL[i] /= d; tR[i] /= d;
  }
  return target;
}

function dimsEqual(dims, expected) {
  if (!dims || dims.length !== expected.length) return false;
  for (let i = 0; i < dims.length; i++) if (Number(dims[i]) !== expected[i]) return false;
  return true;
}

function assertFinite(arr, stem) {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== v || v === Infinity || v === -Infinity) throw new EngineError('NUMERIC', `non-finite sample in the ${stem} stem`, { index: i, stem });
  }
}

// separation.rs / stem_signal.rs: mixture = normalize_peak(mix, 0.9); fold output = raw vocals; vocals = normalize_peak(raw, 0.9);
// instrumental = normalize_peak(mixture − raw, 0.9) — all three with the JOINT two-channel peak. `left`/`right` are consumed
// (scaled in place to xN, then overwritten with the instrumental); `vocals` are fresh Float32Array(n) buffers.
export async function separateRoformer({ ort, session, params, left, right, onProgress, shouldCancel }) {
  const n = left.length;
  if (right.length !== n) throw new EngineError('INTERNAL', 'separateRoformer: channel lengths differ', { left: n, right: right.length });
  const { nFft, hop, frames, chunkSamples, inputName, outputName, inputPeak, outputPeak } = params;
  if (chunkSamples !== hop * (frames - 1)) throw new EngineError('INTERNAL', `separateRoformer: chunkSamples ${chunkSamples} != hop·(frames − 1)`);
  const nBins = nFft / 2 + 1;
  const timings = { chunkMs: [], stftMs: 0, istftMs: 0 };

  scrubNonFinite(left); scrubNonFinite(right);
  if (n === 0 || peakOf(left, right) === 0) {
    return { vocals: [new Float32Array(n), new Float32Array(n)], instrumental: [left, right], timings };
  }
  scaleDownToPeak(left, right, inputPeak);                 // xN, in place (scale down only when the joint peak exceeds inputPeak)

  const { units } = planRoformer(n, params);
  const chunkCount = units.length;
  const target = [new Float32Array(n), new Float32Array(n)];
  const counter = new Float32Array(n);
  const table = hamming54Table(chunkSamples);
  const partL = new Float32Array(chunkSamples), partR = new Float32Array(chunkSamples);
  const inBuf = new Float32Array(2 * nBins * frames * 2);
  const dims = [1, 2 * nBins, frames, 2];
  const geom = { nFft, hop, frames };
  const spec = allocSpectrum(nBins, frames);
  const tar = [new Float32Array(chunkSamples), new Float32Array(chunkSamples)];
  const feedName = inputName ?? session.inputNames[0];
  const outName = outputName ?? session.outputNames[0];

  for (let ui = 0; ui < chunkCount; ui++) {
    if (shouldCancel && shouldCancel()) throw new EngineError('CANCELLED', 'cancelled between units', { chunkIndex: ui, chunkCount });
    if (onProgress) onProgress({ stage: 'separate', chunkIndex: ui, chunkCount });
    const u = units[ui];
    const t0 = now();
    // window_bytes: the unit copied into a zero-filled chunk (the vocals stage runs every unit — no silence shortcut)
    partL.fill(0); partR.fill(0);
    partL.set(left.subarray(u.start, u.start + u.len), 0);
    partR.set(right.subarray(u.start, u.start + u.len), 0);
    const s0 = now();
    stftStereo(partL, partR, geom, spec);
    packRoformer(spec, inBuf);
    timings.stftMs += now() - s0;

    const feeds = {};
    feeds[feedName] = new ort.Tensor('float32', inBuf, dims);
    const result = await session.run(feeds);
    const out = result[outName];
    if (!out || !dimsEqual(out.dims, dims)) {
      throw new EngineError('MODEL_IO', `model output dims ${out ? JSON.stringify(out.dims) : 'missing'} != ${JSON.stringify(dims)}`,
        { expected: dims, actual: out ? Array.from(out.dims, Number) : null, outputName: outName });
    }

    const i0 = now();
    applyMasks(spec, out.data);
    istftStereo(spec.re, spec.im, geom, tar);
    timings.istftMs += now() - i0;
    foldUnit(target, counter, tar, u, table);
    timings.chunkMs.push(now() - t0);
  }

  if (onProgress) onProgress({ stage: 'finalize' });
  finalizeFold(target, counter);                           // raw vocals
  const [rawL, rawR] = target;
  // instrumental = mixture − raw (f64 subtraction, f32 store), into the input buffers
  for (let i = 0; i < n; i++) { left[i] = left[i] - rawL[i]; right[i] = right[i] - rawR[i]; }
  scaleDownToPeak(rawL, rawR, outputPeak);
  scaleDownToPeak(left, right, outputPeak);
  assertFinite(rawL, 'vocals'); assertFinite(rawR, 'vocals');
  assertFinite(left, 'instrumental'); assertFinite(right, 'instrumental');
  return { vocals: [rawL, rawR], instrumental: [left, right], timings };
}
