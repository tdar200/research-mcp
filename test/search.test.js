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
    get: mock.fn(() => ({
      result: [{ title: 'Cached', url: 'https://cached.example', snippet: 'from cache' }],
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
