// scripts/lib/runtime_manifest.mjs — FIX-3 R1: the `runtime` section of site/models/manifest.json. Per backend the vendored
// onnxruntime-web glue (.mjs) and binary (.wasm) of site/vendor/ort/ with bytes / sha256 computed from the files, plus the
// download `sources` from scripts/data/runtime_sources.json (same-origin first, tag-pinned chunk mirrors that accept the
// file size, the official npm copies as whole-file sources). Used by scripts/chunk_models.mjs; `--version` and the tag are
// the manifest's.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_FILES = Object.freeze({
  webgpu: { wasm: 'ort-wasm-simd-threaded.asyncify.wasm', glue: 'ort-wasm-simd-threaded.asyncify.mjs' },
  wasm: { wasm: 'ort-wasm-simd-threaded.wasm', glue: 'ort-wasm-simd-threaded.mjs' },
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function fileEntry(vendorDir, name) {
  const p = join(vendorDir, name);
  statSync(p);                                   // throws when the vendored file is missing (run `npm run vendor` first)
  const buf = readFileSync(p);
  return { name, bytes: buf.length, sha256: sha256(buf) };
}

function sourcesFor(backend, names, data, tag) {
  const out = [{ id: 'origin', kind: 'chunks', base: './', label: '站内' }];
  for (const m of data.chunkMirrors) {
    if (Array.isArray(m.backends) && !m.backends.includes(backend)) continue;
    out.push({ id: m.id, kind: 'chunks', base: m.base.replace('{tag}', tag), label: m.label });
  }
  for (const n of data.npm) {
    out.push({ id: n.id, kind: 'whole', urls: { wasm: n.url.replace('{file}', names.wasm), glue: n.url.replace('{file}', names.glue) }, label: n.label });
  }
  const ids = new Set();
  for (const s of out) { if (ids.has(s.id)) throw new Error(`runtime_sources.json: duplicate source id ${s.id}`); ids.add(s.id); }
  return out;
}

// → { webgpu: { wasm, glue, sources }, wasm: { wasm, glue, sources } }
export function buildRuntimeSection({ repo, tag, sourcesData = null }) {
  const vendorDir = join(repo, 'site', 'vendor', 'ort');
  const data = sourcesData ?? JSON.parse(readFileSync(join(repo, 'scripts', 'data', 'runtime_sources.json'), 'utf8'));
  const runtime = {};
  for (const [backend, names] of Object.entries(RUNTIME_FILES)) {
    runtime[backend] = { wasm: fileEntry(vendorDir, names.wasm), glue: fileEntry(vendorDir, names.glue), sources: sourcesFor(backend, names, data, tag) };
  }
  return runtime;
}
