import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searxngSearch, isSearxngReachable } from '../src/searxng.js';

function mockFetchOk(body) {
  return mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function mockFetchFail(status = 500) {
  return mock.fn(async () => ({
    ok: false, status, statusText: 'Error',
    text: async () => '',
  }));
}

test('searxngSearch returns normalized results from JSON response', async () => {
  const fakeFetch = mockFetchOk({
    query: 'foo',
    results: [
      { title: 'A', url: 'https://a.test', content: 'snippet A', engine: 'google' },
      { title: 'B', url: 'https://b.test', content: 'snippet B', engine: 'bing' },
      { title: 'C', url: 'https://c.test', content: 'snippet C', engine: 'brave' },
    ],
  });
  const results = await searxngSearch('foo', 5, { fetchImpl: fakeFetch });
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { title: 'A', url: 'https://a.test', snippet: 'snippet A' });
  const calledUrl = fakeFetch.mock.calls[0].arguments[0];
  assert.match(calledUrl, /\/search\?q=foo&format=json/);
});

test('searxngSearch respects num_results limit', async () => {
  const fakeFetch = mockFetchOk({
    results: Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, url: `https://${i}.test`, content: `s${i}` })),
  });
  const results = await searxngSearch('foo', 3, { fetchImpl: fakeFetch });
  assert.equal(results.length, 3);
});

test('searxngSearch handles results without content field', async () => {
  const fakeFetch = mockFetchOk({
    results: [{ title: 'A', url: 'https://a.test' }],
  });
  const results = await searxngSearch('foo', 5, { fetchImpl: fakeFetch });
  assert.equal(results[0].snippet, '');
});

test('searxngSearch throws on non-200 response', async () => {
  const fakeFetch = mockFetchFail(503);
  await assert.rejects(
    () => searxngSearch('foo', 5, { fetchImpl: fakeFetch }),
    /SearXNG returned 503/
  );
});

test('searxngSearch uses custom baseUrl', async () => {
  const fakeFetch = mockFetchOk({ results: [] });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, baseUrl: 'http://elsewhere:9999' });
  const calledUrl = fakeFetch.mock.calls[0].arguments[0];
  assert.match(calledUrl, /^http:\/\/elsewhere:9999\//);
});

test('searxngSearch uses cache on hit', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeCache = {
    get: mock.fn(() => ({ result: [{ title: 'Cached', url: 'https://x', snippet: 's' }] })),
    set: mock.fn(),
  };
  const results = await searxngSearch('foo', 3, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(results[0].title, 'Cached');
  assert.equal(fakeFetch.mock.calls.length, 0);
});

test('searxngSearch writes to cache on miss', async () => {
  const fakeFetch = mockFetchOk({ results: [{ title: 'X', url: 'https://x', content: 's' }] });
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  await searxngSearch('foo', 3, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  const stored = fakeCache.set.mock.calls[0].arguments[0];
  assert.equal(stored.tool, 'web_search');
});

test('isSearxngReachable returns true on 200', async () => {
  const fakeFetch = mockFetchOk('OK');
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), true);
});

test('isSearxngReachable returns false on error', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('connection refused'); });
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), false);
});

test('isSearxngReachable returns false on non-200', async () => {
  const fakeFetch = mockFetchFail(503);
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), false);
});
