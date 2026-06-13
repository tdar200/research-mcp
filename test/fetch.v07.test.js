import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { jinaFetch } from '../src/fetch.js';

function res(status, body = '') {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => body };
}

// ── C4 (L7): 429/503 retry with jittered backoff ─────────────────────────────

test('jinaFetch retries once on 429 then succeeds', async () => {
  let n = 0;
  const fetchImpl = mock.fn(async () => (++n === 1 ? res(429) : res(200, '# T\n\nbody')));
  const sleepImpl = mock.fn(async () => {});
  const r = await jinaFetch('https://x.example/p', { fetchImpl, sleepImpl, rngImpl: () => 0 });
  assert.equal(fetchImpl.mock.calls.length, 2);
  assert.equal(sleepImpl.mock.calls.length, 1);
  assert.ok(r.content);
  assert.equal(r.error, undefined);
});

test('jinaFetch retries once on 503 then surfaces the error', async () => {
  const fetchImpl = mock.fn(async () => res(503));
  const sleepImpl = mock.fn(async () => {});
  const r = await jinaFetch('https://x.example/p', { fetchImpl, sleepImpl });
  assert.equal(fetchImpl.mock.calls.length, 2);
  assert.equal(sleepImpl.mock.calls.length, 1);
  assert.match(r.error, /503/);
});

test('jinaFetch does not retry a non-retriable 500', async () => {
  const fetchImpl = mock.fn(async () => res(500));
  const sleepImpl = mock.fn(async () => {});
  const r = await jinaFetch('https://x.example/p', { fetchImpl, sleepImpl });
  assert.equal(fetchImpl.mock.calls.length, 1);
  assert.equal(sleepImpl.mock.calls.length, 0);
  assert.match(r.error, /500/);
});

test('jinaFetch backoff uses injected rng (jitter 0 => 500ms first retry)', async () => {
  let n = 0;
  const fetchImpl = mock.fn(async () => (++n === 1 ? res(429) : res(200, 'ok')));
  let slept = null;
  const sleepImpl = mock.fn(async (ms) => { slept = ms; });
  await jinaFetch('https://x.example/p', { fetchImpl, sleepImpl, rngImpl: () => 0 });
  assert.equal(slept, 500);
});

test('jinaFetch with maxRetries:0 does not retry a 429', async () => {
  const fetchImpl = mock.fn(async () => res(429));
  const sleepImpl = mock.fn(async () => {});
  const r = await jinaFetch('https://x.example/p', { fetchImpl, sleepImpl, maxRetries: 0 });
  assert.equal(fetchImpl.mock.calls.length, 1);
  assert.equal(sleepImpl.mock.calls.length, 0);
  assert.match(r.error, /rate limit/);
});

// ── C4 (L10): boundary-aware truncation ──────────────────────────────────────

test('jinaFetch truncates at a sentence boundary, not mid-token', async () => {
  const body = 'Alpha beta gamma. ' + 'word '.repeat(100);
  const fetchImpl = mock.fn(async () => res(200, body));
  const r = await jinaFetch('https://x.example/p', { fetchImpl, maxChars: 40 });
  assert.equal(r.truncated, true);
  assert.ok(r.content.length <= 40);
  assert.equal(r.content, 'Alpha beta gamma.');
});
