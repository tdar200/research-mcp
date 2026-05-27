#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

import { Cache } from '../src/cache.js';
import { searchAndRead } from '../src/combine.js';

const DB = join(homedir(), '.research-mcp', 'smoke-cache.db');
if (existsSync(DB)) unlinkSync(DB);

const cache = new Cache({ dbPath: DB });
const query = 'Node.js better-sqlite3 vs node sqlite built-in';

console.log('\n— First call (cache miss, real network) —');
console.time('first');
await searchAndRead(query, { numResults: 2, maxCharsPerResult: 1500, cache, ttlMs: 60 * 60 * 1000 });
console.timeEnd('first');

console.log('\n— Second call (cache hit, no network) —');
console.time('second');
const out2 = await searchAndRead(query, { numResults: 2, maxCharsPerResult: 1500, cache, ttlMs: 60 * 60 * 1000 });
console.timeEnd('second');

console.log('\n— list_research —');
console.log(JSON.stringify(cache.list({ limit: 5 }), null, 2));

console.log('\n— get_research(id=1) preview —');
const entry = cache.getById(1);
console.log({ tool: entry.tool, query: entry.query, result_summary: `${entry.result.results.length} results` });

console.log(`\nSecond call should be MUCH faster than the first. If not, cache wiring is broken.`);
cache.close();
