// scripts/tier2_decision.mjs — design §15 / A37 decision path, applied mechanically to the evidence files:
//   evidence/parity_tier2.json      (tier2_reference.py: cpuEp; roformer_parity.test.mjs: js.gates a / bInstrumental / bVocal)
//   evidence/e2e_chrome9222_hq.json (tests/e2e/e2e.mjs --tier hq --backend webgpu: hq.gateC, hq.bVocal, hq.gpuVsCpu, ran)
//   evidence/e2e_live_chrome9222_hq.json (optional, the live run after shipping)
// Writes parity_tier2.json.decision (+ decisionReasons, gateSummary) and evidence/tier2_decision.md.
//   decision ∈ ship | ship-unmeasured-gpu | ship-gpu-only | omit
//   node scripts/tier2_decision.mjs [--evidence <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ei = argv.indexOf('--evidence');
const evidenceDir = ei >= 0 ? path.resolve(argv[ei + 1]) : path.join(repo, '..', 'evidence');
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : null);

const parityFile = path.join(evidenceDir, 'parity_tier2.json');
const parity = readJson(parityFile);
if (!parity) { console.error(`tier2_decision: ${parityFile} missing — run tier2_reference.py and roformer_parity.test.mjs first`); process.exit(2); }
const e2e = readJson(path.join(evidenceDir, 'e2e_chrome9222_hq.json'));
const live = readJson(path.join(evidenceDir, 'e2e_live_chrome9222_hq.json'));

const cpuEp = parity.cpuEp === 'available' ? 'available' : 'unavailable';
const js = parity.js ?? null;
const gA = js?.gates?.a ?? null;
const gBi = js?.gates?.bInstrumental ?? null;
const gBv = js?.gates?.bVocal ?? null;
const aPass = cpuEp === 'available' && gA?.pass === true;
const bCpuPass = gBi?.pass === true && gBv?.pass === true;

// gate (c): the hq WebGPU run must have ended on webgpu with a hardware adapter and median window ≤ 30 s
const cExercised = !!e2e && e2e.ok === true && e2e.ran?.backend === 'webgpu' && e2e.hq?.gateC != null;
const cPass = cExercised && e2e.hq.gateC.pass === true;
const cNotExercisedWhy = !e2e ? 'e2e_chrome9222_hq.json missing' : e2e.webgpu ? String(e2e.webgpu) : e2e.ok !== true ? `run failed: ${e2e.failure?.code ?? 'unknown'} ${e2e.failure?.message ?? ''}` : e2e.ran?.backend !== 'webgpu' ? `ran on ${e2e.ran?.backend}` : null;
// (b) from the GPU stems (A37 path): only (b-vocal) is computable from a clip25 run
const bGpuVocalPass = e2e?.hq?.bVocal?.pass === true;

const reasons = [];
let decision;
if (cpuEp === 'available') {
  if (!aPass) { decision = 'omit'; reasons.push(`gate (a) failed: vocals ${gA?.snrVocalsDb} dB, instrumental ${gA?.snrInstDb} dB (bar ${gA?.bar ?? 25})`); }
  if (!bCpuPass) {
    decision = 'omit';
    if (gBi?.pass !== true) reasons.push(`gate (b-instrumental) failed: ${gBi?.db} dB (bar ${gBi?.bar ?? 20})`);
    if (gBv?.pass !== true) reasons.push(`gate (b-vocal) failed: ${gBv?.db} dB (bar ${gBv?.bar ?? 10})`);
  }
  if (!decision) {
    if (cPass) { decision = 'ship'; reasons.push(`(a) ${gA.snrVocalsDb} / ${gA.snrInstDb} dB, (b-instrumental) ${gBi.db} dB, (b-vocal) ${gBv.db} dB on the CPU EP; (c) median window ${e2e.hq.gateC.medianWindowMs} ms ≤ 30000 ms on WebGPU (${e2e.adapterInfo?.vendor} ${e2e.adapterInfo?.architecture}), ran.backend webgpu`); }
    else if (cExercised) { decision = 'omit'; reasons.push(`gate (c) failed: median window ${e2e.hq.gateC.medianWindowMs} ms > 30000 ms (backend ${e2e.ran.backend})`); }
    else { decision = 'ship-unmeasured-gpu'; reasons.push(`(a)+(b) pass on the CPU EP; (c) not exercised: ${cNotExercisedWhy} — flag 未在 GPU 上实测`); }
  }
} else {
  if (cPass && bGpuVocalPass) { decision = 'ship-gpu-only'; reasons.push(`CPU EP unavailable (${parity.error}); (b-vocal) ${e2e.hq.bVocal.db} dB from the WebGPU stems and (c) median ${e2e.hq.gateC.medianWindowMs} ms pass — flag 仅在 GPU 上验证`); }
  else { decision = 'omit'; reasons.push(`CPU EP unavailable (${parity.error}) and the WebGPU gates did not pass: (c) ${cExercised ? (cPass ? 'pass' : 'fail') : 'not exercised: ' + cNotExercisedWhy}, (b-vocal GPU) ${e2e?.hq?.bVocal?.db ?? 'n/a'}`); }
}

const r2 = (v) => (typeof v === 'number' ? +v.toFixed(2) : v);
const gateSummary = {
  cpuEp, A37: cpuEp === 'available' ? 'the ORT CPU EP created the fp16 / opset-23 session and ran the graph (Python onnxruntime and onnxruntime-node 1.31.1)' : `CPU EP unavailable: ${parity.error}`,
  a: gA ? { snrVocalsDb: gA.snrVocalsDb, snrInstDb: gA.snrInstDb, bar: gA.bar, pass: gA.pass, formula: js.formulas?.a } : { skipped: 'CPU_EP_UNAVAILABLE' },
  bInstrumental: gBi ? { db: gBi.db, bar: gBi.bar, pass: gBi.pass, pythonHostDb: gBi.pythonHostDb, jsVsPythonVocalsSnrDb: gBi.jsVsPythonVocalsSnrDb, formula: js.formulas?.bInstrumental, instrumentalSource: js.instrumentalSource } : null,
  bVocal: gBv ? { db: gBv.db, bar: gBv.bar, pass: gBv.pass, reference: gBv.reference, formula: js.formulas?.bVocal } : null,
  bVocalGpu: e2e?.hq?.bVocal ?? null,
  c: e2e ? { exercised: cExercised, pass: cPass, medianWindowMs: e2e.hq?.gateC?.medianWindowMs ?? null, windowMs: e2e.hq?.gateC?.windowMs ?? null, budgetMs: 30000, ran: e2e.ran ?? null, adapterInfo: e2e.adapterInfo ?? null, browser: e2e.browserBuild ?? null, cdpUp: e2e.cdpInfo?.up ?? null, notExercisedWhy: cNotExercisedWhy, sessionMs: r2(e2e.timings?.sessionMs), totalMs: r2(e2e.timings?.totalMs) } : { exercised: false, notExercisedWhy: cNotExercisedWhy },
  gpuVsCpu: e2e?.hq?.gpuVsCpu ?? null,
  windowStart: js?.windowStart ?? parity.reference?.windowStart ?? null,
  inputScale: js?.inputScale ?? parity.reference?.inputScale ?? null,
  instrumentalSource: js?.instrumentalSource ?? parity.reference?.instrumentalSource ?? null,
  live: live ? { ok: live.ok, ran: live.ran, medianWindowMs: live.hq?.gateC?.medianWindowMs ?? null, windowMs: live.hq?.gateC?.windowMs ?? null, bVocal: live.hq?.bVocal ?? null, gpuVsCpu: live.hq?.gpuVsCpu ?? null, adapterInfo: live.adapterInfo ?? null, base: live.base, downloadMs: r2(live.timings?.downloadMs), failure: live.failure ?? null } : null,
};
parity.decision = decision;
parity.decisionReasons = reasons;
parity.gateSummary = gateSummary;
parity.decisionDate = new Date().toISOString();
fs.writeFileSync(parityFile, JSON.stringify(parity, null, 2) + '\n', 'utf8');

const flag = decision === 'ship-unmeasured-gpu' ? '未在 GPU 上实测' : decision === 'ship-gpu-only' ? '仅在 GPU 上验证' : null;
const fmt = (v) => (v === null || v === undefined ? 'n/a' : String(v));
const md = [];
md.push('# Tier 2（高质量，Mel-Band RoFormer duality student）门禁结论');
md.push('');
md.push(`- 结论：**${decision}**${flag ? `（${flag}）` : ''}`);
for (const r of reasons) md.push(`- 依据：${r}`);
md.push(`- 日期：${parity.decisionDate}`);
md.push(`- CPU EP（A37）：${gateSummary.A37}`);
md.push(`- 窗口：windowStart = ${fmt(gateSummary.windowStart)}（484,659 样本），inputScale = ${fmt(gateSummary.inputScale)}，纯伴奏素材来源 instrumentalSource = ${fmt(gateSummary.instrumentalSource)}`);
md.push('');
md.push('| 门禁 | 公式 | 数值 | 门限 | 结果 |');
md.push('| --- | --- | --- | --- | --- |');
if (gA && !gA.skipped) md.push(`| (a) 人声 | ${js.formulas?.a} | ${gA.snrVocalsDb} dB | ≥ ${gA.bar} dB | ${gA.pass ? 'pass' : 'FAIL'} |`);
if (gA && !gA.skipped) md.push(`| (a) 伴奏 | 同上 | ${gA.snrInstDb} dB | ≥ ${gA.bar} dB | ${gA.pass ? 'pass' : 'FAIL'} |`);
if (gA?.skipped) md.push(`| (a) | — | 跳过（CPU_EP_UNAVAILABLE） | ≥ 25 dB | skipped |`);
if (gBi) md.push(`| (b-instrumental) | ${js.formulas?.bInstrumental} | ${gBi.db} dB（Python host ${fmt(gBi.pythonHostDb)} dB） | ≥ ${gBi.bar} dB | ${gBi.pass ? 'pass' : 'FAIL'} |`);
if (gBv) md.push(`| (b-vocal，无 NoVox） | ${js.formulas?.bVocal} | ${gBv.db} dB（CPU EP）${e2e?.hq?.bVocal?.db !== undefined ? `；${r2(e2e.hq.bVocal.db)} dB（WebGPU 音轨）` : ''} | ≥ ${gBv.bar} dB | ${gBv.pass ? 'pass' : 'FAIL'} |`);
if (e2e?.hq?.gateC) md.push(`| (c) | ${e2e.hq.gateC.formula} | 中位数 ${e2e.hq.gateC.medianWindowMs} ms，各窗口 ${JSON.stringify(e2e.hq.gateC.windowMs)} ms，ran.backend = ${e2e.ran?.backend}，适配器 ${e2e.adapterInfo?.vendor} ${e2e.adapterInfo?.architecture} | ≤ 30000 ms 且 webgpu | ${cPass ? 'pass' : 'FAIL'} |`);
else md.push(`| (c) | — | 未执行：${fmt(cNotExercisedWhy)} | ≤ 30000 ms 且 webgpu | not exercised |`);
md.push('');
if (e2e) {
  md.push('## WebGPU 运行（本地，evidence/e2e_chrome9222_hq.json）');
  md.push(`- 浏览器：${e2e.browserBuild?.channel} ${e2e.browserBuild?.version}；9222 Chrome 可用：${e2e.cdpInfo?.up}${e2e.cdpInfo?.up === false ? '（未应答，按 §16.C 规则改用 Playwright 无头 Chromium + 硬件适配器）' : ''}`);
  md.push(`- 实际运行：backend ${e2e.ran?.backend}，modelId ${e2e.ran?.modelId}，tier ${e2e.ran?.tier}，fellBack ${e2e.ran?.fellBack}；caps.f16 ${e2e.caps?.f16}，maxStorageBuffersPerShaderStage ${e2e.caps?.sbs}`);
  md.push(`- 用时：模型下载 ${r2(e2e.timings?.downloadMs)} ms（本地），校验 ${r2(e2e.timings?.verifyMs)} ms，会话创建 ${r2(e2e.timings?.sessionMs)} ms，分离总计 ${r2(e2e.timings?.totalMs)} ms（4 个窗口，首个含着色器编译）`);
  if (e2e.hq?.gpuVsCpu && !e2e.hq.gpuVsCpu.skipped) md.push(`- WebGPU 与 CPU EP 音轨一致性（${e2e.hq.gpuVsCpu.formula}）：人声 ${r2(e2e.hq.gpuVsCpu.vocalsDb)} dB，伴奏 ${r2(e2e.hq.gpuVsCpu.instDb)} dB`);
  if (e2e.hq?.vsVocFt && !e2e.hq.vsVocFt.skipped) md.push(`- 与 Voc_FT 整段音轨对比（仅供参考，双方峰值归一到 0.9）：人声 ${r2(e2e.hq.vsVocFt.vocalsDb)} dB，伴奏 ${r2(e2e.hq.vsVocFt.instDb)} dB`);
  md.push(`- MP3：${e2e.mp3 ? `${e2e.mp3.vocals.frames} 帧，Δ ${e2e.mp3.vocals.deltaSamples} 样本，下载事件 ${e2e.mp3.downloadEventOk}` : 'n/a'}`);
  md.push('');
}
if (live) {
  md.push('## WebGPU 运行（线上，evidence/e2e_live_chrome9222_hq.json）');
  md.push(`- base ${live.base}；ok ${live.ok}；ran ${JSON.stringify(live.ran)}；适配器 ${live.adapterInfo?.vendor} ${live.adapterInfo?.architecture}`);
  md.push(`- 模型下载 ${r2(live.timings?.downloadMs)} ms（${live.hq?.stems?.samples ?? ''}）；窗口中位数 ${live.hq?.gateC?.medianWindowMs} ms，各窗口 ${JSON.stringify(live.hq?.gateC?.windowMs)} ms`);
  if (live.hq?.bVocal) md.push(`- (b-vocal) 线上音轨：${r2(live.hq.bVocal.db)} dB`);
  if (live.hq?.gpuVsCpu && !live.hq.gpuVsCpu.skipped) md.push(`- 与 CPU EP 一致性：人声 ${r2(live.hq.gpuVsCpu.vocalsDb)} dB，伴奏 ${r2(live.hq.gpuVsCpu.instDb)} dB`);
  if (live.failure) md.push(`- 失败：${live.failure.code} ${live.failure.message}`);
  md.push('');
}
md.push('## 备注');
md.push('- A15：模型卡未给出 Intel iGPU 的窗口用时；本机 gen-12lp 上实测见上表。');
md.push('- A16：musetric 已改用更新的 duality-kara2-student 导出；本项目按简报锁定 duality student，不重新评估。');
md.push('- DA-7：lowMemory（iOS / iPadOS）设备不提供「高质量」，由 caps.mjs 的 hq 门控保证（tests/unit/caps.test.mjs）。');
md.push('- 文件：evidence/parity_tier2.json（全部数值）、evidence/ref_tier2/（window.json、Python 参考音轨、CPU EP 整段音轨）、evidence/e2e_chrome9222_hq*.json/.wav。');
fs.writeFileSync(path.join(evidenceDir, 'tier2_decision.md'), md.join('\n') + '\n', 'utf8');
console.log(`tier2_decision: ${decision}${flag ? ` (${flag})` : ''}`);
for (const r of reasons) console.log(`  - ${r}`);
console.log(`wrote ${parityFile} (.decision) and ${path.join(evidenceDir, 'tier2_decision.md')}`);
