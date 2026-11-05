// tests/unit/sniff.test.mjs — design §16.A row `sniff.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffContainer, isValidMpegHeader, id3v2Length } from '../../site/src/engine/sniff.mjs';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let off = 0; for (const p of parts) { o.set(p, off); off += p.length; } return o; };
const pad = (n, fill = 0) => new Uint8Array(n).fill(fill);

function id3v2(size, footer = false) {
  const h = new Uint8Array(10);
  h.set(ascii('ID3')); h[3] = 4; h[4] = 0; h[5] = footer ? 0x10 : 0;
  h[6] = (size >>> 21) & 0x7F; h[7] = (size >>> 14) & 0x7F; h[8] = (size >>> 7) & 0x7F; h[9] = size & 0x7F;
  const body = pad(size, 0x41);
  const foot = footer ? cat(ascii('3DI'), h.subarray(3)) : new Uint8Array(0);
  return cat(h, body, foot);
}

const MPEG1_L3 = Uint8Array.from([0xFF, 0xFB, 0x90, 0x00]);        // MPEG-1, L3, 128 kbps, 44.1 kHz, stereo
const MPEG2_L3 = Uint8Array.from([0xFF, 0xF3, 0x80, 0xC0]);        // MPEG-2 (version bits 10), L3
const MPEG25_L3 = Uint8Array.from([0xFF, 0xE3, 0x40, 0xC0]);       // MPEG-2.5 (version bits 00), L3
const RESERVED = Uint8Array.from([0xFF, 0xEB, 0x90, 0x00]);        // version bits 01 → invalid
const LAYER2 = Uint8Array.from([0xFF, 0xFD, 0x90, 0x00]);          // layer bits 10 = Layer II
const FREE = Uint8Array.from([0xFF, 0xFB, 0x00, 0x00]);            // bitrate index 0
const BAD_BR = Uint8Array.from([0xFF, 0xFB, 0xF0, 0x00]);          // bitrate index 15
const BAD_SR = Uint8Array.from([0xFF, 0xFB, 0x9C, 0x00]);          // sample-rate index 3

test('isValidMpegHeader field rules', () => {
  assert.equal(isValidMpegHeader(...MPEG1_L3), true);
  assert.equal(isValidMpegHeader(...MPEG2_L3), true);
  assert.equal(isValidMpegHeader(...MPEG25_L3), true);
  assert.equal(isValidMpegHeader(...RESERVED), false);
  assert.equal(isValidMpegHeader(...LAYER2), false);
  assert.equal(isValidMpegHeader(...FREE), false);
  assert.equal(isValidMpegHeader(...BAD_BR), false);
  assert.equal(isValidMpegHeader(...BAD_SR), false);
  assert.equal(isValidMpegHeader(0xFF, 0xDB, 0x90, 0x00), false);   // sync bits broken
  assert.equal(isValidMpegHeader(0xFE, 0xFB, 0x90, 0x00), false);
});

test('container labels', () => {
  assert.equal(sniffContainer(cat(ascii('RIFF'), pad(4), ascii('WAVE'), pad(32))), 'wav');
  assert.equal(sniffContainer(cat(ascii('fLaC'), pad(32))), 'flac');
  assert.equal(sniffContainer(cat(pad(4), ascii('ftyp'), ascii('M4A '), pad(32))), 'mp4');
  assert.equal(sniffContainer(cat(pad(4), ascii('ftyp'), ascii('isom'), pad(32))), 'mp4', 'mp4 video container → mp4');
  assert.equal(sniffContainer(cat(pad(4), ascii('ftyp'), ascii('qt  '), pad(32))), 'mp4', 'QuickTime .mov → mp4 (ISO BMFF)');
  assert.equal(sniffContainer(cat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3]), pad(32))), 'webm', 'EBML header → webm (webm / mkv)');
  assert.equal(sniffContainer(cat(Uint8Array.from([0x1A, 0x45, 0xDF]), pad(1))), 'unknown', 'truncated EBML magic → unknown');
  assert.equal(sniffContainer(cat(ascii('OggS'), pad(32))), 'ogg');
  assert.equal(sniffContainer(cat(MPEG1_L3, pad(400))), 'mpeg');
  assert.equal(sniffContainer(cat(MPEG2_L3, pad(400))), 'mpeg', 'FF F3 → mpeg');
  assert.equal(sniffContainer(cat(MPEG25_L3, pad(400))), 'mpeg', 'FF E3 → mpeg');
  assert.equal(sniffContainer(cat(RESERVED, pad(400))), 'unknown', 'FF EB → unknown');
  assert.equal(sniffContainer(cat(LAYER2, pad(400))), 'unknown', 'FF FD Layer II → unknown');
  assert.equal(sniffContainer(cat(FREE, pad(400))), 'unknown', 'free format → unknown');
  assert.equal(sniffContainer(cat(Uint8Array.from([0xFF, 0xF1, 0x50, 0x80, 0x00, 0x1F, 0xFC]), pad(400))), 'unknown', 'ADTS AAC → unknown');
  assert.equal(sniffContainer(cat(ascii('RF64'), pad(4), ascii('WAVE'), pad(32))), 'unknown', 'RF64 → unknown');
  const rnd = new Uint8Array(4096); let s = 7; for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) >>> 0; rnd[i] = (s >>> 16) & 0x7F; } // < 0x80 → never a sync byte
  assert.equal(sniffContainer(rnd), 'unknown', 'random bytes → unknown');
  assert.equal(sniffContainer(new Uint8Array(0)), 'unknown');
  assert.equal(sniffContainer(new Uint8Array(3)), 'unknown');
});

test('ID3v2 tag is skipped, with and without the footer flag', () => {
  const tagNoFooter = id3v2(300, false);
  assert.equal(id3v2Length(tagNoFooter), 310);
  assert.equal(sniffContainer(cat(tagNoFooter, MPEG1_L3, pad(400))), 'mpeg');
  const tagFooter = id3v2(300, true);
  assert.equal(id3v2Length(tagFooter), 320);
  assert.equal(tagFooter.length, 320);
  assert.equal(sniffContainer(cat(tagFooter, MPEG1_L3, pad(400))), 'mpeg');
  // without honouring the footer the scan would land in the footer bytes; with a WAV after the tag it must still say wav
  assert.equal(sniffContainer(cat(tagFooter, ascii('RIFF'), pad(4), ascii('WAVE'), pad(16))), 'wav');
  // tag longer than the buffer → unknown, no throw
  assert.equal(sniffContainer(id3v2(300, false).subarray(0, 100)), 'unknown');
  assert.equal(id3v2Length(ascii('ID3')), 0);
});

test('mpeg scan is limited to the first 4 KiB after the tag', () => {
  assert.equal(sniffContainer(cat(pad(4000, 0x41), MPEG1_L3, pad(100))), 'mpeg');
  assert.equal(sniffContainer(cat(pad(5000, 0x41), MPEG1_L3, pad(100))), 'unknown');
  assert.equal(sniffContainer(cat(id3v2(1000), pad(4000, 0x41), MPEG1_L3, pad(100))), 'mpeg');
});
