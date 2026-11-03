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
  USERNAME, ITERATIONS, SALT_HEX, HASH_HEX, SESSION_KEY,
  deriveHex, constantTimeEqualHex, verifyCredentials, newSessionToken, hasSession, storeSession, clearSession,
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

test('hasSession: valid / malformed / absent / throwing storage; store + clear', (t) => {
  t.mock.method(console, 'warn', () => {}); // storeSession warns on a throwing storage (by design)
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: 'f'.repeat(64) })), true);
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: 'F'.repeat(64) })), false);
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: 'f'.repeat(63) })), false);
  assert.equal(hasSession(memStorage({ [SESSION_KEY]: 'not-hex' })), false);
  assert.equal(hasSession(memStorage()), false);
  assert.equal(hasSession({ getItem() { throw new Error('SecurityError'); } }), false);

  const s = memStorage();
  storeSession(s, 'a'.repeat(64));
  assert.equal(hasSession(s), true);
  clearSession(s);
  assert.equal(hasSession(s), false);
  // throwing setItem / removeItem must not throw out
  assert.doesNotThrow(() => storeSession({ setItem() { throw new Error('quota'); } }, 'x'));
  assert.doesNotThrow(() => clearSession({ removeItem() { throw new Error('nope'); } }));
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
