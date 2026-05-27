import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKeyFor } from '../src/cacheKey.js';

test('cacheKeyFor is deterministic for same input', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('web_search', ['foo', 5]);
  assert.equal(a, b);
});

test('cacheKeyFor differs across tools with same params', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('search_and_read', ['foo', 5]);
  assert.notEqual(a, b);
});

test('cacheKeyFor differs when params differ', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('web_search', ['foo', 6]);
  assert.notEqual(a, b);
});

test('cacheKeyFor avoids concat-ambiguity (NUL separator)', () => {
  const a = cacheKeyFor('web_search', ['ab', 'c']);
  const b = cacheKeyFor('web_search', ['a', 'bc']);
  assert.notEqual(a, b);
});

test('cacheKeyFor returns hex string', () => {
  const k = cacheKeyFor('web_search', ['foo', 5]);
  assert.match(k, /^[0-9a-f]{64}$/);
});
