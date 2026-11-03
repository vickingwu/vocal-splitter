// scripts/separate_cli.mjs — run the engine in Node on a WAV file (onnxruntime-node, CPU EP).
//   node scripts/separate_cli.mjs <in.wav> <outDir> [--model <id>] [--denoise]
// Writes <base>_人声.wav and <base>_伴奏.wav (PCM16 44.1 kHz stereo) and prints the timings as JSON.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readWav, toInt16Planar, writeWav16 } from '../site/src/engine/wav.mjs';
import { validateManifest, loadModelBytes } from '../site/src/engine/model-loader.mjs';
import { createSession } from '../site/src/engine/session.mjs';
import { separateMdx } from '../site/src/engine/mdx.mjs';
import { makeNodeFetchInto } from './lib/fetch_into_node.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(code) {
  console.error('usage: node scripts/separate_cli.mjs <in.wav> <outDir> [--model <id>] [--denoise]');
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) usage(2);
  const [inFile, outDir] = positional;
  const modelIdx = argv.indexOf('--model');
  const modelId = modelIdx >= 0 ? argv[modelIdx + 1] : 'uvr_mdx_voc_ft';
  const denoise = argv.includes('--denoise');

  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(repo, 'site', 'models', 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')));
  const model = manifest.models[modelId];
  if (!model) { console.error(`unknown model id ${modelId}; known: ${Object.keys(manifest.models).join(', ')}`); process.exit(2); }
  if (model.arch !== 'mdx') { console.error(`model ${modelId} is not an mdx model`); process.exit(2); }

  const input = readWav(new Uint8Array(fs.readFileSync(inFile)));
  if (input.sampleRate !== 44100) { console.error(`input must be 44100 Hz (got ${input.sampleRate}); resample first`); process.exit(2); }

  const t0 = Date.now();
  const loaded = await loadModelBytes(manifest, modelId, {
    fetchInto: makeNodeFetchInto(path.join(repo, 'site')), cache: null, subtle: globalThis.crypto.subtle, baseUrl: 'http://localhost/',
  }, (e) => { if (e.stage === 'verify') process.stderr.write('verify\n'); });
  const loadMs = Date.now() - t0;
  const ort = require('onnxruntime-node');
  const t1 = Date.now();
  const session = await createSession(ort, { backend: 'cpu', bytes: loaded.bytes });
  const sessionMs = Date.now() - t1;

  const t2 = Date.now();
  const res = await separateMdx({
    ort, session, params: model.params, left: input.left, right: input.right, denoise,
    onProgress: (e) => { if (e.stage === 'separate') process.stderr.write(`chunk ${e.chunkIndex + 1}/${e.chunkCount}\n`); },
    shouldCancel: () => false,
  });
  const separateMs = Date.now() - t2;

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(inFile).replace(/\.[^.]+$/, '');
  const t3 = Date.now();
  const [vL, vR] = toInt16Planar(res.vocals[0], res.vocals[1]);
  fs.writeFileSync(path.join(outDir, `${base}_人声.wav`), Buffer.from(writeWav16(vL, vR, 44100)));
  const [iL, iR] = toInt16Planar(res.instrumental[0], res.instrumental[1]);
  fs.writeFileSync(path.join(outDir, `${base}_伴奏.wav`), Buffer.from(writeWav16(iL, iR, 44100)));
  const writeMs = Date.now() - t3;
  await session.release?.();

  console.log(JSON.stringify({
    modelId, denoise, frames: input.left.length, seconds: +(input.left.length / 44100).toFixed(3),
    chunkCount: res.timings.chunkMs.length,
    timings: { loadMs, sessionMs, separateMs, writeMs, chunkMs: res.timings.chunkMs.map((v) => Math.round(v)), stftMs: Math.round(res.timings.stftMs), istftMs: Math.round(res.timings.istftMs), totalMs: Date.now() - t0 },
    outputs: [path.join(outDir, `${base}_人声.wav`), path.join(outDir, `${base}_伴奏.wav`)],
  }, null, 2));
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
