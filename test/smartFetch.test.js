import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { smartFetch } from '../src/fetch.js';

test('smartFetch uses extractor when URL matches', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async (url) => ({ url, title: 'EX', content: 'extractor body', truncated: false })),
  };
  const jinaImpl = mock.fn(async () => { throw new Error('jina should not be called'); });
  const readabilityImpl = mock.fn(async () => { throw new Error('readability should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'extractor body');
});

test('smartFetch falls back to jina if extractor returns error', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async (url) => ({ url, content: null, error: 'extractor failed' })),
  };
  const jinaImpl = mock.fn(async () => ({ url: 'u', title: 'J', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'jina body');
});

test('smartFetch falls back to readability if extractor + jina both fail', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async () => ({ url: 'u', content: null, error: 'ex fail' })),
  };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', title: 'R', content: 'readability body', truncated: false }));

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jsonldImpl, jinaImpl, readabilityImpl,
    disableCrawl4ai: true,
  });
  assert.equal(result.content, 'readability body');
});

test('smartFetch returns aggregated error when all three fail', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => ({ url: 'u', content: null, error: 'ex fail' })) };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'read fail' }));

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jsonldImpl, jinaImpl, readabilityImpl,
    disableCrawl4ai: true,
  });
  assert.equal(result.content, null);
  assert.match(result.error, /ex fail/);
  assert.match(result.error, /jina fail/);
  assert.match(result.error, /read fail/);
});

test('smartFetch skips extractor when disableExtractors=true', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => { throw new Error('should not be called'); }) };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
    disableExtractors: true,
  });
  assert.equal(result.content, 'jina body');
  assert.equal(extractorImpl.extract.mock.calls.length, 0);
});

test('smartFetch uses URL-based registry lookup when no extractorImpl provided', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://random-blog.example.com/post', { jinaImpl, readabilityImpl });
  assert.equal(result.content, 'jina body');
});

test('smartFetch caches successful result', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'body', truncated: false }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no' }));

  await smartFetch('https://random.example.com/p', {
    jinaImpl, readabilityImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'fetch_url');
});

test('smartFetch returns cache hit and skips all strategies', async () => {
  const fakeCache = { get: mock.fn(() => ({ result: { url: 'u', content: 'cached', truncated: false } })), set: mock.fn() };
  const jinaImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://random.example.com/p', {
    jinaImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(result.content, 'cached');
  assert.equal(jinaImpl.mock.calls.length, 0);
});

test('smartFetch does NOT cache when all strategies fail', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina err' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'read err' }));

  await smartFetch('https://random.example.com/p', {
    jinaImpl, readabilityImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 0);
});

// ── v0.5.0: JSON-LD integration ──────────────────────────────────────────

test('smartFetch tries JSON-LD parser between extractor and Jina', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => ({ url: 'u', content: null, error: 'no match' })) };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', title: 'JSON-LD title', content: 'JSON-LD body', truncated: false, schemaType: 'Product', extractor: 'jsonld' }));
  const jinaImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://example.com/p', {
    extractorImpl, jsonldImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'JSON-LD body');
  assert.equal(result.schemaType, 'Product');
});

test('smartFetch falls through to Jina when JSON-LD returns no data', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no structured data found' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', title: 'Jina', content: 'Jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://example.com/p', { jsonldImpl, jinaImpl, readabilityImpl });
  assert.equal(result.content, 'Jina body');
  assert.equal(jsonldImpl.mock.calls.length, 1);
  assert.equal(jinaImpl.mock.calls.length, 1);
});

test('smartFetch caches JSON-LD result like any other strategy', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', title: 'T', content: 'body', truncated: false }));

  await smartFetch('https://example.com/p', { jsonldImpl, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'fetch_url');
});

// ── v0.6.0: Crawl4AI integration ──────────────────────────────────────────

test('smartFetch tries Crawl4AI between Jina and Readability when reachable', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => ({ url: 'u', title: 'C4AI', content: 'crawl4ai body', truncated: false, extractor: 'crawl4ai' }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const reachableImpl = mock.fn(async () => true);

  const result = await smartFetch('https://example.com', {
    jsonldImpl, jinaImpl, crawl4aiImpl, readabilityImpl, crawl4aiReachableImpl: reachableImpl,
  });
  assert.equal(result.content, 'crawl4ai body');
});

test('smartFetch skips Crawl4AI when not reachable', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: 'readability body', truncated: false }));
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const reachableImpl = mock.fn(async () => false);

  const result = await smartFetch('https://example.com', {
    jsonldImpl, jinaImpl, crawl4aiImpl, readabilityImpl, crawl4aiReachableImpl: reachableImpl,
  });
  assert.equal(result.content, 'readability body');
  assert.equal(crawl4aiImpl.mock.calls.length, 0);
});

test('smartFetch skips Crawl4AI when disableCrawl4ai=true', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: 'readability body', truncated: false }));
  const reachableImpl = mock.fn(async () => true);

  const result = await smartFetch('https://example.com', {
    jinaImpl, crawl4aiImpl, readabilityImpl,
    crawl4aiReachableImpl: reachableImpl,
    disableCrawl4ai: true,
    jsonldImpl: mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' })),
  });
  assert.equal(result.content, 'readability body');
  assert.equal(crawl4aiImpl.mock.calls.length, 0);
});
