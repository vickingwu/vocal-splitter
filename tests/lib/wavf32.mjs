// tests/lib/wavf32.mjs — float32 (formatTag 3) stereo WAV writer for evidence stems (Node only; readWav reads it back).
import fs from 'node:fs';

export function wavF32Buffer(left, right, sampleRate = 44100) {
  const n = left.length;
  if (right.length !== n) throw new Error('wavF32Buffer: channel lengths differ');
  const dataBytes = n * 8;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0, o = 44; i < n; i++, o += 8) { buf.writeFloatLE(left[i], o); buf.writeFloatLE(right[i], o + 4); }
  return buf;
}

export function writeWavF32(file, left, right, sampleRate = 44100) {
  fs.writeFileSync(file, wavF32Buffer(left, right, sampleRate));
}
