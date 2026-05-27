import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mdnExtractor } from '../../src/extractors/mdn.js';

const SAMPLE_MDN_HTML = `<!DOCTYPE html>
<html>
<head><title>fetch() - Web APIs | MDN</title></head>
<body>
  <nav>top nav junk</nav>
  <aside>side junk</aside>
  <main>
    <article class="main-page-content">
      <h1>fetch()</h1>
      <p>The fetch() method starts the process of fetching a resource from the network.</p>
      <p>It returns a Promise which is fulfilled once the response is available.</p>
      <div class="notecard">should be stripped</div>
      <div class="interactive-example">interactive example removed</div>
      <p>You can use it like: fetch(url).then(response => response.json())</p>
    </article>
  </main>
  <footer>footer noise</footer>
</body>
</html>`;

function mockFetch(body, ok = true, status = 200) {
  return mock.fn(async () => ({
    ok, status, statusText: ok ? 'OK' : 'Err',
    text: async () => body,
  }));
}

test('mdnExtractor extracts main-page-content via cheerio', async () => {
  const fakeFetch = mockFetch(SAMPLE_MDN_HTML);
  const result = await mdnExtractor('https://developer.mozilla.org/en-US/docs/Web/API/fetch', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /starts the process of fetching/);
  assert.match(result.content, /Promise which is fulfilled/);
  assert.doesNotMatch(result.content, /top nav junk/);
  assert.doesNotMatch(result.content, /should be stripped/);
  assert.doesNotMatch(result.content, /interactive example removed/);
  assert.equal(result.extractor, 'mdn');
});

test('mdnExtractor pulls title from h1', async () => {
  const fakeFetch = mockFetch(SAMPLE_MDN_HTML);
  const result = await mdnExtractor('https://developer.mozilla.org/foo', { fetchImpl: fakeFetch });
  assert.ok(result.title);
  assert.match(result.title, /fetch/);
});

test('mdnExtractor falls back to <main> if .main-page-content missing', async () => {
  const html = '<html><body><main><h1>Title</h1><p>Body text here.</p></main></body></html>';
  const fakeFetch = mockFetch(html);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /Body text here/);
});

test('mdnExtractor returns error when no main content found', async () => {
  const html = '<html><body><p>Just floating text with no main element.</p></body></html>';
  const fakeFetch = mockFetch(html);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /main content/i);
});

test('mdnExtractor surfaces 404 as error', async () => {
  const fakeFetch = mockFetch('', false, 404);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('mdnExtractor truncates long content', async () => {
  const longContent = '<main><article class="main-page-content"><h1>T</h1><p>' + 'x'.repeat(50000) + '</p></article></main>';
  const fakeFetch = mockFetch(`<html><body>${longContent}</body></html>`);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});
