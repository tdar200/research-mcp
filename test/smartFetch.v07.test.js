import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { smartFetch } from '../src/fetch.js';

// ── C2: SSRF guard (top-level pre-check, gated on no-leaf-injection) ──────────

test('smartFetch blocks a loopback URL before any strategy (SSRF)', async () => {
  // No leaf impl injected => production-mode guard engages. IP literal => no DNS.
  const resolver = mock.fn(async () => { throw new Error('resolver must not be called for an IP literal'); });
  const result = await smartFetch('http://127.0.0.1:8888/healthz', {
    ssrfResolver: resolver,
    disableCrawl4ai: true,
  });
  assert.equal(result.content, null);
  assert.match(result.error, /blocked/);
  assert.equal(resolver.mock.calls.length, 0);
});

test('smartFetch blocks a public host that resolves to a private IP (DNS rebinding)', async () => {
  const resolver = mock.fn(async () => ['10.0.0.5']);
  const result = await smartFetch('http://intranet.evil.example/x', {
    ssrfResolver: resolver,
    disableCrawl4ai: true,
  });
  assert.match(result.error, /blocked/);
  assert.equal(resolver.mock.calls.length, 1);
});

test('smartFetch with injected leaves skips the SSRF guard (hermetic back-compat)', async () => {
  // Injecting any leaf marks test mode -> top-level guard skipped, no DNS.
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'ok', truncated: false }));
  const result = await smartFetch('http://127.0.0.1/x', { jsonldImpl, jinaImpl, disableCrawl4ai: true });
  assert.equal(result.content, 'ok');
});

// ── C5: strategy + elapsed_ms observability ──────────────────────────────────

test('smartFetch tags the winning result with strategy and elapsed_ms', async () => {
  let t = 1000;
  const nowImpl = () => t;
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => { t = 1042; return { url: 'u', content: 'body', truncated: false }; });
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, disableCrawl4ai: true, nowImpl });
  assert.equal(result.strategy, 'jina');
  assert.equal(result.elapsed_ms, 42);
});

test('smartFetch strategy reflects the leaf extractor name', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: 'jl', truncated: false, extractor: 'jsonld' }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, disableCrawl4ai: true });
  assert.equal(result.strategy, 'jsonld');
});

test('smartFetch strategy is the site-extractor name', async () => {
  const extractorImpl = { name: 'github', extract: mock.fn(async () => ({ url: 'u', content: 'gh', truncated: false, extractor: 'github' })) };
  const result = await smartFetch('https://github.com/a/b', { extractorImpl, disableCrawl4ai: true });
  assert.equal(result.strategy, 'github');
});

test('smartFetch marks a cache hit with strategy:cache and elapsed_ms 0', async () => {
  const fakeCache = { get: mock.fn(() => ({ result: { url: 'u', content: 'cached', truncated: false } })), set: mock.fn() };
  const jinaImpl = mock.fn(async () => { throw new Error('should not run'); });
  const result = await smartFetch('https://x.example/p', { jinaImpl, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(result.content, 'cached');
  assert.equal(result.strategy, 'cache');
  assert.equal(result.elapsed_ms, 0);
  assert.equal(jinaImpl.mock.calls.length, 0);
});

test('smartFetch does not persist strategy/elapsed_ms into the cache', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'body', truncated: false }));
  await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, cache: fakeCache, ttlMs: 60_000, disableCrawl4ai: true });
  const cached = fakeCache.set.mock.calls[0].arguments[0].result;
  assert.equal(cached.strategy, undefined);
  assert.equal(cached.elapsed_ms, undefined);
  assert.equal(cached.content, 'body');
});

test('smartFetch aggregated-error result carries no strategy', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'a' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'b' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'c' }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, readabilityImpl, disableCrawl4ai: true });
  assert.match(result.error, /all strategies failed/);
  assert.equal(result.strategy, undefined);
  assert.equal(result.elapsed_ms, undefined);
});

// ── C6: content cleaning ─────────────────────────────────────────────────────

test('smartFetch cleans ad/nav chrome from the winning content', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'Skip to main content\n\nReal body here.', truncated: false }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, disableCrawl4ai: true });
  assert.doesNotMatch(result.content, /Skip to main content/);
  assert.match(result.content, /Real body here\./);
  assert.ok(result.cleaned.removedLineCount >= 1);
});

test('smartFetch skips cleaning when disableClean=true', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'Skip to main content\n\nReal body.', truncated: false }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, disableCrawl4ai: true, disableClean: true });
  assert.match(result.content, /Skip to main content/);
  assert.equal(result.cleaned, undefined);
});

test('smartFetch caches the cleaned content, not the raw', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'Log In\n\nArticle body.', truncated: false }));
  await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, cache: fakeCache, ttlMs: 60_000, disableCrawl4ai: true });
  const cached = fakeCache.set.mock.calls[0].arguments[0].result;
  assert.doesNotMatch(cached.content, /Log In/);
  assert.match(cached.content, /Article body\./);
});

// ── C6: URL identity verification ────────────────────────────────────────────

test('smartFetch flags urlMismatch when crawl4ai lands on a different reddit post', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const crawl4aiImpl = mock.fn(async () => ({
    url: 'u', landedUrl: 'https://reddit.com/r/x/comments/zzz999/other_post/',
    content: 'body', truncated: false, extractor: 'crawl4ai',
  }));
  const result = await smartFetch('https://reddit.com/r/x/comments/abc123/fabricated_slug/', {
    jsonldImpl, jinaImpl, crawl4aiImpl,
    crawl4aiReachableImpl: mock.fn(async () => true),
    readabilityImpl: mock.fn(async () => { throw new Error('should not run'); }),
  });
  assert.ok(result.urlMismatch);
  assert.match(result.urlMismatch.reason, /path identity differs/);
});

test('smartFetch does NOT flag urlMismatch on a slug-only reddit change', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const crawl4aiImpl = mock.fn(async () => ({
    url: 'u', landedUrl: 'https://reddit.com/r/x/comments/abc123/the_real_slug/',
    content: 'body', truncated: false, extractor: 'crawl4ai',
  }));
  const result = await smartFetch('https://reddit.com/r/x/comments/abc123/fabricated_slug/', {
    jsonldImpl, jinaImpl, crawl4aiImpl,
    crawl4aiReachableImpl: mock.fn(async () => true),
    readabilityImpl: mock.fn(async () => { throw new Error('should not run'); }),
  });
  assert.equal(result.urlMismatch, undefined);
});

test('smartFetch sets no urlMismatch when there is no landed-URL signal', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'body', truncated: false }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, disableCrawl4ai: true });
  assert.equal(result.urlMismatch, undefined);
});
