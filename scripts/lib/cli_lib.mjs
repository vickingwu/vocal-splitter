// scripts/lib/cli_lib.mjs — the pure parts of scripts/cli_separate.mjs (argument parsing, model choice, output names,
// ffmpeg / ffprobe argument lists, the ffprobe answer → duration verdict), kept free of I/O so tests/unit/cli-separate.test.mjs
// covers them without ffmpeg or a model.
import { safeFileName, stripExtension } from '../../site/src/ui/url-input.mjs';

export const DEFAULTS = Object.freeze({
  model: null, tier: 'standard', out: 'out', name: null, wav: false, denoise: false, maxSeconds: 900,
  modelsBase: null, cache: null, sources: null, json: null, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', help: false,
});
const STRING_OPTS = ['model', 'tier', 'out', 'name', 'models-base', 'cache', 'sources', 'json', 'ffmpeg', 'ffprobe', 'max-seconds'];
const FLAG_OPTS = ['wav', 'denoise', 'help'];
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export const USAGE = `usage: node scripts/cli_separate.mjs <input> [options]
  input                 any audio or video file ffmpeg can read (mp3 / wav / m4a / flac / ogg / opus / mp4 / mov / webm …)
  --out <dir>           output directory (default out)
  --name <base>         output base name (default: the input file name without extension)
  --model <id>          manifest model id (uvr_mdx_voc_ft | uvr_mdxnet_9482 | melroformer_duality_student)
  --tier standard|hq    model by tier when --model is absent (standard → uvr_mdx_voc_ft, hq → melroformer_duality_student)
  --wav                 keep the WAV stems next to the MP3s
  --denoise             two inferences per chunk (mdx models only)
  --max-seconds <n>     refuse longer inputs (default 900)
  --models-base <x>     where the manifest's chunk paths resolve: a directory (default <repo>/site) or an https directory URL
                        such as https://raw.githubusercontent.com/vickingwu/vocal-splitter/<tag>/site/
  --cache <dir>         model store directory (segments while downloading, the assembled model afterwards); default: none
  --sources <ids>       comma-separated manifest source ids to use (default: origin only)
  --json <file>         write the report (timings, outputs, or the error) there as JSON
  --ffmpeg / --ffprobe  executables (default: on PATH)`;

// → { input, ...options }; throws Error('BAD_ARG: …') on unknown options or missing values.
export function parseArgs(argv) {
  const opts = { ...DEFAULTS, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { if (opts.input === null && argv[i + 1] !== undefined) opts.input = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2));
      if (FLAG_OPTS.includes(key)) { opts[camel(key)] = true; continue; }
      if (!STRING_OPTS.includes(key)) throw new Error(`BAD_ARG: unknown option ${a}`);
      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new Error(`BAD_ARG: ${a} needs a value`);
      opts[camel(key)] = value;
      continue;
    }
    if (opts.input !== null) throw new Error(`BAD_ARG: unexpected argument ${a}`);
    opts.input = a;
  }
  if (opts.tier !== 'standard' && opts.tier !== 'hq') throw new Error(`BAD_ARG: --tier must be standard or hq (got ${opts.tier})`);
  const ms = Number(opts.maxSeconds);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`BAD_ARG: --max-seconds must be a positive number (got ${opts.maxSeconds})`);
  opts.maxSeconds = ms;
  if (opts.sources !== null) opts.sources = String(opts.sources).split(',').map((s) => s.trim()).filter(Boolean);
  return opts;
}

// The model id for the run: --model wins (must exist); otherwise the tier's CPU-runnable entry (standard → the manifest's
// tiers.standard.wasm model, hq → tiers.hq.webgpu — the melroformer runs on the CPU EP here, the backends list is a browser rule).
export function chooseModelId(manifest, { model = null, tier = 'standard' } = {}) {
  if (model) {
    if (!manifest.models[model]) throw new Error(`UNKNOWN_MODEL: ${model}; known: ${Object.keys(manifest.models).join(', ')}`);
    return model;
  }
  const t = manifest.tiers[tier];
  const id = t ? (tier === 'hq' ? t.webgpu : (t.wasm ?? t.webgpu)) : undefined;
  if (!id || !manifest.models[id]) throw new Error(`NO_MODEL_FOR_TIER: ${tier}`);
  return id;
}

// 人声-<name>.mp3 / 伴奏-<name>.mp3 (+ .wav); <name> = --name or the input file name without extension, file-system safe,
// at most 80 characters, never empty.
export function baseName(inputPath, name = null) {
  const fileName = String(inputPath).split(/[\\/]/).pop() || '';
  const raw = name !== null && name !== undefined && String(name).trim() !== '' ? String(name) : (/^\.[^.]{1,5}$/.test(fileName) ? '' : stripExtension(fileName));
  let s = safeFileName(raw).trim().replace(/\s+/g, ' ');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s.length ? s : 'audio';
}
export function outputNames(base) {
  return {
    vocalsWav: `人声-${base}.wav`, instWav: `伴奏-${base}.wav`,
    vocalsMp3: `人声-${base}.mp3`, instMp3: `伴奏-${base}.mp3`,
  };
}

// ffprobe: duration and the audio streams as JSON
export function ffprobeArgs(input) {
  return ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', input];
}
// → { seconds, audioStreams, codec } | throws on no audio stream / no duration
export function parseProbe(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  const streams = Array.isArray(p.streams) ? p.streams.filter((s) => s.codec_type === 'audio') : [];
  if (streams.length === 0) throw new Error('NO_AUDIO: the file has no audio stream');
  const seconds = Number(p.format && p.format.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('NO_DURATION: ffprobe reported no duration');
  return { seconds, audioStreams: streams.length, codec: streams[0].codec_name ?? null, sampleRate: Number(streams[0].sample_rate) || null, channels: Number(streams[0].channels) || null };
}
// TOO_LONG detail or null (the same rule as the web app: exact duration, held to maxSeconds)
export function durationVerdict(seconds, maxSeconds) {
  return seconds > maxSeconds ? { seconds, maxSeconds } : null;
}

// decode: first audio stream → stereo 44.1 kHz float32 WAV (what the browser's decodeAudioData hands the engine)
export function ffmpegDecodeArgs(input, outWav) {
  return ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', '-f', 'wav', outWav];
}
// encode: 320 kbps CBR MP3, plain stereo (the web app's lamejs output format: MPEG-1 Layer III, 44.1 kHz, mode stereo)
export function ffmpegEncodeArgs(inWav, outMp3) {
  return ['-v', 'error', '-nostdin', '-y', '-i', inWav, '-c:a', 'libmp3lame', '-b:a', '320k', '-joint_stereo', '0', '-f', 'mp3', outMp3];
}

export const mmss = (s) => { const t = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
