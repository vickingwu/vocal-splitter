// tests/tools/make_long_fixture.mjs — builds a long test input by concatenating a PCM16 WAV fixture N times (sample-exact
// copy of the data chunk, no resampling) and, optionally, a CBR MP3 of it with the vendored lamejs (no Xing/Info frame).
//   node tests/tools/make_long_fixture.mjs --out <dir> [--src tests/fixtures/clip25.wav] [--repeat 12] [--name clip300]
//        [--kbps 192] [--no-mp3]
// clip25.wav × 12 = 13,230,000 frames = 300.000 s. The outputs live OUTSIDE the repo (evidence/long/) and are never committed.
import fs from 'node:fs';
import path from 'node:path';
import { fixturePath } from '../lib/fixtures.mjs';
import { readWavHeader } from '../../site/src/engine/wav.mjs';
import { loadLame } from '../lib/mp3-fixtures.mjs';
import { mpegDuration } from '../../site/src/engine/mp3frames.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const outDir = arg('--out', undefined);
if (!outDir) { console.error('BAD_ARG: --out <dir> is required'); process.exit(2); }
const src = path.resolve(arg('--src', fixturePath('clip25.wav')));
const repeat = Math.max(1, Number(arg('--repeat', '12')) || 12);
const name = arg('--name', 'clip300');
const kbps = Number(arg('--kbps', '192')) || 192;
const wantMp3 = !argv.includes('--no-mp3');

fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(src));
const h = readWavHeader(bytes);
if (!h || h.formatTag !== 1 || h.bitsPerSample !== 16 || h.channels !== 2) { console.error('BAD_SRC: expected a PCM16 stereo WAV'); process.exit(2); }
const pcm = bytes.subarray(h.dataOffset, h.dataOffset + h.frames * h.blockAlign);
const frames = h.frames * repeat;
const dataBytes = frames * h.blockAlign;

// ---- WAV: 44-byte header + the source data chunk repeated
const wavFile = path.join(outDir, `${name}.wav`);
{
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(h.sampleRate, 24); header.writeUInt32LE(h.sampleRate * h.blockAlign, 28); header.writeUInt16LE(h.blockAlign, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(dataBytes, 40);
  const fd = fs.openSync(wavFile, 'w');
  try { fs.writeSync(fd, header); for (let i = 0; i < repeat; i++) fs.writeSync(fd, pcm); } finally { fs.closeSync(fd); }
}
const out = { src: path.basename(src), srcFrames: h.frames, repeat, sampleRate: h.sampleRate, frames, seconds: frames / h.sampleRate, wav: { file: wavFile, bytes: fs.statSync(wavFile).size } };
console.log('[fixture] wav', JSON.stringify(out.wav), `${out.seconds} s`);

// ---- MP3: lamejs CBR, 1152-sample blocks, planar Int16 input (the source period is re-read per repeat, no 13 M-sample copy)
if (wantMp3) {
  const t0 = Date.now();
  const lame = loadLame();
  const enc = new lame.Mp3Encoder(2, h.sampleRate, kbps);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = h.frames;
  const L = new Int16Array(n), R = new Int16Array(n);
  for (let i = 0; i < n; i++) { L[i] = view.getInt16(i * 4, true); R[i] = view.getInt16(i * 4 + 2, true); }
  const mp3File = path.join(outDir, `${name}.mp3`);
  const fd = fs.openSync(mp3File, 'w');
  let written = 0;
  try {
    for (let rep = 0; rep < repeat; rep++) {
      for (let i = 0; i < n; i += 1152) {
        const o = enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152));
        if (o.length) { fs.writeSync(fd, Buffer.from(o.buffer, o.byteOffset, o.length)); written += o.length; }
      }
    }
    const fl = enc.flush();
    if (fl.length) { fs.writeSync(fd, Buffer.from(fl.buffer, fl.byteOffset, fl.length)); written += fl.length; }
  } finally { fs.closeSync(fd); }
  const d = mpegDuration(new Uint8Array(fs.readFileSync(mp3File)));
  out.mp3 = { file: mp3File, bytes: written, kbps, frames: d ? d.frames : null, seconds: d ? d.seconds : null, encodeMs: Date.now() - t0 };
  console.log('[fixture] mp3', JSON.stringify(out.mp3));
}
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('[fixture] done');
