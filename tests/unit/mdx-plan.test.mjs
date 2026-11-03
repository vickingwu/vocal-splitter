// tests/unit/mdx-plan.test.mjs — design §16.A row `mdx-plan.test.mjs`.
// PRIMARY oracle: an integer re-implementation of mdx_separator.py demix() lines 342–348 written here (the pattern of
// .agents/review_probe/plan_check.mjs). The hard-coded triples are sanity values asserted against the oracle, not the planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMdx, numpyHanning } from '../../site/src/engine/mdx.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'site', 'models', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const PARAMS = {
  voc_ft: manifest.models.uvr_mdx_voc_ft.params,
  m9482: manifest.models.uvr_mdxnet_9482.params,
};

// ---- the oracle: lines 228–237 (settings) and 342–348 (plan) in integers ----
function oracle(n, p) {
  const trim = Math.floor(p.nFft / 2);
  const chunk = p.hop * (p.segmentSize - 1);
  const gen = chunk - 2 * trim;
  const pad = gen + trim - (n % gen);
  const M = trim + n + pad;
  const step = Math.trunc((1 - p.overlap) * chunk);
  const chunks = [];
  for (let i = 0; i < M; i += step) {
    const start = i, end = Math.min(i + chunk, M);
    chunks.push({ start, end, len: end - start, skippable: start >= trim + n });
  }
  const planned = Math.ceil(M / step);
  const nonSkipped = chunks.filter((c) => c.start < trim + n).length;
  return { trim, chunk, gen, pad, M, step, chunks, planned, nonSkipped };
}

function assertPlanEqualsOracle(n, p, label) {
  const o = oracle(n, p);
  const plan = planMdx(n, p);
  assert.equal(plan.trim, o.trim, `${label}: trim`);
  assert.equal(plan.gen, o.gen, `${label}: gen`);
  assert.equal(plan.pad, o.pad, `${label}: pad`);
  assert.equal(plan.mixtureLen, o.M, `${label}: mixtureLen`);
  assert.equal(plan.step, o.step, `${label}: step`);
  assert.equal(plan.chunkSize, o.chunk, `${label}: chunkSize`);
  assert.equal(plan.chunks.length, o.planned, `${label}: planned chunk count`);
  assert.deepEqual(plan.chunks, o.chunks, `${label}: chunk list`);
  assert.equal(plan.chunks.filter((c) => !c.skippable).length, o.nonSkipped, `${label}: non-skipped`);
  for (const c of plan.chunks) assert.equal(c.skippable, c.start >= o.trim + n, `${label}: skippable ⇔ start >= trim + n`);
  return { o, plan };
}

// Identity-model fold: tar = part (zero-padded chunk), Float32 accumulators, shared divider as in §3.3.
// Reconstructs [trim, trim+n) of the mixture; also proves divider > 0 on every retained sample.
function identityFold(n, p, seed) {
  const { o, plan } = assertPlanEqualsOracle(n, p, `fold n=${n}`);
  const { trim, mixtureLen, chunkSize } = plan;
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand();
  const result = new Float32Array(mixtureLen);
  const divider = new Float32Array(mixtureLen);
  const part = new Float32Array(chunkSize);
  const windows = new Map();
  for (const c of plan.chunks) {
    if (c.skippable) continue;
    part.fill(0);
    const from = Math.max(c.start, trim), to = Math.min(c.end, trim + n);
    if (to > from) part.set(x.subarray(from - trim, to - trim), from - c.start);
    let w = windows.get(c.len);
    if (!w) { w = numpyHanning(c.len); windows.set(c.len, w); }
    for (let k = 0; k < c.len; k++) {
      result[c.start + k] += Math.fround(part[k] * w[k]);
      divider[c.start + k] += w[k];
    }
  }
  let maxErr = 0, zeroDiv = 0;
  for (let j = 0; j < n; j++) {
    const d = divider[trim + j];
    if (!(d > 0)) { zeroDiv++; continue; }
    const err = Math.abs(result[trim + j] / d - x[j]);
    if (err > maxErr) maxErr = err;
  }
  return { maxErr, zeroDiv, windows: [...windows.keys()], o };
}

const NAMED = [1, 1000, 253439, 253440, 253441, 1102500, 1323000, 1600000, 10584000, 39690000];

test('np.hanning table matches numpy\'s expression incl. len 1 → [1.0] and symmetric endpoints 0', () => {
  assert.deepEqual(Array.from(numpyHanning(1)), [1]);
  const w = numpyHanning(5);
  assert.ok(Math.abs(w[0]) < 1e-15 && Math.abs(w[4]) < 1e-15);
  assert.ok(Math.abs(w[2] - 1) < 1e-15);
  assert.ok(Math.abs(w[1] - 0.5) < 1e-15 && Math.abs(w[3] - 0.5) < 1e-15);
  const big = numpyHanning(261120);
  assert.equal(big.length, 261120);
  assert.ok(Math.abs(big[130560 - 1] - big[130560]) < 1e-9);  // symmetric around the centre
  for (let k = 0; k < 2000; k++) assert.ok(Math.abs(big[k] - big[261119 - k]) < 1e-12);
});

test('sanity triples (planned/non-skipped) hold for the ORACLE itself (Voc_FT geometry)', () => {
  const triples = [[1102500, 7, 6], [1323000, 8, 7], [1600000, 10, 9], [10584000, 55, 55], [39690000, 204, 203]];
  for (const [n, planned, nonSkipped] of triples) {
    const o = oracle(n, PARAMS.voc_ft);
    assert.equal(o.planned, planned, `oracle planned for n=${n}`);
    assert.equal(o.nonSkipped, nonSkipped, `oracle non-skipped for n=${n}`);
  }
  const o15 = oracle(39690000, PARAMS.voc_ft);
  assert.equal(o15.chunks[203].start, 39755520);
  assert.ok(o15.chunks[203].start >= o15.trim + 39690000);
  assert.equal(o15.M, 39797760);
  const o16 = oracle(1600000, PARAMS.voc_ft);
  assert.deepEqual(o16.chunks.slice(-2).map((c) => [c.start, c.len, c.skippable]), [[1566720, 215040, false], [1762560, 19200, true]]);
  const o25 = oracle(1102500, PARAMS.voc_ft);
  assert.equal(o25.M, 1274880);
  assert.deepEqual(o25.chunks.slice(-2).map((c) => [c.start, c.len, c.skippable]), [[979200, 261120, false], [1175040, 99840, true]]);
});

for (const [label, p] of Object.entries(PARAMS)) {
  test(`planner equals the oracle for the named set (${label})`, () => {
    for (const n of NAMED) assertPlanEqualsOracle(n, p, `${label} n=${n}`);
  });

  test(`planner equals the oracle for n = k·gen + δ, k = 0..17, δ ∈ {−1, 0, 1} (${label})`, () => {
    const gen = oracle(1, p).gen;
    let count = 0;
    for (let k = 0; k <= 17; k++) for (const d of [-1, 0, 1]) {
      const n = k * gen + d;
      if (n < 1) continue;
      assertPlanEqualsOracle(n, p, `${label} sweep n=${n}`);
      count++;
    }
    assert.ok(count >= 52);
  });

  test(`planner equals the oracle for 200 seeded random n in [1, 18·gen] (${label})`, () => {
    const gen = oracle(1, p).gen;
    let s = 0xC0FFEE;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * (18 * gen));
      try { assertPlanEqualsOracle(n, p, `${label} random n=${n}`); } catch (e) { e.message += ` (seed 0xC0FFEE, i=${i}, n=${n})`; throw e; }
    }
  });
}

test('identity fold reconstructs [trim, trim+n) within 1e-6 with divider > 0 on every retained sample (Voc_FT)', () => {
  for (const n of [1, 1000, 253439, 253440, 253441, 1102500, 1323000, 1600000]) {
    const r = identityFold(n, PARAMS.voc_ft, 42 + n);
    assert.equal(r.zeroDiv, 0, `n=${n}: divider is 0 on ${r.zeroDiv} retained samples`);
    assert.ok(r.maxErr < 1e-6, `n=${n}: max|recon − x| = ${r.maxErr}`);
  }
  const r16 = identityFold(1600000, PARAMS.voc_ft, 7);
  assert.deepEqual(r16.windows, [261120, 215040]);   // two distinct lengths among non-skipped chunks (19,200 is skipped)
});

test('identity fold over the sweep n = k·gen + δ (Voc_FT) and the 9482 geometry', () => {
  const gen = oracle(1, PARAMS.voc_ft).gen;
  for (let k = 0; k <= 17; k++) for (const d of [-1, 0, 1]) {
    const n = k * gen + d;
    if (n < 1) continue;
    const r = identityFold(n, PARAMS.voc_ft, n);
    assert.equal(r.zeroDiv, 0, `n=${n} zero divider`);
    assert.ok(r.maxErr < 1e-6, `n=${n} recon err ${r.maxErr}`);
  }
  for (const n of [1, 1000, 1102500, 1600000]) {
    const r = identityFold(n, PARAMS.m9482, n);
    assert.equal(r.zeroDiv, 0);
    assert.ok(r.maxErr < 1e-6);
  }
});

test('long inputs: 4 min and 15 min plans equal the oracle (O(M) divider check)', () => {
  for (const n of [10584000, 39690000]) {
    const { o, plan } = assertPlanEqualsOracle(n, PARAMS.voc_ft, `long n=${n}`);
    const divider = new Float32Array(plan.mixtureLen);
    const windows = new Map();
    for (const c of plan.chunks) {
      if (c.skippable) continue;
      let w = windows.get(c.len); if (!w) { w = numpyHanning(c.len); windows.set(c.len, w); }
      for (let k = 0; k < c.len; k++) divider[c.start + k] += w[k];
    }
    let zero = 0;
    for (let j = o.trim; j < o.trim + n; j++) if (!(divider[j] > 0)) zero++;
    assert.equal(zero, 0, `n=${n}: ${zero} retained samples with divider 0`);
  }
});

test('9482 geometry derives from params (A2: nFft 6144, dimT 256 → chunk 261,120, gen 254,976, step 195,840)', () => {
  const o = oracle(1102500, PARAMS.m9482);
  assert.equal(o.trim, 3072);
  assert.equal(o.chunk, 261120);
  assert.equal(o.gen, 254976);
  assert.equal(o.step, 195840);
  const plan = planMdx(1102500, PARAMS.m9482);
  assert.equal(plan.chunks.length, o.planned);
  assert.equal(plan.chunks.filter((c) => !c.skippable).length, o.nonSkipped);
  // 6-minute iOS case of §3.6
  const o6 = oracle(15876000, PARAMS.m9482);
  assert.equal(o6.M, 16069632);
  assert.equal(o6.planned, 83);
  assert.equal(o6.nonSkipped, 82);
});
