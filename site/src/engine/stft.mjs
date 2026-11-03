// site/src/engine/stft.mjs — design §3.2 / §4: torch.stft / torch.istft semantics for a stereo chunk.
//   hann   : torch.hann_window(nFft, periodic=True)  → w[n] = 0.5 − 0.5·cos(2πn/N)
//   forward  : center=True reflect pad nFft/2 on both sides (left[i] = x[pad − i], right[j] = x[L − 2 − j]),
//              frame t covers padded [t·hop, t·hop + nFft), frames = 1 + floor(L/hop), onesided, not normalized
//   inverse  : per frame irfft(X_t)·w (Im X[0] = Im X[N/2] = 0), overlap-add into nFft + hop·(T−1), env += w²,
//              divide by max(env, 1e-11), trim pad both ends → hop·(T−1) samples
// Both channels go through ONE complex FFT per frame via the §4 real-pair packing. Frames are processed in tiles of
// TILE frames whose spectra are transposed block-wise into the bin-major output (a per-frame strided scatter costs as
// much as the FFT itself).
// Layout: re[c], im[c] are Float64Array(nBins·frames), bin-major: index f·frames + t. Runtime-agnostic, pure.
import { FFT, packRealPair, unpackRealPair, makePairWork } from './fft.mjs';
import { EngineError } from './errors.mjs';

const TILE = 16;

export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

export function stftFrames(length, hop) { return 1 + Math.floor(length / hop); }

const plans = new Map();

// One plan per (nFft, hop, frames): FFT instance, hann, envelope and scratch buffers, reused across calls.
function getPlan(nFft, hop, frames) {
  const key = `${nFft}:${hop}:${frames}`;
  let plan = plans.get(key);
  if (plan) return plan;
  if (!Number.isInteger(nFft) || nFft < 2 || nFft % 2 !== 0) throw new EngineError('INTERNAL', `stft: nFft must be a positive even integer, got ${nFft}`);
  if (!Number.isInteger(hop) || hop < 1 || hop > nFft) throw new EngineError('INTERNAL', `stft: hop must be in [1, nFft], got ${hop}`);
  if (!Number.isInteger(frames) || frames < 1) throw new EngineError('INTERNAL', `stft: frames must be a positive integer, got ${frames}`);
  const pad = nFft / 2;
  const nBins = pad + 1;
  const chunkLen = hop * (frames - 1);
  const paddedLen = chunkLen + nFft;
  const hann = hannPeriodic(nFft);
  // envelope Σ w² over the OLA buffer (depends only on the geometry)
  const env = new Float64Array(paddedLen);
  for (let t = 0; t < frames; t++) {
    const off = t * hop;
    for (let i = 0; i < nFft; i++) env[off + i] += hann[i] * hann[i];
  }
  const tileRows = Math.min(TILE, frames);
  // synthesis hann with the irfft 1/N folded in (the inverse FFT runs unscaled)
  const hannOverN = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) hannOverN[i] = hann[i] / nFft;
  plan = {
    nFft, hop, frames, pad, nBins, chunkLen, paddedLen, hann, hannOverN, env,
    fft: new FFT(nFft),
    work: makePairWork(nFft),
    padded: [new Float64Array(paddedLen), new Float64Array(paddedLen)],
    // frame-major tile buffers: row = frame within the tile, nBins columns; [L_re, L_im, R_re, R_im]
    tile: [0, 1, 2, 3].map(() => new Float64Array(tileRows * nBins)),
    ola: [new Float64Array(paddedLen), new Float64Array(paddedLen)],
  };
  plans.set(key, plan);
  return plan;
}

function reflectPad(x, out, pad, L) {
  if (L <= pad) throw new EngineError('INTERNAL', `stft: reflect padding ${pad} needs more than ${pad} samples, got ${L}`);
  for (let i = 0; i < pad; i++) out[i] = x[pad - i];
  for (let i = 0; i < L; i++) out[pad + i] = x[i];
  const base = pad + L;
  for (let j = 0; j < pad; j++) out[base + j] = x[L - 2 - j];
}

// tile (frame-major, rows t0..t0+rows) → dst (bin-major f·frames + t)
function tileToBinMajor(src, dst, rows, nBins, frames, t0) {
  for (let f = 0; f < nBins; f++) {
    const base = f * frames + t0;
    for (let r = 0; r < rows; r++) dst[base + r] = src[r * nBins + f];
  }
}

// dst tile (frame-major) ← src (bin-major)
function binMajorToTile(src, dst, rows, nBins, frames, t0) {
  for (let f = 0; f < nBins; f++) {
    const base = f * frames + t0;
    for (let r = 0; r < rows; r++) dst[r * nBins + f] = src[base + r];
  }
}

export function allocSpectrum(nBins, frames) {
  return { re: [new Float64Array(nBins * frames), new Float64Array(nBins * frames)], im: [new Float64Array(nBins * frames), new Float64Array(nBins * frames)], nBins, frames };
}

// left/right: planar Float32Array (or any numeric array) of length hop·(frames−1).
// Returns { re: [L, R], im: [L, R], nBins, frames } with Float64Array(nBins·frames) per channel, bin-major.
// `out` (optional, from allocSpectrum) is filled and returned instead of allocating.
export function stftStereo(left, right, { nFft, hop, frames }, out) {
  const L = left.length;
  if (right.length !== L) throw new EngineError('INTERNAL', 'stft: channel lengths differ');
  const derived = stftFrames(L, hop);
  if (frames === undefined) frames = derived;
  else if (frames !== derived) throw new EngineError('INTERNAL', `stft: ${L} samples / hop ${hop} give ${derived} frames, not ${frames}`);
  const plan = getPlan(nFft, hop, frames);
  const { pad, nBins, hann, fft, work, padded, tile } = plan;
  if (!out) out = allocSpectrum(nBins, frames);
  else if (out.re[0].length !== nBins * frames) throw new EngineError('INTERNAL', 'stft: out buffer has the wrong size');
  out.nBins = nBins; out.frames = frames;
  reflectPad(left, padded[0], pad, L);
  reflectPad(right, padded[1], pad, L);
  const pl = padded[0], pr = padded[1];
  const wre = work.re, wim = work.im;
  const [tLRe, tLIm, tRRe, tRIm] = tile;
  for (let t0 = 0; t0 < frames; t0 += TILE) {
    const rows = Math.min(TILE, frames - t0);
    for (let r = 0; r < rows; r++) {
      const off = (t0 + r) * hop;
      for (let i = 0; i < nFft; i++) { wre[i] = pl[off + i] * hann[i]; wim[i] = pr[off + i] * hann[i]; }
      const row = r * nBins;
      packRealPair(fft, wre, wim,
        tLRe.subarray(row, row + nBins), tLIm.subarray(row, row + nBins),
        tRRe.subarray(row, row + nBins), tRIm.subarray(row, row + nBins), work);
    }
    tileToBinMajor(tLRe, out.re[0], rows, nBins, frames, t0);
    tileToBinMajor(tLIm, out.im[0], rows, nBins, frames, t0);
    tileToBinMajor(tRRe, out.re[1], rows, nBins, frames, t0);
    tileToBinMajor(tRIm, out.im[1], rows, nBins, frames, t0);
  }
  return out;
}

// re/im: [L, R] Float64Array(nBins·frames) bin-major (bins beyond the model's dimF already zero-padded by the caller).
// Returns [Float32Array(hop·(frames−1)), Float32Array(hop·(frames−1))]; `out` (optional [L, R]) is filled instead.
export function istftStereo(re, im, { nFft, hop, frames }, out) {
  const plan = getPlan(nFft, hop, frames);
  const { pad, nBins, chunkLen, hannOverN, env, fft, work, tile, ola } = plan;
  const size = nBins * frames;
  if (re[0].length !== size || im[0].length !== size || re[1].length !== size || im[1].length !== size) {
    throw new EngineError('INTERNAL', `istft: expected ${nBins}×${frames} spectra`);
  }
  const oL = ola[0], oR = ola[1];
  oL.fill(0); oR.fill(0);
  const wre = work.re, wim = work.im;
  const [tLRe, tLIm, tRRe, tRIm] = tile;
  for (let t0 = 0; t0 < frames; t0 += TILE) {
    const rows = Math.min(TILE, frames - t0);
    binMajorToTile(re[0], tLRe, rows, nBins, frames, t0);
    binMajorToTile(im[0], tLIm, rows, nBins, frames, t0);
    binMajorToTile(re[1], tRRe, rows, nBins, frames, t0);
    binMajorToTile(im[1], tRIm, rows, nBins, frames, t0);
    for (let r = 0; r < rows; r++) {
      const row = r * nBins;
      unpackRealPair(fft,
        tLRe.subarray(row, row + nBins), tLIm.subarray(row, row + nBins),
        tRRe.subarray(row, row + nBins), tRIm.subarray(row, row + nBins), wre, wim, work, true);
      const off = (t0 + r) * hop;
      for (let i = 0; i < nFft; i++) {
        const w = hannOverN[i];
        oL[off + i] += wre[i] * w;
        oR[off + i] += wim[i] * w;
      }
    }
  }
  const outL = out ? out[0] : new Float32Array(chunkLen), outR = out ? out[1] : new Float32Array(chunkLen);
  if (outL.length !== chunkLen || outR.length !== chunkLen) throw new EngineError('INTERNAL', 'istft: out buffer has the wrong size');
  for (let i = 0; i < chunkLen; i++) {
    const j = i + pad;
    const e = env[j] > 1e-11 ? env[j] : 1e-11;
    outL[i] = oL[j] / e;
    outR[i] = oR[j] / e;
  }
  return [outL, outR];
}
