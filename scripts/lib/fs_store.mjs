// scripts/lib/fs_store.mjs — the part-store contract ({ name, get, put, delete, keys }, site/src/engine/part-store.mjs) over
// a directory: one file per key, file name = encodeURIComponent(key) (keys carry ':'). Used by scripts/cli_separate.mjs so
// the model loader persists segments while downloading and finds the assembled model on the next run (the directory is
// what the GitHub Actions job caches between runs). Writes are atomic (temp file + rename).
import fs from 'node:fs';
import path from 'node:path';

export function createFsStore(dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const fileOf = (key) => path.join(root, encodeURIComponent(String(key)));
  return {
    name: 'fs',
    dir: root,
    async get(key) {
      try { return new Uint8Array(await fs.promises.readFile(fileOf(key))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async put(key, bytes) {
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const file = fileOf(key);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, file);
      return true;
    },
    async delete(key) {
      try { await fs.promises.unlink(fileOf(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    async keys(prefix = '') {
      const names = await fs.promises.readdir(root);
      const out = [];
      for (const n of names) {
        if (n.endsWith('.tmp')) continue;
        let k;
        try { k = decodeURIComponent(n); } catch { continue; }
        if (k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
  };
}
