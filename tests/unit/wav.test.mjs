// tests/unit/wav.test.mjs — design §16.A row `wav.test.mjs`: readWavHeader cases (a)–(l) with REAL bodies (8 kHz mono 8-bit),
// toInt16Planar clamp/round table incl. offset views, writeWav16 → readWav identity, TypeError on Float32Array, PCM16/24/32/float reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWavHeader, readWav, toInt16Planar, writeWav16 } from '../../site/src/engine/wav.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u16 = (v) => Uint8Array.from([v & 0xFF, (v >>> 8) & 0xFF]);
const u32 = (v) => Uint8Array.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let off = 0; for (const p of parts) { o.set(p, off); off += p.length; } return o; };

// fmt chunk; `extensible` adds the WAVE_FORMAT_EXTENSIBLE tail with the given sub-format GUID head
function fmtChunk({ formatTag = 1, channels = 1, sampleRate = 8000, bitsPerSample = 8, blockAlign = channels * bitsPerSample / 8, subFormat = null }) {
  const base = cat(u16(formatTag), u16(channels), u32(sampleRate), u32(sampleRate * blockAlign), u16(blockAlign), u16(bitsPerSample));
  if (subFormat === null) return cat(ascii('fmt '), u32(16), base);
  const guidTail = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71]);
  const ext = cat(u16(22), u16(bitsPerSample), u32(channels === 1 ? 4 : 3), u16(subFormat), guidTail);
  return cat(ascii('fmt '), u32(40), base, ext);
}

function wav({ fmt = {}, dataSize, body, extraChunks = [], noData = false }) {
  const bodyBytes = body ?? new Uint8Array(dataSize ?? 0).fill(128);
  const declared = dataSize === undefined ? bodyBytes.length : dataSize;
  const parts = [fmtChunk(fmt), ...extraChunks];
  if (!noData) parts.push(ascii('data'), u32(declared), bodyBytes);
  const inner = cat(...parts);
  return cat(ascii('RIFF'), u32(4 + inner.length), ascii('WAVE'), inner);
}

const SEC_8K = 8000; // 8 kHz mono 8-bit → 8,000 B per second

test('(a) 900.5 s header with a 900.5 s body → frames 7,204,000 → 900.5 s', () => {
  const h = readWavHeader(wav({ dataSize: 7204000 }));
  assert.ok(h);
  assert.equal(h.frames, 7204000);
  assert.equal(h.frames / h.sampleRate, 900.5);
  assert.deepEqual({ sampleRate: h.sampleRate, channels: h.channels, bitsPerSample: h.bitsPerSample, formatTag: h.formatTag, blockAlign: h.blockAlign, dataOffset: h.dataOffset, dataBytes: h.dataBytes },
    { sampleRate: 8000, channels: 1, bitsPerSample: 8, formatTag: 1, blockAlign: 1, dataOffset: 44, dataBytes: 7204000 });
});

test('(b) data size 0xFFFFFFFF over a 10.0 s body → 10.0 s', () => {
  const h = readWavHeader(wav({ dataSize: 0xFFFFFFFF, body: new Uint8Array(10 * SEC_8K).fill(128) }));
  assert.ok(h);
  assert.equal(h.dataBytes, 80000);
  assert.equal(h.frames / h.sampleRate, 10.0);
});

test('(c) 20-minute header truncated to 10 s of bytes → 10.0 s', () => {
  const h = readWavHeader(wav({ dataSize: 9600000, body: new Uint8Array(10 * SEC_8K).fill(128) }));
  assert.ok(h);
  assert.equal(h.frames / h.sampleRate, 10.0);
});

test('(d) data size 0 over a 10 s body → frames 0 → 0.0 s', () => {
  const h = readWavHeader(wav({ dataSize: 0, body: new Uint8Array(10 * SEC_8K).fill(128) }));
  assert.ok(h);
  assert.equal(h.frames, 0);
  assert.equal(h.frames / h.sampleRate, 0);
});

test('(e) blockAlign 0 → null', () => {
  assert.equal(readWavHeader(wav({ fmt: { blockAlign: 0 }, dataSize: SEC_8K })), null);
});

test('(f) format tag 0x55 (MP3-in-WAV) → null; (g) format tag 2 (ADPCM) → null; μ-law 7 → null', () => {
  assert.equal(readWavHeader(wav({ fmt: { formatTag: 0x55 }, dataSize: SEC_8K })), null);
  assert.equal(readWavHeader(wav({ fmt: { formatTag: 2 }, dataSize: SEC_8K })), null);
  assert.equal(readWavHeader(wav({ fmt: { formatTag: 7 }, dataSize: SEC_8K })), null);
});

test('(h) EXTENSIBLE with PCM sub-format → frames as PCM; unknown sub-format GUID → null', () => {
  const ok = readWavHeader(wav({ fmt: { formatTag: 0xFFFE, subFormat: 1 }, dataSize: 3 * SEC_8K }));
  assert.ok(ok);
  assert.equal(ok.formatTag, 1);
  assert.equal(ok.frames / ok.sampleRate, 3);
  assert.equal(readWavHeader(wav({ fmt: { formatTag: 0xFFFE, subFormat: 0x55 }, dataSize: SEC_8K })), null);
  // right sub-format head but a foreign GUID tail → null
  const foreign = wav({ fmt: { formatTag: 0xFFFE, subFormat: 1 }, dataSize: SEC_8K });
  foreign[12 + 8 + 26 + 13] ^= 0xFF;
  assert.equal(readWavHeader(foreign), null);
  // EXTENSIBLE float sub-format with 32-bit → read as float
  const f = readWavHeader(wav({ fmt: { formatTag: 0xFFFE, subFormat: 3, bitsPerSample: 32 }, dataSize: 4 * SEC_8K }));
  assert.ok(f); assert.equal(f.formatTag, 3); assert.equal(f.frames, SEC_8K);
});

test('(i) sampleRate 0 → null; channels 0 → null', () => {
  assert.equal(readWavHeader(wav({ fmt: { sampleRate: 0 }, dataSize: SEC_8K })), null);
  assert.equal(readWavHeader(wav({ fmt: { channels: 0, blockAlign: 1 }, dataSize: SEC_8K })), null);
});

test('(j) blockAlign 5 with 16-bit stereo → null; odd bit depth → null', () => {
  assert.equal(readWavHeader(wav({ fmt: { channels: 2, bitsPerSample: 16, blockAlign: 5 }, dataSize: SEC_8K })), null);
  assert.equal(readWavHeader(wav({ fmt: { bitsPerSample: 12, blockAlign: 2 }, dataSize: SEC_8K })), null);
});

test('(k) LIST chunk with an odd size + pad byte before data → correct dataOffset', () => {
  const list = cat(ascii('LIST'), u32(5), ascii('INFOx'), Uint8Array.from([0]));   // 5 B payload + 1 pad
  const bytes = wav({ dataSize: 2 * SEC_8K, extraChunks: [list] });
  const h = readWavHeader(bytes);
  assert.ok(h);
  assert.equal(h.dataOffset, 12 + 24 + 14 + 8);
  assert.equal(h.frames, 2 * SEC_8K);
  // JUNK before fmt is fine too
  const junk = cat(ascii('JUNK'), u32(4), new Uint8Array(4));
  const inner = cat(junk, fmtChunk({}), ascii('data'), u32(SEC_8K), new Uint8Array(SEC_8K).fill(128));
  const h2 = readWavHeader(cat(ascii('RIFF'), u32(4 + inner.length), ascii('WAVE'), inner));
  assert.ok(h2); assert.equal(h2.frames, SEC_8K);
});

test('(l) no data chunk → null; data before fmt → null; not RIFF → null; tiny buffers never throw', () => {
  assert.equal(readWavHeader(wav({ noData: true })), null);
  const inner = cat(ascii('data'), u32(SEC_8K), new Uint8Array(SEC_8K), fmtChunk({}));
  assert.equal(readWavHeader(cat(ascii('RIFF'), u32(4 + inner.length), ascii('WAVE'), inner)), null);
  assert.equal(readWavHeader(cat(ascii('RIFX'), u32(0), ascii('WAVE'))), null);
  for (let n = 0; n < 60; n++) assert.doesNotThrow(() => readWavHeader(wav({ dataSize: SEC_8K }).subarray(0, n)));
  assert.equal(readWavHeader(new Uint8Array(0)), null);
  assert.throws(() => readWav(wav({ fmt: { formatTag: 2 }, dataSize: 100 })), (e) => e instanceof EngineError && e.code === 'DECODE');
});

test('toInt16Planar clamp/round table and offset-view input', () => {
  const l = new Float32Array([0.5, 1.0, -1.0, 1.5, -2, NaN, 0, 0.25, -0.5]);
  const r = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [li, ri] = toInt16Planar(l, r);
  assert.ok(li instanceof Int16Array && ri instanceof Int16Array);
  assert.deepEqual(Array.from(li), [16384, 32767, -32768, 32767, -32768, 0, 0, 8192, -16384]);
  assert.deepEqual(Array.from(ri), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // A26: offset views (the vocals stems are subarray(trim, trim + n))
  const big = new Float32Array(10); big.set([9, 9, 0.5, -0.25, 9, 9], 0);
  const view = big.subarray(2, 4);
  assert.equal(view.byteOffset, 8);
  const [vi] = toInt16Planar(view, view);
  assert.deepEqual(Array.from(vi), [16384, -8192]);
  // round half away from zero is NOT required; Math.round semantics: 0.5 → 1 for positive
  assert.equal(toInt16Planar(new Float32Array([1 / 32768 * 0.5]), new Float32Array([0]))[0][0], 1);
  assert.throws(() => toInt16Planar(new Float32Array(2), new Float32Array(3)), (e) => e.code === 'INTERNAL');
});

test('writeWav16 → readWav identity for int16-representable data; TypeError on Float32Array', () => {
  const n = 1000;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = Math.round(Math.sin(i / 7) * 30000) / 32768; r[i] = Math.round(Math.cos(i / 5) * 12345) / 32768; }
  const [li, ri] = toInt16Planar(l, r);
  const buf = writeWav16(li, ri, 44100);
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 44 + n * 4);
  const bytes = new Uint8Array(buf);
  const h = readWavHeader(bytes);
  assert.deepEqual({ sampleRate: h.sampleRate, channels: h.channels, bitsPerSample: h.bitsPerSample, formatTag: h.formatTag, blockAlign: h.blockAlign, dataOffset: h.dataOffset, dataBytes: h.dataBytes, frames: h.frames },
    { sampleRate: 44100, channels: 2, bitsPerSample: 16, formatTag: 1, blockAlign: 4, dataOffset: 44, dataBytes: n * 4, frames: n });
  const back = readWav(bytes);
  assert.equal(back.sampleRate, 44100);
  for (let i = 0; i < n; i++) { assert.ok(Math.abs(back.left[i] - l[i]) < 1e-7); assert.ok(Math.abs(back.right[i] - r[i]) < 1e-7); }
  assert.throws(() => writeWav16(l, r), TypeError);
  assert.throws(() => writeWav16(li, r), TypeError);
  assert.throws(() => writeWav16(new Int16Array(2), new Int16Array(3)), (e) => e.code === 'INTERNAL');
  // byte order of the interleaved PCM: first frame L then R
  const pcm = new DataView(buf);
  assert.equal(pcm.getInt16(44, true), li[0]);
  assert.equal(pcm.getInt16(46, true), ri[0]);
  // default sample rate
  assert.equal(readWavHeader(new Uint8Array(writeWav16(li, ri))).sampleRate, 44100);
});

test('PCM16 read scale: 0x7FFF → 32767/32768, 0x8000 → −1.0; mono → right copies left', () => {
  const body = cat(u16(0x7FFF), u16(0x8000), u16(0), u16(0x4000));
  const bytes = wav({ fmt: { channels: 1, sampleRate: 44100, bitsPerSample: 16 }, body });
  const { left, right } = readWav(bytes);
  assert.equal(left.length, 4);
  assert.equal(left[0], 32767 / 32768);
  assert.equal(left[1], -1.0);
  assert.equal(left[2], 0);
  assert.equal(left[3], 0.5);
  assert.deepEqual(Array.from(right), Array.from(left));
  assert.notEqual(left, right);
  assert.notEqual(left.buffer, right.buffer);
});

test('24-bit and float32 reads (hand-built), 32-bit int, 8-bit unsigned, stereo channel mapping', () => {
  // 24-bit stereo: L = +0x400000 (0.5), R = −0x800000 (−1.0)
  const b24 = Uint8Array.from([0x00, 0x00, 0x40, 0x00, 0x00, 0x80]);
  const w24 = readWav(wav({ fmt: { channels: 2, sampleRate: 48000, bitsPerSample: 24 }, body: b24 }));
  assert.equal(w24.sampleRate, 48000);
  assert.equal(w24.left[0], 0.5);
  assert.equal(w24.right[0], -1.0);
  // float32 stereo
  const f32 = new Uint8Array(8); new DataView(f32.buffer).setFloat32(0, 0.75, true); new DataView(f32.buffer).setFloat32(4, -1.25, true);
  const wf = readWav(wav({ fmt: { formatTag: 3, channels: 2, sampleRate: 44100, bitsPerSample: 32 }, body: f32 }));
  assert.equal(wf.left[0], 0.75);
  assert.equal(wf.right[0], -1.25);
  // 32-bit int mono
  const i32 = new Uint8Array(4); new DataView(i32.buffer).setInt32(0, -2147483648, true);
  assert.equal(readWav(wav({ fmt: { channels: 1, bitsPerSample: 32 }, body: i32 })).left[0], -1.0);
  // 8-bit unsigned mono: 128 → 0, 255 → 127/128, 0 → −1
  const w8 = readWav(wav({ body: Uint8Array.from([128, 255, 0]) }));
  assert.deepEqual(Array.from(w8.left), [0, 127 / 128, -1]);
  // > 2 channels: channels 0 and 1 are used
  const b16 = cat(u16(0x4000), u16(0x2000), u16(0x1000), u16(0x0800));
  const w4 = readWav(wav({ fmt: { channels: 4, bitsPerSample: 16 }, body: b16 }));
  assert.equal(w4.left[0], 0.5); assert.equal(w4.right[0], 0.25);
  // float64 is readable (formatTag 3, 64-bit)
  const f64 = new Uint8Array(8); new DataView(f64.buffer).setFloat64(0, 0.125, true);
  assert.equal(readWav(wav({ fmt: { formatTag: 3, channels: 1, bitsPerSample: 64 }, body: f64 })).left[0], 0.125);
});
