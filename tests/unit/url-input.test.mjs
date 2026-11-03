// tests/unit/url-input.test.mjs — design §10.2 / §10.3 (§16.A row): classifyUrl table, proxy URLs, filename derivation and the
// attempt loop driven by an injected fake fetch + node:test mock timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, proxyUrls, baseNameFromUrl, fetchAudioUrl, anySignal, PROXIES, CAP, HEADERS_MS, STALL_MS, PLATFORM_HOSTS } from '../../site/src/ui/url-input.mjs';
import { EngineError } from '../../site/src/engine/errors.mjs';
import { makeFetchFake } from '../lib/fakes.mjs';

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const hang = () => () => new Promise(() => {});
const delayed = (ms, value) => () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const headersNever = (u, init) => new Promise((_, reject) => {
  if (init.signal.aborted) { reject(abortErr()); return; }                  // a real fetch rejects at once on an aborted signal
  init.signal.addEventListener('abort', () => reject(abortErr()), { once: true });
});
const MB = new Uint8Array(1024 * 1024);
const AUDIO = (body = new Uint8Array([1, 2, 3, 4])) => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body });
// The attempt-loop tests inject this two-proxy list so they exercise the full direct → proxy → proxy state machine whatever
// tests/e2e/proxies.mjs pinned into PROXIES (empty on 2026-11-03 — both candidates timed out, evidence/proxies.json).
const TEST_PROXIES = Object.freeze([
  { name: 'allorigins', host: 'api.allorigins.win', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs', host: 'api.codetabs.com', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
]);
const isProxy = (u) => u.startsWith('https://api.allorigins.win/') || u.startsWith('https://api.codetabs.com/');

async function expectCode(promise, code) {
  try { await promise; } catch (e) {
    assert.ok(e instanceof EngineError, `expected EngineError, got ${e && e.stack}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected ${code}`);
}

// ------------------------------------------------------------------------------------------------------- classifyUrl
test('classifyUrl table', () => {
  assert.equal(PLATFORM_HOSTS.length, 14);
  const platform = ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://m.bilibili.com/video/BV1', 'https://b23.tv/abc', 'music.163.com/song?id=1',
    'https://163cn.tv/x', 'https://y.qq.com/n/ryqq/songDetail/1', 'https://www.kugou.com/song/x', 'http://kuwo.cn/play_detail/1', 'https://open.spotify.com/track/1',
    'https://www.douyin.com/video/1', 'https://v.douyin.com/x', 'https://www.iesdouyin.com/share/video/1', 'https://soundcloud.com/a/b', 'https://www.tiktok.com/@a/video/1', 'https://vt.tiktok.com/x'];
  for (const u of platform) assert.equal(classifyUrl(u).kind, 'platform', u);
  assert.equal(classifyUrl('https://example.com/song.mp3').kind, 'direct');
  assert.equal(classifyUrl('example.com/song.mp3').url, 'https://example.com/song.mp3');     // scheme defaulting
  assert.equal(classifyUrl('  http://example.com/a b.mp3  ').url, 'http://example.com/a%20b.mp3');
  assert.equal(classifyUrl('https://notyoutube.com/x').kind, 'direct');                        // suffix match needs a dot
  assert.equal(classifyUrl('https://cdn.example.com/x').kind, 'direct');
  assert.equal(classifyUrl('').kind, 'invalid');
  assert.equal(classifyUrl('   ').kind, 'invalid');
  assert.equal(classifyUrl('ftp://example.com/a.mp3').kind, 'invalid');
  assert.equal(classifyUrl('javascript:alert(1)').kind, 'invalid');
  assert.equal(classifyUrl('http://').kind, 'invalid');
  assert.equal(classifyUrl('not a url at all').kind, 'invalid');
  assert.equal(classifyUrl(null).kind, 'invalid');
});

test('2048 chars accepted, 2049 invalid without calling new URL', () => {
  const base = 'https://example.com/';
  const ok = base + 'a'.repeat(2048 - base.length);
  assert.equal(ok.length, 2048);
  assert.equal(classifyUrl(ok).kind, 'direct');
  const RealURL = globalThis.URL;
  let calls = 0;
  globalThis.URL = class extends RealURL { constructor(...a) { calls++; super(...a); } };
  try {
    assert.equal(classifyUrl(ok + 'a').kind, 'invalid');
    assert.equal(calls, 0);
    assert.equal(classifyUrl('').kind, 'invalid');
    assert.equal(calls, 0);
  } finally { globalThis.URL = RealURL; }
});

test('proxy URL construction and filename derivation', () => {
  const u = 'https://example.com/My%20Song.mp3?x=1';
  const p = proxyUrls(u);
  assert.equal(p.length, PROXIES.length);
  // whatever is pinned: a well-formed https URL on the proxy's own host carrying the encoded target, and the filename
  // derivation sees through it to the inner target
  for (let i = 0; i < PROXIES.length; i++) {
    assert.equal(p[i], PROXIES[i].build(u));
    assert.equal(new URL(p[i]).protocol, 'https:');
    assert.equal(new URL(p[i]).hostname, PROXIES[i].host);
    assert.ok(p[i].includes(encodeURIComponent(u)));
    assert.equal(baseNameFromUrl(p[i]), 'My Song');
  }
  // the two known templates (pinned or not) build as expected
  assert.equal(TEST_PROXIES[0].build(u), 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u));
  assert.equal(TEST_PROXIES[1].build(u), 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u));
  assert.equal(baseNameFromUrl(u), 'My Song');
  assert.equal(baseNameFromUrl('https://example.com/bad%E0.mp3'), 'bad%E0');
  assert.equal(baseNameFromUrl('https://example.com/'), 'audio');
  assert.equal(baseNameFromUrl('https://example.com'), 'audio');
  assert.equal(baseNameFromUrl('https://example.com/a/b/track.flac'), 'track');
  assert.equal(baseNameFromUrl('https://example.com/a%3Ab%2Fc%3F.mp3'), 'a_b_c_');
  assert.equal(baseNameFromUrl('https://example.com/noext'), 'noext');
  assert.equal(baseNameFromUrl('https://example.com/archive.tar.gz'), 'archive.tar');
  assert.equal(baseNameFromUrl('not a url'), 'audio');
});

test('with no pinned proxy a failed direct fetch is final: one attempt, URL_FETCH [network] / URL_STATUS', async () => {
  const fetch = makeFetchFake(() => new TypeError('Failed to fetch'));
  const e = await fetchAudioUrl(URL_, { fetch, userSignal: new AbortController().signal, proxies: [] }).then(() => null, (err) => err);
  assert.equal(e.code, 'URL_FETCH');
  assert.deepEqual(e.detail.attempts, ['network']);
  assert.equal(fetch.calls.length, 1);
  const f2 = makeFetchFake(() => ({ status: 403 }));
  const e2 = await fetchAudioUrl(URL_, { fetch: f2, userSignal: new AbortController().signal, proxies: [] }).then(() => null, (err) => err);
  assert.equal(e2.code, 'URL_STATUS');
  assert.equal(e2.detail.status, 403);
  assert.equal(f2.calls.length, 1);
});

test('anySignal forwards either abort', () => {
  const a = new AbortController(), b = new AbortController();
  const s = anySignal(a.signal, b.signal);
  assert.equal(s.aborted, false);
  b.abort('x');
  assert.equal(s.aborted, true);
  const c = new AbortController(); c.abort();
  assert.equal(anySignal(c.signal, new AbortController().signal).aborted, true);
});

// ------------------------------------------------------------------------------------------------------ attempt loop
const URL_ = 'https://example.org/song.mp3';
const run = (fetch, extra = {}) => fetchAudioUrl(URL_, { fetch, userSignal: extra.userSignal ?? new AbortController().signal, proxies: TEST_PROXIES, ...extra });

test('direct CORS error + proxies answering HTML → URL_FETCH with attempts [network, html, html]', async () => {
  const fetch = makeFetchFake((u) => (isProxy(u) ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: new Uint8Array([60]) } : new TypeError('Failed to fetch')));
  const e = await expectCode(run(fetch), 'URL_FETCH');
  assert.deepEqual(e.detail.attempts, ['network', 'html', 'html']);
  assert.equal(fetch.calls.length, 3);
});

test('direct text/html → URL_NOT_AUDIO, no proxy call', async () => {
  const fetch = makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array([60]) }));
  await expectCode(run(fetch), 'URL_NOT_AUDIO');
  assert.equal(fetch.calls.length, 1);
});

test('direct 404 → URL_STATUS 404 immediately, no proxy call; 410 likewise', async () => {
  const fetch = makeFetchFake(() => ({ status: 404 }));
  const e = await expectCode(run(fetch), 'URL_STATUS');
  assert.equal(e.detail.status, 404);
  assert.equal(fetch.calls.length, 1);
  const f2 = makeFetchFake(() => ({ status: 410 }));
  assert.equal((await expectCode(run(f2), 'URL_STATUS')).detail.status, 410);
});

test('direct 403 + both proxies failing → URL_STATUS 403 after three attempts', async () => {
  const fetch = makeFetchFake((u) => (isProxy(u) ? { status: 502 } : { status: 403 }));
  const e = await expectCode(run(fetch), 'URL_STATUS');
  assert.equal(e.detail.status, 403);
  assert.equal(fetch.calls.length, 3);
});

test('direct CORS error + first proxy 2xx audio → success with the proxy bytes', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const fetch = makeFetchFake((u) => (isProxy(u) ? AUDIO(bytes) : new TypeError('cors')));
  const r = await run(fetch);
  assert.equal(fetch.calls.length, 2);
  assert.equal(r.kind, 'proxy');
  assert.deepEqual(r.attempts, ['network']);
  assert.equal(r.blob.size, 3);
  assert.deepEqual(new Uint8Array(await r.blob.arrayBuffer()), bytes);
  assert.equal(r.blob.type, 'audio/mpeg');
  assert.ok(fetch.calls[1].init.mode === 'cors');
});

test('slow body: one 1 MB chunk every 5 s for 90 s → success, no abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chunks = Array.from({ length: 18 }, () => delayed(5000, MB));
  const fetch = makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'audio/wav' }, body: chunks }));
  const progress = [];
  const p = run(fetch, { onProgress: (x) => progress.push(x.received) });
  for (let i = 0; i < 18; i++) { await flush(); t.mock.timers.tick(5000); await flush(); }
  const r = await p;
  assert.equal(r.blob.size, 18 * MB.length);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].cancelled, false);
  assert.equal(progress.length, 18);
  assert.equal(r.blob.type, 'audio/wav');
});

test('stall: body silent for 31 s → reader.cancel(), reason stall, next attempt starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = makeFetchFake((u) => (isProxy(u) ? AUDIO() : { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: [MB, hang()] }));
  const p = run(fetch);
  await flush();
  assert.equal(fetch.calls.length, 1);
  t.mock.timers.tick(STALL_MS + 1000);
  await flush();
  const r = await p;
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].cancelled, true);
  assert.deepEqual(r.attempts, ['stall']);
  assert.equal(r.kind, 'proxy');
});

test('headers timeout: 21 s direct → headers-timeout, proxy attempt; 41 s proxy → headers-timeout again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = makeFetchFake((u, init, n) => (n <= 2 ? headersNever(u, init) : AUDIO()));
  const p = run(fetch);
  await flush();
  assert.equal(fetch.calls.length, 1);
  t.mock.timers.tick(HEADERS_MS.direct - 1000);
  await flush();
  assert.equal(fetch.calls.length, 1, 'not yet');
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(fetch.calls.length, 2, 'proxy attempt started after 21 s');
  t.mock.timers.tick(HEADERS_MS.proxy - 1000);
  await flush();
  assert.equal(fetch.calls.length, 2);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(fetch.calls.length, 3);
  const r = await p;
  assert.deepEqual(r.attempts, ['headers-timeout', 'headers-timeout']);
});

for (const mode of ['AbortSignal.any', 'anySignal']) {
  test(`user abort mid-body → CANCELLED, fetch count unchanged (${mode})`, async () => {
    const user = new AbortController();
    const abortingChunk = () => new Promise(() => { user.abort(); });        // the user presses 取消 while the 3rd chunk is pending
    const fetch = makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: [MB, MB, abortingChunk, MB, MB] }));
    const extra = { userSignal: user.signal };
    if (mode === 'anySignal') extra.abortSignalAny = null;
    await expectCode(run(fetch, extra), 'CANCELLED');
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].reads, 3, 'two chunks delivered, the third read aborted');
    await flush();
    assert.equal(fetch.calls.length, 1, 'no further attempt after the user abort');
    assert.equal(fetch.calls[0].cancelled, true);
  });

  test(`user abort before the first attempt / during headers → CANCELLED (${mode})`, async () => {
    const user = new AbortController();
    const fetch = makeFetchFake((u, init) => { user.abort(); return headersNever(u, init); });
    const extra = { userSignal: user.signal };
    if (mode === 'anySignal') extra.abortSignalAny = null;
    await expectCode(run(fetch, extra), 'CANCELLED');
    assert.equal(fetch.calls.length, 1);
    const pre = new AbortController(); pre.abort();
    const f2 = makeFetchFake(() => AUDIO());
    await expectCode(run(f2, { userSignal: pre.signal }), 'CANCELLED');
    assert.equal(f2.calls.length, 0);
  });
}

test('Content-Length 314572800 → URL_TOO_LARGE before reading the body (zero reads)', async () => {
  const fetch = makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '314572800' }, body: [MB] }));
  const e = await expectCode(run(fetch), 'URL_TOO_LARGE');
  assert.equal(e.detail.bytes, 314572800);
  assert.equal(fetch.calls[0].reads, 0);
  assert.equal(fetch.calls.length, 1);
  assert.equal(CAP, 200 * 1024 * 1024);
});

test('201 MB streamed without Content-Length → URL_TOO_LARGE and the reader cancelled', async () => {
  const body = Array.from({ length: 201 }, () => MB);
  const fetch = makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body }));
  await expectCode(run(fetch), 'URL_TOO_LARGE');
  assert.equal(fetch.calls[0].cancelled, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].reads, 201);
});

test('Blob type: audio/mpeg from the header, "" for application/octet-stream; attempts recorded on success', async () => {
  const a = await run(makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg; charset=binary' }, body: new Uint8Array(10) })));
  assert.equal(a.blob.type, 'audio/mpeg');
  assert.deepEqual(a.attempts, []);
  const b = await run(makeFetchFake(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(10) })));
  assert.equal(b.blob.type, '');
  assert.equal(b.blob.size, 10);
  const c = await run(makeFetchFake(() => ({ status: 200, headers: {}, body: new Uint8Array(10) })));
  assert.equal(c.blob.type, '');
});
