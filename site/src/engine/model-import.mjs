// site/src/engine/model-import.mjs — offline model import, FIX-2 R2b. The user hands over the original model file(s)
// (`.onnx`, `.onnx.data`) or the repo's own `part-NN.bin` chunks of one model; each is matched against the manifest by size,
// then hashed chunk by chunk (sha256 per manifest chunk, <= 19 MB in memory at a time — no second copy of a 213 MB file)
// and written to the part store under the loader's own keys (`${modelId}:${sha256}:part-<n>`, n = 4 MiB segment index), so
// the next load assembles it without any network request. Runtime-agnostic: files are { name, size, slice(start, end) →
// Promise<Uint8Array> }; store / subtle injected.
import { planSegments } from './model-loader.mjs';
import { partKey } from './part-store.mjs';

function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// every manifest file / chunk whose byte count equals `size`
export function candidatesForSize(manifest, size) {
  const out = [];
  for (const [modelId, model] of Object.entries(manifest.models)) {
    for (const fileKey of ['model', 'externalData']) {
      const file = model.files[fileKey];
      if (!file) continue;
      if (file.bytes === size) out.push({ kind: 'whole', modelId, fileKey, file });
      file.chunks.forEach((chunk, chunkIndex) => { if (chunk.bytes === size) out.push({ kind: 'chunk', modelId, fileKey, file, chunkIndex, chunk }); });
    }
  }
  return out;
}

// → { imported: [{ modelId, displayName, bytes, files: [{ name, matched, chunks }] }], mismatched: [names], totalBytes }
export async function importModelFiles(manifest, files, { store, subtle, onProgress } = {}) {
  if (!store) throw new Error('importModelFiles: store missing');
  const totalBytes = files.reduce((a, f) => a + (Number(f.size) || 0), 0);
  let doneBytes = 0;
  const progress = () => { if (onProgress) onProgress({ doneBytes, totalBytes }); };
  const imported = new Map();                 // modelId → { modelId, displayName, bytes, files: [] }
  const mismatched = [];
  const sha256 = async (bytes) => hexOf(await subtle.digest('SHA-256', bytes));

  // writes the bytes of chunk `chunkIndex` (already verified) as the loader's segments
  const storeChunk = async (c, bytes) => {
    const segs = planSegments(c.file).filter((s) => s.chunkIndex === c.chunkIndex);
    for (const s of segs) await store.put(partKey(c.modelId, c.file.sha256, s.n), bytes.subarray(s.chunkOffset, s.chunkOffset + s.length));
    return segs.length;
  };
  const record = (c, name, chunks, bytes) => {
    const m = imported.get(c.modelId) ?? { modelId: c.modelId, displayName: manifest.models[c.modelId].displayName, bytes: 0, files: [] };
    m.bytes += bytes;
    m.files.push({ name, matched: c.file.name + (c.kind === 'chunk' ? ` chunk ${c.chunkIndex + 1}/${c.file.chunks.length}` : ''), chunks });
    imported.set(c.modelId, m);
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
        record(c, f.name, n, size);
        matched = true;
      }
    }
    for (const c of candidates) {
      if (matched) break;
      if (c.kind !== 'whole') continue;
      // whole file: verify + store chunk by chunk; a mismatch on any chunk rejects this candidate (its stored parts are dropped)
      let off = 0, ok = true, written = 0;
      const doneBefore = doneBytes;
      const writtenKeys = [];
      for (let ci = 0; ci < c.file.chunks.length && ok; ci++) {
        const chunk = c.file.chunks[ci];
        const bytes = await f.slice(off, off + chunk.bytes);
        if (bytes.length !== chunk.bytes || await sha256(bytes) !== chunk.sha256) { ok = false; break; }
        const segs = planSegments(c.file).filter((s) => s.chunkIndex === ci);
        for (const s of segs) { const k = partKey(c.modelId, c.file.sha256, s.n); await store.put(k, bytes.subarray(s.chunkOffset, s.chunkOffset + s.length)); writtenKeys.push(k); }
        written += segs.length;
        off += chunk.bytes;
        doneBytes = Math.min(totalBytes, doneBytes + chunk.bytes); progress();
      }
      if (!ok) { for (const k of writtenKeys) { try { await store.delete(k); } catch { /* ignore */ } } doneBytes = doneBefore; continue; }
      record(c, f.name, written, size);
      matched = true;
      break;
    }
    if (!matched) { mismatched.push(f.name); doneBytes = Math.min(totalBytes, doneBytes + size); progress(); }
  }
  return { imported: [...imported.values()], mismatched, totalBytes };
}
