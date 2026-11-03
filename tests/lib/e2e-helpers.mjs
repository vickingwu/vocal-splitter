// tests/lib/e2e-helpers.mjs — shared Playwright helpers for tests/e2e/*.mjs (design §16.C; design_accepted DA-4: the
// navigation counter is registered once per page and every caller passes the count it saw before its own navigation).
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { repoRoot } from './fixtures.mjs';

export function makeNavCounter(context) {
  let n = 0;
  const attach = (page) => page.on('framenavigated', (f) => { if (f === page.mainFrame()) n++; });
  context.on('page', attach);
  for (const p of context.pages()) attach(p);
  return { count: () => n };
}

// Tolerates the coi-serviceworker reload (§9): two waitForFunction passes, then the loaded post-reload document with __vs.
export async function awaitIsolation(page, { counter = null, sinceNavigation = 0, maxExtraNavigations = 2, passes = 2, timeout = 5000 } = {}) {
  for (let i = 0; i < passes; i++) {
    try { await page.waitForFunction(() => crossOriginIsolated, null, { timeout }); break; }
    catch (e) { if (/context was destroyed|navigation|Execution context/i.test(String(e && e.message))) continue; break; }
  }
  await page.waitForLoadState('load');
  await page.waitForFunction(() => window.__vs !== undefined, null, { timeout: 10000 });
  if (counter) {
    const extra = counter.count() - sinceNavigation;
    if (extra > maxExtraNavigations) throw new Error(`NAVIGATION_LOOP: ${extra} main-frame navigations since the deliberate one (max ${maxExtraNavigations})`);
  }
  return page.evaluate(() => crossOriginIsolated);
}

// Positive-only login helper: fills the form, submits with Enter, waits for idle.
export async function login(page, { user, pass, timeout = 30000 }) {
  await page.fill('#login-user', user);
  await page.fill('#login-pass', pass);
  await page.press('#login-pass', 'Enter');
  await page.waitForFunction(() => window.__vs.state === 'idle' || window.__vs.state === 'unsupported', null, { timeout });
  return page.evaluate(() => window.__vs.state);
}

function probe(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// For a local base: probe GET <base>index.html and spawn scripts/serve.mjs when nothing answers (SERVER_DOWN after 5 s).
// A remote base is only probed. Returns { stop(), started }.
export async function startServerIfNeeded(base) {
  const u = new URL(base);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  const probeUrl = new URL('index.html', base).href;
  if (await probe(probeUrl)) return { stop() {}, started: false };
  if (!local) throw new Error(`SERVER_DOWN: nothing answers on ${base}`);
  const port = u.port || '80';
  const child = spawn(process.execPath, [path.join('scripts', 'serve.mjs'), '--port', port, '--root', 'site'], { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probe(probeUrl)) return { stop() { try { child.kill(); } catch { /* ignore */ } }, started: true };
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new Error(`SERVER_DOWN: nothing answers on ${base} and serve.mjs did not come up`);
}

export async function readManifest(base) {
  const r = await fetch(new URL('models/manifest.json', base).href);
  if (!r.ok) throw new Error(`MANIFEST_HTTP_${r.status}`);
  return r.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
