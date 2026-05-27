import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../src/cache.js';

const TEST_DB = join(tmpdir(), `research-mcp-test-${process.pid}.db`);

function freshCache(now = () => Date.now()) {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new Cache({ dbPath: TEST_DB, now });
}

test('Cache.set then Cache.get within TTL returns stored result', () => {
  const cache = freshCache();
  const key = 'abc123';
  cache.set({
    tool: 'web_search',
    cacheKey: key,
    query: 'foo',
    params: { num_results: 5 },
    result: { query: 'foo', results: [{ title: 't', url: 'https://x.test', snippet: 's' }] },
  });

  const hit = cache.get({ cacheKey: key, ttlMs: 60_000 });
  assert.ok(hit, 'expected cache hit');
  assert.equal(hit.tool, 'web_search');
  assert.equal(hit.result.query, 'foo');
  assert.equal(hit.result.results[0].title, 't');
});

test('Cache.get past TTL returns null', () => {
  let nowMs = 1_000_000;
  const cache = freshCache(() => nowMs);

  cache.set({
    tool: 'fetch_url',
    cacheKey: 'x',
    query: 'https://x.test',
    params: { max_chars: 1000 },
    result: { url: 'https://x.test', content: 'hi' },
  });

  nowMs += 10_000;
  assert.ok(cache.get({ cacheKey: 'x', ttlMs: 60_000 }), 'within TTL → hit');

  nowMs += 60_000;
  assert.equal(cache.get({ cacheKey: 'x', ttlMs: 60_000 }), null, 'past TTL → miss');
});

test('Cache.get with ttlMs=0 always returns null (caching disabled)', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q', params: {}, result: { ok: true } });
  assert.equal(cache.get({ cacheKey: 'k', ttlMs: 0 }), null);
});

test('Cache.set with same cache_key overwrites (INSERT OR REPLACE)', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q1', params: {}, result: { v: 1 } });
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q2', params: {}, result: { v: 2 } });

  const hit = cache.get({ cacheKey: 'k', ttlMs: 60_000 });
  assert.equal(hit.query, 'q2');
  assert.equal(hit.result.v, 2);
});

test('Cache.list returns metadata only, newest first', () => {
  let nowMs = 1_000_000;
  const cache = freshCache(() => nowMs);

  cache.set({ tool: 'web_search', cacheKey: 'a', query: 'q1', params: {}, result: { x: 1 } });
  nowMs += 1000;
  cache.set({ tool: 'fetch_url', cacheKey: 'b', query: 'https://b.test', params: {}, result: { x: 2 } });
  nowMs += 1000;
  cache.set({ tool: 'web_search', cacheKey: 'c', query: 'q3', params: {}, result: { x: 3 } });

  const entries = cache.list({ limit: 10 });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].query, 'q3', 'newest first');
  assert.equal(entries[2].query, 'q1', 'oldest last');
  for (const e of entries) {
    assert.ok(typeof e.id === 'number');
    assert.ok(typeof e.created_at_iso === 'string');
    assert.ok(typeof e.age_hours === 'number');
    assert.equal(e.result, undefined, 'list must not include result_json');
  }
});

test('Cache.list with tool_filter only returns matching rows', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'a', query: 'q1', params: {}, result: {} });
  cache.set({ tool: 'fetch_url', cacheKey: 'b', query: 'https://x', params: {}, result: {} });
  cache.set({ tool: 'web_search', cacheKey: 'c', query: 'q3', params: {}, result: {} });

  const entries = cache.list({ limit: 10, toolFilter: 'web_search' });
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e => e.tool === 'web_search'));
});

test('Cache.list respects limit', () => {
  const cache = freshCache();
  for (let i = 0; i < 5; i++) {
    cache.set({ tool: 'web_search', cacheKey: `k${i}`, query: `q${i}`, params: {}, result: {} });
  }
  assert.equal(cache.list({ limit: 3 }).length, 3);
});

test('Cache.getById returns full entry with parsed JSON', () => {
  const cache = freshCache();
  cache.set({
    tool: 'search_and_read',
    cacheKey: 'k',
    query: 'q',
    params: { num_results: 2 },
    result: { query: 'q', results: [{ title: 'T', url: 'https://u', content: 'C' }] },
  });

  const entry = cache.list({ limit: 1 })[0];
  const full = cache.getById(entry.id);

  assert.ok(full);
  assert.equal(full.tool, 'search_and_read');
  assert.equal(full.query, 'q');
  assert.deepEqual(full.params, { num_results: 2 });
  assert.equal(full.result.results[0].title, 'T');
});

test('Cache.getById returns null for unknown id', () => {
  const cache = freshCache();
  assert.equal(cache.getById(999), null);
});

test('Cache initializes schema on first construction (no file yet)', () => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const cache = new Cache({ dbPath: TEST_DB });
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q', params: {}, result: { ok: true } });
  assert.ok(existsSync(TEST_DB));
});
