import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanContent,
  LINE_DROP_PATTERNS,
  MAX_DROP_LINE_LEN,
  MAX_PROMO_BLOCK_LINES,
} from '../src/clean.js';
import { checkUrlIdentity } from '../src/urlIdentity.js';

test('cleanContent strips a Reddit Promoted ad block but keeps the post body', () => {
  const input = [
    '# How I self-host my AI stack',
    '',
    'Promoted',
    'VPS Hosting For Self Hosted AI Tools',
    'evomi.com SERP scraping',
    '',
    'This is the real post body that explains the setup in detail.',
  ].join('\n');

  const { content, removedKinds } = cleanContent(input);
  assert.ok(removedKinds.includes('promoted'));
  assert.doesNotMatch(content, /VPS Hosting/);
  assert.doesNotMatch(content, /evomi\.com/);
  assert.match(content, /This is the real post body/);
  // boundary heading and the post heading both survive
  assert.match(content, /# How I self-host my AI stack/);
});

test('cleanContent removes Skip to main content navigation line (plain + markdown link)', () => {
  const input = [
    'Skip to main content',
    '',
    '[Skip to main content](#main)',
    '',
    'Real article text follows here and should be preserved.',
  ].join('\n');

  const { content } = cleanContent(input);
  assert.doesNotMatch(content, /Skip to main content/);
  assert.match(content, /Real article text follows/);
});

test('cleanContent removes login/nav/cookie chrome lines but keeps long prose with the word cookies', () => {
  const longProse =
    'We use cookies and a service worker for offline caching, and here is a much longer ' +
    'explanation that goes well past the length cap so it must be kept as real content.';
  assert.ok(longProse.length > MAX_DROP_LINE_LEN); // sanity: this is genuinely long

  const input = [
    'Log In',
    'Sign Up',
    'Create account',
    'Accept all cookies',
    'We use cookies to...',
    'Home / r/selfhosted',
    '',
    longProse,
    '',
    'Body paragraph that is the actual content.',
  ].join('\n');

  const { content } = cleanContent(input);
  assert.doesNotMatch(content, /^Log In$/m);
  assert.doesNotMatch(content, /^Sign Up$/m);
  assert.doesNotMatch(content, /^Create account$/m);
  assert.doesNotMatch(content, /^Accept all cookies$/m);
  assert.doesNotMatch(content, /^We use cookies to\.\.\.$/m);
  assert.doesNotMatch(content, /^Home \/ r\/selfhosted$/m);
  // length-guard keeps the long prose line even though it contains 'cookies'
  assert.match(content, /service worker for offline caching/);
  assert.match(content, /actual content/);
});

test('cleanContent does NOT remove a long prose line that contains a drop keyword', () => {
  const prose =
    'Promoted by the community, this approach to self-hosting AI tools has been refined ' +
    'over many months and remains the most reliable method we have documented to date.';
  assert.ok(prose.length > MAX_DROP_LINE_LEN);

  const { content, removedLineCount } = cleanContent(prose);
  assert.match(content, /Promoted by the community/);
  assert.equal(removedLineCount, 0);
});

test('cleanContent caps Promoted block removal at MAX_PROMO_BLOCK_LINES', () => {
  const adLines = [];
  for (let i = 0; i < 30; i++) adLines.push(`Ad line number ${i} with no boundary`);
  const input = ['Promoted', ...adLines].join('\n');

  const { content, removedLineCount } = cleanContent(input);
  assert.equal(removedLineCount, MAX_PROMO_BLOCK_LINES);
  // The remaining ad lines (which in a malformed page would be real content) survive.
  assert.match(content, /Ad line number 29/);
  // exactly the first (MAX_PROMO_BLOCK_LINES - 1) ad lines were eaten with the 'Promoted' label
  assert.doesNotMatch(content, /Ad line number 0 /);
});

test('cleanContent returns null-safe result for null/empty/non-string input', () => {
  for (const v of [null, undefined, '', 123, {}]) {
    const r = cleanContent(v);
    assert.deepEqual(r, { content: null, removedLineCount: 0, removedKinds: [] });
  }
});

test('cleanContent collapses excess blank lines left after removals', () => {
  const input = [
    'Log In',
    '',
    '',
    'Sign Up',
    '',
    '',
    '',
    'Real content here.',
  ].join('\n');

  const { content } = cleanContent(input);
  assert.doesNotMatch(content, /\n\n\n/);
  assert.match(content, /Real content here\./);
});

test('cleanContent honors injected extraLinePatterns', () => {
  const input = ['Sponsored line', 'Sponsored', 'Keep this real line.'].join('\n');
  const { content } = cleanContent(input, { extraLinePatterns: [/^Sponsored$/] });
  // bare 'Sponsored' matches both built-in and injected; injected catches exact form
  assert.doesNotMatch(content, /^Sponsored$/m);
  assert.match(content, /Keep this real line\./);
});

test('cleanContent disabled passes content through unchanged', () => {
  const input = 'Log In\n\nReal body';
  const r = cleanContent(input, { enabled: false });
  assert.equal(r.content, input);
  assert.equal(r.removedLineCount, 0);
});

test('cleanContent returns content:null when cleaning empties the document', () => {
  const input = ['Skip to main content', 'Log In', 'Sign Up', 'Promoted'].join('\n');
  const { content } = cleanContent(input);
  assert.equal(content, null);
});

test('LINE_DROP_PATTERNS is an exported array of RegExp', () => {
  assert.ok(Array.isArray(LINE_DROP_PATTERNS));
  assert.ok(LINE_DROP_PATTERNS.length > 0);
  for (const p of LINE_DROP_PATTERNS) assert.ok(p instanceof RegExp);
});

test('checkUrlIdentity flags differing Reddit comment ids and ignores slug-only changes', () => {
  const base = 'https://reddit.com/r/x/comments/abc123/';

  // same id, different slug => no mismatch
  assert.equal(
    checkUrlIdentity(base + 'fabricated_slug/', base + 'totally_different_post/'),
    null,
  );

  // different id => mismatch
  const diff = checkUrlIdentity(
    'https://reddit.com/r/x/comments/abc123/fabricated_slug/',
    'https://reddit.com/r/x/comments/zzz999/some_other_post/',
  );
  assert.ok(diff);
  assert.equal(diff.requested, 'https://reddit.com/r/x/comments/abc123/fabricated_slug/');
  assert.equal(diff.landed, 'https://reddit.com/r/x/comments/zzz999/some_other_post/');
  assert.match(diff.reason, /path identity differs/);

  // different host => mismatch
  const hostMm = checkUrlIdentity('https://example.com/a', 'https://evil.com/a');
  assert.ok(hostMm);
  assert.equal(hostMm.reason, 'host differs');
});

test('checkUrlIdentity is lenient: www/trailing-slash/query/fragment do not flag', () => {
  assert.equal(
    checkUrlIdentity('https://www.example.com/article/', 'https://example.com/article'),
    null,
  );
  assert.equal(
    checkUrlIdentity('https://example.com/p?utm=1#top', 'https://example.com/p'),
    null,
  );
});

test('checkUrlIdentity flags a genuinely different non-Reddit path', () => {
  const mm = checkUrlIdentity('https://example.com/articles/real', 'https://example.com/login');
  assert.ok(mm);
  assert.equal(mm.reason, 'path identity differs');
});
