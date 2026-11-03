// site/src/engine/mdx.mjs — design §3.3–§3.5: audio-separator's MDX-Net demix() replicated for one model.
//   planMdx(n, params)      → { trim, gen, pad, mixtureLen, step, chunkSize, chunks:[{start,end,len,skippable}] }
//   separateMdx({...})      → { vocals:[L,R] (offset views over Float32Array(mixtureLen)), instrumental:[L,R] (the input
//                              buffers, consumed in place), timings:{ chunkMs:[], stftMs, istftMs } }
// Every constant comes from manifest.params (nFft, hop, dimF, dimT, overlap, compensate, zeroLowBins, inputPeak, outputPeak).
// Runtime-agnostic: `ort` is injected, no globals.
import { EngineError } from './errors.mjs';
import { peakOf, scaleDownToPeak, scrubNonFinite } from './normalize.mjs';
import { stftStereo, istftStereo, allocSpectrum } from './stft.mjs';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export function planMdx(n, params) {
  const { nFft, hop, dimT, overlap } = params;
  const trim = nFft / 2;                               // n_fft // 2 (nFft is even by validation)
  const chunkSize = hop * (dimT - 1);                  // hop·(segment_size − 1), segment_size == dim_t
  const gen = chunkSize - 2 * trim;
  const pad = gen + trim - (n % gen);                  // mdx_separator.py line 342
  const mixtureLen = trim + n + pad;                   // zeros(trim) ++ mix ++ zeros(pad)
  const step = Math.trunc((1 - overlap) * chunkSize);  // int((1 − overlap)·chunk_size), line 348
  const chunks = [];
  const retainedEnd = trim + n;
  for (let i = 0; i < mixtureLen; i += step) {
    const start = i;
    const end = Math.min(i + chunkSize, mixtureLen);
    chunks.push({ start, end, len: end - start, skippable: start >= retainedEnd });
  }
  return { trim, gen, pad, mixtureLen, step, chunkSize, chunks };
}

// np.hanning(len): w[k] = 0.5 + 0.5·cos(π·(2k − (len−1))/(len−1)); np.hanning(1) = [1.0]  (§3.3, same expression as numpy)
export function numpyHanning(len) {
  const w = new Float64Array(len);
  if (len === 1) { w[0] = 1; return w; }
  const d = len - 1;
  for (let k = 0; k < len; k++) w[k] = 0.5 + 0.5 * Math.cos(Math.PI * (2 * k - d) / d);
  return w;
}

// Packs the (zero-low-bin) stereo spectrum into the model input [1, 4, dimF, dimT]: flat ((ch·dimF)+f)·dimT + t with
// ch = [L_re, L_im, R_re, R_im]. Because the spectra are bin-major (f·frames + t) and frames === dimT, every channel
// block is a contiguous prefix of the corresponding Float64Array.
export function packSpectrum(spec, dimF, dimT, out) {
  const block = dimF * dimT;
  if (spec.frames !== dimT) throw new EngineError('INTERNAL', `pack: frames ${spec.frames} != dimT ${dimT}`);
  if (out.length !== 4 * block) throw new EngineError('INTERNAL', `pack: buffer length ${out.length} != ${4 * block}`);
  out.set(spec.re[0].subarray(0, block), 0);
  out.set(spec.im[0].subarray(0, block), block);
  out.set(spec.re[1].subarray(0, block), 2 * block);
  out.set(spec.im[1].subarray(0, block), 3 * block);
  return out;
}

// Inverse of packSpectrum into full nBins spectra with bins dimF..nBins−1 zero (stft.py inverse(): pad_frequency_dimension).
export function unpackSpectrum(data, dimF, dimT, nBins, target) {
  const block = dimF * dimT;
  const full = nBins * dimT;
  const { re, im } = target;
  for (let c = 0; c < 2; c++) {
    re[c].fill(0, block, full); im[c].fill(0, block, full);
    re[c].set(data.subarray((2 * c) * block, (2 * c + 1) * block), 0);
    im[c].set(data.subarray((2 * c + 1) * block, (2 * c + 2) * block), 0);
  }
  return target;
}

function zeroLowBinsOf(spec, zeroLowBins) {
  const T = spec.frames;
  for (let c = 0; c < 2; c++) {
    spec.re[c].fill(0, 0, zeroLowBins * T);
    spec.im[c].fill(0, 0, zeroLowBins * T);
  }
}

function dimsEqual(dims, expected) {
  if (!dims || dims.length !== expected.length) return false;
  for (let i = 0; i < dims.length; i++) if (Number(dims[i]) !== expected[i]) return false;
  return true;
}

async function runModel(ort, session, inBuf, dims, inputName, outputName) {
  const feeds = {};
  feeds[inputName] = new ort.Tensor('float32', inBuf, dims);
  const result = await session.run(feeds);
  const out = result[outputName];
  if (!out || !dimsEqual(out.dims, dims)) {
    throw new EngineError('MODEL_IO', `model output dims ${out ? JSON.stringify(out.dims) : 'missing'} != ${JSON.stringify(dims)}`,
      { expected: dims, actual: out ? Array.from(out.dims, Number) : null, outputName });
  }
  return out.data;
}

export async function separateMdx({ ort, session, params, left, right, denoise = false, maxChunks = Infinity, onProgress, shouldCancel }) {
  const n = left.length;
  if (right.length !== n) throw new EngineError('INTERNAL', 'separateMdx: channel lengths differ', { left: n, right: right.length });
  const { nFft, hop, dimF, dimT, zeroLowBins, compensate, inputPeak, outputPeak } = params;
  const nBins = nFft / 2 + 1;
  const timings = { chunkMs: [], stftMs: 0, istftMs: 0 };

  scrubNonFinite(left); scrubNonFinite(right);
  const peak0 = peakOf(left, right);
  if (peak0 === 0 || n === 0) {
    // silent input: both stems are zeros, no inference (§3.4)
    return { vocals: [new Float32Array(n), new Float32Array(n)], instrumental: [left, right], timings };
  }
  // D1: xN = x · (inputPeak / peak0) in place — audio-separator's normalize(0.9) applied to the unity-peak input
  const scale = inputPeak / peak0;
  for (let i = 0; i < n; i++) { left[i] *= scale; right[i] *= scale; }

  const plan = planMdx(n, params);
  const { trim, mixtureLen, chunkSize, chunks } = plan;
  const retainedEnd = trim + n;
  const result = [new Float32Array(mixtureLen), new Float32Array(mixtureLen)];
  const divider = new Float32Array(mixtureLen);
  const partL = new Float32Array(chunkSize), partR = new Float32Array(chunkSize);
  const inBuf = new Float32Array(4 * dimF * dimT);
  const dims = [1, 4, dimF, dimT];
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const geom = { nFft, hop, frames: dimT };
  const spec = allocSpectrum(nBins, dimT);           // reused: forward spectrum, then the model output zero-padded to nBins
  const tar = [new Float32Array(chunkSize), new Float32Array(chunkSize)];
  const windows = new Map();
  const windowFor = (len) => { let w = windows.get(len); if (!w) { w = numpyHanning(len); windows.set(len, w); } return w; };

  const nonSkipped = chunks.filter((c) => !c.skippable);
  const chunkCount = nonSkipped.length;
  let combined = null;
  for (let ci = 0; ci < chunkCount; ci++) {
    if (ci >= maxChunks) break;
    if (shouldCancel && shouldCancel()) throw new EngineError('CANCELLED', 'cancelled between chunks', { chunkIndex: ci, chunkCount });
    if (onProgress) onProgress({ stage: 'separate', chunkIndex: ci, chunkCount });
    const c = nonSkipped[ci];
    const t0 = now();
    // mix_part_: the covered mixture range, zero-padded to chunkSize (the mixture itself is never materialised)
    partL.fill(0); partR.fill(0);
    const from = Math.max(c.start, trim), to = Math.min(c.end, retainedEnd);
    if (to > from) {
      partL.set(left.subarray(from - trim, to - trim), from - c.start);
      partR.set(right.subarray(from - trim, to - trim), from - c.start);
    }
    const s0 = now();
    stftStereo(partL, partR, geom, spec);
    zeroLowBinsOf(spec, zeroLowBins);                // spek[:, :, :zeroLowBins, :] *= 0
    packSpectrum(spec, dimF, dimT, inBuf);
    timings.stftMs += now() - s0;

    let pred = await runModel(ort, session, inBuf, dims, inputName, outputName);
    if (denoise) {
      // spec_pred = model(−spek)·(−0.5) + model(spek)·0.5
      for (let i = 0; i < inBuf.length; i++) inBuf[i] = -inBuf[i];
      const neg = await runModel(ort, session, inBuf, dims, inputName, outputName);
      if (!combined || combined.length !== pred.length) combined = new Float32Array(pred.length);
      for (let i = 0; i < pred.length; i++) combined[i] = neg[i] * -0.5 + pred[i] * 0.5;
      pred = combined;
    }

    const i0 = now();
    unpackSpectrum(pred, dimF, dimT, nBins, spec);
    const [tarL, tarR] = istftStereo(spec.re, spec.im, geom, tar);
    timings.istftMs += now() - i0;

    // tar_waves[..., :L] *= hann (float32 store); result[..., start:end] += tar; divider[..., start:end] += hann
    const L = c.len, w = windowFor(L), start = c.start;
    const rL = result[0], rR = result[1];
    for (let k = 0; k < L; k++) {
      const wk = w[k];
      rL[start + k] += Math.fround(tarL[k] * wk);
      rR[start + k] += Math.fround(tarR[k] * wk);
      divider[start + k] += wk;
    }
    timings.chunkMs.push(now() - t0);
  }

  if (onProgress) onProgress({ stage: 'finalize' });
  // tar_waves = result / divider, in place over the retained range only
  const rL = result[0], rR = result[1];
  for (let i = trim; i < retainedEnd; i++) {
    const d = divider[i];
    if (d > 0) { rL[i] /= d; rR[i] /= d; } else { rL[i] = 0; rR[i] = 0; }
  }
  const vocL = rL.subarray(trim, retainedEnd), vocR = rR.subarray(trim, retainedEnd);
  // secondary = (−primary · compensate) + mix.T, in place in the input buffers
  for (let i = 0; i < n; i++) { left[i] -= compensate * vocL[i]; right[i] -= compensate * vocR[i]; }
  // write_audio normalize(stem, max_peak=0.9): joint per stem
  scaleDownToPeak(vocL, vocR, outputPeak);
  scaleDownToPeak(left, right, outputPeak);
  for (const arr of [vocL, vocR, left, right]) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v !== v || v === Infinity || v === -Infinity) throw new EngineError('NUMERIC', 'non-finite sample in a stem', { index: i });
    }
  }
  return { vocals: [vocL, vocR], instrumental: [left, right], timings };
}
