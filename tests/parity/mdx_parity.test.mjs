// tests/parity/mdx_parity.test.mjs — design §16.B: the engine vs audio-separator's reference stems for one Tier 1 model.
//   VS_MODEL_ID = uvr_mdx_voc_ft (default) | uvr_mdxnet_9482;  VS_REF_DIR overrides ../evidence/ref
// Skips loudly when the model chunks or the reference stems are absent. Pass: raw SNR >= 25 dB on BOTH stems (never lower).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readWav } from '../../site/src/engine/wav.mjs';
import { peakOf } from '../../site/src/engine/normalize.mjs';
import { validateManifest, loadModelBytes } from '../../site/src/engine/model-loader.mjs';
import { createSession } from '../../site/src/engine/session.mjs';
import { separateMdx, planMdx } from '../../site/src/engine/mdx.mjs';
import { makeNodeFetchInto } from '../../scripts/lib/fetch_into_node.mjs';
import { snrStereoDb, snrDb, fittedStereo, maxAbsErr } from '../lib/snr.mjs';
import { fixturePath, referenceStems, modelChunksPresent, readManifest, mergeEvidenceJson, repoRoot, evidenceDir } from '../lib/fixtures.mjs';

const require = createRequire(import.meta.url);
const modelId = process.env.VS_MODEL_ID || 'uvr_mdx_voc_ft';
const SNR_BAR_DB = 25;

function pythonVersions() {
  const file = path.join(evidenceDir, 'python_env.txt');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  return {
    python: pick(/^version:\s*(.+)$/m),
    audioSeparator: pick(/^audio-separator==(.+)$/m),
    onnxruntime: pick(/^onnxruntime==(.+)$/m),
    torch: pick(/^torch==(.+)$/m),
    librosa: pick(/^librosa==(.+)$/m),
    numpy: pick(/^numpy==(.+)$/m),
  };
}

test(`MDX parity vs audio-separator — ${modelId}`, { timeout: 30 * 60 * 1000 }, async (t) => {
  const manifest = validateManifest(readManifest());
  const model = manifest.models[modelId];
  assert.ok(model, `unknown model id ${modelId}`);
  if (!modelChunksPresent(manifest, modelId)) {
    t.skip(`SKIP: model chunks missing under site/models/${modelId}/ — run npm run chunk`);
    console.log(`PARITY SKIPPED: model chunks missing for ${modelId}`);
    return;
  }
  let refs;
  try { refs = referenceStems(modelId); } catch (e) {
    if (e.code === 'REF_MISSING') { t.skip(`SKIP: ${e.message} — run scripts/reference_mdx.ps1`); console.log(`PARITY SKIPPED: ${e.message}`); return; }
    throw e;
  }

  // D1 precondition: the fixture must have peak ≈ 1 so audio-separator's `* peak` is a no-op in the reference
  const fixture = readWav(new Uint8Array(fs.readFileSync(fixturePath('clip25.wav'))));
  assert.equal(fixture.sampleRate, 44100);
  const fixturePeak = peakOf(fixture.left, fixture.right);
  assert.ok(fixturePeak >= 0.999, `FIXTURE_PEAK: clip25.wav joint peak ${fixturePeak} < 0.999 (D1 precondition, design §3.4)`);
  const n = fixture.left.length;

  const refV = readWav(new Uint8Array(fs.readFileSync(refs.vocals)));
  const refI = readWav(new Uint8Array(fs.readFileSync(refs.instrumental)));
  assert.equal(refV.left.length, n, 'reference vocals length');
  assert.equal(refI.left.length, n, 'reference instrumental length');

  // model bytes through the loader + the Node adapter (also exercises the manifest/hash path)
  const t0 = Date.now();
  const loaded = await loadModelBytes(manifest, modelId, {
    fetchInto: makeNodeFetchInto(path.join(repoRoot, 'site')), cache: null, subtle: globalThis.crypto.subtle, baseUrl: 'http://localhost/',
  }, () => {});
  const loadMs = Date.now() - t0;
  assert.equal(loaded.bytes.length, model.files.model.bytes);

  const ort = require('onnxruntime-node');
  const t1 = Date.now();
  const session = await createSession(ort, { backend: 'cpu', bytes: loaded.bytes });
  const sessionMs = Date.now() - t1;
  console.log(`[parity ${modelId}] input=${session.inputNames[0]} output=${session.outputNames[0]} load=${loadMs}ms session=${sessionMs}ms`);

  const plan = planMdx(n, model.params);
  const expectedChunks = plan.chunks.filter((c) => !c.skippable).length;
  const progress = [];
  const t2 = Date.now();
  const res = await separateMdx({
    ort, session, params: model.params, left: fixture.left, right: fixture.right,
    onProgress: (e) => progress.push(e), shouldCancel: () => false,
  });
  const separateMs = Date.now() - t2;
  const chunkCount = res.timings.chunkMs.length;
  assert.equal(chunkCount, expectedChunks, 'non-skipped chunk count');
  assert.equal(progress.filter((p) => p.stage === 'separate').length, expectedChunks);
  assert.equal(progress.filter((p) => p.stage === 'finalize').length, 1);
  assert.equal(res.vocals[0].length, n); assert.equal(res.instrumental[0].length, n);
  assert.equal(res.vocals[0].byteOffset, plan.trim * 4, 'vocals are offset views (byteOffset = trim·4)');
  assert.ok(res.instrumental[0] === fixture.left && res.instrumental[1] === fixture.right, 'instrumental reuses the input buffers');

  const snrVocalsDb = snrStereoDb(refV.left, refV.right, res.vocals[0], res.vocals[1]);
  const snrInstDb = snrStereoDb(refI.left, refI.right, res.instrumental[0], res.instrumental[1]);
  const perChannel = {
    vocalsL: snrDb(refV.left, res.vocals[0]), vocalsR: snrDb(refV.right, res.vocals[1]),
    instL: snrDb(refI.left, res.instrumental[0]), instR: snrDb(refI.right, res.instrumental[1]),
  };
  const fitV = fittedStereo(refV.left, refV.right, res.vocals[0], res.vocals[1]);
  const fitI = fittedStereo(refI.left, refI.right, res.instrumental[0], res.instrumental[1]);
  const maxErr = { vocals: Math.max(maxAbsErr(refV.left, res.vocals[0]), maxAbsErr(refV.right, res.vocals[1])), instrumental: Math.max(maxAbsErr(refI.left, res.instrumental[0]), maxAbsErr(refI.right, res.instrumental[1])) };
  const peaks = { vocals: peakOf(res.vocals[0], res.vocals[1]), instrumental: peakOf(res.instrumental[0], res.instrumental[1]), refVocals: peakOf(refV.left, refV.right), refInstrumental: peakOf(refI.left, refI.right) };

  const record = {
    model: model.files.model.name, modelId, uvrHash: model.uvrHash, params: model.params,
    fixture: 'tests/fixtures/clip25.wav', fixturePeak, frames: n,
    snrVocalsDb: +snrVocalsDb.toFixed(2), snrInstDb: +snrInstDb.toFixed(2),
    perChannelDb: Object.fromEntries(Object.entries(perChannel).map(([k, v]) => [k, +v.toFixed(2)])),
    fittedGain: { vocals: +fitV.gain.toFixed(6), instrumental: +fitI.gain.toFixed(6) },
    snrFittedDb: { vocals: +fitV.snrDb.toFixed(2), instrumental: +fitI.snrDb.toFixed(2) },
    maxAbsErr: maxErr, peaks,
    chunkCount, plannedChunks: plan.chunks.length,
    timingsMs: { load: loadMs, session: sessionMs, separate: separateMs, chunkMs: res.timings.chunkMs.map((v) => Math.round(v)), stftMs: Math.round(res.timings.stftMs), istftMs: Math.round(res.timings.istftMs) },
    ioNames: { input: session.inputNames[0], output: session.outputNames[0] },
    ortNodeVersion: require('onnxruntime-node/package.json').version,
    node: process.version,
    pythonVersions: pythonVersions(),
    referenceFiles: { vocals: path.basename(refs.vocals), instrumental: path.basename(refs.instrumental) },
    snrBarDb: SNR_BAR_DB,
    pass: snrVocalsDb >= SNR_BAR_DB && snrInstDb >= SNR_BAR_DB,
    date: new Date().toISOString(),
  };
  mergeEvidenceJson('parity_mdx.json', { [modelId]: record });
  console.log(`[parity ${modelId}] vocals ${snrVocalsDb.toFixed(2)} dB, instrumental ${snrInstDb.toFixed(2)} dB; fitted gain ${fitV.gain.toFixed(5)} / ${fitI.gain.toFixed(5)} → ${fitV.snrDb.toFixed(2)} / ${fitI.snrDb.toFixed(2)} dB; chunks ${chunkCount}; separate ${separateMs} ms`);
  assert.ok(snrVocalsDb >= SNR_BAR_DB, `vocals SNR ${snrVocalsDb.toFixed(2)} dB < ${SNR_BAR_DB} dB (10–25 dB = plan/window/compensation bug — fix the engine)`);
  assert.ok(snrInstDb >= SNR_BAR_DB, `instrumental SNR ${snrInstDb.toFixed(2)} dB < ${SNR_BAR_DB} dB`);
  await session.release?.();
});
