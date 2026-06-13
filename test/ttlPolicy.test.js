import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ttlClassFor,
  resolveTtlMs,
  TTL_CLASS,
  TTL_MULTIPLIERS,
} from '../src/ttlPolicy.js';

test('ttlClassFor returns short for source=news', () => {
  assert.equal(ttlClassFor({ tool: 'web_search', source: 'news' }), 'short');
  assert.equal(ttlClassFor({ tool: 'web_search', source: 'news' }), TTL_CLASS.SHORT);
});

test('ttlClassFor returns short for time_range=day', () => {
  assert.equal(
    ttlClassFor({ tool: 'search_and_read', source: 'web', timeRange: 'day' }),
    'short',
  );
  // week is also short.
  assert.equal(
    ttlClassFor({ tool: 'search_and_read', source: 'web', timeRange: 'week' }),
    'short',
  );
});

test('ttlClassFor returns static for doc/code hosts', () => {
  const staticUrls = [
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    'https://github.com/nodejs/node',
    'https://stackoverflow.com/questions/12345/foo',
    'https://www.npmjs.com/package/zod',
    'https://docs.python.org/3/library/asyncio.html',
    'https://something.readthedocs.io/en/latest/',
    'https://example.com/whitepaper.pdf',
    'https://example.com/report.pdf?download=1',
  ];
  for (const url of staticUrls) {
    assert.equal(
      ttlClassFor({ tool: 'fetch_url', url }),
      'static',
      `expected static for ${url}`,
    );
  }
});

test('ttlClassFor returns long for generic search and arbitrary fetch_url', () => {
  assert.equal(
    ttlClassFor({ tool: 'web_search', source: 'web', timeRange: 'all' }),
    'long',
  );
  assert.equal(
    ttlClassFor({ tool: 'fetch_url', url: 'https://random.example.com/post' }),
    'long',
  );
});

test('resolveTtlMs returns 0 when base ttl is 0 or NaN', () => {
  const anySpec = { tool: 'web_search', source: 'news' };
  assert.equal(resolveTtlMs(anySpec, 0), 0);
  assert.equal(resolveTtlMs(anySpec, Number.NaN), 0);
  // negative base also disables caching.
  assert.equal(resolveTtlMs(anySpec, -5), 0);
  // class is irrelevant to the short-circuit.
  assert.equal(resolveTtlMs({ tool: 'fetch_url', url: 'https://github.com/x' }, 0), 0);
});

test('resolveTtlMs applies class multipliers to base', () => {
  const base = 24 * 3600 * 1000; // 24h in ms

  const shortSpec = { tool: 'web_search', source: 'news' };
  const longSpec = { tool: 'web_search', source: 'web', timeRange: 'all' };
  const staticSpec = { tool: 'fetch_url', url: 'https://github.com/x' };

  assert.equal(resolveTtlMs(shortSpec, base), Math.round(base * TTL_MULTIPLIERS.short));
  assert.equal(resolveTtlMs(longSpec, base), Math.round(base * TTL_MULTIPLIERS.long));
  assert.equal(resolveTtlMs(staticSpec, base), Math.round(base * TTL_MULTIPLIERS.static));

  // Spelled-out exact products: short ~= 1h, long = 7*24h, static = 30*24h.
  assert.equal(resolveTtlMs(shortSpec, base), 3600 * 1000);
  assert.equal(resolveTtlMs(longSpec, base), 7 * 24 * 3600 * 1000);
  assert.equal(resolveTtlMs(staticSpec, base), 30 * 24 * 3600 * 1000);
});
