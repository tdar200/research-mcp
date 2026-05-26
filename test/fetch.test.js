import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { jinaFetch } from '../src/fetch.js';

function mockFetchOk(body) {
  return mock.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
  }));
}

function mockFetchErr(status, statusText, body = '') {
  return mock.fn(async () => ({
    ok: false,
    status,
    statusText,
    text: async () => body,
  }));
}

test('jinaFetch returns content under max_chars', async () => {
  const fakeFetch = mockFetchOk('Title: Example\n\nHello world');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.url, 'https://example.com');
  assert.ok(result.content.includes('Hello world'));
  assert.equal(result.truncated, false);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls[0].arguments[0], 'https://r.jina.ai/https://example.com');
});

test('jinaFetch truncates when content exceeds max_chars', async () => {
  const longBody = 'x'.repeat(5000);
  const fakeFetch = mockFetchOk(longBody);
  const result = await jinaFetch('https://example.com', { maxChars: 100, fetchImpl: fakeFetch });

  assert.equal(result.content.length, 100);
  assert.equal(result.truncated, true);
});

test('jinaFetch surfaces 429 rate-limit error structurally', async () => {
  const fakeFetch = mockFetchErr(429, 'Too Many Requests');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.url, 'https://example.com');
  assert.equal(result.content, null);
  assert.match(result.error, /rate limit/i);
});

test('jinaFetch surfaces other non-200 errors with status', async () => {
  const fakeFetch = mockFetchErr(500, 'Internal Server Error', 'oops');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.content, null);
  assert.match(result.error, /500/);
});

test('jinaFetch extracts title from first markdown heading if present', async () => {
  const fakeFetch = mockFetchOk('Title: Doc Title\n\n# Doc Title\n\nBody text here.');
  const result = await jinaFetch('https://example.com/doc', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.title, 'Doc Title');
});
