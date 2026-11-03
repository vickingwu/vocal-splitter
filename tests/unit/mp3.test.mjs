// tests/unit/mp3.test.mjs — design §16.A row `mp3.test.mjs`: lamejs streams walked by mp3frames.mjs, header FIELDS asserted
// (never byte literals), mechanistic duration bound 0 <= walked − input <= k·(576 + 2·spf), Info-frame offsets, junk resync, LSF streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, mpegDuration, parseHeader } from '../../site/src/engine/mp3frames.mjs';
import { sniffContainer } from '../../site/src/engine/sniff.mjs';
import { encodeStereo, mixedBitrateStream, lsfStreams, buildFrame, concat, repeatBlocks } from '../lib/mp3-fixtures.mjs';

const fields = (bytes, off) => {
  const b1 = bytes[off], b2 = bytes[off + 1], b3 = bytes[off + 2], b4 = bytes[off + 3];
  return { sync: b1 === 0xFF && (b2 & 0xE0) === 0xE0, version: (b2 >> 3) & 3, layer: (b2 >> 1) & 3, protection: b2 & 1, bitrateIndex: b3 >> 4, srIndex: (b3 >> 2) & 3, padding: (b3 >> 1) & 1, mode: (b4 >> 6) & 3 };
};

// brute-force count of valid headers at the positions the walker is expected to visit (consecutive frames by table length)
function bruteForceFrames(bytes) {
  let count = 0, i = 0;
  while (i + 4 <= bytes.length) {
    const h = parseHeader(bytes, i);
    if (!h || h.freeFormat) { i++; continue; }
    count++; i += h.length;
  }
  return count;
}

function assertBound(label, walkedSamples, inputSamples, spf, k = 1) {
  const delta = walkedSamples - inputSamples;
  assert.ok(delta >= 0, `${label}: walked ${walkedSamples} < input ${inputSamples}`);
  assert.ok(delta <= k * (576 + 2 * spf), `${label}: walked − input = ${delta} > ${k}·(576 + 2·${spf})`);
}

test('lamejs 2.0 s 320 kbps stereo: header fields per frame, no junk, mechanistic duration bound, |Δ| <= 0.1 s', () => {
  const { bytes, inputSamples } = encodeStereo(2.0, 320);
  assert.equal(sniffContainer(bytes), 'mpeg');
  const w = walk(bytes);
  assert.equal(w.junkBytes, 0); assert.equal(w.syncLoss, 0); assert.equal(w.freeFormat, false);
  assert.ok(w.frames.length >= 70, `frames ${w.frames.length}`);
  let padded = 0;
  for (const f of w.frames) {
    const h = fields(bytes, f.offset);
    assert.ok(h.sync, 'sync');
    assert.equal(h.version, 3, 'MPEG-1');
    assert.equal(h.layer, 1, 'Layer III');
    assert.equal(h.bitrateIndex, 0xE, '320 kbps');
    assert.equal(h.srIndex, 0, '44.1 kHz');
    assert.equal(h.mode, 0, 'stereo (not joint stereo)');
    assert.equal(f.version, 1); assert.equal(f.bitrate, 320000); assert.equal(f.sampleRate, 44100); assert.equal(f.samples, 1152); assert.equal(f.isInfo, false);
    assert.equal(f.length, Math.floor(144 * 320000 / 44100) + h.padding);
    padded += h.padding;
  }
  assert.ok(padded > 0 && padded < w.frames.length, 'padding bit alternates at 320 kbps / 44.1 kHz');
  // frames are contiguous
  for (let i = 1; i < w.frames.length; i++) assert.equal(w.frames[i].offset, w.frames[i - 1].offset + w.frames[i - 1].length);
  const d = mpegDuration(bytes);
  assert.ok(d);
  assert.equal(d.frames, w.frames.length);
  assertBound('320 kbps', d.samples, inputSamples, 1152);
  assert.ok(Math.abs(d.seconds - 2.0) <= 0.1, `duration ${d.seconds}`);
  assert.equal(d.frames, bruteForceFrames(bytes));
});

test('mixed-bitrate 112 + 320 kbps stream without Xing: no sync loss, duration within 2·(576 + 2·1152) of 20.0 s, naive estimate >= 2×', () => {
  const { bytes, inputSamples } = mixedBitrateStream(5, 15);
  const w = walk(bytes);
  assert.equal(w.syncLoss, 0); assert.equal(w.junkBytes, 0);
  const bitrates = new Set(w.frames.map((f) => f.bitrate));
  assert.deepEqual([...bitrates].sort((a, b) => a - b), [112000, 320000]);
  assert.ok(w.frames.every((f) => f.sampleRate === 44100), 'single sample rate');
  const d = mpegDuration(bytes);
  assertBound('mixed', d.samples, inputSamples, 1152, 2);
  assert.ok(Math.abs(d.seconds - 20.0) <= 0.14, `duration ${d.seconds}`);
  const naive = bytes.length * 8 / 112000;
  assert.ok(naive / d.seconds >= 2, `naive first-frame estimate ${naive.toFixed(2)} s is only ${(naive / d.seconds).toFixed(2)}× the true ${d.seconds.toFixed(2)} s`);
  assert.equal(d.frames, bruteForceFrames(bytes));
});

test('hand-inserted Info frame (320 kbps, tag at offset 36, bogus count 1,000,000) contributes 0 samples → same duration', () => {
  const { bytes } = mixedBitrateStream(5, 15);
  const base = mpegDuration(bytes);
  const info = buildFrame({ versionBits: 3, bitrateIndex: 0xE, srIndex: 0, mode: 0, tag: 'Info', tagOffset: 36 });
  assert.equal(info.length, 1044);
  const withInfo = concat([info.bytes, bytes]);
  const w = walk(withInfo);
  assert.equal(w.frames[0].isInfo, true); assert.equal(w.frames[0].samples, 0);
  assert.equal(w.frames.length, base.frames + 1);
  const d = mpegDuration(withInfo);
  assert.equal(d.seconds, base.seconds);
  assert.equal(d.samples, base.samples);
  // Xing spelled tag and VBRI at 36 are also recognised
  const xing = buildFrame({ versionBits: 3, bitrateIndex: 0xE, srIndex: 0, mode: 0, tag: 'Xing', tagOffset: 36 });
  assert.equal(walk(concat([xing.bytes, bytes])).frames[0].isInfo, true);
  const vbri = buildFrame({ versionBits: 3, bitrateIndex: 0xE, srIndex: 0, mode: 0, tag: 'VBRI', tagOffset: 36 });
  assert.equal(walk(concat([vbri.bytes, bytes])).frames[0].isInfo, true);
});

test('2,000 junk bytes mid-stream → resync, junkBytes 2000, syncLoss 1; > 1 % junk → null; free-format header → null', () => {
  const { bytes, inputSamples } = encodeStereo(2.0, 320);
  const w0 = walk(bytes);
  const cut = w0.frames[30].offset;
  const junk = new Uint8Array(2000).fill(0x41);
  const withJunk = concat([bytes.subarray(0, cut), junk, bytes.subarray(cut)]);
  const w = walk(withJunk);
  assert.equal(w.junkBytes, 2000);
  assert.equal(w.syncLoss, 1);
  assert.equal(w.frames.length, w0.frames.length);
  // 2000 B inside an 83 KB stream is 2.4 % > 1 % → the walker resynced but mpegDuration refuses to vouch
  assert.ok(2000 > 0.01 * withJunk.length);
  assert.equal(mpegDuration(withJunk), null, '> 1 % junk → null');
  // the same 2000 B inside a long stream (4 × 2 s ≈ 326 KB → 0.6 %) → resync + accepted, and the bound holds for 4 encodes
  const long = repeatBlocks(bytes, 4);
  const longJunk = concat([long.subarray(0, cut), junk, long.subarray(cut)]);
  const wl = walk(longJunk);
  assert.equal(wl.junkBytes, 2000); assert.equal(wl.syncLoss, 1);
  assert.equal(wl.frames.length, 4 * w0.frames.length);
  const dl = mpegDuration(longJunk);
  assert.ok(dl !== null, 'junk below 1 % is accepted');
  assert.equal(dl.junkBytes, 2000);
  assertBound('long+junk', dl.samples, 4 * inputSamples, 1152, 4);
  const shortStream = encodeStereo(0.5, 320).bytes;         // ≈ 20 KB → 2000 B = 10 %
  const shortJunk = concat([shortStream.subarray(0, walk(shortStream).frames[5].offset), junk, shortStream.subarray(walk(shortStream).frames[5].offset)]);
  assert.equal(walk(shortJunk).junkBytes, 2000);
  assert.equal(mpegDuration(shortJunk), null, '> 1 % junk → null');
  // free format: bitrate index 0 mid-stream
  const free = bytes.slice();
  free[w0.frames[10].offset + 2] &= 0x0F;                  // bitrate index → 0
  assert.equal(walk(free).freeFormat, true);
  assert.equal(mpegDuration(free), null);
  // ID3v1 TAG trailer and empty input
  const tag = new Uint8Array(128); tag.set([0x54, 0x41, 0x47]);
  const withTag = concat([bytes, tag]);
  assert.equal(walk(withTag).junkBytes, 0);
  assert.equal(mpegDuration(withTag).frames, w0.frames.length);
  assert.equal(mpegDuration(new Uint8Array(0)), null);
  assert.equal(mpegDuration(new Uint8Array(100).fill(0x41)), null);
});

test('LSF streams (MPEG-2 mono/stereo 22.05 kHz, MPEG-2.5 mono 11.025 kHz): fields, zero junk, frames === brute force, 576 samples/frame, bound', () => {
  const streams = lsfStreams();
  for (const [label, s] of Object.entries(streams)) {
    const w = walk(s.bytes);
    assert.equal(w.junkBytes, 0, `${label} junk`); assert.equal(w.syncLoss, 0);
    assert.ok(w.frames.length > 30, `${label} frames ${w.frames.length}`);
    for (const f of w.frames) {
      const h = fields(s.bytes, f.offset);
      assert.ok(h.sync); assert.equal(h.layer, 1);
      assert.equal(h.version, s.expect.versionBits, `${label} version bits`);
      assert.equal(f.sampleRate, s.expect.sampleRate, `${label} rate`);
      assert.equal(f.bitrate, s.expect.bitrate, `${label} bitrate`);
      assert.equal(f.mode, s.expect.mode, `${label} mode`);
      assert.equal(f.samples, 576, `${label} spf`);
      assert.equal(f.length, Math.floor(72 * f.bitrate / f.sampleRate) + h.padding, `${label} frame length`);
    }
    assert.equal(w.frames.length, bruteForceFrames(s.bytes), `${label} brute-force count`);
    const d = mpegDuration(s.bytes);
    assert.equal(d.samples, w.frames.length * 576);
    assertBound(label, d.samples, s.inputSamples, 576);
    console.log(`mp3 ${label}: ${w.frames.length} frames, ${d.samples} samples, ${d.seconds.toFixed(4)} s (input ${s.inputSamples / s.sampleRate} s)`);
  }
  // the 11.025 kHz stream is OUTSIDE a flat 0.1 s bar but inside the mechanistic one
  const d25 = mpegDuration(streams.mono11025.bytes);
  assert.ok(d25.seconds - 2.0 > 0.1, `11.025 kHz stream expected to exceed a flat 0.1 s bar (${d25.seconds})`);
});

test('Info frame offsets: MPEG-2 mono at 13 → 0 samples; moved to 21 → counted; CRC variant at 15 → 0 samples', () => {
  const { bytes: mono } = lsfStreams().mono22050;
  const base = mpegDuration(mono);
  // 64 kbps / 22,050 Hz / mono / MPEG-2 → floor(72·64000/22050) = 208 B
  const at13 = buildFrame({ versionBits: 2, bitrateIndex: 8, srIndex: 0, mode: 3, tag: 'Info', tagOffset: 13 });
  assert.equal(at13.length, 208);
  const d13 = mpegDuration(concat([at13.bytes, mono]));
  assert.equal(d13.frames, base.frames + 1);
  assert.equal(d13.samples, base.samples, 'Info at the mono MPEG-2 offset contributes 0 samples');
  const at21 = buildFrame({ versionBits: 2, bitrateIndex: 8, srIndex: 0, mode: 3, tag: 'Info', tagOffset: 21 });
  const d21 = mpegDuration(concat([at21.bytes, mono]));
  assert.equal(d21.samples, base.samples + 576, 'Info at the stereo offset is NOT the tag position of a mono frame → counted as audio');
  const crc = buildFrame({ versionBits: 2, bitrateIndex: 8, srIndex: 0, mode: 3, protection: 0, tag: 'Info', tagOffset: 15 });
  const dCrc = mpegDuration(concat([crc.bytes, mono]));
  assert.equal(dCrc.samples, base.samples, 'CRC-protected frame: Info at 4 + 2 + 9 = 15 contributes 0 samples');
  // MPEG-1 stereo with CRC: Info at 4 + 2 + 32 = 38
  const { bytes: st } = encodeStereo(1.0, 320);
  const b1 = mpegDuration(st);
  const crc1 = buildFrame({ versionBits: 3, bitrateIndex: 0xE, srIndex: 0, mode: 0, protection: 0, tag: 'Info', tagOffset: 38 });
  assert.equal(mpegDuration(concat([crc1.bytes, st])).samples, b1.samples);
  // MPEG-1 mono: 4 + 17 = 21
  const m1 = buildFrame({ versionBits: 3, bitrateIndex: 0xE, srIndex: 0, mode: 3, tag: 'Info', tagOffset: 21 });
  assert.equal(walk(concat([m1.bytes, st])).frames[0].isInfo, true);
});

test('per-frame sample-rate accumulation: a 44.1 kHz stream followed by a 22.05 kHz stream sums seconds per frame', () => {
  const a = encodeStereo(1.0, 320), b = lsfStreams().stereo22050;
  const both = concat([a.bytes, b.bytes]);
  const w = walk(both);
  assert.equal(w.junkBytes, 0);
  const d = mpegDuration(both);
  const expected = w.frames.reduce((acc, f) => acc + f.samples / f.sampleRate, 0);
  assert.ok(Math.abs(d.seconds - expected) < 1e-9);
  assert.ok(Math.abs(d.seconds - 3.0) < 0.2, `duration ${d.seconds}`);
});
