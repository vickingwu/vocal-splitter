// scripts/chunk_models.mjs — models_src/*.onnx -> site/models/<id>/part-NN.bin + site/models/manifest.json
// (design §3.1, §6.1, §6.2; FIX-2 R1: `sources` per model + chunks <= 19,000,000 B so jsDelivr can mirror them). Usage:
//   node scripts/chunk_models.mjs --version <ver> [--wasm-standard uvr_mdx_voc_ft|uvr_mdxnet_9482] [--tier2] [--out <dir>]
//        [--chunk-bytes 19000000] [--tag models-<ver>]
// Every MDX model's params come from the UVR hash table (MD5 of the LAST 10,240,000 bytes looked up in
// scripts/data/mdx_model_data.json); the build FAILS when the hash is absent, the whole-file sha256 differs
// from scripts/data/expected_sha256.json, or the table entry is not a Vocals model. Nothing is hard-coded.
// Sources come from scripts/data/model_sources.json: source 0 is always the same-origin chunk directory, then the
// byte-identical whole-file copies (Hugging Face) and the chunk mirrors (jsDelivr / raw GitHub and accelerators in front
// of them) for the git tag --tag (default models-<ver>); the tag must be created on the commit that contains the chunks.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CHUNK_BYTES = 19_000_000;   // jsDelivr serves GitHub files up to 20 MB
const UVR_HASH_BYTES = 10_240_000; // separator.py get_model_hash: BYTES_TO_HASH = 10000 * 1024
const RELEASE = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/';
const HF_TIER2 = 'https://huggingface.co/musetric/mel-band-roformer-duality-student-onnx';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const version = opt('--version', null);
const wasmStandard = opt('--wasm-standard', 'uvr_mdx_voc_ft');
const tier2 = args.includes('--tier2');
const outDir = resolve(repo, opt('--out', 'site/models'));
const CHUNK_BYTES = Number(opt('--chunk-bytes', String(MAX_CHUNK_BYTES)));
const srcDir = join(repo, 'models_src');
const evidenceDir = process.env.VS_EVIDENCE_DIR || join(repo, '..', 'evidence');

function fail(msg) { console.error('chunk_models: ' + msg); process.exit(1); }
if (!version || !/^[A-Za-z0-9._-]{1,64}$/.test(version)) fail('--version <ver> is required and must match /^[A-Za-z0-9._-]{1,64}$/');
if (!['uvr_mdx_voc_ft', 'uvr_mdxnet_9482'].includes(wasmStandard)) fail('--wasm-standard must be uvr_mdx_voc_ft or uvr_mdxnet_9482');
if (!Number.isInteger(CHUNK_BYTES) || CHUNK_BYTES < 1_000_000 || CHUNK_BYTES > MAX_CHUNK_BYTES) fail(`--chunk-bytes must be an integer in [1000000, ${MAX_CHUNK_BYTES}]`);
const tag = opt('--tag', `models-${version}`);
if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag)) fail('--tag must match /^[A-Za-z0-9._-]{1,80}$/');

const expected = JSON.parse(readFileSync(join(repo, 'scripts/data/expected_sha256.json'), 'utf8'));
const table = JSON.parse(readFileSync(join(repo, 'scripts/data/mdx_model_data.json'), 'utf8'));
const sourcesData = JSON.parse(readFileSync(join(repo, 'scripts/data/model_sources.json'), 'utf8'));

// manifest `sources` for one model: same-origin chunks first (the final fallback), whole-file copies, chunk mirrors
function sourcesFor(id, hasExternalData) {
  const out = [{ id: 'origin', kind: 'chunks', base: './', label: '站内' }];
  for (const w of sourcesData.whole[id] ?? []) {
    if (!w.urls || typeof w.urls.model !== 'string') fail(`model_sources.json whole.${id}.${w.id}: urls.model is required`);
    if (hasExternalData && typeof w.urls.externalData !== 'string') fail(`model_sources.json whole.${id}.${w.id}: urls.externalData is required for a two-file model`);
    const urls = { model: w.urls.model };
    if (hasExternalData) urls.externalData = w.urls.externalData;
    out.push({ id: w.id, kind: 'whole', urls, label: w.label });
  }
  for (const m of sourcesData.chunkMirrors) out.push({ id: m.id, kind: 'chunks', base: m.base.replace('{tag}', tag), label: m.label });
  const ids = new Set();
  for (const s of out) { if (ids.has(s.id)) fail(`duplicate source id ${s.id} for ${id}`); ids.add(s.id); }
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

function readVerified(name) {
  const p = join(srcDir, name);
  if (!existsSync(p)) fail(`missing ${p} — run scripts/fetch_models.ps1 first`);
  const buf = readFileSync(p);
  const hash = sha256(buf);
  if (!expected[name]) fail(`no expected sha256 for ${name} in scripts/data/expected_sha256.json`);
  if (hash !== expected[name]) fail(`sha256 mismatch for ${name}: ${hash} != ${expected[name]}`);
  return { buf, hash };
}

function uvrHashOf(buf) {
  const start = Math.max(0, buf.length - UVR_HASH_BYTES);
  return md5(buf.subarray(start));
}

function writeChunks(id, prefix, buf) {
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  const chunks = [];
  for (let off = 0, i = 0; off < buf.length; off += CHUNK_BYTES, i++) {
    const part = buf.subarray(off, Math.min(off + CHUNK_BYTES, buf.length));
    const file = `${prefix}part-${String(i).padStart(2, '0')}.bin`;
    writeFileSync(join(dir, file), part);
    chunks.push({ path: `models/${id}/${file}`, bytes: part.length, sha256: sha256(part) });
  }
  return chunks;
}

function mdxParams(uvrHash) {
  const e = table[uvrHash];
  if (!e) fail(`UVR hash ${uvrHash} not found in scripts/data/mdx_model_data.json`);
  for (const k of ['compensate', 'mdx_dim_f_set', 'mdx_dim_t_set', 'mdx_n_fft_scale_set', 'primary_stem']) {
    if (!(k in e)) fail(`table entry ${uvrHash} lacks ${k}`);
  }
  if (e.primary_stem !== 'Vocals') fail(`table entry ${uvrHash} is a ${e.primary_stem} model; only Vocals models are accepted`);
  const dimT = 2 ** e.mdx_dim_t_set;
  return {
    params: {
      sampleRate: 44100,
      nFft: e.mdx_n_fft_scale_set,
      hop: 1024,
      dimF: e.mdx_dim_f_set,
      dimT,
      segmentSize: dimT,          // always equal to dimT = 2^mdx_dim_t_set (§3.1)
      overlap: 0.25,
      compensate: e.compensate,
      primaryStem: 'vocals',
      zeroLowBins: 3,
      inputPeak: 0.9,
      outputPeak: 0.9,
    },
    tableEntry: e,
  };
}

const TIER1 = [
  { id: 'uvr_mdx_voc_ft', name: 'UVR-MDX-NET-Voc_FT.onnx', backends: ['webgpu', 'wasm'] },
  { id: 'uvr_mdxnet_9482', name: 'UVR_MDXNET_9482.onnx', backends: ['wasm'] },
];

const models = {};
const evidence = { version, chunkBytes: CHUNK_BYTES, models: {} };

for (const m of TIER1) {
  const { buf, hash } = readVerified(m.name);
  const uvrHash = uvrHashOf(buf);
  const { params, tableEntry } = mdxParams(uvrHash);
  rmSync(join(outDir, m.id), { recursive: true, force: true });
  const chunks = writeChunks(m.id, '', buf);
  models[m.id] = {
    displayName: '标准',
    tier: 1,
    arch: 'mdx',
    backends: m.backends,
    license: 'MIT',
    source: RELEASE + m.name,
    files: { model: { name: m.name, bytes: buf.length, sha256: hash, chunks } },
    sources: sourcesFor(m.id, false),
    uvrHash,
    params,
  };
  evidence.models[m.id] = { name: m.name, bytes: buf.length, sha256: hash, uvrHash, tableEntry, params, chunks };
  console.log(`${m.id}: ${m.name} ${buf.length} B sha256 ${hash.slice(0, 8)}… uvrHash ${uvrHash} ` +
    `nFft ${params.nFft} dimF ${params.dimF} dimT ${params.dimT} (dim_t_set ${tableEntry.mdx_dim_t_set}) compensate ${params.compensate} chunks ${chunks.length}`);
}

const tiers = {
  standard: { webgpu: 'uvr_mdx_voc_ft', wasm: wasmStandard, wasmLow: 'uvr_mdxnet_9482' },
};

if (tier2) {
  const core = readVerified('duality_student_core_t1100.onnx');
  const data = readVerified('duality_student_core_t1100.onnx.data');
  const id = 'melroformer_duality_student';
  rmSync(join(outDir, id), { recursive: true, force: true });
  const coreChunks = writeChunks(id, 'core.', core.buf);
  const dataChunks = writeChunks(id, 'data.', data.buf);
  models[id] = {
    displayName: '高质量',
    tier: 2,
    arch: 'melroformer',
    backends: ['webgpu'],
    license: 'Apache-2.0',
    source: HF_TIER2,
    files: {
      model: { name: 'duality_student_core_t1100.onnx', bytes: core.buf.length, sha256: core.hash, chunks: coreChunks },
      externalData: { name: 'duality_student_core_t1100.onnx.data', bytes: data.buf.length, sha256: data.hash, chunks: dataChunks },
    },
    sources: sourcesFor(id, true),
    params: {
      sampleRate: 44100, nFft: 2048, hop: 441, frames: 1100, chunkSamples: 484659, stepSamples: 352800,
      weight: 'hamming54', inputName: 'stft_repr', outputName: 'masks',
      requiredFeatures: ['shader-f16'], minStorageBuffersPerShaderStage: 9, inputPeak: 0.9, outputPeak: 0.9,
    },
  };
  tiers.hq = { webgpu: id };
  evidence.models[id] = { core: { bytes: core.buf.length, sha256: core.hash, chunks: coreChunks }, data: { bytes: data.buf.length, sha256: data.hash, chunks: dataChunks } };
  console.log(`${id}: core ${core.buf.length} B (${coreChunks.length} chunk) + data ${data.buf.length} B (${dataChunks.length} chunks)`);
}

const manifest = { schema: 1, version, tag, tiers, models };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${join(outDir, 'manifest.json')} (version ${version}, tag ${tag}, chunkBytes ${CHUNK_BYTES}, tiers.standard.wasm = ${wasmStandard})`);
evidence.tag = tag;

// Evidence: merge into models_sha256.json (written by fetch_models.ps1) — never inside the repo.
try {
  mkdirSync(evidenceDir, { recursive: true });
  const evPath = join(evidenceDir, 'models_sha256.json');
  // PowerShell 5.1's Out-File -Encoding utf8 writes a BOM; strip it before parsing.
  const prev = existsSync(evPath) ? JSON.parse(readFileSync(evPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const g = evidence.models.uvr_mdxnet_9482;
  prev.manifest = evidence;
  prev.a2_9482_geometry = g ? {
    uvrHash: g.uvrHash, nFft: g.params.nFft, dimF: g.params.dimF, dimT: g.params.dimT,
    mdx_dim_t_set: g.tableEntry.mdx_dim_t_set, compensate: g.params.compensate,
    chunkSize: g.params.hop * (g.params.dimT - 1),
  } : null;
  writeFileSync(evPath, JSON.stringify(prev, null, 2) + '\n');
  console.log(`evidence -> ${evPath}`);
} catch (e) {
  console.warn('evidence not written:', e.message);
}
