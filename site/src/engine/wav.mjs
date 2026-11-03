// site/src/engine/wav.mjs — design §5 / §10.1: RIFF/WAVE header walk with the clamp rules, PCM/float reader,
// the ONLY float → int16 step (toInt16Planar), and the PCM16 writer. Runtime-agnostic, pure.
import { EngineError } from './errors.mjs';

const ASCII = (bytes, off, s) => {
  if (off + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[off + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

// Returns { sampleRate, channels, bitsPerSample, formatTag, blockAlign, dataOffset, dataBytes, frames } or null.
// null = "not something whose duration we can vouch for" (§10.1): never throws.
export function readWavHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length < 12 || !ASCII(bytes, 0, 'RIFF') || !ASCII(bytes, 8, 'WAVE')) return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const size = u32(bytes, off + 4);
    const payload = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || payload + 16 > bytes.length) return null;
      let formatTag = u16(bytes, payload);
      const channels = u16(bytes, payload + 2);
      const sampleRate = u32(bytes, payload + 4);
      const blockAlign = u16(bytes, payload + 12);
      const bitsPerSample = u16(bytes, payload + 14);
      if (formatTag === 0xFFFE) {
        // WAVE_FORMAT_EXTENSIBLE: cbSize at +16, SubFormat GUID at +24 (first two bytes = the PCM/float tag)
        if (size < 40 || payload + 40 > bytes.length) return null;
        const sub = u16(bytes, payload + 24);
        // the rest of the KSDATAFORMAT_SUBTYPE GUID: 0000-0010-8000-00aa00389b71
        const guidTail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71];
        for (let i = 0; i < guidTail.length; i++) if (bytes[payload + 26 + i] !== guidTail[i]) return null;
        if (sub !== 1 && sub !== 3) return null;
        formatTag = sub;
      }
      if (formatTag !== 1 && formatTag !== 3) return null;
      if (channels === 0 || sampleRate === 0 || blockAlign === 0) return null;
      if (![8, 16, 24, 32, 64].includes(bitsPerSample)) return null;
      if (blockAlign !== channels * (bitsPerSample / 8)) return null;
      if (formatTag === 3 && bitsPerSample !== 32 && bitsPerSample !== 64) return null;
      if (formatTag === 1 && bitsPerSample === 64) return null;
      fmt = { formatTag, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === 'data') {
      if (fmt === null) return null;
      const dataOffset = payload;
      if (dataOffset > bytes.length) return null;
      const available = bytes.length - dataOffset;
      const dataBytes = Math.min(size, available);
      return { ...fmt, dataOffset, dataBytes, frames: Math.floor(dataBytes / fmt.blockAlign) };
    }
    // chunks are padded to an even length
    off = payload + size + (size & 1);
    if (off < payload) return null;   // overflow guard
  }
  return null;
}

// Returns { sampleRate, left, right } (Float32Array planar). Sample scale: PCM8 (x − 128)/128, PCM16 x/32768,
// PCM24 x/8388608, PCM32 x/2147483648, float32/float64 as is. Mono → right = copy of left.
export function readWav(bytes) {
  const h = readWavHeader(bytes);
  if (h === null) throw new EngineError('DECODE', 'not a PCM/float WAV file');
  const { frames, channels, bitsPerSample, formatTag, blockAlign, dataOffset } = h;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = bitsPerSample / 8;
  const read = (() => {
    if (formatTag === 3 && bitsPerSample === 32) return (o) => view.getFloat32(o, true);
    if (formatTag === 3 && bitsPerSample === 64) return (o) => view.getFloat64(o, true);
    switch (bitsPerSample) {
      case 8: return (o) => (bytes[o] - 128) / 128;
      case 16: return (o) => view.getInt16(o, true) / 32768;
      case 24: return (o) => (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608;
      case 32: return (o) => view.getInt32(o, true) / 2147483648;
      default: throw new EngineError('DECODE', `unsupported bit depth ${bitsPerSample}`);
    }
  })();
  const rightCh = channels === 1 ? 0 : 1;
  for (let i = 0; i < frames; i++) {
    const base = dataOffset + i * blockAlign;
    left[i] = read(base);
    right[i] = read(base + rightCh * bps);
  }
  return { sampleRate: h.sampleRate, left, right };
}

// The only float → int step: clamp(round(x·32768), −32768, 32767), NaN → 0. Reads through the typed-array views,
// so offset views (the vocals stems of §3.3) need no copy. Allocation failures propagate as RangeError (→ OOM).
export function toInt16Planar(left, right) {
  const n = left.length;
  if (right.length !== n) throw new EngineError('INTERNAL', 'toInt16Planar: channel lengths differ');
  const out = [new Int16Array(n), new Int16Array(n)];
  const src = [left, right];
  for (let c = 0; c < 2; c++) {
    const s = src[c], d = out[c];
    for (let i = 0; i < n; i++) {
      let v = Math.round(s[i] * 32768);
      if (v !== v) v = 0;
      else if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      d[i] = v;
    }
  }
  return out;
}

// 44-byte RIFF/WAVE header + interleaved PCM16. Takes ONLY Int16Arrays (TypeError otherwise, §11).
export function writeWav16(leftI16, rightI16, sampleRate = 44100) {
  if (!(leftI16 instanceof Int16Array) || !(rightI16 instanceof Int16Array)) throw new TypeError('writeWav16 expects two Int16Array channels');
  const n = leftI16.length;
  if (rightI16.length !== n) throw new EngineError('INTERNAL', 'writeWav16: channel lengths differ');
  const channels = 2, blockAlign = channels * 2, dataBytes = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w4(8, 'WAVE');
  w4(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
  w4(36, 'data'); v.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(buf, 44, n * 2);
  for (let i = 0, j = 0; i < n; i++, j += 2) { pcm[j] = leftI16[i]; pcm[j + 1] = rightI16[i]; }
  return buf;
}
