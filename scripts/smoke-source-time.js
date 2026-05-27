#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { webSearch } from '../src/search.js';

const cases = [
  { label: 'web (default)',       opts: { source: 'web' } },
  { label: 'reddit',              opts: { source: 'reddit' } },
  { label: 'hackernews',          opts: { source: 'hackernews' } },
  { label: 'news',                opts: { source: 'news' } },
  { label: 'web + month',         opts: { source: 'web',    timeRange: 'month' } },
  { label: 'reddit + year',       opts: { source: 'reddit', timeRange: 'year'  } },
];

const query = 'Foodhub pricing';

for (const c of cases) {
  process.stdout.write(`${c.label.padEnd(20)} `);
  const t0 = Date.now();
  try {
    const results = await webSearch(query, 3, c.opts);
    const ms = Date.now() - t0;
    console.log(`OK ${ms}ms — ${results.length} results`);
    results.forEach((r, i) => console.log(`    ${i + 1}. ${r.title.slice(0, 60)}  → ${r.url}`));
  } catch (e) {
    console.log(`FAIL — ${e.message.slice(0, 100)}`);
  }
}
