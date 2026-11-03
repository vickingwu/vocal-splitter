// scripts/run_parity.mjs — `npm run test:parity`: runs tests/parity/mdx_parity.test.mjs once per Tier 1 model id
// (VS_MODEL_ID = uvr_mdx_voc_ft, then uvr_mdxnet_9482) and tests/parity/roformer_parity.test.mjs once (Tier 2 gate, §15;
// skips loudly without the Tier 2 bytes), each in its own `node --test` process; exits non-zero if any fails.
//   node scripts/run_parity.mjs [--models id1,id2] [--skip-tier2]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const mIdx = argv.indexOf('--models');
const models = (mIdx >= 0 ? argv[mIdx + 1] : 'uvr_mdx_voc_ft,uvr_mdxnet_9482').split(',').map((s) => s.trim()).filter(Boolean);
const skipTier2 = argv.includes('--skip-tier2');

let failed = false;
for (const id of models) {
  console.log(`\n=== parity: ${id} ===`);
  const r = spawnSync(process.execPath, ['--test', 'tests/parity/mdx_parity.test.mjs'], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, VS_MODEL_ID: id }, shell: false,
  });
  if (r.status !== 0) { failed = true; console.error(`parity FAILED for ${id} (exit ${r.status})`); }
}
if (!skipTier2) {
  console.log('\n=== parity: melroformer_duality_student (Tier 2 gate) ===');
  const r = spawnSync(process.execPath, ['--test', 'tests/parity/roformer_parity.test.mjs'], { cwd: repo, stdio: 'inherit', env: process.env, shell: false });
  if (r.status !== 0) { failed = true; console.error(`Tier 2 parity FAILED (exit ${r.status})`); }
}
process.exit(failed ? 1 : 0);
