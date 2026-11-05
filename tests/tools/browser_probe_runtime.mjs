// tests/tools/browser_probe_runtime.mjs — FIX-3 R1: what headless Chromium itself gets from every runtime source of the
// LOCAL manifest (site/models/manifest.json → runtime.<backend>.sources), fetched from a page on --base (the live origin, so
// CORS is judged against the real Origin header): (1) the loader's probe request (256 KB Range) and (2) a whole-file GET of
// the .wasm whose bytes are sha256-checked against the manifest — the browser-side proof that a whole-file source (compressed
// representation, Range ignored) still delivers the exact file. Tag-pinned mirrors are probed with --tag (the tag that exists
// today; the manifest's own tag is created by the ship step). No login needed.
//   node tests/tools/browser_probe_runtime.mjs [--base https://vickingwu.github.io/vocal-splitter/] [--tag models-2026-11-04.1]
//        [--backend webgpu|wasm|both] [--out ../evidence/runtime_sources_browser_probe.json]
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright');
import { launchChromium } from '../lib/e2e-helpers.mjs';
import { repoRoot } from '../lib/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
let base = arg('--base', 'https://vickingwu.github.io/vocal-splitter/');
if (!base.endsWith('/')) base += '/';
const tag = arg('--tag', 'models-2026-11-04.1');
const backendArg = arg('--backend', 'both');
const outFile = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'runtime_sources_browser_probe.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'site', 'models', 'manifest.json'), 'utf8'));
const backends = backendArg === 'both' ? ['webgpu', 'wasm'] : [backendArg];

const targets = [];
for (const b of backends) {
  const rt = manifest.runtime[b];
  for (const s of rt.sources) {
    const substituted = (u) => u.replace(manifest.tag, tag);
    const wasmUrl = s.kind === 'chunks' ? new URL('vendor/ort/' + rt.wasm.name, s.base === './' ? base : substituted(s.base)).href : s.urls.wasm;
    const glueUrl = s.kind === 'chunks' ? new URL('vendor/ort/' + rt.glue.name, s.base === './' ? base : substituted(s.base)).href : s.urls.glue;
    targets.push({ backend: b, sourceId: s.id, kind: s.kind, tagPinned: s.kind === 'chunks' && s.id !== 'origin', wasmUrl, glueUrl, wasm: rt.wasm, glue: rt.glue });
  }
}
const l = await launchChromium(chromium, { headless: true });
const browser = l.browser;
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(base);
const log = (...a) => console.log('[rt-probe]', ...a);

// in-page: a Range probe (what sources.mjs sends) and a whole-file GET with sha256 of the body
const PROBE = async ({ url, n, expectBytes, expectSha, whole }) => {
  const headersOf = (resp) => { const h = {}; for (const k of ['content-length', 'content-range', 'content-encoding', 'access-control-allow-origin', 'content-type', 'accept-ranges']) h[k] = resp.headers.get(k); return h; };
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = { probe: null, whole: null };
  const t0 = performance.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=0-${n - 1}` }, signal: ac.signal });
    const buf = new Uint8Array(await resp.arrayBuffer());
    clearTimeout(timer);
    out.probe = { ok: resp.ok, status: resp.status, headers: headersOf(resp), bytes: buf.length, ms: Math.round(performance.now() - t0), cleanRange: resp.status === 206 && buf.length === n && !resp.headers.get('content-encoding') && (!resp.headers.get('content-range') || /\/(\d+)$/.exec(resp.headers.get('content-range'))?.[1] === String(expectBytes)) };
  } catch (e) { out.probe = { ok: false, status: null, bytes: 0, ms: Math.round(performance.now() - t0), error: `${e && e.name}: ${e && e.message}` }; }
  if (!whole) return out;
  const t1 = performance.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120000);
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ac.signal });
    const buf = await resp.arrayBuffer();
    clearTimeout(timer);
    const sha = hex(await crypto.subtle.digest('SHA-256', buf));
    out.whole = { ok: resp.ok, status: resp.status, headers: headersOf(resp), bytes: buf.byteLength, sha256: sha, identical: buf.byteLength === expectBytes && sha === expectSha, ms: Math.round(performance.now() - t1) };
  } catch (e) { out.whole = { ok: false, status: null, bytes: 0, ms: Math.round(performance.now() - t1), error: `${e && e.name}: ${e && e.message}` }; }
  return out;
};

const results = [];
for (const t of targets) {
  const r = await page.evaluate(PROBE, { url: t.wasmUrl, n: 262144, expectBytes: t.wasm.bytes, expectSha: t.wasm.sha256, whole: true });
  const g = await page.evaluate(PROBE, { url: t.glueUrl, n: Math.min(262144, t.glue.bytes), expectBytes: t.glue.bytes, expectSha: t.glue.sha256, whole: true });
  const rec = { ...t, wasm: { url: t.wasmUrl, ...r }, glue: { url: t.glueUrl, ...g } };
  delete rec.wasmUrl; delete rec.glueUrl;
  rec.wasm.kBps = r.whole && r.whole.ms ? Math.round(r.whole.bytes / r.whole.ms * 1000 / 1024) : 0;
  results.push(rec);
  log(t.backend, t.sourceId, 'probe', r.probe.status, r.probe.bytes, 'B', r.probe.cleanRange ? 'clean-range' : 'range-less', `enc=${r.probe.headers?.['content-encoding']} CR=${r.probe.headers?.['content-range']}`, 'whole', r.whole.status, r.whole.bytes, 'B', r.whole.identical ? 'IDENTICAL' : 'MISMATCH', `${rec.wasm.kBps} kB/s`, r.probe.error ?? '', r.whole.error ?? '', '| glue', g.probe.status, g.whole.identical ? 'IDENTICAL' : 'MISMATCH');
}
await browser.close();
const doc = { date: new Date().toISOString(), base, probedTag: tag, manifestTag: manifest.tag, manifestVersion: manifest.version, browser: { channel: l.channel, version: browser.version() }, method: 'page.evaluate fetch from a page on --base: Range bytes=0-262143 (the loader probe), then a whole-file GET with sha256 of the decoded body vs the manifest', results };
fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
log('wrote', outFile);
