// tests/lib/mp3-fixtures.mjs — lamejs (site/vendor/lamejs/lame.min.js) in Node via node:vm; MPEG stream builders for mp3.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let lamejs = null;

export function loadLame() {
  if (lamejs) return lamejs;
  const src = fs.readFileSync(path.join(repo, 'site', 'vendor', 'lamejs', 'lame.min.js'), 'utf8');
  const ctx = vm.createContext({ Int8Array, Int16Array, Int32Array, Uint8Array, Float32Array, Float64Array, Math, console, ArrayBuffer });
  vm.runInContext(src, ctx);
  lamejs = ctx.lamejs;
  if (!lamejs || !lamejs.Mp3Encoder) throw new Error('lamejs did not load');
  return lamejs;
}

export function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Encodes `seconds` of a stereo (or mono) sine at `kbps`; returns { bytes, inputSamples, sampleRate, channels }.
export function encodeStereo(seconds, kbps, sampleRate = 44100, channels = 2) {
  const lame = loadLame();
  const enc = new lame.Mp3Encoder(channels, sampleRate, kbps);
  const n = Math.round(sampleRate * seconds);
  const L = new Int16Array(n), R = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
    R[i] = Math.round(6000 * Math.sin(2 * Math.PI * 660 * i / sampleRate));
  }
  const parts = [];
  for (let i = 0; i < n; i += 1152) {
    const out = channels === 1 ? enc.encodeBuffer(L.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152));
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
  }
  const fl = enc.flush();
  if (fl.length) parts.push(new Uint8Array(fl.buffer, fl.byteOffset, fl.length).slice());
  return { bytes: concat(parts), inputSamples: n, sampleRate, channels };
}

// 112 kbps + 320 kbps stereo 44.1 kHz streams, both flushed, concatenated (no Xing/Info frame, reservoir disabled).
export function mixedBitrateStream(seconds112 = 5, seconds320 = 15) {
  const a = encodeStereo(seconds112, 112), b = encodeStereo(seconds320, 320);
  return { bytes: concat([a.bytes, b.bytes]), inputSamples: a.inputSamples + b.inputSamples, parts: 2, sampleRate: 44100 };
}

// MPEG-2 mono / MPEG-2 stereo / MPEG-2.5 mono streams of 2.0 s each.
export function lsfStreams() {
  return {
    mono22050: { ...encodeStereo(2.0, 64, 22050, 1), expect: { versionBits: 2, sampleRate: 22050, bitrate: 64000, mode: 3 } },
    stereo22050: { ...encodeStereo(2.0, 64, 22050, 2), expect: { versionBits: 2, sampleRate: 22050, bitrate: 64000, mode: 0 } },
    mono11025: { ...encodeStereo(2.0, 32, 11025, 1), expect: { versionBits: 0, sampleRate: 11025, bitrate: 32000, mode: 3 } },
  };
}

// Repeats a block of frames n times (long-file builder for the E2E/bench cases).
export function repeatBlocks(blockBytes, n) {
  const out = new Uint8Array(blockBytes.length * n);
  for (let i = 0; i < n; i++) out.set(blockBytes, i * blockBytes.length);
  return out;
}

// Hand-built frame: header + zero body of the table length; `tag` ('Info') placed at `tagOffset` when given.
export function buildFrame({ versionBits, bitrateIndex, srIndex, mode, protection = 1, padding = 0, tag = null, tagOffset = 0 }) {
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const v1 = versionBits === 3;
  const br = (v1 ? BR1 : BR2)[bitrateIndex] * 1000;
  const sr = SR[versionBits][srIndex];
  const spf = v1 ? 1152 : 576;
  const len = Math.floor((spf / 8) * br / sr) + padding;
  const f = new Uint8Array(len);
  f[0] = 0xFF;
  f[1] = 0xE0 | (versionBits << 3) | (1 << 1) | protection;      // layer III
  f[2] = (bitrateIndex << 4) | (srIndex << 2) | (padding << 1);
  f[3] = mode << 6;
  if (tag) {
    for (let i = 0; i < tag.length; i++) f[tagOffset + i] = tag.charCodeAt(i);
    // bogus frame-count field: flags (4 B) = 0x0F, frames = 1,000,000
    const flagsOff = tagOffset + 4;
    f[flagsOff + 3] = 0x0F;
    const frames = 1000000;
    f[flagsOff + 4] = (frames >>> 24) & 0xFF; f[flagsOff + 5] = (frames >>> 16) & 0xFF; f[flagsOff + 6] = (frames >>> 8) & 0xFF; f[flagsOff + 7] = frames & 0xFF;
  }
  return { bytes: f, length: len, samples: spf, sampleRate: sr };
}
