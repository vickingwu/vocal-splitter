// site/src/engine/model-import.mjs — offline model import, FIX-2 R2b. The user hands over the original model file(s)
// (`.onnx`, `.onnx.data`) or the repo's own `part-NN.bin` chunks of one model; each is matched against the manifest by size,
// then hashed chunk by chunk (sha256 per manifest chunk, <= 19 MB in memory at a time — no second copy of a 213 MB file)
// and written to the part store under the loader's own keys (`${modelId}:${sha256}:part-<n>`, n = 4 MiB segment index), so
// the next load assembles it without any network request. A file the store already holds assembled (`${modelId}:${sha256}`)
// is verified but not written again (its parts would sit beside the file until the manifest changes); it still counts as
// 已导入. A store that cannot take the bytes (a throwing put, or the part-store facade's `false` once every backend failed)
// rejects with EngineError IMPORT_STORE — an import that stored nothing must not report 已导入. Runtime-agnostic: files are
// { name, size, slice(start, end) → Promise<Uint8Array> }; store / subtle injected.
// FIX-3 R4: the ONNX Runtime files (manifest.runtime.<backend>: ort-wasm-simd-threaded[.asyncify].wasm and the glue .mjs,
// `site/vendor/ort/` in the repo) are accepted the same way — hash-matched and stored under the loader's runtime keys
// (`runtime:<name>:<sha256>:part-<n>`); the result lists them as { kind: 'runtime', backend, bytes, files }.
import { planSegments, runtimeFiles, runtimeFileId } from './model-loader.mjs';
import { partKey, fileKey } from './part-store.mjs';
import { EngineError } from './errors.mjs';

const RUNTIME_BACKENDS = ['webgpu', 'wasm'];

function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// every manifest file / chunk whose byte count equals `size`: model files ({ modelId }) and runtime files ({ runtime:
// backend, keyId 'runtime:<name>' }); `keyId` is the store-key prefix the loader uses for the file
export function candidatesForSize(manifest, size) {
  const out = [];
  for (const [modelId, model] of Object.entries(manifest.models)) {
    for (const fileKey of ['model', 'externalData']) {
      const file = model.files[fileKey];
      if (!file) continue;
      if (file.bytes === size) out.push({ kind: 'whole', modelId, keyId: modelId, fileKey, file });
      file.chunks.forEach((chunk, chunkIndex) => { if (chunk.bytes === size) out.push({ kind: 'chunk', modelId, keyId: modelId, fileKey, file, chunkIndex, chunk }); });
    }
  }
  for (const backend of RUNTIME_BACKENDS) {
    for (const { key, file } of runtimeFiles(manifest, backend) ?? []) {
      if (file.bytes === size) out.push({ kind: 'whole', runtime: backend, keyId: runtimeFileId(file.name), fileKey: key, file });
    }
  }
  return out;
}

// → { imported: [{ kind: 'model', modelId, displayName, bytes, files: [{ name, matched, chunks }] } |
//                 { kind: 'runtime', backend, bytes, files }], mismatched: [names], totalBytes }
export async function importModelFiles(manifest, files, { store, subtle, onProgress } = {}) {
  if (!store) throw new Error('importModelFiles: store missing');
  const totalBytes = files.reduce((a, f) => a + (Number(f.size) || 0), 0);
  let doneBytes = 0;
  const progress = () => { if (onProgress) onProgress({ doneBytes, totalBytes }); };
  const imported = new Map();                 // modelId | 'runtime:<backend>' → { kind, modelId | backend, displayName?, bytes, files: [] }
  const mismatched = [];
  const sha256 = async (bytes) => hexOf(await subtle.digest('SHA-256', bytes));
  // storage is the whole point of an import: a put that throws, or the part-store facade reporting `false` (every backend
  // failed — private mode, quota), ends the import with IMPORT_STORE; the keys written so far are removed (best effort)
  const written = [];
  const put = async (key, bytes) => {
    let ok, cause = null;
    try { ok = await store.put(key, bytes); } catch (e) { ok = false; cause = e; }
    if (ok === false) {
      for (const k of written) { try { await store.delete(k); } catch { /* ignore */ } }
      throw new EngineError('IMPORT_STORE', `import: store put failed for ${key}${cause ? ': ' + (cause.message ?? cause) : ''}`, { key });
    }
    written.push(key);
  };

  // the assembled file is already in the store → nothing to write (checked once per file key; a failing keys() → not stored)
  const storedFiles = new Map();
  const fileStored = async (c) => {
    const k = fileKey(c.keyId, c.file.sha256);
    if (!storedFiles.has(k)) {
      let has = false;
      try { has = (await store.keys(k)).includes(k); } catch { has = false; }
      storedFiles.set(k, has);
    }
    return storedFiles.get(k);
  };
  // writes the bytes of chunk `chunkIndex` (already verified) as the loader's segments — unless the whole file is stored
  const storeChunk = async (c, bytes) => {
    if (await fileStored(c)) return 0;
    const segs = planSegments(c.file).filter((s) => s.chunkIndex === c.chunkIndex);
    for (const s of segs) await put(partKey(c.keyId, c.file.sha256, s.n), bytes.subarray(s.chunkOffset, s.chunkOffset + s.length));
    return segs.length;
  };
  const record = async (c, name, chunks, bytes) => {
    const id = c.runtime ? `runtime:${c.runtime}` : c.modelId;
    const m = imported.get(id) ?? (c.runtime
      ? { kind: 'runtime', backend: c.runtime, bytes: 0, files: [] }
      : { kind: 'model', modelId: c.modelId, displayName: manifest.models[c.modelId].displayName, bytes: 0, files: [] });
    m.bytes += bytes;
    m.files.push({ name, matched: c.file.name + (c.kind === 'chunk' ? ` chunk ${c.chunkIndex + 1}/${c.file.chunks.length}` : ''), chunks, alreadyStored: await fileStored(c) });
    imported.set(id, m);
  };

  progress();
  for (const f of files) {
    const size = Number(f.size) || 0;
    const candidates = candidatesForSize(manifest, size);
    let matched = false;
    // a part file is hashed once and compared with every same-size chunk of the manifest (most chunks share the 19,000,000 B size)
    const chunkCandidates = candidates.filter((c) => c.kind === 'chunk');
    if (chunkCandidates.length) {
      const bytes = await f.slice(0, size);
      const hex = await sha256(bytes);
      const c = chunkCandidates.find((x) => x.chunk.sha256 === hex);
      if (c) {
        const n = await storeChunk(c, bytes);
        doneBytes += size; progress();
        await record(c, f.name, n, size);
        matched = true;
      }
    }
    for (const c of candidates) {
      if (matched) break;
      if (c.kind !== 'whole') continue;
      // whole file: verify + store chunk by chunk; a mismatch on any chunk rejects this candidate (its stored parts are dropped)
      let off = 0, ok = true, segCount = 0;
      const doneBefore = doneBytes;
      const writtenBefore = written.length;
      for (let ci = 0; ci < c.file.chunks.length && ok; ci++) {
        const chunk = c.file.chunks[ci];
        const bytes = await f.slice(off, off + chunk.bytes);
        if (bytes.length !== chunk.bytes || await sha256(bytes) !== chunk.sha256) { ok = false; break; }
        segCount += await storeChunk({ ...c, chunkIndex: ci }, bytes);
        off += chunk.bytes;
        doneBytes = Math.min(totalBytes, doneBytes + chunk.bytes); progress();
      }
      if (!ok) { for (const k of written.splice(writtenBefore)) { try { await store.delete(k); } catch { /* ignore */ } } doneBytes = doneBefore; continue; }
      await record(c, f.name, segCount, size);
      matched = true;
      break;
    }
    if (!matched) { mismatched.push(f.name); doneBytes = Math.min(totalBytes, doneBytes + size); progress(); }
  }
  return { imported: [...imported.values()], mismatched, totalBytes };
}
