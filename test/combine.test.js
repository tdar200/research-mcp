import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searchAndRead } from '../src/combine.js';

test('searchAndRead returns enriched results for top-N', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.example.com', snippet: 'snip A' },
    { title: 'B', url: 'https://b.example.com', snippet: 'snip B' },
    { title: 'C', url: 'https://c.example.com', snippet: 'snip C' },
  ]);

  const fakeFetch = mock.fn(async (url) => ({
    url,
    title: `Title of ${url}`,
    content: `Content from ${url}`,
    truncated: false,
  }));

  const out = await searchAndRead('test query', {
    numResults: 3,
    maxCharsPerResult: 1000,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
  });

  assert.equal(out.query, 'test query');
  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].title, 'A');
  assert.equal(out.results[0].snippet, 'snip A');
  assert.equal(out.results[0].content, 'Content from https://a.example.com');
  assert.equal(fakeSearch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls.length, 3);
});

test('searchAndRead handles partial fetch failure gracefully', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.example.com', snippet: 'a' },
    { title: 'B', url: 'https://b.example.com', snippet: 'b' },
  ]);

  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('b.example')) {
      return { url, title: null, content: null, truncated: false, error: 'rate limit (429)' };
    }
    return { url, title: 'A', content: 'A body', truncated: false };
  });

  const out = await searchAndRead('q', {
    numResults: 2,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
  });

  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].content, 'A body');
  assert.equal(out.results[1].content, null);
  assert.match(out.results[1].error, /rate limit/);
});

test('searchAndRead returns empty results array when search returns none', async () => {
  const fakeSearch = mock.fn(async () => []);
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });

  const out = await searchAndRead('q', { searchImpl: fakeSearch, fetchImpl: fakeFetch });

  assert.deepEqual(out.results, []);
  assert.equal(fakeFetch.mock.calls.length, 0);
});

test('searchAndRead caps numResults at 10', async () => {
  const fakeSearch = mock.fn(async (q, n) => {
    assert.equal(n, 10, 'search should be called with capped value');
    return [];
  });
  const fakeFetch = mock.fn(async () => ({}));

  await searchAndRead('q', { numResults: 99, searchImpl: fakeSearch, fetchImpl: fakeFetch });
});

test('searchAndRead caches the combined result and returns it on hit', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.test', snippet: 's' },
  ]);
  const fakeFetch = mock.fn(async (url) => ({
    url, title: 'A', content: 'A body', truncated: false,
  }));

  let storedResult = null;
  const fakeCache = {
    get: mock.fn(() => storedResult ? { result: storedResult } : null),
    set: mock.fn((entry) => { storedResult = entry.result; }),
  };

  const out1 = await searchAndRead('q', {
    numResults: 1,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(out1.results[0].content, 'A body');
  assert.equal(fakeSearch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'search_and_read');

  const out2 = await searchAndRead('q', {
    numResults: 1,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.deepEqual(out2, out1);
  assert.equal(fakeSearch.mock.calls.length, 1, 'should not search again');
  assert.equal(fakeFetch.mock.calls.length, 1, 'should not fetch again');
});

test('searchAndRead does not cache if any result has an error', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.test', snippet: 'a' },
    { title: 'B', url: 'https://b.test', snippet: 'b' },
  ]);
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('b.test')) return { url, content: null, truncated: false, error: 'oops' };
    return { url, content: 'ok', truncated: false };
  });

  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };

  await searchAndRead('q', {
    numResults: 2,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 0, 'partial failures should not be cached');
});
