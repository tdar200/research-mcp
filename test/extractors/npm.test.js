import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { npmExtractor } from '../../src/extractors/npm.js';

function makeFetch(handler) {
  return mock.fn(async (url, opts) => handler(url, opts));
}

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

const SAMPLE_PKG = {
  name: 'express',
  description: 'Fast, unopinionated, minimalist web framework',
  'dist-tags': { latest: '4.19.2' },
  versions: {
    '4.19.2': {
      author: { name: 'TJ Holowaychuk' },
      license: 'MIT',
      dependencies: { accepts: '~1.3.8', body: '^1.0.0' },
    },
  },
  homepage: 'http://expressjs.com/',
  repository: { type: 'git', url: 'git+https://github.com/expressjs/express.git' },
  keywords: ['express', 'framework', 'web'],
  readme: '# Express\n\nWeb framework for node.',
};

test('npmExtractor returns formatted package info for plain package URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    assert.match(url, /registry\.npmjs\.org\/express/);
    return jsonResponse(SAMPLE_PKG);
  });
  const result = await npmExtractor('https://www.npmjs.com/package/express', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /express \(4\.19\.2\)/);
  assert.match(result.content, /Fast, unopinionated/);
  assert.match(result.content, /TJ Holowaychuk/);
  assert.match(result.content, /MIT/);
  assert.match(result.content, /accepts/);
  assert.match(result.content, /# Express/);
  assert.equal(result.extractor, 'npm');
});

test('npmExtractor handles scoped packages', async () => {
  let calledUrl = null;
  const fakeFetch = makeFetch(async (url) => {
    calledUrl = url;
    return jsonResponse({ ...SAMPLE_PKG, name: '@anthropic-ai/sdk' });
  });
  await npmExtractor('https://www.npmjs.com/package/@anthropic-ai/sdk', { fetchImpl: fakeFetch });
  assert.match(calledUrl, /registry\.npmjs\.org\/@anthropic-ai\/sdk/);
});

test('npmExtractor surfaces 404 as error', async () => {
  const fakeFetch = makeFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' }));
  const result = await npmExtractor('https://www.npmjs.com/package/never-exists-pkg', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('npmExtractor handles missing optional fields', async () => {
  const fakeFetch = makeFetch(async () => jsonResponse({
    name: 'minimal',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {} },
  }));
  const result = await npmExtractor('https://www.npmjs.com/package/minimal', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /minimal/);
});

test('npmExtractor truncates long content', async () => {
  const fakeFetch = makeFetch(async () => jsonResponse({
    ...SAMPLE_PKG,
    readme: 'x'.repeat(50000),
  }));
  const result = await npmExtractor('https://www.npmjs.com/package/express', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});

test('npmExtractor returns error for malformed URL', async () => {
  const result = await npmExtractor('https://www.npmjs.com/', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});
