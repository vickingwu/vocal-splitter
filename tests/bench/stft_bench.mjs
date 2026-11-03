// tests/bench/stft_bench.mjs — design §4 budget check (A14): STFT + iSTFT of every chunk of a 4-minute stereo
// signal in the Voc_FT geometry (55 chunks × 256 frames × N = 7680). Writes ../evidence/perf_stft.json.
//   node tests/bench/stft_bench.mjs [--out <path>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Background CPU load during the run (other processes), from os.cpus() deltas minus this process's own CPU time.
function cpuSnapshot() {
  let busy = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; const b = t.user + t.nice + t.sys + t.irq; busy += b; total += b + t.idle; }
  return { busy, total, self: process.cpuUsage() };
}
function backgroundLoad(a, b) {
  const selfMs = ((b.self.user - a.self.user) + (b.self.system - a.self.system)) / 1000;
  const busyMs = b.busy - a.busy, totalMs = b.total - a.total;
  return totalMs > 0 ? +(((busyMs - selfMs) / totalMs) * 100).toFixed(1) : null;
}
const loadStart = cpuSnapshot();
import { stftStereo, istftStereo, allocSpectrum } from '../../site/src/engine/stft.mjs';
import { planMdx } from '../../site/src/engine/mdx.mjs';
import { FFT } from '../../site/src/engine/fft.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.resolve(repo, '..', 'evidence', 'perf_stft.json');

const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'site', 'models', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const params = manifest.models.uvr_mdx_voc_ft.params;
const { nFft, hop, dimT } = params;
const seconds = 240;
const n = seconds * params.sampleRate;

// synthetic stereo: a few tones + deterministic noise
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const left = new Float32Array(n), right = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const t = i / params.sampleRate;
  left[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3300 * t) + 0.1 * rand();
  right[i] = 0.3 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 2750 * t) + 0.1 * rand();
}

const plan = planMdx(n, params);
const nonSkipped = plan.chunks.filter((c) => !c.skippable);
const { trim, chunkSize } = plan;
const partL = new Float32Array(chunkSize), partR = new Float32Array(chunkSize);
const geom = { nFft, hop, frames: dimT };
const spec = allocSpectrum(nFft / 2 + 1, dimT);
const tar = [new Float32Array(chunkSize), new Float32Array(chunkSize)];

// warm-up (plan allocation, JIT)
stftStereo(partL, partR, geom, spec);

let stftMs = 0, istftMs = 0;
const t0 = performance.now();
for (const c of nonSkipped) {
  partL.fill(0); partR.fill(0);
  const from = Math.max(c.start, trim), to = Math.min(c.end, trim + n);
  if (to > from) { partL.set(left.subarray(from - trim, to - trim), from - c.start); partR.set(right.subarray(from - trim, to - trim), from - c.start); }
  const a = performance.now();
  stftStereo(partL, partR, geom, spec);
  const b = performance.now();
  istftStereo(spec.re, spec.im, geom, tar);
  const d = performance.now();
  stftMs += b - a; istftMs += d - b;
}
const total = (performance.now() - t0) / 1000;

// A14 comparison: the same number of complex FFTs with the 4/2/3/5-only plan (the design's first variant) vs radix-8.
function fftOnly(useRadix8) {
  const f = new FFT(nFft, { useRadix8 });
  const re = new Float64Array(nFft), im = new Float64Array(nFft), oRe = new Float64Array(nFft), oIm = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) { re[i] = Math.sin(i); im[i] = Math.cos(i * 0.7); }
  const count = nonSkipped.length * 2 * dimT;
  const a = performance.now();
  for (let i = 0; i < count; i++) f.forward(re, im, oRe, oIm);
  return { radices: f.radices.join('x'), ffts: count, seconds: +((performance.now() - a) / 1000).toFixed(3) };
}
const kernelRadix8 = fftOnly(true), kernelRadix4 = fftOnly(false);

const result = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: os.cpus()[0]?.model ?? null,
  cores: os.cpus().length,
  backgroundCpuLoadPercent: backgroundLoad(loadStart, cpuSnapshot()),
  nFft, hop, frames: dimT, chunkSize,
  inputSeconds: seconds,
  chunks: nonSkipped.length,
  plannedChunks: plan.chunks.length,
  seconds: +total.toFixed(3),
  stftSeconds: +(stftMs / 1000).toFixed(3),
  istftSeconds: +(istftMs / 1000).toFixed(3),
  fftsPerChunk: 2 * dimT,
  budgetSeconds: 15,
  withinBudget: total <= 15,
  radices: '8,4,2,3,5 (Stockham autosort, Float64; one complex FFT per frame for both channels, 1/N folded into the synthesis window)',
  fftKernelOnly: { radix8: kernelRadix8, radix4235: kernelRadix4 },
  history: [
    { variant: 'per-frame strided scatter, new spectra per call, radices 4/2/3/5', seconds: 33.22 },
    { variant: 'tiled transposes + buffer reuse, radices 4/2/3/5', seconds: 14.837 },
  ],
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));
