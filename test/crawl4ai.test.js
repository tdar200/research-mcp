import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { crawl4aiFetch, isCrawl4aiReachable } from '../src/crawl4ai.js';

function mockOk(body) {
  return mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function mockFail(status = 500) {
  return mock.fn(async () => ({
    ok: false, status, statusText: 'Err', text: async () => '',
  }));
}

test('crawl4aiFetch posts URL to /crawl and returns normalized result', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedUrl = url;
    capturedBody = opts.body;
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({
        results: [{
          url: 'https://example.com',
          success: true,
          markdown: '# Hello\n\nClean markdown content here.',
          html: '<html>...</html>',
        }],
      }),
    };
  });

  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.url, 'https://example.com');
  assert.ok(result.content);
  assert.match(result.content, /Clean markdown content/);
  assert.equal(result.truncated, false);
  assert.match(capturedUrl, /\/crawl$/);
  assert.match(capturedBody, /https:\/\/example\.com/);
});

test('crawl4aiFetch truncates content beyond max_chars', async () => {
  const longMd = 'x'.repeat(5000);
  const fakeFetch = mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ results: [{ url: 'u', success: true, markdown: longMd }] }),
  }));
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch, maxChars: 100 });
  assert.equal(result.content.length, 100);
  assert.equal(result.truncated, true);
});

test('crawl4aiFetch handles {success:false} per-result error', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ results: [{ url: 'u', success: false, error_message: 'blocked' }] }),
  }));
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /blocked/);
});

test('crawl4aiFetch surfaces transport-level errors', async () => {
  const fakeFetch = mockFail(503);
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /503/);
});

test('crawl4aiFetch uses custom baseUrl', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [{ success: true, markdown: '' }] }) };
  });
  await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch, baseUrl: 'http://other:9999' });
  assert.match(capturedUrl, /^http:\/\/other:9999/);
});

test('crawl4aiFetch handles malformed JSON response', async () => {
  const fakeFetch = mockOk('not json at all');
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /JSON/i);
});

test('isCrawl4aiReachable returns true on 200', async () => {
  const fakeFetch = mockOk('{"status":"ok"}');
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), true);
});

test('isCrawl4aiReachable returns false on error', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('connection refused'); });
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), false);
});

test('isCrawl4aiReachable returns false on non-200', async () => {
  const fakeFetch = mockFail(503);
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), false);
});
