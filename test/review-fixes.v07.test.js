// Regression tests for the v0.7.0 adversarial-review fixes. Each guards against
// a specific confirmed finding so it cannot silently come back.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { smartFetch } from '../src/fetch.js';
import { guardedCurlFetch } from '../src/http.js';
import { makeGuardedFetch } from '../src/ssrf.js';
import { cleanContent } from '../src/clean.js';
import { searchAndRead } from '../src/combine.js';

const buf = (s) => Buffer.from(s, 'utf8');

// ── HIGH: DNS-rebinding pinning (makeGuardedFetch + guardedCurlFetch --resolve) ──

test('makeGuardedFetch builds an ssrfPin from the validated address', async () => {
  const baseFetch = mock.fn(async () => ({ ok: true, status: 200, finalUrl: 'x', text: async () => 'ok' }));
  const resolver = mock.fn(async () => ['93.184.216.34']);
  const guarded = makeGuardedFetch(baseFetch, { resolver, env: {} });
  await guarded('https://example.com/p');
  const opts = baseFetch.mock.calls[0].arguments[1];
  assert.deepEqual(opts.ssrfPin, { host: 'example.com', port: '443', ip: '93.184.216.34' });
  assert.equal(typeof opts.ssrfGuard, 'function');
});

test('guardedCurlFetch pins the validated IP via curl --resolve', async () => {
  let args = null;
  const _spawnImpl = mock.fn(async (a) => { args = a; return { code: 0, stdout: buf('ok\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' }; });
  await guardedCurlFetch('https://example.com/x', { _spawnImpl, ssrfPin: { host: 'example.com', port: '443', ip: '93.184.216.34' } });
  const i = args.indexOf('--resolve');
  assert.ok(i >= 0, 'should include --resolve');
  assert.equal(args[i + 1], 'example.com:443:93.184.216.34');
});

test('guardedCurlFetch re-pins curl to the validated IP of each redirect hop', async () => {
  const calls = [];
  let n = 0;
  const _spawnImpl = mock.fn(async (a) => {
    calls.push(a); n++;
    return n === 1
      ? { code: 0, stdout: buf('\nHTTP_CODE:302\nREDIRECT_URL:https://b.example/final\n'), stderr: '' }
      : { code: 0, stdout: buf('body\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' };
  });
  const ssrfGuard = mock.fn(async (next) => ({ host: new URL(next).hostname, port: '443', ip: '1.2.3.4' }));
  await guardedCurlFetch('https://a.example/x', { _spawnImpl, ssrfPin: { host: 'a.example', port: '443', ip: '9.9.9.9' }, ssrfGuard });
  assert.equal(calls[0][calls[0].indexOf('--resolve') + 1], 'a.example:443:9.9.9.9');
  assert.equal(calls[1][calls[1].indexOf('--resolve') + 1], 'b.example:443:1.2.3.4');
});

// ── MED: redirect method semantics (303 -> GET, 308 preserves) ────────────────

test('guardedCurlFetch downgrades to GET and drops body on 303', async () => {
  const methods = [];
  let n = 0;
  const _spawnImpl = mock.fn(async (a) => {
    methods.push(a[a.indexOf('-X') + 1]); n++;
    return n === 1
      ? { code: 0, stdout: buf('\nHTTP_CODE:303\nREDIRECT_URL:https://b.example/final\n'), stderr: '' }
      : { code: 0, stdout: buf('ok\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' };
  });
  await guardedCurlFetch('https://a.example/x', { _spawnImpl, ssrfGuard: async () => null, method: 'POST', body: 'data' });
  assert.equal(methods[0], 'POST');
  assert.equal(methods[1], 'GET');
});

test('guardedCurlFetch preserves method and body across a 308', async () => {
  const methods = [], bodies = [];
  let n = 0;
  const _spawnImpl = mock.fn(async (a, body) => {
    methods.push(a[a.indexOf('-X') + 1]); bodies.push(body); n++;
    return n === 1
      ? { code: 0, stdout: buf('\nHTTP_CODE:308\nREDIRECT_URL:https://b.example/final\n'), stderr: '' }
      : { code: 0, stdout: buf('ok\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' };
  });
  await guardedCurlFetch('https://a.example/x', { _spawnImpl, ssrfGuard: async () => null, method: 'POST', body: 'data' });
  assert.equal(methods[1], 'POST');
  assert.equal(bodies[1], 'data');
});

// ── HIGH/MED: content-cleaner false positives ─────────────────────────────────

test('cleanContent keeps prose that merely starts with "Promoted"', () => {
  const r = cleanContent('Promoted by the community, this self-hosting approach works well for teams.');
  assert.match(r.content, /Promoted by the community/);
  assert.equal(r.removedLineCount, 0);
});

test('cleanContent still removes a bare Promoted ad block', () => {
  const r = cleanContent('Promoted\nBuy now at evomi.com\n\nReal article body.');
  assert.doesNotMatch(r.content, /evomi/);
  assert.match(r.content, /Real article body/);
});

test('cleanContent does not eat tight technical slash strings', () => {
  const r = cleanContent('src/main/java\nTCP/IP\nand/or');
  assert.match(r.content, /src\/main\/java/);
  assert.match(r.content, /TCP\/IP/);
  assert.match(r.content, /and\/or/);
});

test('cleanContent still removes a spaced breadcrumb nav line', () => {
  const r = cleanContent('Home / Articles / Self Hosting\n\nReal body here.');
  assert.doesNotMatch(r.content, /Home \/ Articles/);
  assert.match(r.content, /Real body here/);
});

// ── smartFetch fixes: clean-empties fallback, _finalUrl identity, key partition,
//    extractor-field strip, guard-before-cache ─────────────────────────────────

test('smartFetch keeps original content when cleaning would empty it', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'Log In\nSign Up\nMenu', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not cascade'); });
  const result = await smartFetch('https://x.example/p', { jsonldImpl, jinaImpl, readabilityImpl, disableCrawl4ai: true });
  assert.equal(result.content, 'Log In\nSign Up\nMenu');
  assert.equal(result.cleaned, undefined);
  assert.equal(result.strategy, 'jina');
});

test('smartFetch flags urlMismatch from a leaf _finalUrl and strips the internal field', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: 'body', truncated: false, _finalUrl: 'https://other-host.example/p' }));
  const result = await smartFetch('https://requested-host.example/p', { jsonldImpl, disableCrawl4ai: true });
  assert.ok(result.urlMismatch);
  assert.match(result.urlMismatch.reason, /host differs/);
  assert.equal(result._finalUrl, undefined);
});

test('smartFetch result exposes strategy but not the internal extractor field', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: 'jl', truncated: false, extractor: 'jsonld', schemaType: 'Product' }));
  const result = await smartFetch('https://x.example/p', { jsonldImpl, disableCrawl4ai: true });
  assert.equal(result.strategy, 'jsonld');
  assert.equal(result.extractor, undefined);
  assert.equal(result.schemaType, 'Product');
});

test('smartFetch partitions cleaned vs raw cache entries by disableClean', async () => {
  const store = new Map();
  const cache = {
    get: ({ cacheKey }) => (store.has(cacheKey) ? { result: store.get(cacheKey) } : null),
    set: ({ cacheKey, result }) => store.set(cacheKey, result),
  };
  const dirty = async () => ({ url: 'u', content: 'Log In\n\nReal body.', truncated: false });
  const noSchema = async () => ({ url: 'u', content: null, error: 'x' });
  await smartFetch('https://x.example/p', { jsonldImpl: noSchema, jinaImpl: dirty, cache, ttlMs: 60_000, disableCrawl4ai: true });
  const raw = await smartFetch('https://x.example/p', { jsonldImpl: noSchema, jinaImpl: dirty, cache, ttlMs: 60_000, disableCrawl4ai: true, disableClean: true });
  assert.match(raw.content, /Log In/, 'raw call must not read the cleaned cache entry');
  assert.equal(store.size, 2);
});

test('smartFetch runs the SSRF guard BEFORE the cache lookup', async () => {
  const get = mock.fn(() => ({ result: { url: 'u', content: 'STALE CACHED', truncated: false } }));
  const cache = { get, set: mock.fn() };
  const result = await smartFetch('http://127.0.0.1/p', { cache, ttlMs: 60_000, disableCrawl4ai: true });
  assert.match(result.error, /blocked/);
  assert.equal(get.mock.calls.length, 0, 'cache must not be consulted for a blocked URL');
});

// ── combine: cross-source cache isolation ─────────────────────────────────────

test('searchAndRead uses distinct content-cache keys per source', async () => {
  const store = new Map();
  const cache = {
    get: ({ cacheKey }) => (store.has(cacheKey) ? { result: store.get(cacheKey) } : null),
    set: ({ cacheKey, result }) => store.set(cacheKey, result),
  };
  const searchImpl = mock.fn(async () => [{ title: 'A', url: 'https://a.example', snippet: '' }]);
  const fetchImpl = mock.fn(async () => ({ content: 'body', truncated: false }));
  await searchAndRead('q', { searchImpl, fetchImpl, cache, ttlMs: 60_000, source: 'web' });
  await searchAndRead('q', { searchImpl, fetchImpl, cache, ttlMs: 60_000, source: 'reddit' });
  assert.equal(store.size, 2, 'web and reddit must cache under different keys');
});
