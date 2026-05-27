#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { crawl4aiFetch, isCrawl4aiReachable } from '../src/crawl4ai.js';
import { smartFetch } from '../src/fetch.js';

console.log('— Reachability —');
const reachable = await isCrawl4aiReachable();
console.log(`Crawl4AI reachable: ${reachable}`);
if (!reachable) { console.log('Start with: docker compose up -d crawl4ai'); process.exit(1); }

const cases = [
  { label: 'simple page', url: 'https://example.com' },
  { label: 'docs site', url: 'https://docs.crawl4ai.com/' },
  { label: 'JS-heavy SPA', url: 'https://react.dev/' },
];

console.log('\n— Direct crawl4aiFetch —');
for (const c of cases) {
  process.stdout.write(`${c.label.padEnd(20)} `);
  const t0 = Date.now();
  const r = await crawl4aiFetch(c.url, { maxChars: 2000 });
  const ms = Date.now() - t0;
  if (r.error) console.log(`FAIL ${ms}ms — ${r.error.slice(0, 80)}`);
  else console.log(`OK ${ms}ms — title="${(r.title || '').slice(0, 40)}" content=${r.content.length} chars`);
}

console.log('\n— Via smartFetch (full cascade) —');
for (const c of cases) {
  process.stdout.write(`${c.label.padEnd(20)} `);
  const t0 = Date.now();
  const r = await smartFetch(c.url, { maxChars: 2000 });
  const ms = Date.now() - t0;
  if (r.error) console.log(`FAIL ${ms}ms — ${r.error.slice(0, 80)}`);
  else console.log(`OK ${ms}ms — extractor="${r.extractor || 'unknown'}" content=${r.content.length} chars`);
}
