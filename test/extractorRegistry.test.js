import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExtractor, listExtractors } from '../src/extractorRegistry.js';

test('findExtractor matches github repo URL', () => {
  const e = findExtractor('https://github.com/facebook/react');
  assert.ok(e, 'should match');
  assert.equal(e.name, 'github');
});

test('findExtractor matches github subpath URLs (issues/PR)', () => {
  assert.ok(findExtractor('https://github.com/anthropics/claude-code/issues/123'));
  assert.ok(findExtractor('https://github.com/owner/repo/pull/456'));
});

test('findExtractor matches www.github.com', () => {
  assert.ok(findExtractor('https://www.github.com/foo/bar'));
});

test('findExtractor matches npm package URL', () => {
  const e = findExtractor('https://www.npmjs.com/package/express');
  assert.equal(e.name, 'npm');
});

test('findExtractor matches scoped npm package URL', () => {
  const e = findExtractor('https://www.npmjs.com/package/@anthropic-ai/sdk');
  assert.equal(e.name, 'npm');
});

test('findExtractor matches stack overflow question URL', () => {
  const e = findExtractor('https://stackoverflow.com/questions/12345/some-title');
  assert.equal(e.name, 'stackoverflow');
});

test('findExtractor matches MDN URL', () => {
  const e = findExtractor('https://developer.mozilla.org/en-US/docs/Web/API/fetch');
  assert.equal(e.name, 'mdn');
});

test('findExtractor returns null for unknown URLs', () => {
  assert.equal(findExtractor('https://random-blog.example.com/post/123'), null);
});

test('listExtractors returns metadata for all extractors', () => {
  const list = listExtractors();
  const names = list.map(e => e.name).sort();
  assert.deepEqual(names, ['github', 'mdn', 'npm', 'stackoverflow']);
  for (const e of list) {
    assert.equal(typeof e.pattern, 'string');
  }
});
