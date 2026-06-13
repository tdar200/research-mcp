import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';

function tmpDb(tag) {
  const p = join(tmpdir(), `research-mcp-cache-v07-${tag}-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(p + s)) unlinkSync(p + s); } catch { /* ignore */ } }
  return p;
}
const HUGE = 1e15;

test('Cache.prune deletes rows older than maxAgeMs using the injectable now', () => {
  let now = 0;
  const cache = new Cache({ dbPath: tmpDb('age'), now: () => now, maxAgeMs: 10_000, pruneOnStart: false });
  cache.set({ tool: 'fetch_url', cacheKey: 'k1', query: 'q', params: {}, result: { v: 1 } });
  now = 20_000;
  const r = cache.prune();
  assert.ok(r.byAge >= 1);
  assert.equal(cache.get({ cacheKey: 'k1', ttlMs: HUGE }), null);
  cache.close();
});

test('Cache.prune trims to maxRows keeping the newest', () => {
  let now = 0;
  const cache = new Cache({ dbPath: tmpDb('cap'), now: () => now, maxRows: 3, pruneOnStart: false, pruneEveryWrites: 0 });
  for (let i = 1; i <= 5; i++) {
    now = i * 1000;
    cache.set({ tool: 'fetch_url', cacheKey: `k${i}`, query: 'q', params: {}, result: { n: i } });
  }
  const r = cache.prune();
  assert.equal(r.remaining, 3);
  assert.equal(cache.get({ cacheKey: 'k1', ttlMs: HUGE }), null);
  assert.equal(cache.get({ cacheKey: 'k2', ttlMs: HUGE }), null);
  assert.ok(cache.get({ cacheKey: 'k5', ttlMs: HUGE }));
  cache.close();
});

test('Cache auto-prunes every pruneEveryWrites writes', () => {
  let now = 0;
  const cache = new Cache({ dbPath: tmpDb('auto'), now: () => now, maxRows: 1, pruneEveryWrites: 2, pruneOnStart: false });
  now = 1000; cache.set({ tool: 'fetch_url', cacheKey: 'a', query: 'q', params: {}, result: {} });
  now = 2000; cache.set({ tool: 'fetch_url', cacheKey: 'b', query: 'q', params: {}, result: {} }); // 2nd write -> auto-prune to 1
  assert.equal(cache._countRows.get().n, 1);
  assert.ok(cache.get({ cacheKey: 'b', ttlMs: HUGE }), 'newest survives');
  assert.equal(cache.get({ cacheKey: 'a', ttlMs: HUGE }), null, 'oldest evicted');
  cache.close();
});

test('Cache pruneOnStart evicts stale rows on construction', () => {
  const db = tmpDb('start');
  let now = 0;
  const c1 = new Cache({ dbPath: db, now: () => now, pruneOnStart: false });
  c1.set({ tool: 'fetch_url', cacheKey: 'old', query: 'q', params: {}, result: {} }); // created_at 0
  c1.close();
  now = 100 * 24 * 3600 * 1000; // 100 days later
  const c2 = new Cache({ dbPath: db, now: () => now, maxAgeMs: 30 * 24 * 3600 * 1000, pruneOnStart: true });
  assert.equal(c2.get({ cacheKey: 'old', ttlMs: HUGE }), null);
  c2.close();
});

test('default-constructed Cache does not evict small datasets', () => {
  let now = 1000;
  const cache = new Cache({ dbPath: tmpDb('default'), now: () => now });
  for (let i = 0; i < 10; i++) cache.set({ tool: 'fetch_url', cacheKey: `d${i}`, query: 'q', params: {}, result: { i } });
  assert.equal(cache._countRows.get().n, 10);
  assert.ok(cache.get({ cacheKey: 'd0', ttlMs: HUGE }));
  cache.close();
});
