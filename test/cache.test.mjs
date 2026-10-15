// test/cache.test.mjs
//
// §48.5: cached content is shown labelled, with its age, never as live. The label is the
// feature — a cache that silently serves yesterday's feed as today's is the failure mode
// this is here to prevent.
//
//   node --test test/cache.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cached, staleLabel, ageText, TTL_MS, setStorage } = require('../cache.js');

const NOW = Date.UTC(2026, 9, 15, 20, 0, 0);

function fakeStorage(initial = {}) {
  const box = { ...initial };
  return {
    get: async (k) => (k in box ? { [k]: box[k] } : {}),
    set: async (o) => void Object.assign(box, o),
    _box: box,
  };
}

let store;
let loaderCalls;

beforeEach(() => {
  store = fakeStorage();
  setStorage(store);
  loaderCalls = 0;
});

test('a cold cache with a working loader stores and returns fresh data', async () => {
  const out = await cached('feed', async () => { loaderCalls++; return { works: [1, 2] }; }, NOW);
  assert.deepEqual(out, { data: { works: [1, 2] }, at: NOW, stale: false });
  assert.equal(loaderCalls, 1);
  assert.equal(staleLabel(out, NOW), null, 'fresh data is not labelled as cached');
});

test('a warm cache inside the TTL does not call the loader at all', async () => {
  store = fakeStorage({ feed: { data: { works: [1] }, at: NOW - 59 * 60 * 1000 } });
  setStorage(store);
  const out = await cached('feed', async () => { loaderCalls++; return { works: [9] }; }, NOW);
  assert.equal(loaderCalls, 0, 'the point of a cache is not calling the loader');
  assert.equal(out.stale, false);
  assert.deepEqual(out.data, { works: [1] });
});

test('the TTL boundary is exact: at TTL_MS old it reloads, one ms inside it does not', async () => {
  store = fakeStorage({ feed: { data: { works: [1] }, at: NOW - TTL_MS } });
  setStorage(store);
  let out = await cached('feed', async () => { loaderCalls++; return { works: [9] }; }, NOW);
  assert.equal(loaderCalls, 1, 'exactly TTL_MS old is stale');

  store = fakeStorage({ feed: { data: { works: [1] }, at: NOW - TTL_MS + 1 } });
  setStorage(store);
  loaderCalls = 0;
  out = await cached('feed', async () => { loaderCalls++; return { works: [9] }; }, NOW);
  assert.equal(loaderCalls, 0, 'one millisecond inside the TTL is still fresh');
});

test('61 minutes old is reloaded', async () => {
  store = fakeStorage({ feed: { data: { works: [1] }, at: NOW - 61 * 60 * 1000 } });
  setStorage(store);
  const out = await cached('feed', async () => { loaderCalls++; return { works: [9] }; }, NOW);
  assert.equal(loaderCalls, 1);
  assert.deepEqual(out.data, { works: [9] });
  assert.equal(out.stale, false);
});

test('a failed reload serves the old copy LABELLED with its age (§48.5)', async () => {
  const threeHoursAgo = NOW - 3 * 60 * 60 * 1000;
  store = fakeStorage({ feed: { data: { works: [1] }, at: threeHoursAgo } });
  setStorage(store);
  const out = await cached('feed', async () => { throw new Error('server down'); }, NOW);
  assert.equal(out.stale, true, 'a served copy that is not live must say so');
  assert.equal(out.at, threeHoursAgo, 'the age shown must be the fetch time, not now');
  assert.deepEqual(out.data, { works: [1] });
  assert.equal(staleLabel(out, NOW), 'cached 3 h ago');
});

test('a failed load with nothing cached throws — an empty feed is not a cache hit', async () => {
  await assert.rejects(() => cached('feed', async () => { throw new Error('server down'); }, NOW),
    /server down/);
});

test('age text is whole units, and the label is null when the data is live', () => {
  assert.equal(ageText(NOW - 30 * 1000, NOW), '30 s');
  assert.equal(ageText(NOW - 5 * 60 * 1000, NOW), '5 min');
  assert.equal(ageText(NOW - 90 * 60 * 1000, NOW), '1 h');
  assert.equal(ageText(NOW - 50 * 60 * 60 * 1000, NOW), '2 d');
  assert.equal(staleLabel({ stale: false, at: NOW }, NOW), null);
  assert.equal(TTL_MS, 60 * 60 * 1000);
});
