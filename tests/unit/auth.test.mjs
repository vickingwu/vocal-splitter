// tests/unit/auth.test.mjs — design §16.A row `auth.test.mjs` / §23.6.
// The real-password cases run only when VS_TEST_PASS is set (never printed); otherwise they are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USERNAME, ITERATIONS, SALT_HEX, HASH_HEX, SESSION_KEY, SESSION_MAX_AGE_MS,
  deriveHex, constantTimeEqualHex, verifyCredentials, newSessionToken, hasSession, storeSession, clearSession, parseSession,
} from '../../site/auth.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = process.env.VS_TEST_PASS;

function countingSubtle() {
  const calls = { importKey: 0, deriveBits: 0 };
  return {
    calls,
    async importKey() { calls.importKey++; return {}; },
    async deriveBits() { calls.deriveBits++; return new ArrayBuffer(32); },
  };
}

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('constants are well-formed', () => {
  assert.match(SALT_HEX, /^[0-9a-f]{32}$/);
  assert.match(HASH_HEX, /^[0-9a-f]{64}$/);
  assert.ok(ITERATIONS >= 200000);
  assert.equal(USERNAME, 'MQ');
  assert.equal(SESSION_KEY, 'vs-session');
});

test('deriveHex equals Node pbkdf2Sync on a throwaway string (1000 iterations)', async () => {
  const ours = await deriveHex('throwaway-string', SALT_HEX, 1000);
  const node = pbkdf2Sync('throwaway-string', Buffer.from(SALT_HEX, 'hex'), 1000, 32, 'sha256').toString('hex');
  assert.equal(ours, node);
});

test('constantTimeEqualHex truth table', () => {
  assert.equal(constantTimeEqualHex('', ''), true);
  assert.equal(constantTimeEqualHex('abcd', 'abcd'), true);
  assert.equal(constantTimeEqualHex('abcd', 'abce'), false);
  assert.equal(constantTimeEqualHex('abcd', 'abc'), false);
  assert.equal(constantTimeEqualHex('abc', 'abcd'), false);
  assert.equal(constantTimeEqualHex('', 'a'), false);
  assert.equal(constantTimeEqualHex(HASH_HEX, HASH_HEX), true);
  assert.equal(constantTimeEqualHex(HASH_HEX, HASH_HEX.slice(0, 63) + (HASH_HEX.endsWith('0') ? '1' : '0')), false);
});

test('username / password rules reject obvious wrong input', async () => {
  assert.equal(await verifyCredentials('mq ', 'x'), false);
  assert.equal(await verifyCredentials('MQ', ''), false);
  assert.equal(await verifyCredentials(undefined, 'x'), false);
  assert.equal(await verifyCredentials('MQ', null), false);
  assert.equal(await verifyCredentials(42, 'x'), false);
});

test('DA-3: a 257-char password is refused before any derivation; a wrong user still costs one derivation', async () => {
  const fake = countingSubtle();
  assert.equal(await verifyCredentials('MQ', 'a'.repeat(257), fake), false);
  assert.equal(fake.calls.deriveBits, 0);
  assert.equal(fake.calls.importKey, 0);

  const fake2 = countingSubtle();
  assert.equal(await verifyCredentials('MX', 'whatever', fake2), false);
  assert.equal(fake2.calls.deriveBits, 1);

  const fake3 = countingSubtle();
  assert.equal(await verifyCredentials('MQ', 'a'.repeat(256), fake3), false);
  assert.equal(fake3.calls.deriveBits, 1);
});

test('newSessionToken is 64 lowercase hex and unique', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  const fixed = newSessionToken((arr) => { arr.fill(0xab); return arr; });
  assert.equal(fixed, 'ab'.repeat(32));
});

const entry = (token, issuedAt) => JSON.stringify({ token, issuedAt });
const DAY = 24 * 3600 * 1000;

test('hasSession: valid / malformed / absent / throwing storage; store + clear', (t) => {
  t.mock.method(console, 'warn', () => {}); // storeSession warns on a throwing storage (by design)
  const now = 1_800_000_000_000;
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: entry('f'.repeat(64), now) }), now), true);
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: entry('F'.repeat(64), now) }), now), false, 'uppercase hex is not a token');
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: entry('f'.repeat(63), now) }), now), false);
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: entry('f'.repeat(64), 'yesterday') }), now), false, 'issuedAt must be a number');
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: 'not-hex' })), false);
  assert.equal(hasSession(memStorage()), false);
  assert.equal(hasSession({ getItem() { throw new Error('SecurityError'); } }), false);

  const s = memStorage();
  storeSession(s, 'a'.repeat(64), now);
  assert.deepEqual(JSON.parse(s.map.get(SESSION_KEY)), { token: 'a'.repeat(64), issuedAt: now });
  assert.equal(hasSession(s, now), true);
  assert.equal(hasSession(s), true, 'a session stored at the (real) current time is valid now');
  clearSession(s);
  assert.equal(hasSession(s, now), false);
  // throwing setItem / removeItem must not throw out
  assert.doesNotThrow(() => storeSession({ setItem() { throw new Error('quota'); } }, 'x'));
  assert.doesNotThrow(() => clearSession({ removeItem() { throw new Error('nope'); } }));
});

test('7-day expiry: fresh valid, 6 d 23 h valid, 7 d + 1 ms invalid and removed, legacy plain token invalid and removed, malformed JSON invalid', () => {
  assert.equal(SESSION_MAX_AGE_MS, 7 * DAY);
  const issued = 1_800_000_000_000;
  const tok = 'b'.repeat(64);
  const fresh = memStorage({ [SESSION_KEY]: entry(tok, issued) });
  assert.equal(hasSession(fresh, issued), true);
  assert.equal(hasSession(fresh, issued + 1), true);
  assert.ok(fresh.map.has(SESSION_KEY));
  const almost = memStorage({ [SESSION_KEY]: entry(tok, issued) });
  assert.equal(hasSession(almost, issued + 6 * DAY + 23 * 3600 * 1000), true, '6 d 23 h');
  assert.equal(hasSession(almost, issued + 7 * DAY - 1), true, '1 ms before the limit');
  assert.ok(almost.map.has(SESSION_KEY));
  const expired = memStorage({ [SESSION_KEY]: entry(tok, issued) });
  assert.equal(hasSession(expired, issued + 7 * DAY), false, 'exactly 7 d is expired (strict <)');
  assert.equal(expired.map.has(SESSION_KEY), false, 'an expired entry is removed');
  const expired2 = memStorage({ [SESSION_KEY]: entry(tok, issued) });
  assert.equal(hasSession(expired2, issued + 7 * DAY + 1), false, '7 d + 1 ms');
  assert.equal(expired2.map.has(SESSION_KEY), false);
  // no refresh on a visit: a check at day 3 does not move the expiry
  const noRefresh = memStorage({ [SESSION_KEY]: entry(tok, issued) });
  assert.equal(hasSession(noRefresh, issued + 3 * DAY), true);
  assert.equal(noRefresh.map.get(SESSION_KEY), entry(tok, issued), 'issuedAt unchanged after a visit');
  assert.equal(hasSession(noRefresh, issued + 7 * DAY + 1), false);
  // legacy: the plain 64-hex token of earlier builds (no timestamp) → not logged in, removed
  const legacy = memStorage({ [SESSION_KEY]: tok });
  assert.equal(hasSession(legacy, issued), false);
  assert.equal(legacy.map.has(SESSION_KEY), false, 'the legacy entry is removed');
  // malformed
  for (const raw of ['{', '{"token":1,"issuedAt":2}', '[]', 'null', '{"token":"' + tok + '"}', '{"issuedAt":' + issued + '}', '{"token":"' + tok + '","issuedAt":"' + issued + '"}', '{"token":"' + tok + '","issuedAt":null}']) {
    const m = memStorage({ [SESSION_KEY]: raw });
    assert.equal(hasSession(m, issued), false, `malformed ${raw}`);
    assert.equal(m.map.has(SESSION_KEY), false, `malformed ${raw} removed`);
    assert.equal(parseSession(raw), null, `parseSession(${raw})`);
  }
  assert.deepEqual(parseSession(entry(tok, issued)), { token: tok, issuedAt: issued });
  assert.equal(parseSession(entry(tok, issued) + 'x'.repeat(300)), null, 'over-long raw value');
  // a removal that throws does not throw out of hasSession
  assert.equal(hasSession({ getItem: () => tok, removeItem() { throw new Error('nope'); } }, issued), false);
});

test('real credentials: positives', { skip: PW ? false : 'VS_TEST_PASS not set' }, async () => {
  assert.equal(await verifyCredentials('MQ', PW), true);
  assert.equal(await verifyCredentials('mq', PW), true);
  assert.equal(await verifyCredentials(' MQ ', PW), true);
});

test('real credentials: negatives', { skip: PW ? false : 'VS_TEST_PASS not set' }, async () => {
  assert.equal(await verifyCredentials('MQ', PW + 'x'), false);
  if (PW.toLowerCase() !== PW) assert.equal(await verifyCredentials('MQ', PW.toLowerCase()), false);
  assert.equal(await verifyCredentials('MX', PW), false);
  assert.equal(await verifyCredentials('MQ', PW.slice(0, -1)), false);
});

test('plaintext scan: the password appears in no tracked file and no commit message', { skip: PW ? false : 'VS_TEST_PASS not set' }, () => {
  const needle = Buffer.from(PW, 'utf8');
  // tracked files plus untracked-but-not-ignored ones (what the next commit would add)
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const files = [...new Set(list.split('\0').filter(Boolean))];
  assert.ok(files.length > 0, 'git ls-files returned nothing');
  const hits = [];
  for (const f of files) {
    const bytes = readFileSync(join(repoRoot, f));
    if (bytes.includes(needle)) hits.push(f);
  }
  assert.deepEqual(hits, [], 'tracked files containing the plaintext password');

  let log = '';
  try {
    log = execFileSync('git', ['log', '--all', '--format=%B'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (!/does not have any commits yet/.test(msg)) throw e;
  }
  assert.equal(log.includes(PW), false, 'a commit message contains the plaintext password');
});
