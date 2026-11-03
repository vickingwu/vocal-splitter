// scripts/live_e2e_summary.mjs — design §16.E: copy each live E2E run's ran.backend / ran.modelId / login / layout (and the
// failure, if any) into ../evidence/live_check.json under `e2e`, so the live section of REPORT.md can only claim a backend
// that actually ran. Usage: node scripts/live_e2e_summary.mjs [--evidence <dir>]   (reads evidence/e2e_live_*.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const i = argv.indexOf('--evidence');
const evidence = i >= 0 ? path.resolve(argv[i + 1]) : (process.env.VS_EVIDENCE_DIR ? path.resolve(process.env.VS_EVIDENCE_DIR) : path.join(repo, '..', 'evidence'));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));

const liveCheck = path.join(evidence, 'live_check.json');
const doc = fs.existsSync(liveCheck) ? read(liveCheck) : {};
const runs = fs.readdirSync(evidence).filter((f) => /^e2e_live_.*\.json$/.test(f)).sort();
const e2e = {};
for (const f of runs) {
  const j = read(path.join(evidence, f));
  const tag = f.replace(/^e2e_live_/, '').replace(/\.json$/, '');
  e2e[tag] = {
    ok: j.ok ?? null,
    requested: j.requested ? { backend: j.requested.backend, browser: j.requested.browser, device: j.requested.device, expectFallback: j.requested.expectFallback ?? null, noWebgpu: j.requested.noWebgpu ?? false, cdp: j.requested.cdp ?? null } : null,
    ran: j.ran ?? null,
    notExercised: j.webgpu ?? null,
    adapterInfo: j.adapterInfo ?? null,
    cdpInfo: j.cdpInfo ?? null,
    browserBuild: j.browserBuild ?? null,
    crossOriginIsolated: j.crossOriginIsolated ?? null,
    isolatedAtCaps: j.isolatedAtCaps ?? null,
    navigations: j.navigations ?? null,
    login: j.login ?? null,
    layout: j.layout ? { ok: j.layout.ok, complete: j.layout.complete ?? null, widths: j.layout.widths, labels: j.layout.labels ?? null, violations: j.layout.violations ? j.layout.violations.length : null } : null,
    policy: j.policy ?? null,
    snr: j.snr ? { vocalsDb: j.snr.vocalsDb, instDb: j.snr.instDb, threshold: j.snr.threshold, label: j.snr.label } : null,
    mp3: j.mp3 ? { downloadEventOk: j.mp3.downloadEventOk, frames: j.mp3.vocals?.frames ?? null, durationS: j.mp3.vocals?.durationS ?? null } : null,
    fallback: j.fallback ?? null,
    timings: j.timings ? { downloadMs: j.timings.downloadMs, sessionMs: j.timings.sessionMs, chunkMs: j.timings.chunkMs, totalMs: j.timings.totalMs, threads: j.timings.threads } : null,
    webkitIssues: j.webkitIssues ?? [],
    webkitCapabilities: j.webkitCapabilities ?? null,
    failure: j.failure ?? null,
    date: j.date ?? null,
  };
}
doc.e2e = e2e;
doc.e2eSummaryDate = new Date().toISOString();
fs.writeFileSync(liveCheck, JSON.stringify(doc, null, 2) + '\n', 'utf8');
for (const [tag, r] of Object.entries(e2e)) console.log(tag, JSON.stringify({ ok: r.ok, ran: r.ran, notExercised: r.notExercised, webkitIssues: r.webkitIssues.map((x) => x.code) }));
console.log('wrote', liveCheck, Object.keys(e2e).length, 'runs');
