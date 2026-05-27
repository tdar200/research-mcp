#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { smartFetch } from '../src/fetch.js';

const cases = [
  { name: 'GitHub repo',         url: 'https://github.com/anthropics/claude-code' },
  { name: 'GitHub issue',        url: 'https://github.com/anthropics/claude-code/issues/1' },
  { name: 'NPM package',         url: 'https://www.npmjs.com/package/express' },
  { name: 'Stack Overflow',      url: 'https://stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript' },
  { name: 'MDN',                 url: 'https://developer.mozilla.org/en-US/docs/Web/API/fetch' },
  { name: 'Generic blog (jina)', url: 'https://overreacted.io/' },
];

for (const c of cases) {
  process.stdout.write(`${c.name.padEnd(25)} `);
  const t0 = Date.now();
  const r = await smartFetch(c.url, { maxChars: 1500 });
  const ms = Date.now() - t0;
  if (r.error) {
    console.log(`FAIL ${ms}ms — ${r.error.slice(0, 80)}`);
  } else {
    console.log(`OK ${ms}ms — title="${(r.title || '').slice(0, 40)}" content=${r.content.length} chars`);
  }
}
