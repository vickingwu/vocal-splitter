// tests/unit/no-cdn.test.mjs — design §16.A row `no-cdn.test.mjs` (brief §1.8: no CDN at runtime; §7.1 one base URL).
// (1) no https?:// literal outside the allow-list in site/** (vendor excluded); (1b) manifest strings; (2) index.html hrefs/srcs
// on-origin; (3) every dynamic load site is a relative literal or new URL('<literal>', baseUrl)[.href]; no concatenation onto a
// base; no document.baseURI / self.location.href / location.href except the one definition line in app.mjs; worker.mjs has
// exactly two ORT import sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, readManifest } from '../lib/fixtures.mjs';

const site = path.join(repoRoot, 'site');
const ALLOWED_HOSTS = new Set(['api.allorigins.win', 'api.codetabs.com']);
const PLACEHOLDER = 'https://example.com/song.mp3';
const CHUNK_PATH_RE = /^models\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.bin$/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name === 'vendor' || ent.name === 'models') continue; walk(p, out); } else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(site, p).split(path.sep).join('/');
const textFiles = () => walk(site).filter((p) => /\.(html|mjs|js|css)$/.test(p));
const codeFiles = () => textFiles().filter((p) => /\.(mjs|js)$/.test(p) && rel(p) !== 'coi-serviceworker.min.js');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

test('(1) no https?:// literal outside the allow-list in site/** (vendor excluded, coi-serviceworker included)', () => {
  const files = textFiles();
  assert.ok(files.some((p) => rel(p) === 'coi-serviceworker.min.js'), 'coi-serviceworker.min.js is scanned');
  assert.ok(files.some((p) => rel(p) === 'app.mjs'));
  const bad = [];
  for (const p of files) {
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]*)([A-Za-z0-9._~:/?#@!$&*+,;=%-]*)/g)) {
      const host = m[1];
      const full = m[0];
      if (host === '' && rel(p) === 'src/ui/url-input.mjs') continue;          // the scheme-defaulting prefix 'https://' + text
      if (ALLOWED_HOSTS.has(host)) continue;
      if (full === PLACEHOLDER) continue;
      bad.push(`${rel(p)}:${lineOf(text, m.index)}: ${full}`);
    }
  }
  assert.deepEqual(bad, []);
});

// FIX-2 R1: the only off-origin URLs the runtime may use are the manifest's download `sources` (https, probed and sha256-
// verified by the loader) — the attribution `source` and the sources' `base` / `urls.*` are the only "://" strings allowed.
test('(1b) manifest: "://" only at models.<id>.source and models.<id>.sources[n].{base,urls.*} (https); every chunk path matches the §6.2 regex', () => {
  const manifest = readManifest();
  const bad = [];
  const visit = (v, p) => {
    if (typeof v === 'string') {
      if (!v.includes('://')) return;
      if (/^models\.[A-Za-z0-9_-]+\.source$/.test(p)) return;
      if (/^models\.[A-Za-z0-9_-]+\.sources\[\d+\]\.(base|urls\.(model|externalData))$/.test(p) && v.startsWith('https://')) return;
      bad.push(`${p}: ${v}`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k);
  };
  visit(manifest, '');
  assert.deepEqual(bad, []);
  for (const m of Object.values(manifest.models)) assert.deepEqual(m.sources[0], { id: 'origin', kind: 'chunks', base: './', label: '站内' });
  for (const [id, m] of Object.entries(manifest.models)) {
    for (const f of [m.files.model, m.files.externalData].filter(Boolean)) for (const c of f.chunks) {
      assert.ok(CHUNK_PATH_RE.test(c.path), `${id}: ${c.path}`);
      assert.ok(!c.path.includes('://') && !c.path.startsWith('/'));
    }
  }
});

test('(2) index.html has no off-origin script src / link href / a href', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const refs = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]*)"/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]*)"/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<a[^>]*\shref="([^"]*)"/g)) refs.push(m[1]);
  assert.ok(refs.length >= 4, 'scripts, stylesheet and anchors found');
  for (const r of refs) {
    assert.ok(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r) && !r.startsWith('//'), `off-origin reference ${r}`);
  }
  assert.ok(refs.includes('coi-serviceworker.min.js') && refs.includes('app.mjs') && refs.includes('styles.css'));
});

// extracts the first argument of a call whose opening paren is at `open`
function firstArg(text, open) {
  let depth = 0;
  let i = open;
  let quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) return text.slice(open + 1, i).trim(); continue; }
    if (ch === ',' && depth === 1) return text.slice(open + 1, i).trim();
  }
  return text.slice(open + 1).trim();
}

const RELATIVE_LITERAL = /^(['"])(?![a-zA-Z][a-zA-Z0-9+.-]*:)(?!\/)[^'"]+\1$/;
const NEW_URL_BASE = /^new URL\('([^']+)', baseUrl\)(\.href)?$/;
const EXCEPTIONS = { 'src/ui/url-input.mjs': ['attempt.url'], 'src/worker/fetch-into.mjs': ['url'] };

test('(3) every import( / new Worker( / importScripts( / fetch( argument is a relative literal or new URL(<literal>, baseUrl)[.href]', () => {
  const bad = [];
  let sites = 0;
  for (const p of codeFiles()) {
    const text = fs.readFileSync(p, 'utf8');
    const r = rel(p);
    for (const m of text.matchAll(/\b(import|fetch|importScripts)\s*\(|\bnew\s+Worker\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const arg = firstArg(text, open);
      sites++;
      const ok = RELATIVE_LITERAL.test(arg) || NEW_URL_BASE.test(arg) || (EXCEPTIONS[r] ?? []).includes(arg);
      if (!ok) bad.push(`${r}:${lineOf(text, m.index)}: ${m[0]}${arg}`);
      if (NEW_URL_BASE.test(arg)) {
        const lit = NEW_URL_BASE.exec(arg)[1];
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(lit) || lit.startsWith('/')) bad.push(`${r}:${lineOf(text, m.index)}: non-relative literal ${lit}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(sites >= 6, `expected the known load sites, found ${sites}`);
});

test('(3) no concatenation onto a base URL, no document.baseURI / self.location.href; exactly one location.href (the app.mjs definition)', () => {
  const bad = [];
  let hrefCount = 0;
  for (const p of codeFiles().concat([path.join(site, 'index.html')])) {
    const text = fs.readFileSync(p, 'utf8');
    const r = rel(p);
    for (const m of text.matchAll(/baseUrl\s*\+|\+\s*baseUrl|document\.baseURI|self\.location\.href|window\.location\.href/g)) bad.push(`${r}:${lineOf(text, m.index)}: ${m[0]}`);
    for (const m of text.matchAll(/\blocation\.href/g)) {
      hrefCount++;
      const line = text.split('\n')[lineOf(text, m.index) - 1].trim();
      if (!(r === 'app.mjs' && line === "export const baseUrl = new URL('./', location.href).href;")) bad.push(`${r}:${lineOf(text, m.index)}: ${line}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.equal(hrefCount, 1);
});

test('worker.mjs has exactly two import(new URL(…, baseUrl).href) sites naming the two ORT bundles; ort.env written only there', () => {
  const text = fs.readFileSync(path.join(site, 'worker.mjs'), 'utf8');
  const sites = [...text.matchAll(/import\(new URL\('([^']+)', baseUrl\)\.href\)/g)].map((m) => m[1]);
  assert.deepEqual(sites.sort(), ['vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort.webgpu.min.mjs']);
  assert.equal([...text.matchAll(/\bimport\s*\(/g)].length, 2);
  assert.ok(/ort\.env\.wasm\.wasmPaths = new URL\('vendor\/ort\/', baseUrl\)\.href/.test(text));
  for (const p of codeFiles()) {
    if (rel(p) === 'worker.mjs') continue;
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(!/ort\.env\.\w+(\.\w+)?\s*=/.test(t), `${rel(p)} writes ort.env`);
  }
});

test('engine modules never reference window / document / navigator / self', () => {
  const dir = path.join(site, 'src', 'engine');
  for (const f of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(window|document|navigator|self)\b\s*[.[]/.test(t), `${f} touches a browser global`);
  }
});
