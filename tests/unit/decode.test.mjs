// tests/unit/decode.test.mjs — design §10.1 (§16.A row): copyInput channel mapping, probeDuration pure branches,
// durationVerdict table, decodeForDispatch with a fake decoder, decodeInput flow with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyInput, probeDuration, durationVerdict, decodeForDispatch, decodeInput } from '../../site/src/ui/decode.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';
import { encodeStereo } from '../lib/mp3-fixtures.mjs';

// fake AudioBuffer: fills dst with (channel + 1); records copyFromChannel calls
function fakeBuffer(channels, length, sampleRate = 44100) {
  const calls = [];
  return {
    numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, calls,
    copyFromChannel(dst, ch) { calls.push([ch]); dst.fill(ch + 1); },
  };
}

function wavBytes({ sampleRate = 8000, channels = 1, bits = 8, frames = 8000 }) {
  const blockAlign = channels * bits / 8;
  const dataBytes = frames * blockAlign;
  const b = new Uint8Array(44 + dataBytes);
  const dv = new DataView(b.buffer);
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  w4(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); w4(8, 'WAVE'); w4(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, bits, true); w4(36, 'data'); dv.setUint32(40, dataBytes, true);
  return b;
}

test('copyInput: 1 channel → both from channel 0, distinct buffers', () => {
  const b = fakeBuffer(1, 16);
  const { left, right } = copyInput(b);
  assert.notEqual(left, right);
  assert.notEqual(left.buffer, right.buffer);
  assert.deepEqual(Array.from(left), new Array(16).fill(1));
  assert.deepEqual(Array.from(right), new Array(16).fill(1));
  assert.deepEqual(b.calls, [[0], [0]]);
});

test('copyInput: 2 channels → channel 0 / channel 1; 6 channels → channels 0 / 1 only', () => {
  const b2 = fakeBuffer(2, 8);
  const r2 = copyInput(b2);
  assert.deepEqual(Array.from(r2.left), new Array(8).fill(1));
  assert.deepEqual(Array.from(r2.right), new Array(8).fill(2));
  assert.deepEqual(b2.calls, [[0], [1]]);
  const b6 = fakeBuffer(6, 8);
  const r6 = copyInput(b6);
  assert.deepEqual(Array.from(r6.right), new Array(8).fill(2));
  assert.deepEqual(b6.calls, [[0], [1]]);
});

test('copyInput: length 0 → two empty arrays; two calls → four distinct buffers', () => {
  const b0 = fakeBuffer(2, 0);
  const r0 = copyInput(b0);
  assert.equal(r0.left.length, 0);
  assert.equal(r0.right.length, 0);
  const b = fakeBuffer(2, 4);
  const a = copyInput(b), c = copyInput(b);
  const bufs = new Set([a.left.buffer, a.right.buffer, c.left.buffer, c.right.buffer]);
  assert.equal(bufs.size, 4);
});

test('probeDuration pure branches: mpeg and wav bytes; unknown → null; never throws', async () => {
  const mp3 = encodeStereo(2.0, 320);
  const pm = await probeDuration(null, mp3.bytes);
  assert.equal(pm.kind, 'mpeg');
  assert.equal(pm.exact, true);
  assert.ok(Math.abs(pm.seconds - 2.0) < 0.1);
  const pw = await probeDuration(null, wavBytes({ frames: 12000 }));
  assert.deepEqual(pw, { seconds: 1.5, exact: true, kind: 'wav' });
  const pw2 = await probeDuration(null, wavBytes({ frames: 12000 }).buffer);          // ArrayBuffer accepted too
  assert.equal(pw2.seconds, 1.5);
  assert.equal(await probeDuration(null, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(await probeDuration(null, new Uint8Array(0)), null);
  // WAV with a non-PCM tag → readWavHeader null → probe null
  const adpcm = wavBytes({ frames: 100 });
  new DataView(adpcm.buffer).setUint16(20, 2, true);
  assert.equal(await probeDuration(null, adpcm), null);
  // flac/mp4/ogg/webm use the injected audio-element probe
  const flac = new Uint8Array(64); flac.set([0x66, 0x4c, 0x61, 0x43]);
  assert.deepEqual(await probeDuration({}, flac, 10, { audioDuration: async () => 12.5 }), { seconds: 12.5, exact: false, kind: 'audio-element' });
  assert.equal(await probeDuration({}, flac, 10, { audioDuration: async () => null }), null);
  assert.equal(await probeDuration({}, flac, 10, { audioDuration: async () => { throw new Error('x'); } }), null);
  // video containers (mp4 / mov = ftyp box, webm / mkv = EBML) go through the same probe: the file's duration is its audio duration
  const mov = new Uint8Array(64); mov.set([0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20], 4);
  assert.deepEqual(await probeDuration({}, mov, 10, { audioDuration: async () => 10.0 }), { seconds: 10.0, exact: false, kind: 'audio-element' });
  const webm = new Uint8Array(64); webm.set([0x1A, 0x45, 0xDF, 0xA3]);
  assert.deepEqual(await probeDuration({}, webm, 10, { audioDuration: async () => 42 }), { seconds: 42, exact: false, kind: 'audio-element' });
  assert.equal(durationVerdict(await probeDuration({}, webm, 10, { audioDuration: async () => 1801 }), 900).seconds, 1801, 'inexact probe held to 2·maxSeconds');
});

test('durationVerdict table', () => {
  assert.deepEqual(durationVerdict({ seconds: 901, exact: true }, 900), { seconds: 901, maxSeconds: 900 });
  assert.deepEqual(durationVerdict({ seconds: 361, exact: true }, 360), { seconds: 361, maxSeconds: 360 });
  assert.deepEqual(durationVerdict({ seconds: 1801, exact: false }, 900), { seconds: 1801, maxSeconds: 900 });
  assert.equal(durationVerdict({ seconds: 1500, exact: false }, 900), null);
  assert.equal(durationVerdict({ seconds: 359.9, exact: true }, 360), null);
  assert.equal(durationVerdict({ seconds: 900, exact: true }, 900), null);
  assert.equal(durationVerdict(null, 900), null);
  assert.equal(durationVerdict({ seconds: NaN, exact: true }, 900), null);
});

test('decodeForDispatch: one arrayBuffer read, one copyInput, two fresh buffers, no retained reference', async () => {
  let reads = 0;
  const blob = { arrayBuffer: async () => { reads++; return new ArrayBuffer(8); } };
  let decodes = 0;
  let fake = null;
  const decode = async () => { decodes++; fake = fakeBuffer(2, 100); return fake; };
  const r = await decodeForDispatch({ blob, buffer: null }, { maxSeconds: 900 }, { decode });
  assert.equal(reads, 1);
  assert.equal(decodes, 1);
  assert.equal(fake.calls.length, 2);
  assert.ok(r.left instanceof Float32Array && r.right instanceof Float32Array);
  assert.equal(r.left.length, 100);
  assert.notEqual(r.left.buffer, r.right.buffer);
  assert.equal(typeof r.decodeMs, 'number');
  assert.deepEqual(Object.keys(r).sort(), ['decodeMs', 'left', 'right']);        // no reference to the AudioBuffer
  for (const v of Object.values(r)) assert.notEqual(v, fake);
});

test('decodeForDispatch: RangeError → OOM; EncodingError → DECODE', async () => {
  const blob = { arrayBuffer: async () => new ArrayBuffer(8) };
  const oom = await decodeForDispatch({ blob }, {}, { decode: async () => { throw new RangeError('Array buffer allocation failed'); } }).catch((e) => e);
  assert.ok(oom instanceof EngineError);
  assert.equal(oom.code, 'OOM');
  const enc = new Error('Unable to decode audio data'); enc.name = 'EncodingError';
  const dec = await decodeForDispatch({ blob }, {}, { decode: async () => { throw enc; } }).catch((e) => e);
  assert.equal(dec.code, 'DECODE');
});

test('decodeInput: size cap, pre-decode TOO_LONG before any decode, post-decode TOO_LONG, happy path shape', async () => {
  const mkBlob = (bytes, size = bytes.byteLength) => ({ size, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const limits = { maxBytes: 200 * 1024 * 1024, maxSeconds: 900 };
  let decodes = 0;
  const decode = async () => { decodes++; return fakeBuffer(2, 44100 * 2); };
  const big = await decodeInput(mkBlob(new Uint8Array(4), 300 * 1024 * 1024), limits, { decode }).catch((e) => e);
  assert.equal(big.code, 'TOO_LARGE');
  const bigUrl = await decodeInput(mkBlob(new Uint8Array(4), 300 * 1024 * 1024), limits, { decode, source: 'url' }).catch((e) => e);
  assert.equal(bigUrl.code, 'URL_TOO_LARGE');
  const long = await decodeInput(mkBlob(wavBytes({ frames: 8000 * 901 })), limits, { decode }).catch((e) => e);
  assert.equal(long.code, 'TOO_LONG');
  assert.deepEqual(long.detail, { seconds: 901, maxSeconds: 900 });
  assert.equal(decodes, 0, 'refused before decoding');
  const post = await decodeInput(mkBlob(new Uint8Array(32)), limits, { decode: async () => fakeBuffer(2, 44100 * 901) }).catch((e) => e);
  assert.equal(post.code, 'TOO_LONG');
  assert.equal(post.detail.maxSeconds, 900);
  const ok = await decodeInput(mkBlob(wavBytes({ frames: 16000 })), limits, { decode });
  assert.equal(ok.duration, 2);
  assert.equal(ok.probe.probeKind, 'wav');
  assert.equal(typeof ok.probe.probeMs, 'number');
  assert.equal(typeof ok.decodeMs, 'number');
  assert.ok(ok.buffer);
  const unknown = await decodeInput(mkBlob(new Uint8Array(32)), limits, { decode });
  assert.equal(unknown.probe.probeKind, 'none');
  const bad = await decodeInput(mkBlob(new Uint8Array(32)), limits, { decode: async () => { const e = new Error('bad'); e.name = 'EncodingError'; throw e; } }).catch((e) => e);
  assert.equal(bad.code, 'DECODE');
  const oom = await decodeInput(mkBlob(new Uint8Array(32)), limits, { decode: async () => { throw new RangeError('Array buffer allocation failed'); } }).catch((e) => e);
  assert.equal(oom.code, 'OOM');
});
