import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDuckDuckGoHtml, duckDuckGoSearch } from '../src/search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'ddg-results.html');

test('parseDuckDuckGoHtml extracts results from real DDG response', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const results = parseDuckDuckGoHtml(html, 5);

  assert.ok(results.length >= 3, `expected ≥3 results, got ${results.length}`);
  assert.ok(results.length <= 5, `expected ≤5 results, got ${results.length}`);

  for (const r of results) {
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0, 'title should be non-empty');
    assert.match(r.url, /^https?:\/\//, `url should be absolute: ${r.url}`);
    assert.equal(typeof r.snippet, 'string');
  }
});

test('parseDuckDuckGoHtml respects num_results limit', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const results = parseDuckDuckGoHtml(html, 2);
  assert.equal(results.length, 2);
});

test('parseDuckDuckGoHtml returns [] on empty html', () => {
  const results = parseDuckDuckGoHtml('', 5);
  assert.deepEqual(results, []);
});

test('duckDuckGoSearch returns cached results when cache hit (no network call)', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeCache = {
    // Realistic cached entry: real writes always store params.num_results, which
    // readSearchCache uses to honor "engine was asked for >= want" (authoritative).
    get: mock.fn(() => ({
      result: [{ title: 'Cached', url: 'https://cached.example', snippet: 'from cache' }],
      params: { num_results: 3, source: 'web', time_range: 'all' },
    })),
    set: mock.fn(),
  };

  const results = await duckDuckGoSearch('foo', 3, { cache: fakeCache, ttlMs: 60_000, fetchImpl: fakeFetch });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Cached');
  assert.equal(fakeFetch.mock.calls.length, 0);
  assert.equal(fakeCache.get.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 0);
});

test('duckDuckGoSearch fetches + stores when cache miss', async () => {
  const fakeHtml = `
    <div class="result">
      <a class="result__a" href="https://x.example">X</a>
      <a class="result__snippet">snippet</a>
    </div>
  `;
  const fakeFetch = mock.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => fakeHtml }));
  const fakeCache = {
    get: mock.fn(() => null),
    set: mock.fn(),
  };

  const results = await duckDuckGoSearch('foo', 3, { cache: fakeCache, ttlMs: 60_000, fetchImpl: fakeFetch });
  assert.ok(results.length >= 1);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 1);
  const stored = fakeCache.set.mock.calls[0].arguments[0];
  assert.equal(stored.tool, 'web_search');
  assert.equal(stored.query, 'foo');
});

test('duckDuckGoSearch with no cache option still works (back-compat)', async () => {
  const fakeHtml = `<div class="result"><a class="result__a" href="https://y.example">Y</a><a class="result__snippet">s</a></div>`;
  const fakeFetch = mock.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => fakeHtml }));
  const results = await duckDuckGoSearch('foo', 3, { fetchImpl: fakeFetch });
  assert.ok(results.length >= 1);
});

// ── webSearch router tests ──────────────────────────────────────────────────
import { webSearch } from '../src/search.js';

test('webSearch routes to searxng when backend=searxng', async () => {
  const fakeSearxng = mock.fn(async () => [{ title: 'SX', url: 'https://x', snippet: 's' }]);
  const fakeDdg = mock.fn(async () => { throw new Error('should not be called'); });
  const results = await webSearch('foo', 3, {
    backend: 'searxng',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
  });
  assert.equal(results[0].title, 'SX');
  assert.equal(fakeSearxng.mock.calls.length, 1);
  assert.equal(fakeDdg.mock.calls.length, 0);
});

test('webSearch routes to ddg when backend=ddg', async () => {
  const fakeSearxng = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeDdg = mock.fn(async () => [{ title: 'DG', url: 'https://x', snippet: 's' }]);
  const results = await webSearch('foo', 3, {
    backend: 'ddg',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
  });
  assert.equal(results[0].title, 'DG');
});

test('webSearch in auto mode tries searxng first when reachable', async () => {
  const fakeSearxng = mock.fn(async () => [{ title: 'SX', url: 'https://x', snippet: 's' }]);
  const fakeDdg = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeProbe = mock.fn(async () => true);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(results[0].title, 'SX');
});

test('webSearch in auto mode falls back to ddg when searxng unreachable', async () => {
  const fakeSearxng = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeDdg = mock.fn(async () => [{ title: 'DG', url: 'https://x', snippet: 's' }]);
  const fakeProbe = mock.fn(async () => false);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(results[0].title, 'DG');
});

test('webSearch in auto mode falls back to ddg when searxng returns []', async () => {
  // Real-world cause: SearXNG up but a backing engine (reddit/hackernews) timed out.
  const fakeSearxng = mock.fn(async () => []);
  const fakeDdg = mock.fn(async () => [{ title: 'DG', url: 'https://x', snippet: 's' }]);
  const fakeProbe = mock.fn(async () => true);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(fakeSearxng.mock.calls.length, 1);
  assert.equal(fakeDdg.mock.calls.length, 1);
  assert.equal(results[0].title, 'DG');
});

test('webSearch in auto mode keeps searxng results when non-empty', async () => {
  const fakeSearxng = mock.fn(async () => [{ title: 'SX', url: 'https://x', snippet: 's' }]);
  const fakeDdg = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeProbe = mock.fn(async () => true);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(results[0].title, 'SX');
  assert.equal(fakeDdg.mock.calls.length, 0);
});

test('webSearch passes cache and ttlMs through to underlying backend', async () => {
  let captured = null;
  const fakeSearxng = mock.fn(async (q, n, opts) => { captured = opts; return []; });
  const fakeProbe = mock.fn(async () => true);
  const fakeCache = { get: () => null, set: () => {} };
  await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    reachableImpl: fakeProbe,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(captured.cache, fakeCache);
  assert.equal(captured.ttlMs, 60_000);
});

// ── v0.4.0: DDG source + timeRange ─────────────────────────────────────────

test('duckDuckGoSearch with source=reddit prepends site:reddit.com to query', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('Foodhub pricing', 5, { fetchImpl: fakeFetch, source: 'reddit' });
  assert.match(capturedBody, /q=site%3Areddit\.com\+Foodhub\+pricing/);
});

test('duckDuckGoSearch with source=hackernews prepends site:news.ycombinator.com', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('rust async', 5, { fetchImpl: fakeFetch, source: 'hackernews' });
  assert.match(capturedBody, /q=site%3Anews\.ycombinator\.com\+rust\+async/);
});

test('duckDuckGoSearch with source=web does not modify query', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('plain query', 5, { fetchImpl: fakeFetch, source: 'web' });
  assert.doesNotMatch(capturedBody, /site%3A/);
  assert.match(capturedBody, /q=plain\+query/);
});

test('duckDuckGoSearch with timeRange=year adds df=y to form body', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'year' });
  assert.match(capturedBody, /df=y/);
});

test('duckDuckGoSearch with timeRange=all omits df param', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'all' });
  assert.doesNotMatch(capturedBody, /df=/);
});

test('webSearch passes source and timeRange through to underlying backend', async () => {
  let captured = null;
  const fakeSearxng = mock.fn(async (q, n, opts) => { captured = opts; return []; });
  const fakeProbe = mock.fn(async () => true);
  await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    reachableImpl: fakeProbe,
    source: 'reddit',
    timeRange: 'month',
  });
  assert.equal(captured.source, 'reddit');
  assert.equal(captured.timeRange, 'month');
});
