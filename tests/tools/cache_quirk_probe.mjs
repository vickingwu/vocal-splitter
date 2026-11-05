// tests/tools/cache_quirk_probe.mjs — FIX-3 R1 evidence: does a cached 206 (the loader's 256 KB probe) truncate a later whole-file
// GET of the same URL in Chromium's HTTP cache? Fetches run from a page on the live origin.
//   node tests/tools/cache_quirk_probe.mjs [--url <wasm url>] [--out ../evidence/runtime_cache_quirk.json]
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright');
import { repoRoot } from '../lib/fixtures.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const base = 'https://vickingwu.github.io/vocal-splitter/';
const url = arg('--url', base + 'vendor/ort/ort-wasm-simd-threaded.wasm');   // 14.8 MB: quicker than the 28.7 MB one
const out = path.resolve(arg('--out', path.join(repoRoot, '..', 'evidence', 'runtime_cache_quirk.json')));
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const log = (...a) => console.log('[quirk]', ...a);
const FETCH = async ({ url, range, cache }) => {
  const t0 = performance.now();
  try {
    const init = { mode: 'cors', credentials: 'omit', cache };
    if (range) init.headers = { Range: range };
    const resp = await fetch(url, init);
    const buf = await resp.arrayBuffer();
    const h = {}; for (const k of ['content-length', 'content-range', 'content-encoding', 'cache-control', 'etag', 'age', 'x-cache', 'x-served-by']) h[k] = resp.headers.get(k);
    return { status: resp.status, bytes: buf.byteLength, headers: h, ms: Math.round(performance.now() - t0) };
  } catch (e) { return { error: `${e && e.name}: ${e && e.message}`, ms: Math.round(performance.now() - t0) }; }
};
const results = {};
async function scenario(name, steps) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base);
  results[name] = [];
  for (const s of steps) {
    const r = await page.evaluate(FETCH, { url, ...s });
    results[name].push({ ...s, ...r });
    log(name, JSON.stringify(s), r.status, r.bytes, 'B', r.ms, 'ms', r.headers ? `CL=${r.headers['content-length']} CR=${r.headers['content-range']} enc=${r.headers['content-encoding']} age=${r.headers.age}` : r.error);
  }
  await context.close();
}
await scenario('probeThenWholeDefault', [{ range: 'bytes=0-262143', cache: 'default' }, { cache: 'default' }]);
await scenario('probeThenWholeNoStore', [{ range: 'bytes=0-262143', cache: 'default' }, { cache: 'no-store' }]);
await scenario('probeNoStoreThenWholeDefault', [{ range: 'bytes=0-262143', cache: 'no-store' }, { cache: 'default' }]);
await scenario('wholeDefaultFresh', [{ cache: 'default' }]);
await scenario('probeThenRangesDefault', [{ range: 'bytes=0-262143', cache: 'default' }, { range: 'bytes=0-4194303', cache: 'default' }, { range: 'bytes=4194304-8388607', cache: 'default' }]);
await browser.close();
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), url, browser: 'chromium (playwright channel)', results }, null, 2) + '\n');
log('wrote', out);
