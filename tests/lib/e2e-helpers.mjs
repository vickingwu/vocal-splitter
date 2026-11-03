// tests/lib/e2e-helpers.mjs — shared Playwright helpers for tests/e2e/*.mjs (design §16.C; design_accepted DA-4: the
// navigation counter is registered once per page and every caller passes the count it saw before its own navigation).
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
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
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
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

// Headless Chromium = Playwright's full Chromium build in new-headless mode (channel 'chromium'): the headless SHELL has no
// performance.measureUserAgentSpecificMemory() (SecurityError "not available" — its renderer is not site-locked), so the
// §7.5 / §16.D memory peaks need the full build. Falls back to the shell when the full build is not installed.
export async function launchChromium(chromium, opts = {}) {
  try {
    const browser = await chromium.launch({ ...opts, channel: 'chromium' });
    return { browser, channel: 'chromium' };
  } catch (e) {
    const browser = await chromium.launch(opts);
    return { browser, channel: 'headless-shell', channelError: String(e && e.message).slice(0, 200) };
  }
}

// §22.6 layout rules, evaluated in-page at the current viewport: no horizontal overflow; every visible control
// (offsetParent !== null) is >= 44 px tall and inside the viewport horizontally; inputs/selects/buttons have font-size >= 16.
// The checkbox's touch target is its label (label:has(#denoise) is in the list), so the 24 px box itself is exempt from
// the height/font rules but still has to sit inside the viewport. <audio controls> is checked for left/right only.
export function layoutCheck(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const clientWidth = de.clientWidth;
    const violations = [];
    if (de.scrollWidth > clientWidth) violations.push({ kind: 'overflow', scrollWidth: de.scrollWidth, clientWidth });
    const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
    let controls = 0;
    for (const el of document.querySelectorAll('button, input:not([type=file]), select, a#logout, a.dl, #drop-zone, label:has(#denoise)')) {
      if (el.offsetParent === null) continue;
      controls++;
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const checkbox = tag === 'input' && el.type === 'checkbox';
      if (!checkbox && r.height < 44) violations.push({ kind: 'height', el: desc(el), height: r.height });
      if (r.left < 0) violations.push({ kind: 'left', el: desc(el), left: r.left });
      if (r.right > clientWidth) violations.push({ kind: 'right', el: desc(el), right: r.right, clientWidth });
      if (!checkbox && (tag === 'input' || tag === 'select' || tag === 'button')) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (!(fs >= 16)) violations.push({ kind: 'font', el: desc(el), fontSize: fs });
      }
    }
    let audios = 0;
    for (const el of document.querySelectorAll('audio[controls]')) {
      if (el.offsetParent === null) continue;
      audios++;
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.right > clientWidth) violations.push({ kind: 'audio', el: desc(el), left: r.left, right: r.right, clientWidth });
    }
    return { clientWidth, scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, controls, audios, violations };
  });
}

// OS-level renderer memory (Windows): every intervalMs, Win32_Process rows of the Playwright-launched Chromium (browser
// process = chrome.exe/headless_shell.exe under ms-playwright with --remote-debugging-pipe, created after `sinceMs`);
// the renderer children (--type=renderer) carry the page AND its dedicated workers, i.e. the ORT WASM heap. Records the
// peak private commit (PrivatePageCount) and working set of the largest renderer per sample. Elsewhere → nulls.
export function startProcessMemoryPoller({ sinceMs = Date.now() - 60000, intervalMs = 500 } = {}) {
  const win = process.platform === 'win32';
  let samples = 0, peakPrivate = null, peakWorkingSet = null, error = null, browserPid = null;
  const rendererPids = new Set();
  const script = path.join(repoRoot, 'tests', 'lib', 'proc_mem.ps1');
  let child = null, buf = '';
  if (win) {
    // ONE long-lived sampler process (cheap Get-Process per sample) instead of a PowerShell start per tick — a per-tick
    // spawn costs a core and skews the chunk timings measured alongside.
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SinceMs', String(Math.floor(sinceMs)), '-Loop', '-IntervalMs', String(intervalMs)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim().replace(/^\uFEFF/, ''); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.browserPid) browserPid = j.browserPid;
          const rs = Array.isArray(j.renderers) ? j.renderers : [];
          if (rs.length) {
            samples++;
            for (const r of rs) rendererPids.add(r.pid);
            const priv = Math.max(...rs.map((r) => Number(r.priv) || 0));
            const ws = Math.max(...rs.map((r) => Number(r.ws) || 0));
            if (peakPrivate === null || priv > peakPrivate) peakPrivate = priv;
            if (peakWorkingSet === null || ws > peakWorkingSet) peakWorkingSet = ws;
          }
        } catch (e) { error = String(e.message).slice(0, 200); }
      }
    });
    child.stderr.on('data', (d) => { error = String(d).slice(0, 200); });
    child.on('error', (e) => { error = String(e.message).slice(0, 200); });
  }
  return {
    async stop() {
      if (child) { try { child.kill(); } catch { /* ignore */ } }
      await sleep(50);
      return { platform: process.platform, browserPid, rendererPids: [...rendererPids], samples, intervalMs, peakPrivateBytes: peakPrivate, peakWorkingSetBytes: peakWorkingSet, error, label: win ? 'PrivateMemorySize64/WorkingSet64 of the largest renderer (page + dedicated workers), Get-Process sampled by tests/lib/proc_mem.ps1' : 'unsupported platform' };
    },
  };
}

// performance.measureUserAgentSpecificMemory() polling (§7.5 / §16.D, A28): every intervalMs with at most one call in
// flight; the API needs cross-origin isolation and may delay its answer, so the sample count is reported next to the peak.
// Fewer than 5 samples → peakBytes null, label 「未能观测」.
export function startMemoryPoller(page, { intervalMs = 500, minSamples = 5 } = {}) {
  let stopped = false, inFlight = false, peak = null, samples = 0, error = null;
  const probe = () => page.evaluate(async () => {
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') return { error: 'unsupported' };
    try { const r = await performance.measureUserAgentSpecificMemory(); return { bytes: r.bytes }; } catch (e) { return { error: String((e && e.name) || e) }; }
  });
  const loop = (async () => {
    while (!stopped) {
      if (!inFlight) {
        inFlight = true;
        probe().then((r) => {
          inFlight = false;
          if (r && typeof r.bytes === 'number') { samples++; if (peak === null || r.bytes > peak) peak = r.bytes; }
          else if (r && r.error) error = r.error;
        }, (e) => { inFlight = false; error = String(e && e.message).slice(0, 120); });
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      const t0 = Date.now();
      while (inFlight && Date.now() - t0 < 10000) await sleep(100);
      const ok = samples >= minSamples;
      return { peakBytes: ok ? peak : null, peakObserved: peak, samples, label: ok ? 'measureUserAgentSpecificMemory' : '未能观测', error };
    },
  };
}
