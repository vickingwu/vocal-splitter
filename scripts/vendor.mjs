// scripts/vendor.mjs — copy the pinned runtime files from node_modules into site/ byte-identical
// (design §2 / §8). Fails when a file is missing or its size differs from the pinned table: a
// different dist layout or size means the pinned package version changed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(repo, 'node_modules');
const site = join(repo, 'site');

const ORT_VERSION = '1.31.1';
const LAME_VERSION = '1.2.1';
const COI_VERSION = '0.1.7';

// [source, destination, expected bytes]
const FILES = [
  ['onnxruntime-web/dist/ort.wasm.min.mjs', 'vendor/ort/ort.wasm.min.mjs', 53725],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 24738],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'vendor/ort/ort-wasm-simd-threaded.wasm', 14848852],
  ['onnxruntime-web/dist/ort.webgpu.min.mjs', 'vendor/ort/ort.webgpu.min.mjs', 70742],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', 53457],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm', 28747738],
  ['lamejs/lame.min.js', 'vendor/lamejs/lame.min.js', 156043],
  ['coi-serviceworker/coi-serviceworker.min.js', 'coi-serviceworker.min.js', null], // site ROOT (SW scope); size not pinned
];

function pkgVersion(name) {
  return JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8')).version;
}
function expectVersion(name, want) {
  const got = pkgVersion(name);
  if (got !== want) throw new Error(`${name}: installed ${got}, expected ${want}`);
}

expectVersion('onnxruntime-web', ORT_VERSION);
expectVersion('lamejs', LAME_VERSION);
expectVersion('coi-serviceworker', COI_VERSION);

let failed = false;
for (const [src, dst, want] of FILES) {
  const from = join(nm, src);
  const to = join(site, dst);
  if (!existsSync(from)) { console.error(`MISSING ${src}`); failed = true; continue; }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const a = statSync(from).size;
  const b = statSync(to).size;
  const ok = a === b && (want === null || a === want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(a).padStart(10)} B  ${dst}${want === null ? '' : `  (expected ${want})`}`);
  if (!ok) failed = true;
}

// Licenses: onnxruntime-web's npm package ships no LICENSE file (only package.json "license": "MIT");
// scripts/data/onnxruntime_LICENSE is the upstream microsoft/onnxruntime LICENSE (MIT, Microsoft Corporation).
const ortLicense = existsSync(join(nm, 'onnxruntime-web/LICENSE'))
  ? join(nm, 'onnxruntime-web/LICENSE')
  : join(repo, 'scripts/data/onnxruntime_LICENSE');
copyFileSync(ortLicense, join(site, 'vendor/ort/LICENSE'));
copyFileSync(join(nm, 'lamejs/LICENSE'), join(site, 'vendor/lamejs/LICENSE'));
writeFileSync(join(site, 'vendor/ort/VERSION.json'), JSON.stringify({ 'onnxruntime-web': ORT_VERSION }) + '\n');
writeFileSync(join(site, 'vendor/lamejs/VERSION.json'), JSON.stringify({ lamejs: LAME_VERSION }) + '\n');
console.log(`licenses + VERSION.json written (coi-serviceworker ${COI_VERSION} at site root)`);

if (failed) { console.error('vendor: size/presence mismatch — pinned version changed?'); process.exit(1); }
