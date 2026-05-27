#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { searxngSearch, isSearxngReachable } from '../src/searxng.js';
import { webSearch } from '../src/search.js';

console.log('— Reachability —');
const reachable = await isSearxngReachable('http://localhost:8888');
console.log(`SearXNG reachable: ${reachable}`);

if (!reachable) {
  console.log('Start with: docker compose up -d searxng');
  process.exit(1);
}

console.log('\n— Direct searxngSearch —');
const direct = await searxngSearch('TanStack Query v5 partialMatchKey', 3);
console.log(`Got ${direct.length} results:`);
direct.forEach((r, i) => console.log(`  ${i + 1}. ${r.title.slice(0, 60)}  → ${r.url}`));

console.log('\n— Via webSearch router (auto mode) —');
const routed = await webSearch('Node.js better-sqlite3 vs node sqlite built-in', 3, { backend: 'auto' });
console.log(`Router picked: ${routed.length} results`);
routed.forEach((r, i) => console.log(`  ${i + 1}. ${r.title.slice(0, 60)}  → ${r.url}`));
