import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readabilityFetch } from '../src/readability.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Sample Page</title></head>
  <body>
    <nav>Site navigation that should be stripped</nav>
    <article>
      <h1>Real article title</h1>
      <p>This is the first paragraph of real content that Readability should extract.</p>
      <p>This is the second paragraph with more substantial text so Readability
         considers it meaningful content worth extracting from the page.</p>
      <p>And a third paragraph because Readability favors longer content blocks.</p>
    </article>
    <footer>Footer junk</footer>
  </body>
</html>`;

function mockFetch(body, ok = true, status = 200) {
  return mock.fn(async () => ({
    ok, status, statusText: ok ? 'OK' : 'Error',
    text: async () => body,
  }));
}

test('readabilityFetch extracts main content via @mozilla/readability', async () => {
  const fakeFetch = mockFetch(SAMPLE_HTML);
  const result = await readabilityFetch('https://example.test/page', { fetchImpl: fakeFetch, maxChars: 5000 });
  assert.ok(result.content, `expected content, got error: ${result.error}`);
  assert.match(result.content, /first paragraph of real content/);
  assert.match(result.content, /second paragraph/);
  assert.doesNotMatch(result.content, /Site navigation/);
  assert.doesNotMatch(result.content, /Footer junk/);
});

test('readabilityFetch returns title from article', async () => {
  const fakeFetch = mockFetch(SAMPLE_HTML);
  const result = await readabilityFetch('https://example.test/page', { fetchImpl: fakeFetch });
  assert.ok(result.title, 'expected title');
  assert.match(result.title, /Sample Page|Real article title/);
});

test('readabilityFetch truncates when content exceeds max_chars', async () => {
  const longHtml = `<article>${'<p>'.repeat(1)}${'x'.repeat(10000)}${'</p>'.repeat(1)}</article>`;
  const fakeFetch = mockFetch(`<html><body>${longHtml}</body></html>`);
  const result = await readabilityFetch('https://example.test/long', { fetchImpl: fakeFetch, maxChars: 500 });
  if (result.content) {
    assert.ok(result.content.length <= 500);
    assert.equal(result.truncated, true);
  }
});

test('readabilityFetch surfaces non-200 response as error', async () => {
  const fakeFetch = mockFetch('', false, 404);
  const result = await readabilityFetch('https://example.test/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('readabilityFetch returns error when HTML has no extractable content', async () => {
  const fakeFetch = mockFetch('<html><body></body></html>');
  const result = await readabilityFetch('https://example.test/empty', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /Readability/i);
});
