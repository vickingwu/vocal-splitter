// scripts/cli_separate.mjs — the web app's engine as a command-line tool (Node 20+, onnxruntime-node CPU EP, ffmpeg).
//   node scripts/cli_separate.mjs <input> [--out dir] [--name base] [--model id | --tier standard|hq] [--wav] [--denoise]
//        [--max-seconds 900] [--models-base <dir|https URL>] [--cache dir] [--sources ids] [--json file] [--ffmpeg x] [--ffprobe x]
// Pipeline: ffprobe (audio stream, duration ≤ --max-seconds) → ffmpeg → stereo 44.1 kHz float32 WAV → the same model loader /
// separation code as site/ (loadModelBytes with the fs store, separateMdx / separateRoformer on the CPU EP) → PCM16 WAV
// stems → ffmpeg libmp3lame 320 kbps CBR → 人声-<name>.mp3 / 伴奏-<name>.mp3 (WAVs kept with --wav). Model bytes come from
// the manifest's chunk paths under --models-base (the local site/ directory by default, or a raw.githubusercontent.com tag
// URL on a GitHub Actions runner), are sha256-verified and, with --cache, persisted there for the next run. The report
// (timings per stage, outputs) is printed as JSON and written to --json; on failure the JSON carries { ok: false, code }.
// Exit codes: 0 ok · 2 usage · 3 input refused (TOO_LONG / NO_AUDIO / DECODE) · 1 anything else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readWav, toInt16Planar, writeWav16 } from '../site/src/engine/wav.mjs';
import { validateManifest, loadModelBytes } from '../site/src/engine/model-loader.mjs';
import { createSession } from '../site/src/engine/session.mjs';
import { separateMdx } from '../site/src/engine/mdx.mjs';
import { separateRoformer } from '../site/src/engine/roformer.mjs';
import { makeNodeFetchInto } from './lib/fetch_into_node.mjs';
import { makeFetchInto } from './lib/fetch_into_http.mjs';
import { createFsStore } from './lib/fs_store.mjs';
import { USAGE, parseArgs, chooseModelId, baseName, outputNames, ffprobeArgs, parseProbe, durationVerdict, ffmpegDecodeArgs, ffmpegEncodeArgs, mmss } from './lib/cli_lib.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(`[cli] ${a.join(' ')}\n`);

function run(bin, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { const e = new Error(`${path.basename(bin)} failed: ${String(stderr || err.message).trim().slice(0, 2000)}`); e.code = err.code === 'ENOENT' ? 'FFMPEG_MISSING' : 'FFMPEG'; e.stderr = String(stderr); return reject(e); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

class CliError extends Error { constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; } }
const r1 = (v) => Math.round(v);

async function main() {
  const argv = process.argv.slice(2);
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
  if (opts.help || !opts.input) { console.error(USAGE); process.exit(opts.help ? 0 : 2); }
  const t0 = Date.now();
  const report = { ok: false, input: path.resolve(opts.input), stages: {}, date: new Date().toISOString(), node: process.version };
  const writeJson = () => { if (opts.json) { fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true }); fs.writeFileSync(opts.json, JSON.stringify(report, null, 2) + '\n', 'utf8'); } };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cli-'));
  try {
    if (!fs.existsSync(opts.input)) throw new CliError('INPUT_MISSING', `input not found: ${opts.input}`);
    report.inputBytes = fs.statSync(opts.input).size;

    // 1 — probe (audio stream, duration cap)
    let tp = Date.now();
    const probeRaw = await run(opts.ffprobe, ffprobeArgs(opts.input)).catch((e) => { throw new CliError(e.code === 'FFMPEG_MISSING' ? 'FFMPEG_MISSING' : 'DECODE', e.message); });
    let probe;
    try { probe = parseProbe(probeRaw.stdout); } catch (e) { throw new CliError(e.message.startsWith('NO_AUDIO') ? 'NO_AUDIO' : 'DECODE', e.message); }
    report.probe = probe;
    report.stages.probeMs = Date.now() - tp;
    const tooLong = durationVerdict(probe.seconds, opts.maxSeconds);
    if (tooLong) throw new CliError('TOO_LONG', `input is ${mmss(Math.ceil(probe.seconds))}, limit ${mmss(opts.maxSeconds)}`, tooLong);
    log(`input ${probe.codec ?? '?'} ${mmss(probe.seconds)} (${probe.seconds.toFixed(3)} s)`);

    // 2 — decode to stereo 44.1 kHz float32 WAV
    tp = Date.now();
    const decodedWav = path.join(tmpDir, 'in.wav');
    await run(opts.ffmpeg, ffmpegDecodeArgs(opts.input, decodedWav)).catch((e) => { throw new CliError(e.code === 'FFMPEG_MISSING' ? 'FFMPEG_MISSING' : 'DECODE', e.message); });
    const input = readWav(new Uint8Array(fs.readFileSync(decodedWav)));
    fs.rmSync(decodedWav, { force: true });
    if (input.sampleRate !== 44100) throw new CliError('DECODE', `ffmpeg wrote ${input.sampleRate} Hz`);
    report.frames = input.left.length;
    report.seconds = +(input.left.length / 44100).toFixed(3);
    report.stages.decodeMs = Date.now() - tp;
    if (report.seconds > opts.maxSeconds) throw new CliError('TOO_LONG', `decoded ${mmss(Math.ceil(report.seconds))}, limit ${mmss(opts.maxSeconds)}`, { seconds: report.seconds, maxSeconds: opts.maxSeconds });
    log(`decoded ${report.frames} frames in ${report.stages.decodeMs} ms`);

    // 3 — model bytes (manifest from the repo; chunks from --models-base; persisted in --cache)
    tp = Date.now();
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(repo, 'site', 'models', 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')));
    const modelId = chooseModelId(manifest, { model: opts.model, tier: opts.tier });
    const model = manifest.models[modelId];
    report.modelId = modelId; report.arch = model.arch; report.manifestVersion = manifest.version;
    let baseUrl, fetchInto;
    if (opts.modelsBase && /^https?:\/\//i.test(opts.modelsBase)) {
      baseUrl = opts.modelsBase.endsWith('/') ? opts.modelsBase : opts.modelsBase + '/';
      fetchInto = makeFetchInto(path.join(repo, 'site'));
    } else {
      baseUrl = 'http://localhost/';
      fetchInto = makeNodeFetchInto(opts.modelsBase ? path.resolve(opts.modelsBase) : path.join(repo, 'site'));
    }
    const store = opts.cache ? createFsStore(opts.cache) : null;
    report.model = { source: baseUrl, cache: store ? store.dir : null, sources: opts.sources ?? ['origin'] };
    let lastLine = '';
    const loaded = await loadModelBytes(manifest, modelId, {
      fetchInto, store, subtle: globalThis.crypto.subtle, baseUrl, sourceIds: opts.sources ?? ['origin'], warn: (...a) => log('warn', ...a.map(String)),
    }, (e) => {
      if (e.stage === 'download') { const line = `download ${Math.round((e.bytesDone ?? 0) / 1048576)} / ${Math.round((e.bytesTotal ?? 0) / 1048576)} MB`; if (line !== lastLine) { lastLine = line; log(line); } }
      else if (e.stage === 'verify') log('verify');
    });
    report.stages.modelMs = Date.now() - tp;
    const rep = loaded.report;
    report.download = { fromStore: rep.fromStore, restoredBytes: rep.restoredBytes, downloadedBytes: rep.downloadedBytes, used: rep.used, sources: rep.sources ? rep.sources.map((s) => ({ id: s.id, kBps: s.probe?.kBps ?? null, ranges: s.ranges })) : null, excluded: rep.excluded, failures: rep.failures, concurrency: rep.concurrency };
    log(`model ${modelId} ready in ${report.stages.modelMs} ms (${rep.fromStore.length ? 'from cache' : `downloaded ${Math.round(rep.downloadedBytes / 1048576)} MB`})`);

    // 4 — session + separation (CPU EP)
    tp = Date.now();
    const ort = require('onnxruntime-node');
    const session = await createSession(ort, { backend: 'cpu', bytes: loaded.bytes, externalData: loaded.externalData });
    report.stages.sessionMs = Date.now() - tp;
    report.ortNodeVersion = require('onnxruntime-node/package.json').version;
    tp = Date.now();
    const onProgress = (e) => { if (e.stage === 'separate') log(`chunk ${e.chunkIndex + 1}/${e.chunkCount}`); };
    let res;
    if (model.arch === 'mdx') res = await separateMdx({ ort, session, params: model.params, left: input.left, right: input.right, denoise: opts.denoise, onProgress, shouldCancel: () => false });
    else {
      if (opts.denoise) log('warn --denoise ignored: the melroformer host has no denoise pass');
      res = await separateRoformer({ ort, session, params: model.params, left: input.left, right: input.right, onProgress, shouldCancel: () => false });
    }
    report.stages.separateMs = Date.now() - tp;
    report.chunkCount = res.timings.chunkMs.length;
    report.chunkMs = res.timings.chunkMs.map(r1);
    report.stftMs = r1(res.timings.stftMs); report.istftMs = r1(res.timings.istftMs);
    await session.release?.();
    log(`separated ${report.chunkCount} chunks in ${report.stages.separateMs} ms`);

    // 5 — outputs: PCM16 WAV stems → 320 kbps MP3 (ffmpeg); WAVs kept only with --wav
    tp = Date.now();
    const base = baseName(opts.input, opts.name);
    const names = outputNames(base);
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    const wavPaths = { vocals: path.join(opts.wav ? outDir : tmpDir, names.vocalsWav), instrumental: path.join(opts.wav ? outDir : tmpDir, names.instWav) };
    const [vL, vR] = toInt16Planar(res.vocals[0], res.vocals[1]);
    fs.writeFileSync(wavPaths.vocals, Buffer.from(writeWav16(vL, vR, 44100)));
    const [iL, iR] = toInt16Planar(res.instrumental[0], res.instrumental[1]);
    fs.writeFileSync(wavPaths.instrumental, Buffer.from(writeWav16(iL, iR, 44100)));
    report.stages.wavMs = Date.now() - tp;
    tp = Date.now();
    const mp3Paths = { vocals: path.join(outDir, names.vocalsMp3), instrumental: path.join(outDir, names.instMp3) };
    await Promise.all([
      run(opts.ffmpeg, ffmpegEncodeArgs(wavPaths.vocals, mp3Paths.vocals)),
      run(opts.ffmpeg, ffmpegEncodeArgs(wavPaths.instrumental, mp3Paths.instrumental)),
    ]).catch((e) => { throw new CliError('MP3', e.message); });
    report.stages.encodeMs = Date.now() - tp;
    report.outputs = {
      vocalsMp3: mp3Paths.vocals, instMp3: mp3Paths.instrumental,
      ...(opts.wav ? { vocalsWav: wavPaths.vocals, instWav: wavPaths.instrumental } : {}),
    };
    report.outputBytes = Object.fromEntries(Object.entries(report.outputs).map(([k, p]) => [k, fs.statSync(p).size]));
    report.base = base;
    report.stages.totalMs = Date.now() - t0;
    report.ok = true;
    writeJson();
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    const code = e instanceof CliError ? e.code : (e && e.code && typeof e.code === 'string' ? e.code : 'INTERNAL');
    report.ok = false;
    report.code = code;
    report.message = e && e.message ? String(e.message).slice(0, 2000) : String(e);
    if (e && e.detail) report.detail = e.detail;
    report.stages.totalMs = Date.now() - t0;
    writeJson();
    console.error(`[cli] FAIL ${code}: ${report.message}`);
    if (!(e instanceof CliError) && e && e.stack) console.error(e.stack);
    process.exitCode = ['TOO_LONG', 'NO_AUDIO', 'DECODE', 'INPUT_MISSING'].includes(code) ? 3 : 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
