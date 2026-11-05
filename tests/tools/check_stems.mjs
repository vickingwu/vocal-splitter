// tests/tools/check_stems.mjs — validates a pair of stems produced by scripts/cli_separate.mjs (locally or by the GitHub
// Actions channel) against audio-separator's reference stems of the 25-s fixture:
//   node tests/tools/check_stems.mjs --vocals <人声.mp3|wav> --inst <伴奏.mp3|wav> [--ref-model uvr_mdx_voc_ft] [--out report.json]
//        [--expect-samples 1102500] [--bar 25]
// MP3s: every frame header is checked (MPEG-1 Layer III, 320 kbps, 44.1 kHz, stereo), duration Δ vs --expect-samples within
// [0, 2880] samples, then decoded with ffmpeg (float32; ffmpeg honours the LAME gapless tag, so the decode is sample-aligned)
// and compared with the reference. SNR = 10·log10(Σref² / Σ(ref − ours)²) over both channels on the common length, plus
// the best SNR over small offsets (±2048 samples) in case a decoder does not trim the encoder delay. WAVs are compared as is.
// Exit 0 when both stems reach --bar dB (WAV) — MP3 SNRs are reported, the bar applies to the raw stems only when --bar-mp3 is set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readWav } from '../../site/src/engine/wav.mjs';
import { walk, mpegDuration } from '../../site/src/engine/mp3frames.mjs';
import { snrStereoDb } from '../lib/snr.mjs';
import { referenceStems } from '../lib/fixtures.mjs';
import { outputNames } from '../../scripts/lib/cli_lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const args = { vocals: arg('--vocals'), inst: arg('--inst'), refModel: arg('--ref-model', 'uvr_mdx_voc_ft'), out: arg('--out'), expectSamples: Number(arg('--expect-samples', '1102500')), bar: Number(arg('--bar', '25')), barMp3: argv.includes('--bar-mp3'), ffmpeg: arg('--ffmpeg', 'ffmpeg') };
// --dir <dir> --base <name> [--ext mp3|wav]: the CLI's output names (人声-<name>.<ext> / 伴奏-<name>.<ext>) inside <dir>
if (arg('--dir') && arg('--base')) {
  const names = outputNames(arg('--base'));
  const ext = arg('--ext', 'mp3');
  args.vocals = path.join(arg('--dir'), ext === 'wav' ? names.vocalsWav : names.vocalsMp3);
  args.inst = path.join(arg('--dir'), ext === 'wav' ? names.instWav : names.instMp3);
}
if (!args.vocals || !args.inst) { console.error('usage: node tests/tools/check_stems.mjs (--vocals <file> --inst <file> | --dir <dir> --base <name> [--ext mp3|wav]) [--ref-model id] [--out json]'); process.exit(2); }

const MP3_SLACK = 576 + 2 * 1152;
function checkMp3(bytes, label) {
  const w = walk(bytes);
  const issues = [];
  if (w.junkBytes !== 0) issues.push(`${w.junkBytes} junk bytes`);
  if (w.frames.length === 0) issues.push('no frames');
  let bad = 0;
  for (const f of w.frames) {
    const b2 = bytes[f.offset + 1], b3 = bytes[f.offset + 2], b4 = bytes[f.offset + 3];
    const ok = bytes[f.offset] === 0xFF && (b2 & 0xE0) === 0xE0 && ((b2 >> 3) & 3) === 3 && ((b2 >> 1) & 3) === 1 && (b3 >> 4) === 0xE && ((b3 >> 2) & 3) === 0 && ((b4 >> 6) & 3) === 0;
    if (!ok) bad++;
  }
  if (bad) issues.push(`${bad} frames not MPEG-1 L3 320 kbps 44.1 kHz stereo`);
  const d = mpegDuration(bytes);
  const delta = d ? Math.round(d.seconds * 44100) - args.expectSamples : null;
  if (d === null) issues.push('duration null');
  else if (!(delta >= 0 && delta <= MP3_SLACK)) issues.push(`duration Δ ${delta} samples outside [0, ${MP3_SLACK}]`);
  return { label, frames: w.frames.length, bytes: bytes.length, durationS: d ? d.seconds : null, deltaSamples: delta, issues, ok: issues.length === 0 };
}

function decodeMp3(file) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-chk-')), 'd.wav');
  execFileSync(args.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', file, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', '-f', 'wav', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  const w = readWav(new Uint8Array(fs.readFileSync(tmp)));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  return w;
}

function snrWithOffsets(ref, ours) {
  const n = Math.min(ref.left.length, ours.left.length);
  const at0 = snrStereoDb(ref.left.subarray(0, n), ref.right.subarray(0, n), ours.left.subarray(0, n), ours.right.subarray(0, n));
  let best = { offset: 0, db: at0 };
  for (let off = -2048; off <= 2048; off += 16) {
    if (off === 0) continue;
    const m = n - Math.abs(off);
    const r = off > 0 ? [ref.left.subarray(off, off + m), ref.right.subarray(off, off + m)] : [ref.left.subarray(0, m), ref.right.subarray(0, m)];
    const o = off > 0 ? [ours.left.subarray(0, m), ours.right.subarray(0, m)] : [ours.left.subarray(-off, -off + m), ours.right.subarray(-off, -off + m)];
    const db = snrStereoDb(r[0], r[1], o[0], o[1]);
    if (db > best.db) best = { offset: off, db };
  }
  return { snrDb: at0, best, commonSamples: n, refSamples: ref.left.length, ourSamples: ours.left.length };
}

const refs = referenceStems(args.refModel);
const refV = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
const refI = readWav(new Uint8Array(fs.readFileSync(refs.instrumental)));
const result = { date: new Date().toISOString(), refModel: args.refModel, reference: { vocals: path.basename(refs.vocals), instrumental: path.basename(refs.instrumental) }, bar: args.bar, stems: {} };
let ok = true;
for (const [stem, file, ref] of [['vocals', args.vocals, refV], ['instrumental', args.inst, refI]]) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const isMp3 = /\.mp3$/i.test(file);
  const entry = { file: path.basename(file), bytes: bytes.length, kind: isMp3 ? 'mp3' : 'wav' };
  let ours;
  if (isMp3) { entry.mp3 = checkMp3(bytes, stem); if (!entry.mp3.ok) ok = false; ours = decodeMp3(file); }
  else ours = readWav(bytes);
  Object.assign(entry, snrWithOffsets(ref, ours));
  entry.pass = entry.snrDb >= args.bar;
  if ((!isMp3 || args.barMp3) && !entry.pass) ok = false;
  result.stems[stem] = entry;
  console.log(`[check] ${stem}: ${entry.kind} ${entry.bytes} B, SNR ${entry.snrDb.toFixed(2)} dB (best ${entry.best.db.toFixed(2)} dB at offset ${entry.best.offset})${entry.mp3 ? `, mp3 frames ${entry.mp3.frames} Δ ${entry.mp3.deltaSamples} ${entry.mp3.ok ? 'ok' : entry.mp3.issues.join('; ')}` : ''}`);
}
result.ok = ok;
if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n', 'utf8'); }
console.log(`[check] ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
