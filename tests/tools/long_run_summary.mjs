// tests/tools/long_run_summary.mjs — aggregates evidence/long/long_run_*.json (tests/e2e/long_run.mjs outputs) into
// evidence/long_run_5min.json and prints the Markdown table for evidence/long_run_5min.md.
//   node tests/tools/long_run_summary.mjs [--dir ../evidence/long] [--out ../evidence/long_run_5min.json] [--labels a,b,...]
import fs from 'node:fs';
import path from 'node:path';
import { evidenceDir } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const dir = path.resolve(arg('--dir', path.join(evidenceDir, 'long')));
const outFile = path.resolve(arg('--out', path.join(evidenceDir, 'long_run_5min.json')));
const order = arg('--labels', 'a_wasm8_clip300,c_webgpu_clip300,d_hq_webgpu_clip300,e_iphone14_wasm_clip300,b_wasm1_nosw_clip300_10chunks,mp3_wasm8_clip300_10chunks').split(',');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const mmss = (ms) => { if (ms === null || ms === undefined) return '—'; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sec = (ms, d = 1) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(d));

const runs = [];
for (const label of order) {
  const f = path.join(dir, `long_run_${label}.json`);
  if (!fs.existsSync(f)) { runs.push({ label, missing: true }); continue; }
  const j = readJson(f);
  const t = j.timings ?? {};
  const trend = j.chunkTrend ?? {};
  const capped = j.requested?.maxChunksHook !== null && j.requested?.maxChunksHook !== undefined;
  const expected = j.expectedChunks?.nonSkipped ?? j.expectedChunks?.estimate ?? null;
  const encode = t.encodeMs ? Math.max(...Object.values(t.encodeMs)) : null;
  const separateMs = t.totalMs ?? null;
  const row = {
    label, file: path.basename(f), ok: j.ok === true, finished: j.finished === true, state: j.state, failure: j.failure ?? null,
    path: { backend: j.ran?.backend ?? null, modelId: j.ran?.modelId ?? null, tier: j.ran?.tier ?? null, threads: j.ran?.threads ?? null, fellBack: j.ran?.fellBack ?? null, denoise: j.ran?.denoise ?? null, device: j.requested?.device ?? null, noSw: j.requested?.noSw ?? false, isolated: j.isolatedAtCaps, adapter: j.adapterInfo ?? null, browser: j.browserBuild ?? null },
    input: j.input ? { file: j.input.file, bytes: j.requested?.inputBytes ?? null, probeKind: j.input.probeKind, probeMs: j.input.probeMs, decodeMs: j.input.decodeMs, length: j.input.length, duration: j.input.duration } : null,
    chunks: { ran: Array.isArray(t.chunkMs) ? t.chunkMs.length : null, expected, capped, maxChunksHook: j.requested?.maxChunksHook ?? null, progressCount: j.progressChunkCount ?? null },
    chunkMs: { median: trend.medianMs ?? null, mean: trend.meanMs ?? null, min: trend.minMs ?? null, max: trend.maxMs ?? null, p90: trend.p90Ms ?? null, first: trend.firstMs ?? null, last: trend.lastMs ?? null, first10Median: trend.first10MedianMs ?? null, last10Median: trend.last10MedianMs ?? null, lastOverFirst: trend.lastOverFirstRatio ?? null, slopeMsPerChunk: trend.slopeMsPerChunk ?? null, classification: trend.classification ?? null },
    memory: j.memory ? { peakPrivateGB: j.memory.peakPrivateGB, samples: j.memory.samples, firstQuarterMedianMB: j.memory.firstQuarterMedianMB, lastQuarterMedianMB: j.memory.lastQuarterMedianMB } : null,
    timings: { downloadMs: t.downloadMs ?? null, verifyMs: t.verifyMs ?? null, sessionMs: t.sessionMs ?? null, separateMs, stftMs: t.stftMs ?? null, istftMs: t.istftMs ?? null, encodeMs: t.encodeMs ?? null, encodeMaxMs: encode, wallTotalMs: j.wall?.totalMs ?? null, wallEncodingMs: j.wall?.encodingMs ?? null },
    mp3: j.mp3 ? { ok: j.mp3.ok, vocals: j.mp3.vocals, instrumental: j.mp3.instrumental } : null,
    download: j.download ? { eventOk: j.download.eventOk, size: j.download.size, suggestedFilename: j.download.suggestedFilename, error: j.download.error } : null,
    stalls: j.stalls ?? [], consoleErrors: j.consoleErrors ?? [], firstPeriodSnr: j.firstPeriodSnr ?? null, denoiseCheckbox: j.denoiseCheckbox ?? null, stemStats: j.stemStats ?? null,
    progressLineSample: (j.chunkEvents ?? []).slice(-1).map((e) => e.text)[0] ?? null, backendLine: j.backendLine ?? null,
  };
  if (capped && expected && trend.medianMs) row.extrapolated = { fullChunks: expected, separateMs: Math.round(trend.medianMs * expected), formula: 'median chunk ms × non-skipped chunks (encode/decode not included)' };
  runs.push(row);
}

const fixture = fs.existsSync(path.join(dir, 'clip300.json')) ? readJson(path.join(dir, 'clip300.json')) : null;
const probeFile = path.join(dir, 'hq_download_probe.jsonl');
const probe = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];
const summary = { date: new Date().toISOString(), hardware: runs.find((r) => !r.missing)?.hardware ?? null, fixture, hqDownloadProbe: probe, runs };
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('wrote', outFile);

// ---- Markdown table
const lines = [];
lines.push('| 路径 | 完成 | 段数 | 段中位 s | 首/末 10 段中位 s | 趋势 | 峰值 GB | 总用时 mm:ss | MP3 | 下载事件 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of runs) {
  if (r.missing) { lines.push(`| ${r.label} | 未运行 | | | | | | | | |`); continue; }
  const p = r.path;
  const name = `${r.label} — ${p.backend ?? '?'} / ${p.modelId ?? '?'}${p.threads ? ` / ${p.threads} 线程` : ''}${p.device ? ` / ${p.device}` : ''}`;
  const chunks = r.chunks.capped ? `${r.chunks.ran} / ${r.chunks.expected}（maxChunks=${r.chunks.maxChunksHook}）` : `${r.chunks.ran}${r.chunks.expected ? ` / ${r.chunks.expected}` : ''}`;
  const fin = r.finished ? (r.ok ? '是' : `是（${r.failure?.code}）`) : `否（${r.state}${r.failure ? ' ' + r.failure.code : ''}）`;
  const mp3 = r.mp3 ? (r.mp3.ok ? `有效（${(r.mp3.vocals.bytes / 1e6).toFixed(1)} MB，${r.mp3.vocals.durationS}s，编码 ${sec(r.timings.encodeMaxMs, 0)}s）` : '无效') : '—';
  const dl = r.download ? (r.download.eventOk ? `触发（${r.download.size} B）` : `未触发${r.download.error ? '：' + r.download.error.slice(0, 40) : ''}`) : '—';
  const total = r.chunks.capped && r.extrapolated ? `${mmss(r.timings.wallTotalMs)}（推算整首分离 ${mmss(r.extrapolated.separateMs)}）` : mmss(r.timings.wallTotalMs);
  lines.push(`| ${name} | ${fin} | ${chunks} | ${sec(r.chunkMs.median)} | ${sec(r.chunkMs.first10Median)} / ${sec(r.chunkMs.last10Median)}（×${r.chunkMs.lastOverFirst ?? '—'}） | ${r.chunkMs.classification ?? '—'} | ${r.memory ? r.memory.peakPrivateGB.toFixed(2) : '—'} | ${total} | ${mp3} | ${dl} |`);
}
console.log(lines.join('\n'));
