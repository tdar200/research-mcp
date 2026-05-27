#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { searchAndRead } from '../src/combine.js';

const query = 'marketing strategy for selling SaaS POS to restaurants small business';

console.log(`Query: "${query}"\n`);
console.time('elapsed');

const out = await searchAndRead(query, {
  numResults: 5,
  maxCharsPerResult: 4000,
});

console.timeEnd('elapsed');
console.log(`Results: ${out.results.length}\n`);

out.results.forEach((r, i) => {
  console.log('━'.repeat(80));
  console.log(`#${i + 1}  ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet}`);
  console.log(`Content: ${r.content ? r.content.length + ' chars' : 'NULL'}${r.truncated ? ' (truncated)' : ''}`);
  if (r.error) console.log(`Error: ${r.error}`);
  if (r.content) {
    console.log('\n--- content preview (first 800 chars) ---');
    console.log(r.content.slice(0, 800));
  }
  console.log();
});
