// tests/unit/wake.test.mjs — design §22.5 wake-lock wrapper (§16.A row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from '../../site/src/ui/wake.mjs';

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) { listeners.set(type, fn); },
    fire(type) { const fn = listeners.get(type); if (fn) fn({ type }); },
  };
}

function fakeNavigator({ reject = false } = {}) {
  const requests = [];
  const sentinels = [];
  return {
    requests, sentinels,
    wakeLock: {
      async request(kind) {
        requests.push(kind);
        if (reject) { const e = new Error('not allowed'); e.name = 'NotAllowedError'; throw e; }
        const s = { released: 0, release: async function () { this.released++; }, addEventListener() {} };
        sentinels.push(s);
        return s;
      },
    },
  };
}

test('acquire stores the sentinel; release calls sentinel.release()', async () => {
  const nav = fakeNavigator();
  const doc = fakeDocument();
  const w = createWakeLock({ navigatorLike: nav, documentLike: doc });
  assert.equal(await w.acquire(), 'acquired');
  assert.deepEqual(nav.requests, ['screen']);
  assert.equal(nav.sentinels.length, 1);
  assert.equal(w.status, 'acquired');
  await w.release();
  assert.equal(nav.sentinels[0].released, 1);
  assert.equal(w.status, 'released');
  assert.equal(w.active, false);
});

test('visibilitychange → visible while active re-requests the lock; not after release', async () => {
  const nav = fakeNavigator();
  const doc = fakeDocument();
  const w = createWakeLock({ navigatorLike: nav, documentLike: doc });
  await w.acquire();
  // the browser released the lock on hide: simulate by firing the sentinel's release via a hidden/visible cycle
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  assert.equal(nav.requests.length, 1);
  // sentinel gone (browser released it), tab visible again → request again
  nav.sentinels[0].release();
  await w.release();                 // simulate the UA dropping it: our wrapper now has no sentinel but we re-activate
  await w.acquire();
  assert.equal(nav.requests.length, 2);
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');      // sentinel present → no extra request
  await new Promise((r) => setImmediate(r));
  assert.equal(nav.requests.length, 2);
  await w.release();
  doc.fire('visibilitychange');      // inactive → nothing
  await new Promise((r) => setImmediate(r));
  assert.equal(nav.requests.length, 2);
});

test('visible while active and the sentinel was dropped → request again', async () => {
  const nav = fakeNavigator();
  const doc = fakeDocument();
  let dropRelease = null;
  nav.wakeLock.request = async (kind) => {
    nav.requests.push(kind);
    const s = { released: 0, release: async function () { this.released++; }, addEventListener(type, fn) { if (type === 'release') dropRelease = fn; } };
    nav.sentinels.push(s);
    return s;
  };
  const w = createWakeLock({ navigatorLike: nav, documentLike: doc });
  await w.acquire();
  assert.equal(nav.requests.length, 1);
  dropRelease();                     // the UA released the lock when the tab was hidden
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  await new Promise((r) => setImmediate(r));
  assert.equal(nav.requests.length, 2);
});

test('request rejecting (NotAllowedError) → status rejected, no throw', async () => {
  const nav = fakeNavigator({ reject: true });
  const w = createWakeLock({ navigatorLike: nav, documentLike: fakeDocument() });
  assert.equal(await w.acquire(), 'rejected');
  assert.equal(w.status, 'rejected');
  await w.release();
});

test('navigator.wakeLock undefined → status unsupported', async () => {
  const w = createWakeLock({ navigatorLike: {}, documentLike: fakeDocument() });
  assert.equal(await w.acquire(), 'unsupported');
  assert.equal(w.status, 'unsupported');
  await w.release();
  const w2 = createWakeLock({});
  assert.equal(await w2.acquire(), 'unsupported');
});
