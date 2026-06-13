import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searchAndRead } from '../src/combine.js';

const oneResult = [{ title: 'A', url: 'https://a.example', snippet: 's' }];
// Fires the deadline on the next macrotask so an already-resolved fetch wins the
// race, but a never-resolving fetch loses to the timeout — deterministic, no wait.
const immediateTimer = { setTimeoutImpl: (fn) => setImmediate(fn), clearTimeoutImpl: (h) => clearImmediate(h) };

// ── C1: empty-result note ────────────────────────────────────────────────────

test('searchAndRead attaches an explanatory note on zero results', async () => {
  const searchImpl = mock.fn(async () => []);
  const fetchImpl = mock.fn(async () => { throw new Error('should not run'); });
  const out = await searchAndRead('q', { searchImpl, fetchImpl });
  assert.deepEqual(out.results, []);
  assert.match(out.note, /retry/i);
  assert.match(out.note, /broaden|rephrase/i);
  assert.equal(fetchImpl.mock.calls.length, 0);
});

// ── C4 (L6): per-fetch deadline + bounded concurrency ────────────────────────

test('searchAndRead degrades a slow fetch to a fetch timeout', async () => {
  const searchImpl = mock.fn(async () => [
    { title: 'fast', url: 'https://fast.example', snippet: '' },
    { title: 'slow', url: 'https://slow.example', snippet: '' },
  ]);
  const fetchImpl = mock.fn(async (url) =>
    url.includes('slow') ? new Promise(() => {}) : { content: 'fast body', truncated: false });
  const out = await searchAndRead('q', { searchImpl, fetchImpl, timerImpl: immediateTimer, concurrency: 2 });
  const slow = out.results.find(r => r.url.includes('slow'));
  const fast = out.results.find(r => r.url.includes('fast'));
  assert.equal(slow.content, null);
  assert.match(slow.error, /fetch timeout/);
  assert.equal(fast.content, 'fast body');
});

test('searchAndRead does not cache a batch containing a timed-out fetch', async () => {
  const searchImpl = mock.fn(async () => oneResult);
  const fetchImpl = mock.fn(() => new Promise(() => {}));
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const out = await searchAndRead('q', { searchImpl, fetchImpl, timerImpl: immediateTimer, cache: fakeCache, ttlMs: 60_000 });
  assert.match(out.results[0].error, /fetch timeout/);
  assert.equal(fakeCache.set.mock.calls.length, 0);
});

test('searchAndRead bounds concurrency to the configured limit', async () => {
  const urls = Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: `https://e${i}.example`, snippet: '' }));
  const searchImpl = mock.fn(async () => urls);
  let inFlight = 0, maxInFlight = 0, release;
  const barrier = new Promise((r) => { release = r; });
  const fetchImpl = mock.fn(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await barrier;
    inFlight--;
    return { content: 'x', truncated: false };
  });
  const p = searchAndRead('q', { searchImpl, fetchImpl, concurrency: 2, perFetchTimeoutMs: 100_000 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(maxInFlight, 2, 'should reach exactly the cap of 2');
  release();
  await p;
  assert.ok(maxInFlight <= 2);
});

test('searchAndRead preserves result order under out-of-order completion', async () => {
  const urls = Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, url: `https://e${i}.example`, snippet: '' }));
  const searchImpl = mock.fn(async () => urls);
  const fetchImpl = mock.fn(async (url) => {
    const i = Number(url.match(/e(\d)/)[1]);
    await new Promise((r) => setImmediate(r)); // resolve out of strict order
    return { content: `body${i}`, truncated: false };
  });
  const out = await searchAndRead('q', { searchImpl, fetchImpl, concurrency: 4 });
  assert.deepEqual(out.results.map(r => r.url), urls.map(u => u.url));
  assert.equal(out.results[0].content, 'body0');
  assert.equal(out.results[3].content, 'body3');
});

test('searchAndRead surfaces a thrown fetchImpl error as a per-result error', async () => {
  const searchImpl = mock.fn(async () => [
    { title: 'A', url: 'https://a.example', snippet: '' },
    { title: 'B', url: 'https://b.example', snippet: '' },
  ]);
  const fetchImpl = mock.fn(async (url) => {
    if (url.includes('a.example')) throw new Error('boom');
    return { content: 'b body', truncated: false };
  });
  const out = await searchAndRead('q', { searchImpl, fetchImpl, concurrency: 2 });
  const a = out.results.find(r => r.url.includes('a.example'));
  const b = out.results.find(r => r.url.includes('b.example'));
  assert.equal(a.content, null);
  assert.match(a.error, /boom/);
  assert.equal(b.content, 'b body');
});

// ── C5: strategy/elapsed passthrough ─────────────────────────────────────────

test('searchAndRead forwards strategy and elapsed_ms from the fetcher', async () => {
  const searchImpl = mock.fn(async () => oneResult);
  const fetchImpl = mock.fn(async () => ({ content: 'body', truncated: false, strategy: 'jina', elapsed_ms: 12 }));
  const out = await searchAndRead('q', { searchImpl, fetchImpl });
  assert.equal(out.results[0].strategy, 'jina');
  assert.equal(out.results[0].elapsed_ms, 12);
});
