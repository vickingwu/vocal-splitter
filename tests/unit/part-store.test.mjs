// tests/unit/part-store.test.mjs — FIX-2 R2/R3: the persistent part store (Cache Storage backend over the CacheStorage fake,
// key ↔ URL mapping, prefix listing, IndexedDB fallback after a failing put, reads consulting both backends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCacheStore, createPartStore, fileKey, partKey, PART_SUFFIX_RE } from '../../site/src/engine/part-store.mjs';
import { makeCacheStorageFake, makeStoreFake } from '../lib/fakes.mjs';

const BASE = 'http://localhost/vocal-splitter/';

test('keys: fileKey / partKey shapes and the part-suffix regex', () => {
  assert.equal(fileKey('m', 'ab'.repeat(32)), `m:${'ab'.repeat(32)}`);
  assert.equal(partKey('m', 'ab'.repeat(32), 7), `m:${'ab'.repeat(32)}:part-7`);
  assert.equal(PART_SUFFIX_RE.exec(partKey('m', 'x', 12))[1], '12');
  assert.equal(PART_SUFFIX_RE.test(fileKey('m', 'x')), false);
});

test('cache store: put/get/delete round trip, keys(prefix), URLs under <baseUrl>.vs-store/<encoded key>, one cache name', async () => {
  const caches = makeCacheStorageFake();
  const store = createCacheStore({ caches, baseUrl: BASE });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await store.put('model:sha:part-0', bytes);
  await store.put('model:sha:part-1', new Uint8Array([9]));
  await store.put('other:sha', new Uint8Array([7, 7]));
  assert.deepEqual(await store.get('model:sha:part-0'), bytes);
  assert.equal(await store.get('missing'), null);
  assert.deepEqual((await store.keys('model:sha:part-')).sort(), ['model:sha:part-0', 'model:sha:part-1']);
  assert.deepEqual((await store.keys()).sort(), ['model:sha:part-0', 'model:sha:part-1', 'other:sha']);
  await store.delete('model:sha:part-0');
  assert.equal(await store.get('model:sha:part-0'), null);
  assert.deepEqual([...caches._stores.keys()], ['vs-store']);
  const urls = [...caches._stores.get('vs-store').keys()];
  assert.ok(urls.every((u) => u.startsWith(BASE + '.vs-store/')), urls.join());
  assert.ok(urls.includes(BASE + '.vs-store/' + encodeURIComponent('model:sha:part-1')));
  // a subarray view is stored by value
  const big = new Uint8Array(100).map((_, i) => i);
  await store.put('view', big.subarray(10, 20));
  assert.deepEqual(await store.get('view'), big.slice(10, 20));
});

test('createCacheStore / createIdbStore reject missing globals; createPartStore returns null without any backend', () => {
  assert.throws(() => createCacheStore({ caches: null, baseUrl: BASE }), TypeError);
  assert.throws(() => createCacheStore({ caches: makeCacheStorageFake(), baseUrl: 'http://localhost/no-slash' }), TypeError);
  assert.equal(createPartStore({ caches: null, indexedDB: null, baseUrl: BASE }), null);
});

test('part store: Cache Storage first; a failing put switches to the second backend for the session, warned once; reads consult both', async () => {
  const caches = makeCacheStorageFake({ fail: { put: { name: 'QuotaExceededError' } } });
  const warns = [];
  // the IndexedDB backend is replaced by an in-memory fake through a private hook-free path: build the store, then swap
  const store = createPartStore({ caches, indexedDB: null, baseUrl: BASE, warn: (...a) => warns.push(a) });
  assert.equal(store.name, 'cache');
  assert.equal(await store.put('k', new Uint8Array([1])), false, 'no second backend → put reports false');
  assert.equal(warns.length, 1);
  assert.equal(store.name, 'none');
  assert.equal(await store.put('k2', new Uint8Array([1])), false);
  assert.equal(warns.length, 1, 'warned once');
  assert.equal(await store.get('k'), null);
});

test('part store with a working primary: name cache, puts land in Cache Storage, keys/get/delete through the facade', async () => {
  const caches = makeCacheStorageFake();
  const store = createPartStore({ caches, indexedDB: null, baseUrl: BASE });
  assert.equal(store.name, 'cache');
  assert.equal(await store.put('a:b:part-0', new Uint8Array([1, 2])), true);
  assert.deepEqual(await store.get('a:b:part-0'), new Uint8Array([1, 2]));
  assert.deepEqual(await store.keys('a:b:'), ['a:b:part-0']);
  await store.delete('a:b:part-0');
  assert.deepEqual(await store.keys('a:b:'), []);
});

test('two backends (injected): the first failing put demotes to the second for the rest of the session, warned once; reads and keys see both; failures in a backend never throw', async () => {
  const primary = makeStoreFake({ name: 'cache' });
  await primary.put('held', new Uint8Array([5]));
  primary._map.set('held', new Uint8Array([5]));
  const failing = makeStoreFake({ name: 'cache', failPutTimes: 1, initial: primary._map });
  const secondary = makeStoreFake({ name: 'idb' });
  const warns = [];
  const store = createPartStore({ backends: [failing, secondary], warn: (...a) => warns.push(a) });
  assert.equal(store.name, 'cache');
  assert.equal(await store.put('x', new Uint8Array([1])), true, 'the retry on the second backend succeeds');
  assert.equal(store.name, 'idb');
  assert.equal(warns.length, 1);
  assert.ok(secondary._map.has('x') && !failing._map.has('x'));
  assert.equal(await store.put('y', new Uint8Array([2])), true);
  assert.equal(warns.length, 1, 'warned once');
  assert.ok(secondary._map.has('y'));
  assert.deepEqual(await store.get('held'), new Uint8Array([5]), 'reads still see the demoted backend');
  assert.deepEqual((await store.keys()).sort(), ['held', 'x', 'y']);
  await store.delete('held');
  assert.equal(await store.get('held'), null);
  // a backend whose get/keys throw is skipped, not fatal
  const broken = createPartStore({ backends: [makeStoreFake({ fail: { get: {}, keys: {} } }), makeStoreFake({ initial: [['k', new Uint8Array([3])]] })], warn: () => {} });
  assert.deepEqual(await broken.get('k'), new Uint8Array([3]));
  assert.deepEqual(await broken.keys(), ['k']);
  // second backend also failing → put reports false, store name none
  const dead = createPartStore({ backends: [makeStoreFake({ fail: { put: {} } }), makeStoreFake({ fail: { put: {} } })], warn: () => {} });
  assert.equal(await dead.put('k', new Uint8Array(1)), false);
  assert.equal(dead.name, 'none');
});
