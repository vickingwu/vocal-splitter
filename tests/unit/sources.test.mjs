// tests/unit/sources.test.mjs — FIX-2 R1/R2: manifest source resolution (URL builders, ?sources= pinning, origin always kept),
// Content-Range parsing, and the run-time probe (ranking by bytes/ms, exclusion of dead / non-CORS / wrong-status hosts, clean
// vs dirty 206, 200 answers, whole-file sources needing ranges, partial-on-timeout, origin kept last).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSources, probeSources, contentRangeTotal, ORIGIN_SOURCE, PROBE_BYTES } from '../../site/src/engine/sources.mjs';
import { makeChunkBytes, makeManifest, makeFetchIntoFake, concatBytes } from '../lib/fakes.mjs';
import { readManifest } from '../lib/fixtures.mjs';

const BASE = 'http://localhost/app/';
const SOURCES = [
  { id: 'origin', kind: 'chunks', base: './', label: '站内' },
  { id: 'hf', kind: 'whole', urls: { model: 'https://hf.test/r/resolve/main/fake.onnx' }, label: 'hf' },
  { id: 'cdn', kind: 'chunks', base: 'https://cdn.test/gh/x@models-1/site/', label: 'cdn' },
];
const sizes = [1000, 1000, 500];
const chunks = makeChunkBytes(sizes, 1);
const manifest = makeManifest({ modelChunks: chunks, sources: SOURCES });
const model = manifest.models.fake_model;
const file = model.files.model;

test('resolveSources: manifest order, origin URL with ?v=, mirror URL = base + chunk path, whole URL per file key; default when sources absent', () => {
  const r = resolveSources(model, BASE, { version: 'test-1' });
  assert.deepEqual(r.map((s) => [s.id, s.kind, s.isOrigin]), [['origin', 'chunks', true], ['hf', 'whole', false], ['cdn', 'chunks', false]]);
  assert.equal(r[0].urlFor('model', file, file.chunks[1]).href, 'http://localhost/app/models/fake_model/core.part-01.bin?v=test-1');
  assert.equal(r[2].urlFor('model', file, file.chunks[1]).href, 'https://cdn.test/gh/x@models-1/site/models/fake_model/core.part-01.bin');
  assert.equal(r[1].urlFor('model', file).href, 'https://hf.test/r/resolve/main/fake.onnx');
  assert.equal(r[1].urlFor('externalData', file), null, 'no URL for a file the whole source does not carry');
  const plain = resolveSources({ files: model.files }, BASE, {});
  assert.deepEqual(plain.map((s) => s.id), ['origin']);
  assert.equal(plain[0].urlFor('model', file, file.chunks[0]).href, 'http://localhost/app/models/fake_model/core.part-00.bin', 'no ?v= without a version');
  assert.deepEqual(ORIGIN_SOURCE, { id: 'origin', kind: 'chunks', base: './', label: '站内' });
});

test('resolveSources with only: pinned order, unknown ids dropped, origin appended as the fallback when left out', () => {
  assert.deepEqual(resolveSources(model, BASE, { only: ['cdn', 'hf'] }).map((s) => s.id), ['cdn', 'hf', 'origin']);
  assert.deepEqual(resolveSources(model, BASE, { only: ['hf', 'origin', 'cdn'] }).map((s) => s.id), ['hf', 'origin', 'cdn']);
  assert.deepEqual(resolveSources(model, BASE, { only: ['nope'] }).map((s) => s.id), ['origin']);
  assert.deepEqual(resolveSources(model, BASE, { only: [] }).map((s) => s.id), ['origin', 'hf', 'cdn'], 'an empty list means no restriction');
});

test('contentRangeTotal', () => {
  assert.equal(contentRangeTotal('bytes 0-262143/5539495'), 5539495);
  assert.equal(contentRangeTotal(' bytes 1048576-1049599/213244940 '), 213244940);
  assert.equal(contentRangeTotal('bytes 0-1/*'), null);
  assert.equal(contentRangeTotal(null), null);
  assert.equal(contentRangeTotal('garbage'), null);
});

function serveFor(sources) {
  const serve = {};
  file.chunks.forEach((c, i) => { serve[c.path.replace(/^/, 'app/')] = chunks[i]; });
  for (const s of sources) {
    if (s.kind === 'chunks' && s.base !== './') file.chunks.forEach((c, i) => { const u = new URL(c.path, s.base); serve[u.host + u.pathname] = chunks[i]; });
    if (s.kind === 'whole') { const u = new URL(s.urls.model); serve[u.host + u.pathname] = concatBytes(chunks); }
  }
  return serve;
}
// the fake maps same-origin requests by pathname without the leading slash → 'app/models/…' here (baseUrl has a directory)
const probe = (overrides, { ranges = true, timeoutMs = 300, sources = SOURCES } = {}) => {
  const fetchInto = makeFetchIntoFake(serveFor(sources), overrides, { ranges });
  // the fake keys same-origin paths on the pathname; our BASE is /app/, so make its origin match
  const wrapped = (url, target, opts) => fetchInto(url, target, opts);
  wrapped.calls = fetchInto.calls;
  return { fetchInto: wrapped, run: () => probeSources(resolveSources(model, BASE, { version: 'test-1' }), model.files, { fetchInto: wrapped, now: () => performance.now(), origin: 'http://localhost', timeoutMs }) };
};

test('probe: every source gets one Range GET of min(256 KB, size); the fastest is ranked first; clean 206 → ranges true', async () => {
  // delays far apart so scheduling jitter under a loaded test runner cannot reorder them (origin: no delay)
  const p = probe((path) => (path.startsWith('cdn.test') ? { delayMs: 240 } : path.startsWith('hf.test') ? { delayMs: 90 } : null));
  const r = await p.run();
  assert.deepEqual(r.ranked.map((s) => s.id), ['origin', 'hf', 'cdn']);
  assert.ok(r.ranked.every((s) => s.ranges === true));
  assert.deepEqual(r.excluded, []);
  assert.equal(p.fetchInto.calls.length, 3);
  for (const c of p.fetchInto.calls) { assert.equal(c.range.start, 0); assert.equal(c.targetLength, c.range.end + 1); }
  const byId = Object.fromEntries(p.fetchInto.calls.map((c) => [c.pathname.startsWith('hf.test') ? 'hf' : c.pathname.startsWith('cdn.test') ? 'cdn' : 'origin', c]));
  assert.equal(byId.origin.targetLength, 1000, 'chunk source: first chunk (1000 B < 256 KB)');
  assert.equal(byId.hf.targetLength, 2500, 'whole source: the file (2500 B < 256 KB)');
  assert.equal(PROBE_BYTES, 262144);
  for (const s of r.ranked) { assert.equal(typeof s.probe.kBps, 'number'); assert.equal(s.probe.status, 206); }
});

test('probe exclusions: dead host, HTTP 404, whole source answering 200 (range ignored) or a dirty 206; a chunk source answering 200 stays usable range-less', async () => {
  const dead = await probe((path) => (path.startsWith('cdn.test') ? { reject: new TypeError('Failed to fetch') } : null)).run();
  assert.deepEqual(dead.ranked.map((s) => s.id).sort(), ['hf', 'origin']);
  assert.deepEqual(dead.excluded, [{ id: 'cdn', reason: 'TypeError: Failed to fetch' }]);
  const notFound = await probe((path) => (path.startsWith('cdn.test') ? { status: 404 } : null)).run();
  assert.deepEqual(notFound.excluded, [{ id: 'cdn', reason: 'HTTP 404' }]);
  const whole200 = await probe((path) => (path.startsWith('hf.test') ? { noRange: true } : null)).run();
  assert.deepEqual(whole200.excluded, [{ id: 'hf', reason: 'range ignored' }]);
  const dirty = await probe((path) => (path.startsWith('hf.test') ? { contentEncoding: 'br' } : null)).run();
  assert.deepEqual(dirty.excluded, [{ id: 'hf', reason: 'range answer not clean' }]);
  const chunk200 = await probe((path) => (path.startsWith('cdn.test') ? { noRange: true } : null)).run();
  const cdn = chunk200.ranked.find((s) => s.id === 'cdn');
  assert.ok(cdn && cdn.ranges === false && cdn.probe.status === 200, JSON.stringify(chunk200.ranked));
  assert.deepEqual(chunk200.excluded, []);
  // a 206 whose Content-Range total is not the resource size (a compressed representation, as cdn.jsdelivr.net answers with
  // Accept-Encoding) → range-less for a chunk source, excluded for a whole-file source
  const compressed = await probe((path) => (path.startsWith('cdn.test') || path.startsWith('hf.test') ? { contentRange: 'bytes 0-999/422765' } : null)).run();
  assert.equal(compressed.ranked.find((s) => s.id === 'cdn').ranges, false);
  assert.deepEqual(compressed.excluded, [{ id: 'hf', reason: 'range answer not clean' }]);
  const wrongLength = await probe((path) => (path.startsWith('cdn.test') ? { contentLength: 999 } : null)).run();
  assert.equal(wrongLength.ranked.find((s) => s.id === 'cdn').ranges, true, 'content-length alone is not a disqualifier (hidden for CORS answers anyway)');
});

test('probe: the origin is never excluded — a failed origin probe keeps it last and range-less; a timeout with bytes keeps a chunk source (partial measurement)', async () => {
  const failedOrigin = await probe((path) => (path.startsWith('app/models') ? { status: 503 } : null)).run();
  assert.deepEqual(failedOrigin.ranked.map((s) => s.id).slice(-1), ['origin']);
  assert.equal(failedOrigin.ranked.find((s) => s.id === 'origin').ranges, false);
  assert.deepEqual(failedOrigin.excluded, []);
  const slow = await probe((path) => (path.startsWith('cdn.test') || path.startsWith('hf.test') ? { delayMs: 600 } : null), { timeoutMs: 120 }).run();
  const cdn = slow.ranked.find((s) => s.id === 'cdn');
  assert.ok(cdn, 'half the bytes arrived before the timeout → usable');
  assert.equal(cdn.ranges, true, 'the headers (clean 206) arrived before the body timed out → Range support known, 4 MiB resume granularity on a slow link');
  assert.equal(cdn.probe.error, 'timeout (partial)');
  assert.equal(cdn.probe.status, 206);
  const hf = slow.ranked.find((s) => s.id === 'hf');
  assert.ok(hf && hf.ranges === true, 'a slow whole-file source stays usable when its headers are a clean 206');
  assert.equal(slow.ranked[0].id, 'origin', 'ranked by measured bytes/ms');
  // slow AND range-less (200 to the Range request) → chunk source kept range-less, whole source excluded
  const slow200 = await probe((path) => (path.startsWith('cdn.test') || path.startsWith('hf.test') ? { delayMs: 600, noRange: true } : null), { timeoutMs: 120 }).run();
  assert.equal(slow200.ranked.find((s) => s.id === 'cdn').ranges, false);
  assert.deepEqual(slow200.excluded, [{ id: 'hf', reason: 'timeout (range answer not clean)' }]);
});

test('probe: a source without a byte at the timeout is not excluded but ranked last as unmeasured (Range assumed, or from its headers); a dead one is still excluded', async () => {
  // cdn hangs before its headers: unmeasured, last, ranges assumed true (the loader's first request settles it)
  const hang = await probe((path) => (path.startsWith('cdn.test') ? { hang: true } : null), { timeoutMs: 80 }).run();
  assert.deepEqual(hang.excluded, []);
  assert.deepEqual(hang.ranked.map((s) => s.id).slice(-1), ['cdn'], JSON.stringify(hang.ranked.map((s) => s.id)));
  const cdn = hang.ranked.find((s) => s.id === 'cdn');
  assert.equal(cdn.ranges, true);
  assert.deepEqual({ bytes: cdn.probe.bytes, error: cdn.probe.error, unmeasured: cdn.probe.unmeasured }, { bytes: 0, error: 'timeout (no bytes)', unmeasured: true });
  assert.ok(hang.results.find((r) => r.id === 'cdn').ms >= 80 && hang.results.find((r) => r.id === 'cdn').ms < 160, 'no grace: origin and hf delivered bytes within the timeout');
  // a whole-file source that hangs is kept too (its first Range request excludes it when it answers 200)
  const hangHf = await probe((path) => (path.startsWith('hf.test') ? { hang: true } : null), { timeoutMs: 80 }).run();
  assert.deepEqual(hangHf.excluded, []);
  assert.equal(hangHf.ranked.slice(-1)[0].id, 'hf');
  assert.equal(hangHf.ranked.slice(-1)[0].ranges, true);
  // a reset / CORS failure is a real failure: excluded as before
  const dead = await probe((path) => (path.startsWith('cdn.test') ? { reject: new TypeError('Failed to fetch') } : null), { timeoutMs: 80 }).run();
  assert.deepEqual(dead.excluded, [{ id: 'cdn', reason: 'TypeError: Failed to fetch' }]);
  // unmeasured sources keep manifest order among themselves, after every measured one
  const twoHang = await probe((path) => (path.startsWith('cdn.test') || path.startsWith('hf.test') ? { hang: true } : null), { timeoutMs: 80 }).run();
  assert.deepEqual(twoHang.ranked.map((s) => s.id), ['origin', 'hf', 'cdn']);
});

test('probe grace: when NO source has a byte at the timeout the deadline doubles once for every probe; a byte anywhere in time → no grace; linkKBps sums the measured rates', async () => {
  // every source delays its first byte past the 80 ms timeout but inside 160 ms → all measured (partial), extended: true
  const late = probe(() => ({ delayMs: 0, firstByteDelayMs: 110 }), { timeoutMs: 80 });
  const r = await late.run();
  assert.equal(r.extended, true);
  assert.deepEqual(r.excluded, []);
  assert.ok(r.ranked.every((s) => s.probe.bytes > 0 && !s.probe.unmeasured), JSON.stringify(r.ranked.map((s) => s.probe)));
  for (const res of r.results) assert.ok(res.ms >= 110 && res.ms < 400, `probe ran into the grace: ${res.ms} ms`);
  // one fast source → the others time out at the plain deadline, unmeasured, no grace
  const mixed = await probe((path) => (path.startsWith('app/') ? null : { firstByteDelayMs: 500 }), { timeoutMs: 80 }).run();
  assert.equal(mixed.extended, false);
  assert.deepEqual(mixed.ranked.map((s) => [s.id, s.probe.unmeasured === true]), [['origin', false], ['hf', true], ['cdn', true]]);
  for (const res of mixed.results.filter((x) => x.id !== 'origin')) assert.ok(res.ms >= 80 && res.ms < 300, `no grace: ${res.ms} ms`);
  // linkKBps = Σ bytes/ms of the measured sources (the probes share the link), unmeasured ones add nothing
  const all = await probe(() => null).run();
  const sum = all.results.filter((x) => x.ok && !x.unmeasured).reduce((a, x) => a + x.bytesPerMs, 0);
  assert.equal(all.linkKBps, Math.round(sum * 1000 / 1024));
  assert.ok(all.linkKBps >= Math.max(...all.ranked.map((s) => s.probe.kBps)) - 1, 'at least the best single source');
  assert.equal(mixed.linkKBps, mixed.ranked[0].probe.kBps);
});

test('committed manifest: every model resolves its sources and builds https URLs for every chunk / file of every source', () => {
  const m = readManifest();
  for (const [id, model] of Object.entries(m.models)) {
    const sources = resolveSources(model, 'https://vickingwu.github.io/vocal-splitter/', { version: m.version });
    assert.equal(sources[0].id, 'origin');
    for (const s of sources) {
      for (const fk of ['model', 'externalData']) {
        const f = model.files[fk];
        if (!f) continue;
        if (s.kind === 'chunks') for (const c of f.chunks) { const u = s.urlFor(fk, f, c); assert.ok(u.href.startsWith('https://'), `${id} ${s.id}`); assert.ok(u.pathname.endsWith('/' + c.path), `${id} ${s.id} ${u.href}`); if (!s.isOrigin) assert.ok(u.href.includes(`${m.tag}/site/models/`), u.href); }
        else { const u = s.urlFor(fk, f); assert.ok(u && u.href.startsWith('https://') && u.pathname.endsWith('/' + f.name), `${id} ${s.id} ${fk}`); }
      }
    }
  }
});
