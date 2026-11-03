// site/src/engine/sniff.mjs — design §10.1: container sniffing for the pre-decode duration probe. Pure.
//   sniffContainer(bytes) → 'mpeg' | 'wav' | 'flac' | 'mp4' | 'ogg' | 'unknown'
//   isValidMpegHeader(b1, b2, b3, b4) = sync ∧ version ≠ 1 ∧ layer === Layer III ∧ bitrate index ∉ {0, 15} ∧ sample-rate index ≠ 3

const MPEG_SCAN_LIMIT = 4096;

const ascii = (bytes, off, s) => {
  if (off + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[off + i] !== s.charCodeAt(i)) return false;
  return true;
};

export function isValidMpegHeader(b1, b2, b3, b4) {
  if (b1 !== 0xFF || (b2 & 0xE0) !== 0xE0) return false;
  const version = (b2 >> 3) & 3;
  if (version === 1) return false;
  const layer = (b2 >> 1) & 3;
  if (layer !== 1) return false;                    // Layer III only
  const bitrateIndex = b3 >> 4;
  if (bitrateIndex === 0 || bitrateIndex === 15) return false;
  const srIndex = (b3 >> 2) & 3;
  if (srIndex === 3) return false;
  void b4;
  return true;
}

// ID3v2 tag length at the start of `bytes` (0 when absent): 10-byte header + syncsafe size (+10 with the footer flag 0x10).
export function id3v2Length(bytes) {
  if (bytes.length < 10 || !ascii(bytes, 0, 'ID3')) return 0;
  const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
  return 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
}

export function sniffContainer(bytes) {
  if (!(bytes instanceof Uint8Array)) return 'unknown';
  const off = id3v2Length(bytes);
  if (off >= bytes.length) return 'unknown';
  if (ascii(bytes, off, 'RIFF') && ascii(bytes, off + 8, 'WAVE')) return 'wav';
  if (ascii(bytes, off, 'fLaC')) return 'flac';
  if (ascii(bytes, off + 4, 'ftyp')) return 'mp4';
  if (ascii(bytes, off, 'OggS')) return 'ogg';
  const limit = Math.min(bytes.length - 4, off + MPEG_SCAN_LIMIT);
  for (let i = off; i <= limit; i++) {
    if (bytes[i] === 0xFF && isValidMpegHeader(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3])) return 'mpeg';
  }
  return 'unknown';
}
