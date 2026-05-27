import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { githubExtractor } from '../../src/extractors/github.js';

function makeFetch(handler) {
  return mock.fn(async (url, opts) => handler(url, opts));
}

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

function errorResponse(status) {
  return { ok: false, status, statusText: 'Err', text: async () => '' };
}

test('githubExtractor fetches README + repo info for repo root URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.endsWith('/anthropics/claude-code')) {
      return jsonResponse({
        full_name: 'anthropics/claude-code',
        description: 'Claude Code CLI',
        stargazers_count: 12345,
        language: 'TypeScript',
        topics: ['cli', 'agents'],
      });
    }
    if (url.endsWith('/anthropics/claude-code/readme')) {
      return jsonResponse({ content: Buffer.from('# Hello world\nThis is the README.').toString('base64') });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const result = await githubExtractor('https://github.com/anthropics/claude-code', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /anthropics\/claude-code/);
  assert.match(result.content, /Claude Code CLI/);
  assert.match(result.content, /12345/);
  assert.match(result.content, /TypeScript/);
  assert.match(result.content, /Hello world/);
  assert.equal(result.extractor, 'github');
});

test('githubExtractor handles trailing slash on repo URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/repos/foo/bar/readme')) return jsonResponse({ content: Buffer.from('readme').toString('base64') });
    if (url.includes('/repos/foo/bar')) return jsonResponse({ full_name: 'foo/bar', description: '', stargazers_count: 0, topics: [] });
    throw new Error('unexpected');
  });
  const result = await githubExtractor('https://github.com/foo/bar/', { fetchImpl: fakeFetch });
  assert.ok(result.content);
});

test('githubExtractor strips .git suffix from repo name', async () => {
  let capturedRepoCall = null;
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/repos/foo/bar') && !url.includes('/readme')) {
      capturedRepoCall = url;
      return jsonResponse({ full_name: 'foo/bar', description: '', stargazers_count: 0, topics: [] });
    }
    return jsonResponse({ content: '' });
  });
  await githubExtractor('https://github.com/foo/bar.git', { fetchImpl: fakeFetch });
  // Check the path part doesn't end with .git (api.github contains .git as substring, so naive includes won't work)
  assert.ok(!capturedRepoCall.endsWith('.git'), `path should not end with .git: ${capturedRepoCall}`);
  assert.match(capturedRepoCall, /\/repos\/foo\/bar$/, `path should be /repos/foo/bar (without .git): ${capturedRepoCall}`);
});

test('githubExtractor fetches issue content for issue URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/issues/42/comments')) {
      return jsonResponse([
        { user: { login: 'alice' }, body: 'first comment' },
        { user: { login: 'bob' }, body: 'second comment' },
      ]);
    }
    if (url.includes('/issues/42')) {
      return jsonResponse({
        title: 'Bug: things broken',
        state: 'open',
        user: { login: 'reporter' },
        comments: 2,
        body: 'Detailed description of bug.',
      });
    }
    throw new Error('unexpected');
  });

  const result = await githubExtractor('https://github.com/owner/repo/issues/42', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /Bug: things broken/);
  assert.match(result.content, /Detailed description/);
  assert.match(result.content, /alice/);
  assert.match(result.content, /first comment/);
});

test('githubExtractor uses same code path for PR URLs', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/issues/7') && !url.includes('/comments')) return jsonResponse({ title: 'PR title', state: 'open', user: { login: 'u' }, comments: 0, body: 'pr body' });
    if (url.includes('/comments')) return jsonResponse([]);
    throw new Error('unexpected');
  });
  const result = await githubExtractor('https://github.com/owner/repo/pull/7', { fetchImpl: fakeFetch });
  assert.match(result.content, /PR title/);
  assert.match(result.content, /pr body/);
});

test('githubExtractor surfaces 404 as error', async () => {
  const fakeFetch = makeFetch(async () => errorResponse(404));
  const result = await githubExtractor('https://github.com/foo/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('githubExtractor truncates long content', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/readme')) return jsonResponse({ content: Buffer.from('x'.repeat(10000)).toString('base64') });
    return jsonResponse({ full_name: 'a/b', description: '', stargazers_count: 0, topics: [] });
  });
  const result = await githubExtractor('https://github.com/a/b', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});

test('githubExtractor passes Authorization header when GITHUB_TOKEN provided', async () => {
  let capturedHeaders = null;
  const fakeFetch = makeFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    if (url.includes('/readme')) return jsonResponse({ content: '' });
    return jsonResponse({ full_name: 'a/b', description: '', stargazers_count: 0, topics: [] });
  });
  await githubExtractor('https://github.com/a/b', { fetchImpl: fakeFetch, token: 'ghp_test' });
  assert.equal(capturedHeaders['Authorization'], 'Bearer ghp_test');
});

test('githubExtractor returns error for malformed github URL', async () => {
  const result = await githubExtractor('https://github.com/', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});
