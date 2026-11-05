// tests/tools/browser_probe_sources.mjs — SHIP-2: what headless Chromium itself gets from every remote source URL of the live
// manifest (cross-origin Range fetch from a page on the live origin — the same request the loader's probe makes), next to
// what curl sees. No login needed (the fetch runs in page context before the gate).
//   node tests/tools/browser_probe_sources.mjs --base https://vickingwu.github.io/vocal-splitter/ [--out ../evidence/sources_live_browser_probe.json]
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright');
import { launchChromium, readManifest } from '../lib/e2e-helpers.mjs';
import { repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
let base = arg('--base', 'https://vickingwu.github.io/vocal-splitter/');
if (!base.endsWith('/')) base += '/';
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'sources_live_browser_probe.json')));
const manifest = await readManifest(base);

// one URL per (source, model): the first chunk of the model file, or the whole model file
const targets = [];
for (const [mid, m] of Object.entries(manifest.models)) {
  for (const s of m.sources ?? []) {
    if (s.id === 'origin') continue;
    const file = m.files.model;
    const url = s.kind === 'chunks' ? new URL(file.chunks[0].path, s.base).href : s.urls.model;
    const total = s.kind === 'chunks' ? file.chunks[0].bytes : file.bytes;
    targets.push({ modelId: mid, sourceId: s.id, kind: s.kind, url, total });
  }
}
const l = await launchChromium(chromium, { headless: true });
const browser = l.browser;
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(base);
const results = [];
for (const t of targets) {
  const r = await page.evaluate(async ({ url, n }) => {
    const t0 = performance.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=0-${n - 1}` }, signal: ac.signal });
      const headers = {};
      for (const k of ['content-length', 'content-range', 'content-encoding', 'access-control-allow-origin', 'content-type', 'accept-ranges']) headers[k] = resp.headers.get(k);
      const buf = new Uint8Array(await resp.arrayBuffer());
      clearTimeout(timer);
      return { ok: resp.ok, status: resp.status, headers, bytes: buf.length, ms: Math.round(performance.now() - t0), error: null };
    } catch (e) { return { ok: false, status: null, headers: null, bytes: 0, ms: Math.round(performance.now() - t0), error: `${e && e.name}: ${e && e.message}` }; }
  }, { url: t.url, n: 262144 });
  const rec = { ...t, ...r, kBps: r.bytes && r.ms ? Math.round(r.bytes / r.ms * 1000 / 1024) : 0 };
  results.push(rec);
  console.log('[browser-probe]', rec.modelId, rec.sourceId, rec.status, rec.bytes, 'B', rec.ms, 'ms', rec.kBps, 'kB/s', rec.headers ? `CR=${rec.headers['content-range']} enc=${rec.headers['content-encoding']} ACAO=${rec.headers['access-control-allow-origin']}` : '', rec.error ?? '');
}
await browser.close();
const bySource = {};
for (const r of results) { (bySource[r.sourceId] ??= { ok: 0, failed: 0, errors: [] }); if (r.ok && r.bytes === 262144) bySource[r.sourceId].ok++; else { bySource[r.sourceId].failed++; bySource[r.sourceId].errors.push(`${r.modelId}: ${r.error ?? 'status ' + r.status + ' bytes ' + r.bytes}`); } }
const doc = { date: new Date().toISOString(), base, manifestVersion: manifest.version, browser: { channel: l.channel, version: browser.version() }, method: 'page.evaluate fetch(url, {mode: cors, credentials: omit, headers: {Range: bytes=0-262143}}) from a page on the live origin, 15 s timeout', bySource, results };
fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
console.log('[browser-probe] wrote', outFile);
