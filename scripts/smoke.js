#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { searchAndRead } from '../src/combine.js';

const out = await searchAndRead('TanStack Query v5 partialMatchKey', {
  numResults: 2,
  maxCharsPerResult: 2000,
});

console.log('query:', out.query);
console.log('result count:', out.results.length);
out.results.forEach((r, i) => {
  console.log('---', i + 1, '---');
  console.log('title:', r.title);
  console.log('url:', r.url);
  console.log('content length:', r.content ? r.content.length : 'null');
  console.log('error:', r.error || 'none');
});
