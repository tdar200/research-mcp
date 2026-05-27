import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stackoverflowExtractor } from '../../src/extractors/stackoverflow.js';

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

test('stackoverflowExtractor formats question + top answers', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/questions/12345/answers')) {
      return jsonResponse({
        items: [
          { score: 100, is_accepted: true, body: '<p>This is the accepted answer with <code>code</code>.</p>' },
          { score: 50, body: '<p>Another helpful answer.</p>' },
          { score: 10, body: '<p>A third answer.</p>' },
          { score: 1, body: '<p>Should not appear (only top 3).</p>' },
        ],
      });
    }
    if (url.includes('/questions/12345')) {
      return jsonResponse({
        items: [{
          title: 'How do I do X in JavaScript?',
          score: 250,
          view_count: 10000,
          tags: ['javascript', 'arrays'],
          body: '<p>I am trying to do X but I get error Y.</p>',
        }],
      });
    }
    throw new Error(`unexpected: ${url}`);
  });

  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/12345/how-do-i', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /How do I do X/);
  assert.match(result.content, /trying to do X/);
  assert.match(result.content, /accepted answer/);
  assert.match(result.content, /Another helpful/);
  assert.match(result.content, /third answer/);
  assert.doesNotMatch(result.content, /Should not appear/);
  assert.match(result.content, /score 100/);
  assert.match(result.content, /accepted/);
  assert.equal(result.extractor, 'stackoverflow');
});

test('stackoverflowExtractor strips simple HTML tags', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/answers')) return jsonResponse({ items: [] });
    return jsonResponse({
      items: [{
        title: 'Q',
        score: 1,
        view_count: 1,
        tags: ['x'],
        body: '<p>Hello <strong>bold</strong> &amp; <code>inline</code></p><pre><code>code\nblock</code></pre>',
      }],
    });
  });
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch });
  assert.match(result.content, /Hello bold &/);
  assert.match(result.content, /`inline`/);
  assert.match(result.content, /```[\s\S]*code\nblock[\s\S]*```/);
});

test('stackoverflowExtractor handles missing question gracefully', async () => {
  const fakeFetch = mock.fn(async () => jsonResponse({ items: [] }));
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/99999/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /not found/i);
});

test('stackoverflowExtractor surfaces non-200 response', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '' }));
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /429/);
});

test('stackoverflowExtractor returns error for malformed URL', async () => {
  const result = await stackoverflowExtractor('https://stackoverflow.com/users/123', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});

test('stackoverflowExtractor truncates long content', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/answers')) return jsonResponse({
      items: [{ score: 1, body: '<p>' + 'x'.repeat(50000) + '</p>' }],
    });
    return jsonResponse({
      items: [{ title: 'Q', score: 1, view_count: 1, tags: [], body: '<p>q</p>' }],
    });
  });
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});
