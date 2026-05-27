# research-mcp v0.4.0 — Source + Time Range Filters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two parameters — `source` (web/news/reddit/hackernews) and `time_range` (day/week/month/year/all) — to `web_search` and `search_and_read`. Lets the agent target Reddit/news directly and filter by recency.

**Architecture:** Both params plumb from server.js (Zod) → `webSearch` router → either `searxngSearch` (translates to SearXNG `&categories=`, `&engines=`, `&time_range=`) or `duckDuckGoSearch` (translates to `site:` prefix + DDG `df=` form param). Cache keys include the new params so different sources/times don't collide.

**Tech Stack:** No new deps. Pure extension of existing modules.

**Plan location override:** Same as prior plans — kept with the tool at `~/Projects/research-mcp/`.

**Existing repo state:** On `main`, last tag `v0.3.0` (commit `05c4486`), 103/103 tests pass, SearXNG container running.

**`fetch_url` is NOT changed.** It takes a URL not a query — source/time-range don't apply.

---

## File Structure

```
src/
├── searxng.js          # Modified: accept {source, timeRange}; build URL with categories/engines/time_range
├── search.js           # Modified: duckDuckGoSearch accepts {source, timeRange}; webSearch passes through
├── combine.js          # Modified: searchAndRead accepts + passes through {source, timeRange}
├── server.js           # Modified: Zod schemas + tool descriptions; default source=web, time_range=all
├── cacheKey.js         # Unchanged (already takes params array)
└── (other files unchanged)

test/
├── searxng.test.js     # Modified: add tests for source/time mapping
├── search.test.js      # Modified: add tests for DDG source/time mapping + router passthrough
├── combine.test.js     # Modified: add test that source/timeRange reach searchImpl
├── server.test.js      # Modified: smoke test new tool schema includes the params
```

**Source mapping reference (will be implemented):**

| Source value | SearXNG | DDG |
|--------------|---------|-----|
| `web` (default) | (no extra param) | (no change) |
| `news` | `&categories=news` | prepend `site:reuters.com OR site:bloomberg.com OR site:techcrunch.com` |
| `reddit` | `&engines=reddit` | prepend `site:reddit.com` |
| `hackernews` | `&engines=hackernews` | prepend `site:news.ycombinator.com` |

**Time range mapping:**

| Value | SearXNG | DDG |
|-------|---------|-----|
| `all` (default) | (no param) | (no param) |
| `day` | `&time_range=day` | `&df=d` |
| `week` | `&time_range=week` | `&df=w` |
| `month` | `&time_range=month` | `&df=m` |
| `year` | `&time_range=year` | `&df=y` |

**Cache key impact:** keys now include source + timeRange, so different filters get different cache entries. Existing v0.3.0 entries become orphaned (still in DB, never matched). Acceptable — cache self-heals.

---

## Task 0: SPEC + version bump

**Files:**
- Modify: `~/Projects/research-mcp/SPEC.md`
- Modify: `~/Projects/research-mcp/package.json`

- [ ] **Step 1: Append v0.4.0 section to SPEC.md**

Insert after the `## v0.3.0` section, before `## Non-goals`:

```markdown
## v0.4.0 — Source + time range filters

Adds two parameters to `web_search` and `search_and_read` (NOT `fetch_url` — it takes a URL, not a query):

**`source`** — restrict to a specific origin. Default `web`.
- `web` — open web (existing behavior)
- `news` — news sources (Google News, Bing News etc. via SearXNG `categories=news`; major news `site:` filters via DDG)
- `reddit` — Reddit only (SearXNG `engines=reddit`; DDG `site:reddit.com`)
- `hackernews` — Hacker News (SearXNG `engines=hackernews`; DDG `site:news.ycombinator.com`)

**`time_range`** — recency filter. Default `all`.
- `all` — no filter (existing behavior)
- `day` / `week` / `month` / `year` — restrict to results from that recent window

Both map to native parameters of the underlying search backend — SearXNG `time_range=` and `categories=`/`engines=`; DDG `df=` and `site:` operator.

**Cache key impact:** Includes both params. Querying the same topic with different source/time gives different cache entries.

**Use cases:**
- `search_and_read(query="Foodhub pricing", source="reddit", time_range="year")` — find real restaurant-owner discussion from the past year only, no SEO comparison sites
- `search_and_read(query="restaurant POS funding", source="news", time_range="month")` — recent industry news
- `search_and_read(query="POS architecture", source="hackernews")` — technical discussion
```

- [ ] **Step 2: Bump package.json**

Edit `package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"`. No other changes.

- [ ] **Step 3: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "chore: v0.4.0 spec — source + time_range filters"
```

---

## Task 1: SearXNG source + time_range support (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/searxng.js`
- Modify: `~/Projects/research-mcp/test/searxng.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/searxng.test.js`:

```js
test('searxngSearch with source=news adds categories=news to URL', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, source: 'news' });
  assert.match(capturedUrl, /categories=news/);
});

test('searxngSearch with source=reddit adds engines=reddit to URL', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, source: 'reddit' });
  assert.match(capturedUrl, /engines=reddit/);
});

test('searxngSearch with source=hackernews adds engines=hackernews to URL', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, source: 'hackernews' });
  assert.match(capturedUrl, /engines=hackernews/);
});

test('searxngSearch with source=web omits categories and engines params', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, source: 'web' });
  assert.doesNotMatch(capturedUrl, /categories=/);
  assert.doesNotMatch(capturedUrl, /engines=/);
});

test('searxngSearch with timeRange=year adds time_range=year to URL', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'year' });
  assert.match(capturedUrl, /time_range=year/);
});

test('searxngSearch with timeRange=all omits time_range param', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'all' });
  assert.doesNotMatch(capturedUrl, /time_range=/);
});

test('searxngSearch with source + timeRange combines both params', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }) };
  });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, source: 'reddit', timeRange: 'month' });
  assert.match(capturedUrl, /engines=reddit/);
  assert.match(capturedUrl, /time_range=month/);
});

test('searxngSearch cache key differs for different source values', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [] }),
  }));
  const captured = [];
  const fakeCache = {
    get: mock.fn(() => null),
    set: mock.fn((entry) => captured.push(entry.cacheKey)),
  };
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000, source: 'web' });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000, source: 'reddit' });
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0], captured[1], 'different source should produce different cache key');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/searxng.test.js 2>&1 | tail -12
```
Expected: 10 existing pass; 8 new fail (params not threaded yet).

- [ ] **Step 3: Update searxng.js implementation**

Replace the contents of `src/searxng.js` with:

```js
import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';

const DEFAULT_BASE_URL = 'http://localhost:8888';

// Map our `source` enum to SearXNG URL params.
function searxngSourceParams(source) {
  switch (source) {
    case 'news':       return { categories: 'news' };
    case 'reddit':     return { engines: 'reddit' };
    case 'hackernews': return { engines: 'hackernews' };
    case 'web':
    case undefined:
    case null:
    case '':
      return {};
    default:
      // Unknown sources fall through to web (no filter) — fail-safe.
      return {};
  }
}

/**
 * Query a local SearXNG instance via its JSON API.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.baseUrl='http://localhost:8888']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {string} [opts.source='web'] - 'web' | 'news' | 'reddit' | 'hackernews'
 * @param {string} [opts.timeRange='all'] - 'all' | 'day' | 'week' | 'month' | 'year'
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function searxngSearch(query, numResults = 5, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    cache,
    ttlMs,
    source = 'web',
    timeRange = 'all',
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults, source, timeRange]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  // Build URL
  const params = new URLSearchParams({ q: query, format: 'json' });
  const sourceParams = searxngSourceParams(source);
  for (const [k, v] of Object.entries(sourceParams)) params.set(k, v);
  if (timeRange && timeRange !== 'all') {
    params.set('time_range', timeRange);
  }

  const url = `${baseUrl}/search?${params.toString()}`;
  const res = await fetchImpl(url, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.4.0' },
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}: ${res.statusText}`);
  }

  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error(`SearXNG returned non-JSON body (first 200 chars): ${body.slice(0, 200)}`);
  }

  const results = (json.results || []).slice(0, numResults).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }));

  if (cache && cacheKey) {
    cache.set({
      tool: 'web_search',
      cacheKey,
      query,
      params: { num_results: numResults, source, time_range: timeRange },
      result: results,
    });
  }

  return results;
}

/**
 * Quick liveness probe — does SearXNG answer at this baseUrl?
 */
export async function isSearxngReachable(baseUrl = DEFAULT_BASE_URL, fetchImpl = curlFetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/healthz`, { timeoutMs: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/searxng.test.js 2>&1 | tail -8
```
Expected: 18/18 pass (10 existing + 8 new).

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(searxng): source + timeRange opts mapped to SearXNG categories/engines/time_range"
```

---

## Task 2: DDG source + time_range support (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/search.js`
- Modify: `~/Projects/research-mcp/test/search.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/search.test.js`:

```js
test('duckDuckGoSearch with source=reddit prepends site:reddit.com to query', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('Foodhub pricing', 5, { fetchImpl: fakeFetch, source: 'reddit' });
  // form body is `q=site%3Areddit.com+Foodhub+pricing`
  assert.match(capturedBody, /q=site%3Areddit\.com\+Foodhub\+pricing/);
});

test('duckDuckGoSearch with source=hackernews prepends site:news.ycombinator.com', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('rust async', 5, { fetchImpl: fakeFetch, source: 'hackernews' });
  assert.match(capturedBody, /q=site%3Anews\.ycombinator\.com\+rust\+async/);
});

test('duckDuckGoSearch with source=web does not modify query', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('plain query', 5, { fetchImpl: fakeFetch, source: 'web' });
  assert.doesNotMatch(capturedBody, /site%3A/);
  assert.match(capturedBody, /q=plain\+query/);
});

test('duckDuckGoSearch with timeRange=year adds df=y to form body', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'year' });
  assert.match(capturedBody, /df=y/);
});

test('duckDuckGoSearch with timeRange=all omits df param', async () => {
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html></html>' };
  });
  await duckDuckGoSearch('foo', 5, { fetchImpl: fakeFetch, timeRange: 'all' });
  assert.doesNotMatch(capturedBody, /df=/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -8
```
Expected: 11 existing pass; 5 new fail (params not threaded yet).

- [ ] **Step 3: Update search.js — duckDuckGoSearch + webSearch**

Find and replace the `duckDuckGoSearch` function in `src/search.js` with:

```js
// Map our `source` enum to a `site:` prefix for DDG queries.
function ddgSourcePrefix(source) {
  switch (source) {
    case 'reddit':     return 'site:reddit.com ';
    case 'hackernews': return 'site:news.ycombinator.com ';
    case 'news':       return 'site:reuters.com OR site:bloomberg.com OR site:techcrunch.com ';
    case 'web':
    case undefined:
    case null:
    case '':
      return '';
    default:
      return '';
  }
}

// Map our `time_range` enum to DDG's `df` form param.
function ddgTimeParam(timeRange) {
  switch (timeRange) {
    case 'day':   return 'd';
    case 'week':  return 'w';
    case 'month': return 'm';
    case 'year':  return 'y';
    case 'all':
    case undefined:
    case null:
    case '':
      return null;
    default:
      return null;
  }
}

export async function duckDuckGoSearch(query, numResults = 5, opts = {}) {
  const { cache, ttlMs, fetchImpl = curlFetch, source = 'web', timeRange = 'all' } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults, source, timeRange]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const finalQuery = ddgSourcePrefix(source) + query;
  const params = new URLSearchParams({ q: finalQuery });
  const df = ddgTimeParam(timeRange);
  if (df) params.set('df', df);

  const res = await fetchImpl('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: params.toString(),
    timeoutMs: 15000,
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo returned ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const results = parseDuckDuckGoHtml(html, numResults);

  if (cache && cacheKey) {
    cache.set({
      tool: 'web_search',
      cacheKey,
      query,
      params: { num_results: numResults, source, time_range: timeRange },
      result: results,
    });
  }

  return results;
}
```

Also update `webSearch` in the same file to thread `source` + `timeRange` through:

Find:
```js
export async function webSearch(query, numResults = 5, opts = {}) {
  const {
    backend = 'auto',
    searxngUrl,
    cache,
    ttlMs,
    searxngImpl = searxngSearch,
    ddgImpl = duckDuckGoSearch,
    reachableImpl = isSearxngReachable,
  } = opts;

  const downstreamOpts = { cache, ttlMs, baseUrl: searxngUrl };
```

Replace with:
```js
export async function webSearch(query, numResults = 5, opts = {}) {
  const {
    backend = 'auto',
    searxngUrl,
    cache,
    ttlMs,
    source = 'web',
    timeRange = 'all',
    searxngImpl = searxngSearch,
    ddgImpl = duckDuckGoSearch,
    reachableImpl = isSearxngReachable,
  } = opts;

  const downstreamOpts = { cache, ttlMs, baseUrl: searxngUrl, source, timeRange };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -8
```
Expected: 16/16 pass (11 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(search): DDG source/timeRange via site: prefix + df form param; webSearch threads both"
```

---

## Task 3: combine.js + verify webSearch router test

**Files:**
- Modify: `~/Projects/research-mcp/src/combine.js`
- Modify: `~/Projects/research-mcp/test/combine.test.js`
- Modify: `~/Projects/research-mcp/test/search.test.js` (add router passthrough test)

- [ ] **Step 1: Add router-passthrough test to search.test.js**

Append to `test/search.test.js`:

```js
test('webSearch passes source and timeRange through to underlying backend', async () => {
  let captured = null;
  const fakeSearxng = mock.fn(async (q, n, opts) => { captured = opts; return []; });
  const fakeProbe = mock.fn(async () => true);
  await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    reachableImpl: fakeProbe,
    source: 'reddit',
    timeRange: 'month',
  });
  assert.equal(captured.source, 'reddit');
  assert.equal(captured.timeRange, 'month');
});
```

- [ ] **Step 2: Add combine.js passthrough test**

Append to `test/combine.test.js`:

```js
test('searchAndRead passes source and timeRange through to searchImpl', async () => {
  let captured = null;
  const fakeSearch = mock.fn(async (q, n, opts) => { captured = opts; return []; });
  const fakeFetch = mock.fn(async () => ({}));

  await searchAndRead('foo', {
    numResults: 3,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    source: 'reddit',
    timeRange: 'year',
  });
  assert.ok(captured, 'searchImpl should have received opts');
  assert.equal(captured.source, 'reddit');
  assert.equal(captured.timeRange, 'year');
});
```

- [ ] **Step 3: Run combine tests — expect 1 new fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/combine.test.js 2>&1 | tail -8
```
Expected: 6 existing pass; 1 new fail (searchImpl signature doesn't receive opts).

- [ ] **Step 4: Update combine.js to pass opts to searchImpl**

Find in `src/combine.js`:
```js
  const searchResults = await searchImpl(query, capped);
```

Replace with:
```js
  const searchResults = await searchImpl(query, capped, { source: opts.source, timeRange: opts.timeRange });
```

Note: this change is back-compat. Existing tests pass a `searchImpl: mock.fn(async () => [...])` that ignores extra args.

- [ ] **Step 5: Run all tests — expect 105 pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -8
```
Expected: 105/105 pass (103 baseline + 8 searxng + 5 DDG + 1 router + 1 combine — actually 118 total since baseline already grew. Verify the count makes sense; whatever it is, fail=0).

- [ ] **Step 6: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(combine): pass source/timeRange through to searchImpl; router passthrough test"
```

---

## Task 4: Server.js Zod schemas + tool descriptions + smoke

**Files:**
- Modify: `~/Projects/research-mcp/src/server.js`

- [ ] **Step 1: Update Zod schemas for the two tools**

Find in `src/server.js`:
```js
const WebSearchArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(20).optional().default(5),
});
```

Replace with:
```js
const SourceEnum = z.enum(['web', 'news', 'reddit', 'hackernews']).optional().default('web');
const TimeRangeEnum = z.enum(['all', 'day', 'week', 'month', 'year']).optional().default('all');

const WebSearchArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(20).optional().default(5),
  source: SourceEnum,
  time_range: TimeRangeEnum,
});
```

Find in `src/server.js`:
```js
const SearchAndReadArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(10).optional().default(3),
  max_chars_per_result: z.number().int().min(100).max(50000).optional().default(8000),
});
```

Replace with:
```js
const SearchAndReadArgs = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(10).optional().default(3),
  max_chars_per_result: z.number().int().min(100).max(50000).optional().default(8000),
  source: SourceEnum,
  time_range: TimeRangeEnum,
});
```

- [ ] **Step 2: Update TOOLS array — web_search + search_and_read inputSchema and description**

Find the `web_search` entry in the `TOOLS` array. Replace its `description` and `inputSchema`:

```js
  {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo or SearXNG (auto-selected). Returns {title, url, snippet}[]. ' +
      'Optional `source` restricts to news/reddit/hackernews; optional `time_range` filters to recent results. ' +
      'For getting URL content, prefer search_and_read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        source: {
          type: 'string',
          enum: ['web', 'news', 'reddit', 'hackernews'],
          default: 'web',
          description: 'Restrict to a specific source. reddit = real user discussion (less SEO noise); news = recent industry news; hackernews = tech discussion; web = open web (default).',
        },
        time_range: {
          type: 'string',
          enum: ['all', 'day', 'week', 'month', 'year'],
          default: 'all',
          description: 'Filter to recent results. Use for fast-moving topics where outdated info is harmful.',
        },
      },
      required: ['query'],
    },
  },
```

Find the `search_and_read` entry. Replace its `description` and `inputSchema`:

```js
  {
    name: 'search_and_read',
    description:
      'Search + extract content from top-N results in one call. The default research tool. ' +
      'Returns {query, results: [{title, url, snippet, content, truncated, error?}]}. Partial failures do not abort. ' +
      'Use source=reddit + time_range=year for "what do real users say recently"; source=news for industry updates.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        num_results: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
        max_chars_per_result: { type: 'integer', minimum: 100, maximum: 50000, default: 8000 },
        source: {
          type: 'string',
          enum: ['web', 'news', 'reddit', 'hackernews'],
          default: 'web',
        },
        time_range: {
          type: 'string',
          enum: ['all', 'day', 'week', 'month', 'year'],
          default: 'all',
        },
      },
      required: ['query'],
    },
  },
```

- [ ] **Step 3: Update tool handlers to thread the new params**

Find the `web_search` handler:
```js
    if (name === 'web_search') {
      const { query, num_results } = WebSearchArgs.parse(args);
      const results = await webSearch(query, num_results, {
        cache, ttlMs: TTL_MS,
        backend: SEARCH_BACKEND,
        searxngUrl: SEARXNG_URL,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
    }
```

Replace with:
```js
    if (name === 'web_search') {
      const { query, num_results, source, time_range } = WebSearchArgs.parse(args);
      const results = await webSearch(query, num_results, {
        cache, ttlMs: TTL_MS,
        backend: SEARCH_BACKEND,
        searxngUrl: SEARXNG_URL,
        source,
        timeRange: time_range,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
    }
```

Find the `search_and_read` handler:
```js
    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
        cache,
        ttlMs: TTL_MS,
        searchImpl: (q, n) => webSearch(q, n, { cache, ttlMs: TTL_MS, backend: SEARCH_BACKEND, searxngUrl: SEARXNG_URL }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
```

Replace with:
```js
    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result, source, time_range } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
        cache,
        ttlMs: TTL_MS,
        source,
        timeRange: time_range,
        searchImpl: (q, n, innerOpts) => webSearch(q, n, {
          cache, ttlMs: TTL_MS, backend: SEARCH_BACKEND, searxngUrl: SEARXNG_URL,
          source: innerOpts?.source ?? source,
          timeRange: innerOpts?.timeRange ?? time_range,
        }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
```

- [ ] **Step 4: Bump version banner**

Find:
```js
process.stderr.write(`[research-mcp] v0.3.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

Replace with:
```js
process.stderr.write(`[research-mcp] v0.4.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

Find:
```js
const server = new Server(
  { name: 'research-mcp', version: '0.3.0' },
  { capabilities: { tools: {} } }
);
```

Replace with:
```js
const server = new Server(
  { name: 'research-mcp', version: '0.4.0' },
  { capabilities: { tools: {} } }
);
```

- [ ] **Step 5: Update server.test.js — verify new params appear in schema**

Find in `test/server.test.js` the test `server lists 5 tools including list_research and get_research`. After its existing assertions, append (before the closing `});`):

```js
  const webSearchTool = listResp.result.tools.find(t => t.name === 'web_search');
  assert.ok(webSearchTool.inputSchema.properties.source, 'web_search schema should include source');
  assert.ok(webSearchTool.inputSchema.properties.time_range, 'web_search schema should include time_range');
  const sarTool = listResp.result.tools.find(t => t.name === 'search_and_read');
  assert.ok(sarTool.inputSchema.properties.source, 'search_and_read schema should include source');
  assert.ok(sarTool.inputSchema.properties.time_range, 'search_and_read schema should include time_range');
```

- [ ] **Step 6: Run server tests**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/server.test.js 2>&1 | tail -10
```
Expected: 3/3 pass with the augmented assertions.

- [ ] **Step 7: Smoke-test server initialization**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 5 node src/server.js 2>&1 | head -3
```
Expected: `[research-mcp] v0.4.0 connected ...` on stderr; JSON-RPC response shows `serverInfo: {name: "research-mcp", version: "0.4.0"}`.

- [ ] **Step 8: Full test suite**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -8
```
Expected: all tests pass; total count grows by ~16 (8 searxng + 5 DDG + 1 router + 1 combine + 1 server schema assertions count as part of the same test).

- [ ] **Step 9: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(server): expose source + time_range params on web_search and search_and_read"
```

---

## Task 5: Live verify + README + tag v0.4.0

**Files:**
- Modify: `~/Projects/research-mcp/README.md`
- Create: `~/Projects/research-mcp/scripts/smoke-source-time.js`

- [ ] **Step 1: Create live smoke script**

Create `scripts/smoke-source-time.js`:

```js
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
```

- [ ] **Step 2: Run live smoke**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && timeout 90 node scripts/smoke-source-time.js 2>&1 | tail -40
```
Expected: 6 cases run. `reddit` results should be reddit.com URLs; `hackernews` should be news.ycombinator.com; `news` should be news sources. Time-filtered cases may return fewer results than `all` but should still be non-empty for a topic with recent coverage.

If `reddit` source returns 0 results from SearXNG, the reddit engine may be disabled in SearXNG config. Check with `docker compose logs searxng | tail -50` and consider enabling via `searxng-config/settings.yml` engines section.

- [ ] **Step 3: Update README.md — document the new params**

Find this table in `README.md`:

```markdown
| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5)` | You just need URLs — no content. |
| `fetch_url(url, max_chars=20000)` | You have a URL and want clean markdown content. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000)` | **Default research call** — top-N results + their content in one shot. |
| `list_research(limit=20, tool_filter?)` | Browse what's already cached. Free, instant. |
| `get_research(id)` | Pull full cached content by id (from `list_research`). Zero network. |
```

Replace with:

```markdown
| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5, source?, time_range?)` | You just need URLs — no content. |
| `fetch_url(url, max_chars=20000)` | You have a URL and want clean markdown content. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000, source?, time_range?)` | **Default research call** — top-N results + their content in one shot. |
| `list_research(limit=20, tool_filter?)` | Browse what's already cached. Free, instant. |
| `get_research(id)` | Pull full cached content by id (from `list_research`). Zero network. |

### Source + time_range filters (v0.4.0)

Both `web_search` and `search_and_read` accept:

- **`source`**: `web` (default), `news`, `reddit`, `hackernews`. Filters to that origin. Cuts SEO comparison-site noise; surfaces authentic discussion (reddit) or recent industry news.
- **`time_range`**: `all` (default), `day`, `week`, `month`, `year`. Filters by recency.

Examples worth committing to muscle memory:
- `search_and_read("Foodhub pricing", source="reddit", time_range="year")` — real recent restaurant-owner discussion
- `search_and_read("Toast Q4 earnings", source="news", time_range="month")` — fresh industry news
- `search_and_read("better-sqlite3 perf", source="hackernews")` — technical-community take
```

- [ ] **Step 4: Commit + tag v0.4.0**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "docs: v0.4.0 README + live smoke for source/time_range" && git tag v0.4.0 && git log --oneline | head -10
```

- [ ] **Step 5: Update memory pointer**

Update `~/.claude/projects/-home-tahseen-dar-POSSystem-Inventory-System-Root/memory/project_research-mcp-tool.md` to note v0.4.0 capabilities: `source` (web/news/reddit/hackernews) + `time_range` (day/week/month/year) on web_search and search_and_read. Update MEMORY.md index line.

---

## Self-Review

**1. Spec coverage:**
- `source` values web/news/reddit/hackernews → Task 1 (SearXNG mapping) + Task 2 (DDG mapping) ✓
- `time_range` values all/day/week/month/year → Task 1 + Task 2 ✓
- SearXNG translation to `categories=`/`engines=`/`time_range=` → Task 1 ✓
- DDG translation to `site:` prefix + `df=` form param → Task 2 ✓
- Plumbed through webSearch router → Task 2 (Step 3 webSearch update) + Task 3 (router test) ✓
- Plumbed through searchAndRead → Task 3 ✓
- Server.js Zod schemas + tool descriptions updated → Task 4 ✓
- Default values (source=web, time_range=all) preserve back-compat → all tasks ✓
- Cache key includes new params → Task 1 (searxng) + Task 2 (DDG) ✓
- `fetch_url` NOT modified → confirmed; only web_search + search_and_read touched ✓
- Live smoke test of all source/time combinations → Task 5 ✓
- README + tag v0.4.0 → Task 5 ✓

**2. Placeholder scan:** No TBDs, no "add error handling", every code block is complete and runnable. Test code shows exact `assert` calls; impl code shows exact param mappings.

**3. Type consistency:**
- `source` is camelCase internally (`opts.source`) — same in searxngSearch, duckDuckGoSearch, webSearch, searchAndRead, combine.js. The MCP arg is snake_case (`source`) — happens to be one word so identical.
- `timeRange` is camelCase internally; `time_range` is snake_case for MCP arg. Bridge happens in server.js via destructure rename (`time_range` → passed as `timeRange:`). Consistent.
- Cache key includes `[query, numResults, source, timeRange]` in both searxng.js and search.js — same param order, same value semantics. ✓
- `ddgSourcePrefix` and `searxngSourceParams` cover the same enum values + same fallback behavior (unknown → no filter). ✓
- Zod `SourceEnum` and `TimeRangeEnum` defaults match the default values in the impl functions. ✓

No gaps. No inconsistencies. Plan is complete.
