// site/src/engine/mp3frames.mjs — design §10.1: MPEG Layer III frame walk and exact duration. Pure.
//   walk(bytes)         → { frames: [{ offset, length, version, bitrate, sampleRate, mode, samples, isInfo }], junkBytes, syncLoss }
//   mpegDuration(bytes) → { seconds, frames, samples } | null   (null on free format or junkBytes > 1 % of bytes.length)
// Tables: bitrate (kbps) MPEG-1 L3 / MPEG-2+2.5 L3, sample rate per version, 1152 / 576 samples per frame,
// frameLength = floor((spf/8)·bitrate/sampleRate) + padding, side info 32/17 (MPEG-1 non-mono/mono) 17/9 (MPEG-2/2.5),
// Xing/Info at 4 + (protection === 0 ? 2 : 0) + sideInfo — both positions checked when a CRC is present — VBRI at 36.
import { isValidMpegHeader, id3v2Length } from './sniff.mjs';

const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATE = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

const ascii = (bytes, off, s) => {
  if (off + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[off + i] !== s.charCodeAt(i)) return false;
  return true;
};

// Decodes a 4-byte header at `off`; null when invalid. `freeFormat: true` for bitrate index 0 (valid sync, no length).
export function parseHeader(bytes, off) {
  if (off + 4 > bytes.length) return null;
  const b1 = bytes[off], b2 = bytes[off + 1], b3 = bytes[off + 2], b4 = bytes[off + 3];
  if (b1 !== 0xFF || (b2 & 0xE0) !== 0xE0) return null;
  const versionBits = (b2 >> 3) & 3;
  if (versionBits === 1) return null;
  if (((b2 >> 1) & 3) !== 1) return null;
  const bitrateIndex = b3 >> 4;
  if (bitrateIndex === 15) return null;
  const srIndex = (b3 >> 2) & 3;
  if (srIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const protection = b2 & 1;
  const padding = (b3 >> 1) & 1;
  const mode = (b4 >> 6) & 3;
  const sampleRate = SAMPLE_RATE[version][srIndex];
  const samples = version === 1 ? 1152 : 576;
  const sideInfo = version === 1 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
  if (bitrateIndex === 0) return { freeFormat: true, version, versionBits, sampleRate, samples, mode, protection, padding, sideInfo };
  const bitrate = (version === 1 ? BITRATE_V1 : BITRATE_V2)[bitrateIndex] * 1000;
  const length = Math.floor((samples / 8) * bitrate / sampleRate) + padding;
  return { freeFormat: false, version, versionBits, bitrate, bitrateIndex, sampleRate, srIndex, samples, mode, protection, padding, sideInfo, length };
}

function isInfoFrame(bytes, off, h) {
  const base = off + 4 + h.sideInfo;
  // without CRC the tag sits right after the side info; with CRC 2 bytes later — check both when protection === 0
  if (ascii(bytes, base, 'Xing') || ascii(bytes, base, 'Info')) return true;
  if (h.protection === 0 && (ascii(bytes, base + 2, 'Xing') || ascii(bytes, base + 2, 'Info'))) return true;
  if (ascii(bytes, off + 36, 'VBRI')) return true;
  return false;
}

function trailerStart(bytes) {
  let end = bytes.length;
  if (end >= 128 && ascii(bytes, end - 128, 'TAG')) end -= 128;
  // APETAGEX footer: 32 bytes; its size field (bytes 12..15) covers the items + footer (not the header)
  if (end >= 32 && ascii(bytes, end - 32, 'APETAGEX')) {
    const size = (bytes[end - 20] | (bytes[end - 19] << 8) | (bytes[end - 18] << 16)) + bytes[end - 17] * 0x1000000;
    const flags = (bytes[end - 12] | (bytes[end - 11] << 8) | (bytes[end - 10] << 16)) + bytes[end - 9] * 0x1000000;
    const hasHeader = (flags & 0x80000000) !== 0;
    const total = size + (hasHeader ? 32 : 0);
    end = Math.max(0, end - total);
  }
  return end;
}

export function walk(bytes) {
  const frames = [];
  let junkBytes = 0, syncLoss = 0, freeFormat = false;
  const end = trailerStart(bytes);
  let i = id3v2Length(bytes);
  if (i > end) i = end;
  let inJunk = false;
  while (i + 4 <= end) {
    const h = parseHeader(bytes, i);
    if (h === null) {
      if (!inJunk && frames.length > 0) syncLoss++;
      inJunk = true;
      i++; junkBytes++;
      continue;
    }
    if (h.freeFormat) { freeFormat = true; break; }
    inJunk = false;
    const isInfo = isInfoFrame(bytes, i, h);
    frames.push({ offset: i, length: h.length, version: h.version, bitrate: h.bitrate, sampleRate: h.sampleRate, mode: h.mode, samples: isInfo ? 0 : h.samples, isInfo, protection: h.protection, padding: h.padding });
    i += h.length;
  }
  // bytes after the last frame that were never reached count as neither frame nor junk (a truncated last frame)
  return { frames, junkBytes, syncLoss, freeFormat, end };
}

export function mpegDuration(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  const w = walk(bytes);
  if (w.freeFormat) return null;
  if (w.junkBytes > 0.01 * bytes.length) return null;
  if (w.frames.length === 0) return null;
  let seconds = 0, samples = 0;
  for (const f of w.frames) { seconds += f.samples / f.sampleRate; samples += f.samples; }
  return { seconds, frames: w.frames.length, samples, junkBytes: w.junkBytes, syncLoss: w.syncLoss };
}
