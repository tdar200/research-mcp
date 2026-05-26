import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDuckDuckGoHtml } from '../src/search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'ddg-results.html');

test('parseDuckDuckGoHtml extracts results from real DDG response', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const results = parseDuckDuckGoHtml(html, 5);

  assert.ok(results.length >= 3, `expected ≥3 results, got ${results.length}`);
  assert.ok(results.length <= 5, `expected ≤5 results, got ${results.length}`);

  for (const r of results) {
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0, 'title should be non-empty');
    assert.match(r.url, /^https?:\/\//, `url should be absolute: ${r.url}`);
    assert.equal(typeof r.snippet, 'string');
  }
});

test('parseDuckDuckGoHtml respects num_results limit', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const results = parseDuckDuckGoHtml(html, 2);
  assert.equal(results.length, 2);
});

test('parseDuckDuckGoHtml returns [] on empty html', () => {
  const results = parseDuckDuckGoHtml('', 5);
  assert.deepEqual(results, []);
});
