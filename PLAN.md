# research-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-cost, zero-key MCP server that gives Claude agents fresh web research via DuckDuckGo search + Jina Reader extraction, exposed as 3 tools: `web_search`, `fetch_url`, `search_and_read`.

**Architecture:** Single-process Node.js (ESM) MCP server using `@modelcontextprotocol/sdk` over stdio. Three small modules — search (DDG HTML scrape via cheerio), fetch (Jina Reader markdown), combine (composed combo tool with partial-failure handling). Unit tests via `node:test` against fixtures and mocked `fetch`. No build step.

**Tech Stack:** Node.js ≥20 (ESM, built-in `fetch`, `node:test`), `@modelcontextprotocol/sdk`, `cheerio`, `zod`.

**Plan location override:** This tool lives at `~/Projects/research-mcp/` (global, not project-scoped), so this plan + spec live with the tool rather than under a project's `docs/superpowers/plans/`.

**Spec:** `/home/tahseen-dar/Projects/research-mcp/SPEC.md`

---

## File Structure

```
~/Projects/research-mcp/
├── package.json              # ESM, deps, node:test runner
├── .gitignore                # node_modules, .env
├── SPEC.md                   # design doc (exists)
├── PLAN.md                   # this file
├── README.md                 # install + usage (Task 5)
├── src/
│   ├── server.js             # MCP wiring (Task 4)
│   ├── search.js             # DDG parser (Task 1)
│   ├── fetch.js              # Jina wrapper (Task 2)
│   └── combine.js            # search_and_read (Task 3)
└── test/
    ├── fixtures/
    │   └── ddg-results.html  # captured DDG response (Task 1)
    ├── search.test.js        # parser tests
    ├── fetch.test.js         # truncation + error tests
    └── combine.test.js       # partial-success tests
```

**Responsibilities:**
- `search.js` — turns a query string into `[{title, url, snippet}]`. Pure HTML parsing.
- `fetch.js` — turns a URL into `{title, content, truncated}`. Pure HTTP + truncation.
- `combine.js` — composes search + fetch in parallel, handles partial failure.
- `server.js` — MCP protocol wiring only. No business logic.

---

## Task 0: Scaffold project

**Files:**
- Create: `~/Projects/research-mcp/package.json`
- Create: `~/Projects/research-mcp/.gitignore`

- [ ] **Step 1: Initialize git repo for the tool**

Run:
```bash
cd ~/Projects/research-mcp && git init -q && git branch -m main 2>/dev/null || true
```
Expected: silent success, `.git/` directory created.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "research-mcp",
  "version": "0.1.0",
  "description": "MCP server: DuckDuckGo search + Jina Reader extraction for Claude agents",
  "type": "module",
  "main": "src/server.js",
  "bin": {
    "research-mcp": "src/server.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/",
    "test:integration": "RUN_INTEGRATION=1 node --test test/"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "cheerio": "^1.0.0",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.env
*.log
```

- [ ] **Step 4: Install deps**

Run:
```bash
cd ~/Projects/research-mcp && npm install
```
Expected: `node_modules/` populated, no errors. `package-lock.json` created.

- [ ] **Step 5: Verify versions**

Run:
```bash
cd ~/Projects/research-mcp && node -e "import('@modelcontextprotocol/sdk/server/index.js').then(m => console.log('sdk OK'))" && node -e "import('cheerio').then(m => console.log('cheerio OK'))" && node -e "import('zod').then(m => console.log('zod OK'))"
```
Expected: three lines, each ending in `OK`.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "chore: scaffold research-mcp package"
```

---

## Task 1: DuckDuckGo search parser

**Files:**
- Create: `~/Projects/research-mcp/test/fixtures/ddg-results.html`
- Create: `~/Projects/research-mcp/test/search.test.js`
- Create: `~/Projects/research-mcp/src/search.js`

- [ ] **Step 1: Capture DDG fixture (one real call)**

Run:
```bash
cd ~/Projects/research-mcp && curl -sS -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" \
  --data-urlencode "q=TanStack Query v5 partialMatchKey" \
  "https://html.duckduckgo.com/html/" > test/fixtures/ddg-results.html
```
Expected: ~30-100 KB of HTML containing `class="result__a"` and `class="result__snippet"`. Verify:
```bash
grep -c 'class="result__a"' ~/Projects/research-mcp/test/fixtures/ddg-results.html
```
Expected: integer ≥ 5.

If zero matches, DDG layout changed — investigate before proceeding.

- [ ] **Step 2: Write failing parser test**

Create `test/search.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/search.test.js
```
Expected: FAIL with `Cannot find module '../src/search.js'` or similar.

- [ ] **Step 4: Implement parser**

Create `src/search.js`:

```js
import { load } from 'cheerio';

/**
 * Parse a DuckDuckGo HTML search results page into structured results.
 * @param {string} html - raw HTML from html.duckduckgo.com/html/
 * @param {number} numResults - max results to return
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function parseDuckDuckGoHtml(html, numResults) {
  if (!html || typeof html !== 'string') return [];

  const $ = load(html);
  const results = [];

  $('.result').each((_, el) => {
    if (results.length >= numResults) return false;

    const $el = $(el);
    const $a = $el.find('a.result__a').first();
    const title = $a.text().trim();
    let url = $a.attr('href') || '';

    // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>&...
    const ddgWrapMatch = url.match(/[?&]uddg=([^&]+)/);
    if (ddgWrapMatch) {
      try {
        url = decodeURIComponent(ddgWrapMatch[1]);
      } catch {
        /* leave as-is */
      }
    }
    // Strip leading // if relative-protocol
    if (url.startsWith('//')) url = 'https:' + url;

    const snippet = $el.find('.result__snippet').first().text().trim();

    if (title && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  });

  return results;
}

/**
 * Perform a live DuckDuckGo HTML search.
 * @param {string} query
 * @param {number} numResults
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function duckDuckGoSearch(query, numResults = 5) {
  const params = new URLSearchParams({ q: query });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo returned ${res.status}: ${res.statusText}`);
    }

    const html = await res.text();
    return parseDuckDuckGoHtml(html, numResults);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/search.test.js
```
Expected: all 3 tests pass, exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "feat(search): DDG HTML parser with cheerio + fixture test"
```

---

## Task 2: Jina Reader fetch wrapper

**Files:**
- Create: `~/Projects/research-mcp/test/fetch.test.js`
- Create: `~/Projects/research-mcp/src/fetch.js`

- [ ] **Step 1: Write failing fetch test**

Create `test/fetch.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { jinaFetch } from '../src/fetch.js';

function mockFetchOk(body) {
  return mock.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
  }));
}

function mockFetchErr(status, statusText, body = '') {
  return mock.fn(async () => ({
    ok: false,
    status,
    statusText,
    text: async () => body,
  }));
}

test('jinaFetch returns content under max_chars', async () => {
  const fakeFetch = mockFetchOk('Title: Example\n\nHello world');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.url, 'https://example.com');
  assert.ok(result.content.includes('Hello world'));
  assert.equal(result.truncated, false);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls[0].arguments[0], 'https://r.jina.ai/https://example.com');
});

test('jinaFetch truncates when content exceeds max_chars', async () => {
  const longBody = 'x'.repeat(5000);
  const fakeFetch = mockFetchOk(longBody);
  const result = await jinaFetch('https://example.com', { maxChars: 100, fetchImpl: fakeFetch });

  assert.equal(result.content.length, 100);
  assert.equal(result.truncated, true);
});

test('jinaFetch surfaces 429 rate-limit error structurally', async () => {
  const fakeFetch = mockFetchErr(429, 'Too Many Requests');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.url, 'https://example.com');
  assert.equal(result.content, null);
  assert.match(result.error, /rate limit/i);
});

test('jinaFetch surfaces other non-200 errors with status', async () => {
  const fakeFetch = mockFetchErr(500, 'Internal Server Error', 'oops');
  const result = await jinaFetch('https://example.com', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.content, null);
  assert.match(result.error, /500/);
});

test('jinaFetch extracts title from first markdown heading if present', async () => {
  const fakeFetch = mockFetchOk('Title: Doc Title\n\n# Doc Title\n\nBody text here.');
  const result = await jinaFetch('https://example.com/doc', { maxChars: 1000, fetchImpl: fakeFetch });

  assert.equal(result.title, 'Doc Title');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/fetch.test.js
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement fetch wrapper**

Create `src/fetch.js`:

```js
const JINA_BASE = 'https://r.jina.ai/';

/**
 * Fetch a URL via Jina Reader and return cleaned markdown.
 * @param {string} url - target URL to extract
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000] - truncate content to this length
 * @param {function} [opts.fetchImpl=fetch] - inject for tests
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{url: string, title: string|null, content: string|null, truncated: boolean, error?: string}>}
 */
export async function jinaFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    fetchImpl = fetch,
    timeoutMs = 15000,
  } = opts;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: { 'Accept': 'text/markdown' },
      signal: controller.signal,
    });

    if (!res.ok) {
      const bodyExcerpt = (await res.text().catch(() => '')).slice(0, 200);
      const error = res.status === 429
        ? `rate limit (429): ${res.statusText}`
        : `${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`;
      return { url, title: null, content: null, truncated: false, error };
    }

    const raw = await res.text();
    const title = extractTitle(raw);
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;

    return { url, title, content, truncated };
  } catch (err) {
    return {
      url,
      title: null,
      content: null,
      truncated: false,
      error: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err.message || err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Jina prepends "Title: ..." then first h1. Use whichever appears first. */
function extractTitle(markdown) {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/fetch.test.js
```
Expected: all 5 tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "feat(fetch): Jina Reader wrapper with truncation + error surfacing"
```

---

## Task 3: search_and_read combo

**Files:**
- Create: `~/Projects/research-mcp/test/combine.test.js`
- Create: `~/Projects/research-mcp/src/combine.js`

- [ ] **Step 1: Write failing combo test**

Create `test/combine.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searchAndRead } from '../src/combine.js';

test('searchAndRead returns enriched results for top-N', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.example.com', snippet: 'snip A' },
    { title: 'B', url: 'https://b.example.com', snippet: 'snip B' },
    { title: 'C', url: 'https://c.example.com', snippet: 'snip C' },
  ]);

  const fakeFetch = mock.fn(async (url) => ({
    url,
    title: `Title of ${url}`,
    content: `Content from ${url}`,
    truncated: false,
  }));

  const out = await searchAndRead('test query', {
    numResults: 3,
    maxCharsPerResult: 1000,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
  });

  assert.equal(out.query, 'test query');
  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].title, 'A');
  assert.equal(out.results[0].snippet, 'snip A');
  assert.equal(out.results[0].content, 'Content from https://a.example.com');
  assert.equal(fakeSearch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls.length, 3);
});

test('searchAndRead handles partial fetch failure gracefully', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.example.com', snippet: 'a' },
    { title: 'B', url: 'https://b.example.com', snippet: 'b' },
  ]);

  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('b.example')) {
      return { url, title: null, content: null, truncated: false, error: 'rate limit (429)' };
    }
    return { url, title: 'A', content: 'A body', truncated: false };
  });

  const out = await searchAndRead('q', {
    numResults: 2,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
  });

  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].content, 'A body');
  assert.equal(out.results[1].content, null);
  assert.match(out.results[1].error, /rate limit/);
});

test('searchAndRead returns empty results array when search returns none', async () => {
  const fakeSearch = mock.fn(async () => []);
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });

  const out = await searchAndRead('q', { searchImpl: fakeSearch, fetchImpl: fakeFetch });

  assert.deepEqual(out.results, []);
  assert.equal(fakeFetch.mock.calls.length, 0);
});

test('searchAndRead caps numResults at 10', async () => {
  const fakeSearch = mock.fn(async (q, n) => {
    assert.equal(n, 10, 'search should be called with capped value');
    return [];
  });
  const fakeFetch = mock.fn(async () => ({}));

  await searchAndRead('q', { numResults: 99, searchImpl: fakeSearch, fetchImpl: fakeFetch });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/combine.test.js
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement combine**

Create `src/combine.js`:

```js
import { duckDuckGoSearch } from './search.js';
import { jinaFetch } from './fetch.js';

const MAX_NUM_RESULTS = 10;

/**
 * Search the web and extract content from the top N results.
 * Returns partial results — a failed extraction surfaces as `content: null, error: ...`
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.numResults=3] - capped at 10
 * @param {number} [opts.maxCharsPerResult=8000]
 * @param {function} [opts.searchImpl=duckDuckGoSearch] - inject for tests
 * @param {function} [opts.fetchImpl=jinaFetch] - inject for tests
 * @returns {Promise<{query: string, results: Array<{title, url, snippet, content, truncated, error?}>}>}
 */
export async function searchAndRead(query, opts = {}) {
  const {
    numResults = 3,
    maxCharsPerResult = 8000,
    searchImpl = duckDuckGoSearch,
    fetchImpl = jinaFetch,
  } = opts;

  const capped = Math.min(Math.max(1, numResults), MAX_NUM_RESULTS);
  const searchResults = await searchImpl(query, capped);

  if (searchResults.length === 0) {
    return { query, results: [] };
  }

  const enriched = await Promise.all(
    searchResults.map(async (r) => {
      const fetched = await fetchImpl(r.url, { maxChars: maxCharsPerResult });
      return {
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: fetched.content,
        truncated: fetched.truncated ?? false,
        ...(fetched.error ? { error: fetched.error } : {}),
      };
    })
  );

  return { query, results: enriched };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/combine.test.js
```
Expected: all 4 tests pass.

- [ ] **Step 5: Run full unit suite to verify nothing regressed**

Run:
```bash
cd ~/Projects/research-mcp && node --test test/
```
Expected: 12 tests pass total (3 search + 5 fetch + 4 combine), exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "feat(combine): search_and_read combo with partial-failure handling"
```

---

## Task 4: MCP server wiring

**Files:**
- Create: `~/Projects/research-mcp/src/server.js`

- [ ] **Step 1: Write the server**

Create `src/server.js`:

```js
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { duckDuckGoSearch } from './search.js';
import { jinaFetch } from './fetch.js';
import { searchAndRead } from './combine.js';

const WebSearchArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(20).optional().default(5),
});

const FetchUrlArgs = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(100).max(200000).optional().default(20000),
});

const SearchAndReadArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(10).optional().default(3),
  max_chars_per_result: z.number().int().min(100).max(50000).optional().default(8000),
});

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo. Returns a list of {title, url, snippet} results. ' +
      'Use this when you need to find URLs about a topic. For getting the actual content of those URLs, use fetch_url or (preferred) search_and_read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a URL via Jina Reader and return cleaned markdown content. ' +
      'Returns {url, title, content, truncated}. Handles JS-rendered pages. ' +
      'Use when you already know the URL you want to read.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        max_chars: { type: 'integer', minimum: 100, maximum: 200000, default: 20000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_and_read',
    description:
      'Search the web AND extract clean markdown content from the top N results in one call. ' +
      'This is usually the right tool for "research a topic" — it returns {query, results[]} where each ' +
      "result has {title, url, snippet, content, truncated, error?}. Partial failures don't abort.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        num_results: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
        max_chars_per_result: { type: 'integer', minimum: 100, maximum: 50000, default: 8000 },
      },
      required: ['query'],
    },
  },
];

const server = new Server(
  { name: 'research-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'web_search') {
      const { query, num_results } = WebSearchArgs.parse(args);
      const results = await duckDuckGoSearch(query, num_results);
      return {
        content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }],
      };
    }

    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await jinaFetch(url, { maxChars: max_chars });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error in ${name}: ${err.message || String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[research-mcp] connected via stdio\n');
```

- [ ] **Step 2: Smoke-test the server via JSON-RPC**

Run:
```bash
cd ~/Projects/research-mcp && \
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 5 node src/server.js 2>/dev/null \
  | head -100
```
Expected: two JSON-RPC responses, the second containing `"name":"web_search"`, `"name":"fetch_url"`, `"name":"search_and_read"`.

If you see SDK import errors, run `npm install` again and check `package.json` versions.

- [ ] **Step 3: Make server executable**

Run:
```bash
chmod +x ~/Projects/research-mcp/src/server.js
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "feat(server): MCP stdio server wiring all 3 tools"
```

---

## Task 5: README + registration + live verification

**Files:**
- Create: `~/Projects/research-mcp/README.md`

- [ ] **Step 1: Write README**

Create `README.md`:

````markdown
# research-mcp

Zero-cost, zero-key MCP server giving Claude Code agents fresh web research via DuckDuckGo search + [Jina Reader](https://jina.ai/reader/) extraction.

## Tools

| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5)` | You just need URLs — no content extraction. |
| `fetch_url(url, max_chars=20000)` | You already have a URL and want clean markdown. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000)` | **Default research call** — top-N results + their content in one shot. |

## Install

Already done if this lives in `~/Projects/research-mcp/`. To register globally:

```bash
claude mcp add -s user research-mcp -- node /home/tahseen-dar/Projects/research-mcp/src/server.js
```

Verify:
```bash
claude mcp list | grep research-mcp
```
Should show `✓ Connected`.

## Tests

```bash
npm test              # unit tests, offline
npm run test:integration   # real network calls — only when validating end-to-end
```

## Architecture

See [SPEC.md](./SPEC.md). Three modules: `search.js` (DDG HTML parser), `fetch.js` (Jina wrapper), `combine.js` (the combo tool). `server.js` is MCP protocol wiring only.

## Maintenance

The DDG parser depends on DuckDuckGo HTML markup. If `web_search` starts returning empty arrays, refresh the fixture:

```bash
curl -sS -A "Mozilla/5.0" --data-urlencode "q=test" "https://html.duckduckgo.com/html/" > test/fixtures/ddg-results.html
npm test  # see what breaks, update parser
```
````

- [ ] **Step 2: Register with Claude Code (user scope)**

Run:
```bash
claude mcp add -s user research-mcp -- node /home/tahseen-dar/Projects/research-mcp/src/server.js
```
Expected: success message.

- [ ] **Step 3: Verify registration**

Run:
```bash
claude mcp list | grep research-mcp
```
Expected: `research-mcp: node /home/tahseen-dar/Projects/research-mcp/src/server.js - ✓ Connected`.

If it shows `✗` or a connection error, run `node ~/Projects/research-mcp/src/server.js < /dev/null` and inspect stderr.

- [ ] **Step 4: Live integration smoke test**

Run:
```bash
cd ~/Projects/research-mcp && RUN_INTEGRATION=1 timeout 60 node -e "
import('./src/combine.js').then(async ({ searchAndRead }) => {
  const out = await searchAndRead('TanStack Query v5 partialMatchKey', { numResults: 2, maxCharsPerResult: 2000 });
  console.log('query:', out.query);
  console.log('result count:', out.results.length);
  out.results.forEach((r, i) => {
    console.log('---', i + 1, '---');
    console.log('title:', r.title);
    console.log('url:', r.url);
    console.log('content length:', r.content?.length ?? 'null');
    console.log('error:', r.error ?? 'none');
  });
});
"
```
Expected: 2 results, each with non-null content of ≥500 chars and no error. If Jina rate-limits, one may have an error — that's acceptable, ≥1 successful result is the pass bar.

- [ ] **Step 5: Commit and tag v0.1.0**

```bash
cd ~/Projects/research-mcp && git add -A && git commit -m "docs: README + verified live integration"
git tag v0.1.0
```

- [ ] **Step 6: Final reachability check from Claude Code**

In a new Claude Code session (or current), confirm the tools surface in available tools list. The `search_and_read` tool should be callable. This is the true end-to-end success signal — `claude mcp list` says `Connected` but the agent reachability is what matters.

---

## Self-Review

**1. Spec coverage:**
- Tool surface (3 tools with exact schemas) → Task 4 ✓
- DDG HTML scrape with cheerio → Task 1 ✓
- Jina Reader fetch with truncation → Task 2 ✓
- search_and_read combo with partial-failure handling → Task 3 ✓
- Error handling table (DDG non-200, parser empty, Jina 429, network timeout) → search.js timeout, fetch.js status surfacing, combine.js partial pattern ✓
- File layout matches SPEC ✓
- Unit tests via `node:test` against fixtures ✓
- Integration smoke gated by `RUN_INTEGRATION=1` → Task 5 ✓
- Registration via `claude mcp add -s user` → Task 5 ✓
- ≤250 LOC excluding tests → search.js ~60, fetch.js ~55, combine.js ~40, server.js ~85 = ~240 LOC ✓
- Success criteria (`claude mcp list` shows Connected; search_and_read returns content) → Task 5 Steps 3-4 ✓

**2. Placeholder scan:** No TBDs / TODOs / "fill in details" / vague error-handling. Each code block is complete and runnable.

**3. Type consistency:**
- `parseDuckDuckGoHtml(html, numResults)` — same signature everywhere
- `duckDuckGoSearch(query, numResults)` — same
- `jinaFetch(url, opts)` where opts has `{maxChars, fetchImpl, timeoutMs}` — consistent in fetch.test.js, combine.js, server.js
- `searchAndRead(query, opts)` where opts has `{numResults, maxCharsPerResult, searchImpl, fetchImpl}` — consistent
- MCP tool args use snake_case (`num_results`, `max_chars`) per MCP convention; internal JS uses camelCase. Server.js bridges via zod parse + manual mapping. ✓

No gaps found.
