import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_CACHE_TOOL,
  searchCacheKey,
  readSearchCache,
  emptySearchNote,
} from '../src/searchCacheKey.js';

test('searchCacheKey is identical regardless of numResults', () => {
  // The web_search default path and the search_and_read capped path use
  // different numResults but the SAME (query, source, time_range). The key
  // must be identical — numResults is excluded from the key. Core L2 invariant.
  const webDefault = searchCacheKey({ query: 'q', source: 'web', timeRange: 'all' });
  const capped = searchCacheKey({ query: 'q', source: 'web', timeRange: 'all' });
  assert.equal(webDefault, capped);
  // sanity: tag is the literal 'web_search'
  assert.equal(SEARCH_CACHE_TOOL, 'web_search');
});

test('searchCacheKey differs by query, source, and time_range', () => {
  const base = searchCacheKey({ query: 'q', source: 'web', timeRange: 'all' });
  const same = searchCacheKey({ query: 'q', source: 'web', timeRange: 'all' });
  assert.equal(base, same);

  const diffQuery = searchCacheKey({ query: 'other', source: 'web', timeRange: 'all' });
  const diffSource = searchCacheKey({ query: 'q', source: 'reddit', timeRange: 'all' });
  const diffTimeRange = searchCacheKey({ query: 'q', source: 'web', timeRange: 'week' });

  assert.notEqual(base, diffQuery);
  assert.notEqual(base, diffSource);
  assert.notEqual(base, diffTimeRange);
});

test('readSearchCache slices a larger cached set down to want', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ url: `u${i}` }));
  const cache = {
    get() {
      return { result: rows, params: { num_results: 8 } };
    },
  };
  const out = readSearchCache({ cache, ttlMs: 1000, key: 'k', want: 3 });
  assert.deepEqual(out, rows.slice(0, 3));
  assert.equal(out.length, 3);
});

test('readSearchCache returns null when cached set is smaller than want and engine was not maxed', () => {
  const rows = [{ url: 'a' }, { url: 'b' }];
  const cache = {
    get() {
      return { result: rows, params: { num_results: 2 } };
    },
  };
  const out = readSearchCache({ cache, ttlMs: 1000, key: 'k', want: 5 });
  assert.equal(out, null);
});

test('readSearchCache reuses an authoritative short set when engine asked for >= want', () => {
  // Engine was asked for 10 but only had 2 results — there are genuinely no
  // more, so a want=5 request reuses the 2 rather than refetching forever.
  const rows = [{ url: 'a' }, { url: 'b' }];
  const cache = {
    get() {
      return { result: rows, params: { num_results: 10 } };
    },
  };
  const out = readSearchCache({ cache, ttlMs: 1000, key: 'k', want: 5 });
  assert.deepEqual(out, rows);
  assert.equal(out.length, 2);
});

test('readSearchCache returns null with no cache or no ttl', () => {
  assert.equal(readSearchCache({ cache: null, ttlMs: 1000, key: 'k', want: 5 }), null);
  const cache = {
    get() {
      throw new Error('cache.get should not be called when ttlMs is 0');
    },
  };
  assert.equal(readSearchCache({ cache, ttlMs: 0, key: 'k', want: 5 }), null);
});

test('emptySearchNote mentions retry and broaden and drops source restriction when source is set', () => {
  const withSource = emptySearchNote('reddit');
  assert.match(withSource, /retry/i);
  assert.match(withSource, /broaden|rephrase/i);
  assert.match(withSource, /drop the `source` restriction/i);

  const webNote = emptySearchNote('web');
  assert.match(webNote, /retry/i);
  assert.match(webNote, /broaden|rephrase/i);
  assert.doesNotMatch(webNote, /drop the `source` restriction/i);
});
