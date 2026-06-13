import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  wrapUntrusted,
  wrapFetchResult,
  wrapSearchResult,
} from '../src/untrusted.js';

test('wrapUntrusted fences a non-empty string with begin/end markers', () => {
  const out = wrapUntrusted('hello world');
  assert.ok(out.startsWith(UNTRUSTED_BEGIN), 'starts with BEGIN marker');
  assert.ok(out.endsWith(UNTRUSTED_END), 'ends with END marker');
  // Original content is verbatim and on its own line between the markers.
  assert.equal(out, `${UNTRUSTED_BEGIN}\nhello world\n${UNTRUSTED_END}`);
  const lines = out.split('\n');
  assert.equal(lines[0], UNTRUSTED_BEGIN);
  assert.equal(lines[1], 'hello world');
  assert.equal(lines[2], UNTRUSTED_END);
});

test('wrapUntrusted returns null/empty unchanged', () => {
  assert.equal(wrapUntrusted(null), null);
  assert.equal(wrapUntrusted(''), '');
  // Non-string, non-null inputs also pass through untouched.
  assert.equal(wrapUntrusted(undefined), undefined);
});

test('wrapUntrusted is idempotent (no double-wrap)', () => {
  const once = wrapUntrusted('body text');
  const twice = wrapUntrusted(once);
  assert.equal(twice, once, 'second wrap is a no-op');
  // Exactly one BEGIN/END marker — no nesting.
  assert.equal(twice.split(UNTRUSTED_BEGIN).length - 1, 1);
  assert.equal(twice.split(UNTRUSTED_END).length - 1, 1);
});

test('wrapFetchResult wraps content and preserves other fields', () => {
  const input = { url: 'https://x.test', title: 'T', content: 'body', truncated: true };
  const inputCopy = { url: 'https://x.test', title: 'T', content: 'body', truncated: true };

  const out = wrapFetchResult(input);

  assert.equal(out.url, 'https://x.test');
  assert.equal(out.title, 'T');
  assert.equal(out.truncated, true);
  assert.equal(out.content, `${UNTRUSTED_BEGIN}\nbody\n${UNTRUSTED_END}`);
  // New object, input not mutated.
  assert.notEqual(out, input);
  assert.deepEqual(input, inputCopy, 'input must not be mutated');
});

test('wrapFetchResult leaves content:null error results untouched', () => {
  const input = { url: 'https://x.test', content: null, error: 'rate limit (429)' };
  const out = wrapFetchResult(input);
  assert.equal(out.content, null);
  assert.equal(out.error, 'rate limit (429)');
  // No markers introduced anywhere.
  assert.equal(out, input);
});

test('wrapFetchResult with enabled:false is a passthrough', () => {
  const input = { url: 'https://x.test', content: 'body' };
  const out = wrapFetchResult(input, { enabled: false });
  assert.equal(out, input, 'same reference returned');
  assert.equal(out.content, 'body', 'no markers');
});

test('wrapSearchResult wraps each result content and skips error/null entries', () => {
  const input = {
    query: 'q',
    results: [
      { title: 'A', snippet: 'snip a', content: 'a' },
      { title: 'B', snippet: 'snip b', content: null, error: 'x' },
    ],
  };
  const inputCopy = JSON.parse(JSON.stringify(input));

  const out = wrapSearchResult(input);

  assert.equal(out.query, 'q');
  assert.equal(out.results.length, 2);
  // First entry fenced, order preserved, snippet NOT wrapped.
  assert.equal(out.results[0].content, `${UNTRUSTED_BEGIN}\na\n${UNTRUSTED_END}`);
  assert.equal(out.results[0].snippet, 'snip a');
  assert.equal(out.results[0].title, 'A');
  // Second (error/null) entry left untouched.
  assert.equal(out.results[1].content, null);
  assert.equal(out.results[1].error, 'x');
  // New payload + new array, input not mutated.
  assert.notEqual(out, input);
  assert.notEqual(out.results, input.results);
  assert.deepEqual(input, inputCopy, 'input must not be mutated');
});

test('wrapSearchResult with enabled:false is a passthrough', () => {
  const input = { query: 'q', results: [{ content: 'a' }] };
  const out = wrapSearchResult(input, { enabled: false });
  assert.equal(out, input, 'same reference returned');
  assert.equal(out.results[0].content, 'a', 'no markers');
});

test('markers survive truncated content (marker not cut)', () => {
  // Simulate content already truncated upstream to maxChars; markers are
  // applied AROUND it, so the END marker is fully present after the body.
  const maxChars = 64;
  const truncatedBody = 'x'.repeat(maxChars);
  assert.equal(truncatedBody.length, maxChars);

  const out = wrapUntrusted(truncatedBody);
  assert.ok(out.startsWith(UNTRUSTED_BEGIN));
  assert.ok(out.endsWith(UNTRUSTED_END), 'END marker fully present after body');
  assert.ok(out.includes(`\n${truncatedBody}\n`), 'full truncated body preserved verbatim');
});
