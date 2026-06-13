import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateAtBoundary } from '../src/truncate.js';

test('truncateAtBoundary is a no-op when text length <= maxChars', () => {
  const shorter = 'hello world';
  const r1 = truncateAtBoundary(shorter, 100);
  assert.equal(r1.content, shorter); // byte-identical
  assert.equal(r1.truncated, false);

  // exact-length boundary: length === maxChars must also be a no-op (strict > only)
  const exact = 'x'.repeat(50);
  const r2 = truncateAtBoundary(exact, 50);
  assert.equal(r2.content, exact);
  assert.equal(r2.content.length, 50);
  assert.equal(r2.truncated, false);
});

test('truncateAtBoundary cuts at preceding sentence boundary within window', () => {
  const text = 'Sentence one. Sentence two. Sentence three.';
  // maxChars lands inside "three" -> last full sentence ending <= maxChars is "two."
  const maxChars = 35;
  const { content, truncated } = truncateAtBoundary(text, maxChars);

  assert.equal(truncated, true);
  assert.ok(content.length <= maxChars, `length ${content.length} <= ${maxChars}`);
  assert.equal(content, 'Sentence one. Sentence two.');
  assert.match(content, /[.!?]$/); // ends on a sentence boundary, not mid-token
});

test('truncateAtBoundary falls back to last whitespace when no sentence boundary in window', () => {
  // No punctuation at all -> must fall back to a whitespace cut.
  const text = 'word '.repeat(50); // "word word word ..." length 250
  const maxChars = 23; // lands mid-word ("word word word word wo|rd ")
  const { content, truncated } = truncateAtBoundary(text, maxChars);

  assert.equal(truncated, true);
  assert.ok(content.length <= maxChars, `length ${content.length} <= ${maxChars}`);
  // No partial word remains: every non-empty token in the result is a complete "word"
  const tokens = content.split(/\s+/).filter(Boolean);
  assert.ok(tokens.length > 0, 'should retain at least one full token');
  assert.ok(tokens.every((w) => w === 'word'), 'no partial token remains after a whitespace cut');
  // whitespace cut + trimEnd() means it does not end with a trailing space
  assert.ok(!content.endsWith(' '), 'trimEnd removes the trailing space');
});

test('truncateAtBoundary hard-cuts a single giant token with no boundary in window', () => {
  const text = 'x'.repeat(5000);
  const maxChars = 100;
  const { content, truncated } = truncateAtBoundary(text, maxChars, { window: 10 });

  assert.equal(truncated, true);
  assert.equal(content.length, 100); // exact hard cut, graceful degradation
  assert.equal(content, 'x'.repeat(100));
});

test('truncateAtBoundary never exceeds maxChars', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta! Eta theta iota? '.repeat(20);
  for (const maxChars of [10, 25, 50, 100, 250, 500, text.length, text.length + 100]) {
    const { content, truncated } = truncateAtBoundary(text, maxChars);
    assert.ok(content.length <= maxChars, `content.length ${content.length} <= ${maxChars}`);
    if (text.length <= maxChars) {
      assert.equal(truncated, false);
      assert.equal(content, text);
    } else {
      assert.equal(truncated, true);
    }
  }
});

test('truncateAtBoundary handles null/undefined content defensively', () => {
  const rNull = truncateAtBoundary(null, 100);
  assert.equal(rNull.content, null);
  assert.equal(rNull.truncated, false);

  const rUndef = truncateAtBoundary(undefined, 100);
  assert.equal(rUndef.content, undefined);
  assert.equal(rUndef.truncated, false);
});
