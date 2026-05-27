# research-mcp v0.3.0 — Tier 2 + Tier 3c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-source DuckDuckGo search with a self-hosted SearXNG meta-search (Tier 2), add a Mozilla Readability fallback for when Jina fails (Tier 2), and add site-specific extractors for GitHub, NPM, Stack Overflow, and MDN (Tier 3c) — composed into a `smartFetch` router that tries extractor → Jina → Readability in sequence.

**Architecture:** SearXNG runs as a Docker container on `localhost:8888`. A `webSearch` router in `src/search.js` selects between `searxngSearch` (when reachable) and existing `duckDuckGoSearch` (fallback). A `smartFetch` router in `src/fetch.js` checks URL against an extractor registry (GitHub/NPM/SO/MDN) → uses site-specific extractor if matched, falls back to Jina Reader, then Readability. Cache layer (v0.2.0) wraps everything unchanged.

**Tech Stack:** Docker (SearXNG service), `@mozilla/readability` + `jsdom` (Readability fallback), `cheerio` (already used; for MDN extractor), public APIs (`api.github.com`, `registry.npmjs.org`, `api.stackexchange.com`).

**Plan location override:** Same as v0.1.0/v0.2.0 — kept with the tool at `~/Projects/research-mcp/`.

**Existing repo state:** On `main`, last tag `v0.2.0` (commit `572befc`), 12 commits, 38/38 tests pass, registered as `research-mcp` MCP at user scope. Docker installed and verified.

---

## File Structure

```
~/Projects/research-mcp/
├── SPEC.md                                # Modified: add v0.3.0 section
├── PLAN-v0.3.0-tier2-3c.md                # this file
├── README.md                              # Modified: SearXNG setup + extractors + env
├── package.json                           # Modified: add @mozilla/readability + jsdom, bump 0.3.0
├── docker-compose.yml                     # NEW: SearXNG service
├── searxng-config/
│   └── settings.yml                       # NEW: enable JSON format, disable limiter
├── src/
│   ├── searxng.js                         # NEW: SearXNG JSON API client (~70 LOC)
│   ├── readability.js                     # NEW: @mozilla/readability + jsdom fallback (~70 LOC)
│   ├── extractorRegistry.js               # NEW: URL pattern → extractor mapping (~40 LOC)
│   ├── extractors/
│   │   ├── github.js                      # NEW: api.github.com (~120 LOC)
│   │   ├── npm.js                         # NEW: registry.npmjs.org (~70 LOC)
│   │   ├── stackoverflow.js               # NEW: api.stackexchange.com (~100 LOC)
│   │   └── mdn.js                         # NEW: cheerio scrape of developer.mozilla.org (~70 LOC)
│   ├── search.js                          # Modified: add webSearch router
│   ├── fetch.js                           # Modified: add smartFetch router; keep jinaFetch internal
│   ├── combine.js                         # Modified: default fetchImpl → smartFetch
│   ├── server.js                          # Modified: env wiring + use webSearch/smartFetch
│   ├── cache.js                           # Unchanged
│   ├── cacheKey.js                        # Unchanged
│   └── http.js                            # Unchanged
└── test/
    ├── searxng.test.js                    # NEW
    ├── readability.test.js                # NEW
    ├── extractorRegistry.test.js          # NEW
    ├── extractors/
    │   ├── github.test.js                 # NEW
    │   ├── npm.test.js                    # NEW
    │   ├── stackoverflow.test.js          # NEW
    │   └── mdn.test.js                    # NEW
    ├── smartFetch.test.js                 # NEW: integration tests for fetch.js router
    ├── search.test.js                     # Modified: add webSearch router tests
    └── (existing tests untouched)
```

**Responsibilities:**
- `searxng.js` — pure SearXNG JSON API client; returns `[{title, url, snippet}]`. Symmetrical interface with `duckDuckGoSearch` so the router can swap them.
- `readability.js` — fetch raw HTML, run Mozilla Readability via jsdom, return `{url, title, content, truncated}` matching `jinaFetch` shape.
- `extractorRegistry.js` — pattern→extractor mapping. `findExtractor(url) → extractor | null`.
- `extractors/*.js` — each exports `(url, opts) → Promise<fetch-shaped result>`. Self-contained, no shared state.
- `search.js` — `webSearch(query, n, opts)` router with auto-detection + `SEARCH_BACKEND` env override. Keeps `duckDuckGoSearch` and `parseDuckDuckGoHtml` exports for tests and explicit fallback.
- `fetch.js` — `smartFetch(url, opts)` router. Keeps `jinaFetch` exported for tests + as the middle tier. Cache wrapping happens in `smartFetch`, not in leaf functions, to avoid double-cache.
- `server.js` — owns env reading; switches tool handlers from `duckDuckGoSearch`/`jinaFetch` to `webSearch`/`smartFetch`.

**Cache key contract (unchanged from v0.2.0):**
- `web_search` and `search_and_read` use the same key regardless of which backend served (DDG or SearXNG). Switching backend invalidates by changing results, not by changing keys. Acceptable for personal-use volume.

**Env contract:**
- `SEARCH_BACKEND` = `auto` (default) | `searxng` | `ddg`. In `auto`, the router probes `${SEARXNG_URL}/healthz` once per process at startup; reachable → searxng, else → ddg.
- `SEARXNG_URL` = `http://localhost:8888` (default).
- `DISABLE_EXTRACTORS` = `1` to skip extractor routing entirely (jina + readability only). Useful for debugging.
- `GITHUB_TOKEN` — optional, raises GitHub API limit from 60/hr → 5000/hr.

---

## Task 0: Spec update + deps + Docker + scaffold dirs

**Files:**
- Modify: `~/Projects/research-mcp/SPEC.md`
- Modify: `~/Projects/research-mcp/package.json`
- Create: `~/Projects/research-mcp/docker-compose.yml`
- Create: `~/Projects/research-mcp/searxng-config/settings.yml`
- Create: `~/Projects/research-mcp/src/extractors/` (dir)
- Create: `~/Projects/research-mcp/test/extractors/` (dir)

- [ ] **Step 1: Append v0.3.0 section to SPEC.md**

Insert after the `## v0.2.0 — SQLite cache layer` section, before `## Non-goals`:

```markdown
## v0.3.0 — Multi-backend search + smart extractors (Tier 2 + Tier 3c)

Adds two orthogonal layers that improve recall and content quality without changing the public tool surface.

### Tier 2: SearXNG meta-search + Readability fallback

**SearXNG** (self-hosted Docker container) replaces direct DuckDuckGo scraping as the default search backend. Queries 70+ engines in parallel (Google, Bing, Brave, DDG, Wikipedia, Stack Overflow, GitHub, etc.), merges + deduplicates, returns clean JSON. Configured via `SEARCH_BACKEND` env (`auto` | `searxng` | `ddg`) and `SEARXNG_URL` env (default `http://localhost:8888`). When `auto`, the router probes `/healthz` on first use; reachable → searxng, else → ddg. DDG remains as a built-in fallback for zero-infra-mode.

**Mozilla Readability fallback** (`src/readability.js`) — when Jina Reader fails (rate-limited, network error, or returns empty), the fetcher falls back to fetching the raw HTML via `curl` and running Mozilla Readability + jsdom locally. No external service dependency. Trade: doesn't handle JS-rendered pages (Jina's headless browser does).

### Tier 3c: Site-specific extractors

URL-pattern routing in `src/extractorRegistry.js` directs known sites to dedicated extractors that use the site's own API instead of generic HTML scraping. Composition via `smartFetch(url)`:

  1. **Match URL against registry.** If matched → call site-specific extractor.
  2. **If extractor missing/fails → call Jina Reader.**
  3. **If Jina fails → call Mozilla Readability fallback.**
  4. **If all three fail → return aggregated error** so the agent knows nothing worked.

| Site | URL pattern | Source | Output |
|------|-------------|--------|--------|
| GitHub repo | `github.com/<owner>/<repo>` | `api.github.com/repos/X/Y/readme` + `/repos/X/Y` | README + stars/lang/topics |
| GitHub issue/PR | `github.com/<owner>/<repo>/(issues\|pull)/<n>` | `api.github.com/repos/X/Y/issues/N` + comments | Title, body, top-5 comments |
| NPM package | `npmjs.com/package/<pkg>` | `registry.npmjs.org/<pkg>` | Name, version, README, deps, links |
| Stack Overflow | `stackoverflow.com/questions/<id>` | `api.stackexchange.com/2.3/questions/<id>` | Question + top-3 answers |
| MDN docs | `developer.mozilla.org/...` | direct HTML + cheerio (`.main-page-content`) | Title + cleaned main content |

Disable with `DISABLE_EXTRACTORS=1` (debugging / opt-out). Optional `GITHUB_TOKEN` env raises GitHub API rate limit 60/hr → 5000/hr.

### Cache contract

Unchanged from v0.2.0. Same `(tool, params)` cache key regardless of which backend or extractor served the result.

### Non-goals carried forward

- **Tier 3a** (query expansion via Claude) — deferred. Open question: can the MCP server reuse Claude Code's session credentials (MCP sampling protocol) instead of needing a separate Anthropic API key?
- **Tier 3b** (semantic reranking via Cohere) — deferred until Cohere key is added.
```

- [ ] **Step 2: Bump version + add deps in package.json**

Update `package.json`:

```json
{
  "name": "research-mcp",
  "version": "0.3.0",
  "description": "MCP server: SearXNG/DDG search + Jina/Readability extraction + site-specific extractors for Claude agents",
  "type": "module",
  "main": "src/server.js",
  "bin": {
    "research-mcp": "src/server.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/*.test.js test/extractors/*.test.js",
    "test:integration": "RUN_INTEGRATION=1 node --test test/*.test.js test/extractors/*.test.js",
    "searxng:up": "docker compose up -d searxng",
    "searxng:down": "docker compose down",
    "searxng:logs": "docker compose logs -f searxng"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "@mozilla/readability": "^0.5.0",
    "better-sqlite3": "^11.5.0",
    "cheerio": "^1.0.0",
    "jsdom": "^25.0.1",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 3: Install new deps**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm install
```
Expected: `@mozilla/readability` + `jsdom` added, no errors. jsdom is heavy (~5MB) — that's expected.

Verify:
```bash
ls /home/tahseen-dar/Projects/research-mcp/node_modules/@mozilla/readability/package.json /home/tahseen-dar/Projects/research-mcp/node_modules/jsdom/package.json
```
Expected: both exist.

- [ ] **Step 4: Create SearXNG settings.yml**

Create `searxng-config/settings.yml`:

```yaml
use_default_settings: true
general:
  instance_name: "research-mcp-searxng"
search:
  formats:
    - html
    - json
server:
  secret_key: "research-mcp-local-only-change-if-exposing-publicly"
  limiter: false
  image_proxy: false
ui:
  static_use_hash: true
```

- [ ] **Step 5: Create docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: research-mcp-searxng
    restart: unless-stopped
    ports:
      - "8888:8080"
    volumes:
      - ./searxng-config:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
      - INSTANCE_NAME=research-mcp-searxng
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
      - DAC_OVERRIDE
    logging:
      driver: "json-file"
      options:
        max-size: "1m"
        max-file: "1"
```

- [ ] **Step 6: Create extractor dirs**

Run:
```bash
mkdir -p /home/tahseen-dar/Projects/research-mcp/src/extractors /home/tahseen-dar/Projects/research-mcp/test/extractors
```

- [ ] **Step 7: Update .gitignore to ignore SearXNG runtime data**

Append to `~/Projects/research-mcp/.gitignore`:

```
# SearXNG generated state (settings.yml is kept; runtime artifacts aren't)
searxng-config/uwsgi.ini
searxng-config/*.log
```

- [ ] **Step 8: Commit scaffolding**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "chore: v0.3.0 spec + docker-compose + deps (mozilla readability, jsdom)"
```

---

## Task 1: SearXNG search module (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/searxng.test.js`
- Create: `~/Projects/research-mcp/src/searxng.js`

- [ ] **Step 1: Write failing tests**

Create `test/searxng.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searxngSearch, isSearxngReachable } from '../src/searxng.js';

function mockFetchOk(body) {
  return mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function mockFetchFail(status = 500) {
  return mock.fn(async () => ({
    ok: false, status, statusText: 'Error',
    text: async () => '',
  }));
}

test('searxngSearch returns normalized results from JSON response', async () => {
  const fakeFetch = mockFetchOk({
    query: 'foo',
    results: [
      { title: 'A', url: 'https://a.test', content: 'snippet A', engine: 'google' },
      { title: 'B', url: 'https://b.test', content: 'snippet B', engine: 'bing' },
      { title: 'C', url: 'https://c.test', content: 'snippet C', engine: 'brave' },
    ],
  });
  const results = await searxngSearch('foo', 5, { fetchImpl: fakeFetch });
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { title: 'A', url: 'https://a.test', snippet: 'snippet A' });
  // Verify URL it called
  const calledUrl = fakeFetch.mock.calls[0].arguments[0];
  assert.match(calledUrl, /\/search\?q=foo&format=json/);
});

test('searxngSearch respects num_results limit', async () => {
  const fakeFetch = mockFetchOk({
    results: Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, url: `https://${i}.test`, content: `s${i}` })),
  });
  const results = await searxngSearch('foo', 3, { fetchImpl: fakeFetch });
  assert.equal(results.length, 3);
});

test('searxngSearch handles results without content field', async () => {
  const fakeFetch = mockFetchOk({
    results: [{ title: 'A', url: 'https://a.test' }],  // no content
  });
  const results = await searxngSearch('foo', 5, { fetchImpl: fakeFetch });
  assert.equal(results[0].snippet, '');
});

test('searxngSearch throws on non-200 response', async () => {
  const fakeFetch = mockFetchFail(503);
  await assert.rejects(
    () => searxngSearch('foo', 5, { fetchImpl: fakeFetch }),
    /SearXNG returned 503/
  );
});

test('searxngSearch uses custom baseUrl', async () => {
  const fakeFetch = mockFetchOk({ results: [] });
  await searxngSearch('foo', 5, { fetchImpl: fakeFetch, baseUrl: 'http://elsewhere:9999' });
  const calledUrl = fakeFetch.mock.calls[0].arguments[0];
  assert.match(calledUrl, /^http:\/\/elsewhere:9999\//);
});

test('searxngSearch uses cache on hit', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeCache = {
    get: mock.fn(() => ({ result: [{ title: 'Cached', url: 'https://x', snippet: 's' }] })),
    set: mock.fn(),
  };
  const results = await searxngSearch('foo', 3, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(results[0].title, 'Cached');
  assert.equal(fakeFetch.mock.calls.length, 0);
});

test('searxngSearch writes to cache on miss', async () => {
  const fakeFetch = mockFetchOk({ results: [{ title: 'X', url: 'https://x', content: 's' }] });
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  await searxngSearch('foo', 3, { fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  const stored = fakeCache.set.mock.calls[0].arguments[0];
  assert.equal(stored.tool, 'web_search');
});

test('isSearxngReachable returns true on 200', async () => {
  const fakeFetch = mockFetchOk('OK');
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), true);
});

test('isSearxngReachable returns false on error', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('connection refused'); });
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), false);
});

test('isSearxngReachable returns false on non-200', async () => {
  const fakeFetch = mockFetchFail(503);
  assert.equal(await isSearxngReachable('http://localhost:8888', fakeFetch), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/searxng.test.js 2>&1 | tail -8
```
Expected: FAIL with `Cannot find module '../src/searxng.js'`.

- [ ] **Step 3: Implement searxng.js**

Create `src/searxng.js`:

```js
import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';

const DEFAULT_BASE_URL = 'http://localhost:8888';

/**
 * Query a local SearXNG instance via its JSON API.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.baseUrl='http://localhost:8888']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {object} [opts.cache] - Cache instance
 * @param {number} [opts.ttlMs] - required if cache provided
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function searxngSearch(query, numResults = 5, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    cache,
    ttlMs,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetchImpl(url, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.3.0' },
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
      params: { num_results: numResults },
      result: results,
    });
  }

  return results;
}

/**
 * Quick liveness probe — does SearXNG answer at this baseUrl?
 * @param {string} baseUrl
 * @param {function} [fetchImpl=curlFetch]
 * @returns {Promise<boolean>}
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
cd /home/tahseen-dar/Projects/research-mcp && node --test test/searxng.test.js 2>&1 | tail -15
```
Expected: 10/10 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(searxng): JSON API client + reachability probe with cache integration"
```

---

## Task 2: webSearch router in search.js

**Files:**
- Modify: `~/Projects/research-mcp/src/search.js`
- Modify: `~/Projects/research-mcp/test/search.test.js`

- [ ] **Step 1: Add router tests to search.test.js**

Append to `test/search.test.js`:

```js
import { webSearch } from '../src/search.js';

test('webSearch routes to searxng when backend=searxng', async () => {
  const fakeSearxng = mock.fn(async () => [{ title: 'SX', url: 'https://x', snippet: 's' }]);
  const fakeDdg = mock.fn(async () => { throw new Error('should not be called'); });
  const results = await webSearch('foo', 3, {
    backend: 'searxng',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
  });
  assert.equal(results[0].title, 'SX');
  assert.equal(fakeSearxng.mock.calls.length, 1);
  assert.equal(fakeDdg.mock.calls.length, 0);
});

test('webSearch routes to ddg when backend=ddg', async () => {
  const fakeSearxng = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeDdg = mock.fn(async () => [{ title: 'DG', url: 'https://x', snippet: 's' }]);
  const results = await webSearch('foo', 3, {
    backend: 'ddg',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
  });
  assert.equal(results[0].title, 'DG');
});

test('webSearch in auto mode tries searxng first when reachable', async () => {
  const fakeSearxng = mock.fn(async () => [{ title: 'SX', url: 'https://x', snippet: 's' }]);
  const fakeDdg = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeProbe = mock.fn(async () => true);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(results[0].title, 'SX');
});

test('webSearch in auto mode falls back to ddg when searxng unreachable', async () => {
  const fakeSearxng = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeDdg = mock.fn(async () => [{ title: 'DG', url: 'https://x', snippet: 's' }]);
  const fakeProbe = mock.fn(async () => false);
  const results = await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    ddgImpl: fakeDdg,
    reachableImpl: fakeProbe,
  });
  assert.equal(results[0].title, 'DG');
});

test('webSearch passes cache and ttlMs through to underlying backend', async () => {
  let captured = null;
  const fakeSearxng = mock.fn(async (q, n, opts) => { captured = opts; return []; });
  const fakeProbe = mock.fn(async () => true);
  const fakeCache = { get: () => null, set: () => {} };
  await webSearch('foo', 3, {
    backend: 'auto',
    searxngImpl: fakeSearxng,
    reachableImpl: fakeProbe,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(captured.cache, fakeCache);
  assert.equal(captured.ttlMs, 60_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -8
```
Expected: 6 existing pass; 5 new fail with `webSearch is not a function`.

- [ ] **Step 3: Add webSearch router to search.js**

Append to `src/search.js`:

```js
import { searxngSearch, isSearxngReachable } from './searxng.js';

/**
 * Route a search query to either SearXNG or DuckDuckGo based on env/opts.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.backend='auto'] - 'auto' | 'searxng' | 'ddg'
 * @param {string} [opts.searxngUrl] - passed through to searxng backend
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {function} [opts.searxngImpl=searxngSearch] - inject for tests
 * @param {function} [opts.ddgImpl=duckDuckGoSearch] - inject for tests
 * @param {function} [opts.reachableImpl=isSearxngReachable] - inject for tests
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
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

  if (backend === 'searxng') {
    return await searxngImpl(query, numResults, downstreamOpts);
  }
  if (backend === 'ddg') {
    return await ddgImpl(query, numResults, downstreamOpts);
  }
  // auto
  const reachable = await reachableImpl(searxngUrl || 'http://localhost:8888');
  if (reachable) {
    return await searxngImpl(query, numResults, downstreamOpts);
  }
  return await ddgImpl(query, numResults, downstreamOpts);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -10
```
Expected: 11/11 pass (6 original + 5 new).

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(search): webSearch router with auto-detect + searxng/ddg backends"
```

---

## Task 3: Mozilla Readability fallback (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/readability.test.js`
- Create: `~/Projects/research-mcp/src/readability.js`

- [ ] **Step 1: Write failing tests**

Create `test/readability.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readabilityFetch } from '../src/readability.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Sample Page</title></head>
  <body>
    <nav>Site navigation that should be stripped</nav>
    <article>
      <h1>Real article title</h1>
      <p>This is the first paragraph of real content that Readability should extract.</p>
      <p>This is the second paragraph with more substantial text so Readability
         considers it meaningful content worth extracting from the page.</p>
      <p>And a third paragraph because Readability favors longer content blocks.</p>
    </article>
    <footer>Footer junk</footer>
  </body>
</html>`;

function mockFetch(body, ok = true, status = 200) {
  return mock.fn(async () => ({
    ok, status, statusText: ok ? 'OK' : 'Error',
    text: async () => body,
  }));
}

test('readabilityFetch extracts main content via @mozilla/readability', async () => {
  const fakeFetch = mockFetch(SAMPLE_HTML);
  const result = await readabilityFetch('https://example.test/page', { fetchImpl: fakeFetch, maxChars: 5000 });
  assert.ok(result.content, `expected content, got error: ${result.error}`);
  assert.match(result.content, /first paragraph of real content/);
  assert.match(result.content, /second paragraph/);
  // Should NOT include nav or footer
  assert.doesNotMatch(result.content, /Site navigation/);
  assert.doesNotMatch(result.content, /Footer junk/);
});

test('readabilityFetch returns title from article', async () => {
  const fakeFetch = mockFetch(SAMPLE_HTML);
  const result = await readabilityFetch('https://example.test/page', { fetchImpl: fakeFetch });
  // Readability picks title from h1 or <title>
  assert.ok(result.title, 'expected title');
  assert.match(result.title, /Sample Page|Real article title/);
});

test('readabilityFetch truncates when content exceeds max_chars', async () => {
  const longHtml = `<article>${'<p>'.repeat(1)}${'x'.repeat(10000)}${'</p>'.repeat(1)}</article>`;
  const fakeFetch = mockFetch(`<html><body>${longHtml}</body></html>`);
  const result = await readabilityFetch('https://example.test/long', { fetchImpl: fakeFetch, maxChars: 500 });
  if (result.content) {
    assert.ok(result.content.length <= 500);
    assert.equal(result.truncated, true);
  }
});

test('readabilityFetch surfaces non-200 response as error', async () => {
  const fakeFetch = mockFetch('', false, 404);
  const result = await readabilityFetch('https://example.test/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('readabilityFetch returns error when HTML has no extractable content', async () => {
  const fakeFetch = mockFetch('<html><body></body></html>');
  const result = await readabilityFetch('https://example.test/empty', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /Readability/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/readability.test.js 2>&1 | tail -5
```
Expected: FAIL with `Cannot find module '../src/readability.js'`.

- [ ] **Step 3: Implement readability.js**

Create `src/readability.js`:

```js
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { curlFetch } from './http.js';

/**
 * Fetch a URL and extract main content using Mozilla Readability + jsdom.
 * This is the offline fallback when Jina Reader fails.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{url, title, content, truncated, error?}>}
 */
export async function readabilityFetch(url, opts = {}) {
  const { maxChars = 20000, fetchImpl = curlFetch, timeoutMs = 15000 } = opts;

  try {
    const res = await fetchImpl(url, {
      timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.3.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok) {
      return {
        url, title: null, content: null, truncated: false,
        error: `${res.status} ${res.statusText}`,
      };
    }

    const html = await res.text();
    let dom;
    try {
      dom = new JSDOM(html, { url });
    } catch (e) {
      return { url, title: null, content: null, truncated: false, error: `jsdom parse failed: ${e.message}` };
    }

    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length === 0) {
      return { url, title: null, content: null, truncated: false, error: 'Readability parse returned no content' };
    }

    const raw = article.textContent.trim();
    const truncated = raw.length > maxChars;
    return {
      url,
      title: article.title || null,
      content: truncated ? raw.slice(0, maxChars) : raw,
      truncated,
    };
  } catch (err) {
    return {
      url, title: null, content: null, truncated: false,
      error: String(err.message || err),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/readability.test.js 2>&1 | tail -12
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(readability): @mozilla/readability + jsdom fallback fetcher"
```

---

## Task 4: Extractor registry (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/extractorRegistry.test.js`
- Create: `~/Projects/research-mcp/src/extractorRegistry.js`

- [ ] **Step 1: Write failing tests**

Create `test/extractorRegistry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExtractor, listExtractors } from '../src/extractorRegistry.js';

test('findExtractor matches github repo URL', () => {
  const e = findExtractor('https://github.com/facebook/react');
  assert.ok(e, 'should match');
  assert.equal(e.name, 'github');
});

test('findExtractor matches github subpath URLs (issues/PR)', () => {
  assert.ok(findExtractor('https://github.com/anthropics/claude-code/issues/123'));
  assert.ok(findExtractor('https://github.com/owner/repo/pull/456'));
});

test('findExtractor matches www.github.com', () => {
  assert.ok(findExtractor('https://www.github.com/foo/bar'));
});

test('findExtractor matches npm package URL', () => {
  const e = findExtractor('https://www.npmjs.com/package/express');
  assert.equal(e.name, 'npm');
});

test('findExtractor matches scoped npm package URL', () => {
  const e = findExtractor('https://www.npmjs.com/package/@anthropic-ai/sdk');
  assert.equal(e.name, 'npm');
});

test('findExtractor matches stack overflow question URL', () => {
  const e = findExtractor('https://stackoverflow.com/questions/12345/some-title');
  assert.equal(e.name, 'stackoverflow');
});

test('findExtractor matches MDN URL', () => {
  const e = findExtractor('https://developer.mozilla.org/en-US/docs/Web/API/fetch');
  assert.equal(e.name, 'mdn');
});

test('findExtractor returns null for unknown URLs', () => {
  assert.equal(findExtractor('https://random-blog.example.com/post/123'), null);
});

test('listExtractors returns metadata for all extractors', () => {
  const list = listExtractors();
  const names = list.map(e => e.name).sort();
  assert.deepEqual(names, ['github', 'mdn', 'npm', 'stackoverflow']);
  for (const e of list) {
    assert.equal(typeof e.pattern, 'string');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractorRegistry.test.js 2>&1 | tail -5
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement extractorRegistry.js**

Create `src/extractorRegistry.js`:

```js
import { githubExtractor } from './extractors/github.js';
import { npmExtractor } from './extractors/npm.js';
import { stackoverflowExtractor } from './extractors/stackoverflow.js';
import { mdnExtractor } from './extractors/mdn.js';

const REGISTRY = [
  {
    name: 'github',
    pattern: /^https?:\/\/(?:www\.)?github\.com\/[^\/]+\/[^\/]+/i,
    extract: githubExtractor,
  },
  {
    name: 'npm',
    pattern: /^https?:\/\/(?:www\.)?npmjs\.com\/package\//i,
    extract: npmExtractor,
  },
  {
    name: 'stackoverflow',
    pattern: /^https?:\/\/(?:[a-z]+\.)?stackoverflow\.com\/questions\/\d+/i,
    extract: stackoverflowExtractor,
  },
  {
    name: 'mdn',
    pattern: /^https?:\/\/developer\.mozilla\.org\//i,
    extract: mdnExtractor,
  },
];

/** Return the first matching extractor for this URL, or null. */
export function findExtractor(url) {
  for (const e of REGISTRY) {
    if (e.pattern.test(url)) return e;
  }
  return null;
}

/** Metadata listing for debugging / introspection. */
export function listExtractors() {
  return REGISTRY.map(e => ({ name: e.name, pattern: e.pattern.source }));
}
```

NOTE: This file imports from extractor files that don't exist yet (Tasks 5-8). Tests will still fail until those tasks land. To unblock the registry test, **create the four extractor files with stub exports first** so the imports resolve:

Create `src/extractors/github.js`:
```js
export async function githubExtractor(url) { return { url, content: null, error: 'not implemented' }; }
```

Create `src/extractors/npm.js`:
```js
export async function npmExtractor(url) { return { url, content: null, error: 'not implemented' }; }
```

Create `src/extractors/stackoverflow.js`:
```js
export async function stackoverflowExtractor(url) { return { url, content: null, error: 'not implemented' }; }
```

Create `src/extractors/mdn.js`:
```js
export async function mdnExtractor(url) { return { url, content: null, error: 'not implemented' }; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractorRegistry.test.js 2>&1 | tail -12
```
Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(extractors): registry + stub extractor modules"
```

---

## Task 5: GitHub extractor (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/extractors/github.js`
- Create: `~/Projects/research-mcp/test/extractors/github.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/extractors/github.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { githubExtractor } from '../../src/extractors/github.js';

function makeFetch(handler) {
  return mock.fn(async (url, opts) => handler(url, opts));
}

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

function errorResponse(status) {
  return { ok: false, status, statusText: 'Err', text: async () => '' };
}

test('githubExtractor fetches README + repo info for repo root URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.endsWith('/anthropics/claude-code')) {
      return jsonResponse({
        full_name: 'anthropics/claude-code',
        description: 'Claude Code CLI',
        stargazers_count: 12345,
        language: 'TypeScript',
        topics: ['cli', 'agents'],
      });
    }
    if (url.endsWith('/anthropics/claude-code/readme')) {
      return jsonResponse({ content: Buffer.from('# Hello world\nThis is the README.').toString('base64') });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const result = await githubExtractor('https://github.com/anthropics/claude-code', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /anthropics\/claude-code/);
  assert.match(result.content, /Claude Code CLI/);
  assert.match(result.content, /12345/);
  assert.match(result.content, /TypeScript/);
  assert.match(result.content, /Hello world/);
  assert.equal(result.extractor, 'github');
});

test('githubExtractor handles trailing slash on repo URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/repos/foo/bar/readme')) return jsonResponse({ content: Buffer.from('readme').toString('base64') });
    if (url.includes('/repos/foo/bar')) return jsonResponse({ full_name: 'foo/bar', description: '', stargazers_count: 0, topics: [] });
    throw new Error('unexpected');
  });
  const result = await githubExtractor('https://github.com/foo/bar/', { fetchImpl: fakeFetch });
  assert.ok(result.content);
});

test('githubExtractor strips .git suffix from repo name', async () => {
  let capturedRepoCall = null;
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/repos/foo/bar')) {
      capturedRepoCall = url;
      return jsonResponse({ full_name: 'foo/bar', description: '', stargazers_count: 0, topics: [] });
    }
    return jsonResponse({ content: '' });
  });
  await githubExtractor('https://github.com/foo/bar.git', { fetchImpl: fakeFetch });
  assert.ok(!capturedRepoCall.includes('.git'), `URL should not contain .git: ${capturedRepoCall}`);
});

test('githubExtractor fetches issue content for issue URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/issues/42/comments')) {
      return jsonResponse([
        { user: { login: 'alice' }, body: 'first comment' },
        { user: { login: 'bob' }, body: 'second comment' },
      ]);
    }
    if (url.includes('/issues/42')) {
      return jsonResponse({
        title: 'Bug: things broken',
        state: 'open',
        user: { login: 'reporter' },
        comments: 2,
        body: 'Detailed description of bug.',
      });
    }
    throw new Error('unexpected');
  });

  const result = await githubExtractor('https://github.com/owner/repo/issues/42', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /Bug: things broken/);
  assert.match(result.content, /Detailed description/);
  assert.match(result.content, /alice/);
  assert.match(result.content, /first comment/);
});

test('githubExtractor uses same code path for PR URLs (GitHub API treats both as issues)', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/issues/7')) return jsonResponse({ title: 'PR title', state: 'open', user: { login: 'u' }, comments: 0, body: 'pr body' });
    if (url.includes('/comments')) return jsonResponse([]);
    throw new Error('unexpected');
  });
  const result = await githubExtractor('https://github.com/owner/repo/pull/7', { fetchImpl: fakeFetch });
  assert.match(result.content, /PR title/);
  assert.match(result.content, /pr body/);
});

test('githubExtractor surfaces 404 as error', async () => {
  const fakeFetch = makeFetch(async () => errorResponse(404));
  const result = await githubExtractor('https://github.com/foo/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('githubExtractor truncates long content', async () => {
  const fakeFetch = makeFetch(async (url) => {
    if (url.includes('/readme')) return jsonResponse({ content: Buffer.from('x'.repeat(10000)).toString('base64') });
    return jsonResponse({ full_name: 'a/b', description: '', stargazers_count: 0, topics: [] });
  });
  const result = await githubExtractor('https://github.com/a/b', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});

test('githubExtractor passes Authorization header when GITHUB_TOKEN provided', async () => {
  let capturedHeaders = null;
  const fakeFetch = makeFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    if (url.includes('/readme')) return jsonResponse({ content: '' });
    return jsonResponse({ full_name: 'a/b', description: '', stargazers_count: 0, topics: [] });
  });
  await githubExtractor('https://github.com/a/b', { fetchImpl: fakeFetch, token: 'ghp_test' });
  assert.equal(capturedHeaders['Authorization'], 'Bearer ghp_test');
});

test('githubExtractor returns error for malformed github URL', async () => {
  const result = await githubExtractor('https://github.com/', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/github.test.js 2>&1 | tail -5
```
Expected: FAIL because the stub from Task 4 returns "not implemented".

- [ ] **Step 3: Replace the stub with real github.js**

Replace contents of `src/extractors/github.js`:

```js
import { curlFetch } from '../http.js';

const API_BASE = 'https://api.github.com';

/**
 * Extract GitHub repo README + metadata, or issue/PR content + comments.
 *
 * Handles URL patterns:
 *   github.com/{owner}/{repo}          → repo README + metadata
 *   github.com/{owner}/{repo}/issues/N → issue content + top 5 comments
 *   github.com/{owner}/{repo}/pull/N   → PR (same API endpoint as issues)
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @param {string} [opts.token=process.env.GITHUB_TOKEN] - optional
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function githubExtractor(url, opts = {}) {
  const {
    fetchImpl = curlFetch,
    maxChars = 20000,
    token = process.env.GITHUB_TOKEN,
  } = opts;

  const repoMatch = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\/|$|\?|#)/i);
  if (!repoMatch) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized github URL pattern' };
  }
  const [, owner, repoRaw] = repoMatch;
  const repo = repoRaw.replace(/\.git$/i, '');

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'research-mcp/0.3.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  const issueMatch = url.match(/\/(?:issues|pull)\/(\d+)/i);
  if (issueMatch) {
    return await fetchIssue({ fetchImpl, headers, url, owner, repo, number: issueMatch[1], maxChars });
  }
  return await fetchRepoReadme({ fetchImpl, headers, url, owner, repo, maxChars });
}

async function fetchRepoReadme({ fetchImpl, headers, url, owner, repo, maxChars }) {
  const [repoRes, readmeRes] = await Promise.all([
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/readme`, { headers, timeoutMs: 15000 }),
  ]);

  if (!repoRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `repo ${repoRes.status}` };
  }

  let repoInfo;
  try {
    repoInfo = JSON.parse(await repoRes.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `repo JSON parse failed: ${e.message}` };
  }

  let readmeText = '';
  if (readmeRes.ok) {
    try {
      const readmeJson = JSON.parse(await readmeRes.text());
      if (readmeJson.content) {
        readmeText = Buffer.from(readmeJson.content, 'base64').toString('utf8');
      }
    } catch { /* skip */ }
  }

  const header = [
    `# ${repoInfo.full_name || `${owner}/${repo}`}`,
    repoInfo.description || '',
    `★ ${repoInfo.stargazers_count ?? '?'} · ${repoInfo.language || 'mixed'} · ${(repoInfo.topics || []).join(', ')}`,
    '',
    '---',
    '',
  ].join('\n');

  const full = header + readmeText;
  const truncated = full.length > maxChars;
  return {
    url,
    title: repoInfo.full_name || `${owner}/${repo}`,
    content: truncated ? full.slice(0, maxChars) : full,
    truncated,
    extractor: 'github',
  };
}

async function fetchIssue({ fetchImpl, headers, url, owner, repo, number, maxChars }) {
  const [issueRes, commentsRes] = await Promise.all([
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/issues/${number}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`, { headers, timeoutMs: 15000 }),
  ]);

  if (!issueRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `issue ${issueRes.status}` };
  }

  const issue = JSON.parse(await issueRes.text());
  const comments = commentsRes.ok ? JSON.parse(await commentsRes.text()) : [];

  const lines = [
    `# ${issue.title}`,
    `**State:** ${issue.state} · **Author:** ${issue.user?.login ?? '?'} · **Comments:** ${issue.comments ?? '?'}`,
    '',
    issue.body || '_(no description)_',
  ];

  for (const c of comments.slice(0, 5)) {
    lines.push('', '---', `**${c.user?.login ?? '?'}:**`, c.body || '');
  }

  const md = lines.join('\n');
  const truncated = md.length > maxChars;
  return {
    url,
    title: issue.title,
    content: truncated ? md.slice(0, maxChars) : md,
    truncated,
    extractor: 'github',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/github.test.js 2>&1 | tail -15
```
Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(extractors/github): repo README + issue/PR via api.github.com"
```

---

## Task 6: NPM extractor (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/extractors/npm.js`
- Create: `~/Projects/research-mcp/test/extractors/npm.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/extractors/npm.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { npmExtractor } from '../../src/extractors/npm.js';

function makeFetch(handler) {
  return mock.fn(async (url, opts) => handler(url, opts));
}

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

const SAMPLE_PKG = {
  name: 'express',
  description: 'Fast, unopinionated, minimalist web framework',
  'dist-tags': { latest: '4.19.2' },
  versions: {
    '4.19.2': {
      author: { name: 'TJ Holowaychuk' },
      license: 'MIT',
      dependencies: { accepts: '~1.3.8', body: '^1.0.0' },
    },
  },
  homepage: 'http://expressjs.com/',
  repository: { type: 'git', url: 'git+https://github.com/expressjs/express.git' },
  keywords: ['express', 'framework', 'web'],
  readme: '# Express\n\nWeb framework for node.',
};

test('npmExtractor returns formatted package info for plain package URL', async () => {
  const fakeFetch = makeFetch(async (url) => {
    assert.match(url, /registry\.npmjs\.org\/express/);
    return jsonResponse(SAMPLE_PKG);
  });
  const result = await npmExtractor('https://www.npmjs.com/package/express', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /express \(4\.19\.2\)/);
  assert.match(result.content, /Fast, unopinionated/);
  assert.match(result.content, /TJ Holowaychuk/);
  assert.match(result.content, /MIT/);
  assert.match(result.content, /accepts/);
  assert.match(result.content, /# Express/);
  assert.equal(result.extractor, 'npm');
});

test('npmExtractor handles scoped packages', async () => {
  let calledUrl = null;
  const fakeFetch = makeFetch(async (url) => {
    calledUrl = url;
    return jsonResponse({ ...SAMPLE_PKG, name: '@anthropic-ai/sdk' });
  });
  await npmExtractor('https://www.npmjs.com/package/@anthropic-ai/sdk', { fetchImpl: fakeFetch });
  assert.match(calledUrl, /registry\.npmjs\.org\/@anthropic-ai\/sdk/);
});

test('npmExtractor surfaces 404 as error', async () => {
  const fakeFetch = makeFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' }));
  const result = await npmExtractor('https://www.npmjs.com/package/never-exists-pkg', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('npmExtractor handles missing optional fields', async () => {
  const fakeFetch = makeFetch(async () => jsonResponse({
    name: 'minimal',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {} },
  }));
  const result = await npmExtractor('https://www.npmjs.com/package/minimal', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /minimal/);
});

test('npmExtractor truncates long content', async () => {
  const fakeFetch = makeFetch(async () => jsonResponse({
    ...SAMPLE_PKG,
    readme: 'x'.repeat(50000),
  }));
  const result = await npmExtractor('https://www.npmjs.com/package/express', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});

test('npmExtractor returns error for malformed URL', async () => {
  const result = await npmExtractor('https://www.npmjs.com/', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/npm.test.js 2>&1 | tail -5
```
Expected: FAIL (stub returns "not implemented").

- [ ] **Step 3: Replace stub with real npm.js**

Replace contents of `src/extractors/npm.js`:

```js
import { curlFetch } from '../http.js';

const REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * Fetch a package's metadata + README from the npm registry.
 *
 * URL pattern: npmjs.com/package/<pkg> or npmjs.com/package/@scope/pkg
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function npmExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  // Match either /package/foo or /package/@scope/foo
  const match = url.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/(@[^\/?#]+\/[^\/?#]+|[^\/?#]+)/i);
  if (!match) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized npm package URL' };
  }
  const pkg = decodeURIComponent(match[1]);

  const res = await fetchImpl(`${REGISTRY_BASE}/${pkg}`, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.3.0', 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return { url, title: null, content: null, truncated: false, error: `npm ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `npm JSON parse failed: ${e.message}` };
  }

  const latest = data['dist-tags']?.latest ?? 'unknown';
  const version = data.versions?.[latest] ?? {};
  const author = version.author?.name || data.author?.name || 'unknown';

  const deps = Object.entries(version.dependencies || {});
  const depsBlock = deps.length
    ? deps.map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '_(none)_';

  const lines = [
    `# ${data.name} (${latest})`,
    '',
    data.description || '',
    '',
    `**Author:** ${author}`,
    `**License:** ${version.license || data.license || 'unknown'}`,
    `**Homepage:** ${data.homepage || 'n/a'}`,
    `**Repository:** ${data.repository?.url || 'n/a'}`,
    `**Keywords:** ${(data.keywords || []).join(', ') || 'none'}`,
    '',
    '## Dependencies',
    depsBlock,
    '',
    '## README',
    data.readme || version.readme || '_(no README)_',
  ];

  const md = lines.join('\n');
  const truncated = md.length > maxChars;
  return {
    url,
    title: `${data.name} (${latest})`,
    content: truncated ? md.slice(0, maxChars) : md,
    truncated,
    extractor: 'npm',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/npm.test.js 2>&1 | tail -12
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(extractors/npm): package metadata + README via registry.npmjs.org"
```

---

## Task 7: Stack Overflow extractor (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/extractors/stackoverflow.js`
- Create: `~/Projects/research-mcp/test/extractors/stackoverflow.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/extractors/stackoverflow.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stackoverflowExtractor } from '../../src/extractors/stackoverflow.js';

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

test('stackoverflowExtractor formats question + top answers', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/questions/12345/answers')) {
      return jsonResponse({
        items: [
          { score: 100, is_accepted: true, body: '<p>This is the accepted answer with <code>code</code>.</p>' },
          { score: 50, body: '<p>Another helpful answer.</p>' },
          { score: 10, body: '<p>A third answer.</p>' },
          { score: 1, body: '<p>Should not appear (only top 3).</p>' },
        ],
      });
    }
    if (url.includes('/questions/12345')) {
      return jsonResponse({
        items: [{
          title: 'How do I do X in JavaScript?',
          score: 250,
          view_count: 10000,
          tags: ['javascript', 'arrays'],
          body: '<p>I am trying to do X but I get error Y.</p>',
        }],
      });
    }
    throw new Error(`unexpected: ${url}`);
  });

  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/12345/how-do-i', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /How do I do X/);
  assert.match(result.content, /trying to do X/);
  assert.match(result.content, /accepted answer/);
  assert.match(result.content, /Another helpful/);
  assert.match(result.content, /third answer/);
  assert.doesNotMatch(result.content, /Should not appear/);
  assert.match(result.content, /score 100/);
  assert.match(result.content, /accepted/);
  assert.equal(result.extractor, 'stackoverflow');
});

test('stackoverflowExtractor strips simple HTML tags', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/answers')) return jsonResponse({ items: [] });
    return jsonResponse({
      items: [{
        title: 'Q',
        score: 1,
        view_count: 1,
        tags: ['x'],
        body: '<p>Hello <strong>bold</strong> &amp; <code>inline</code></p><pre><code>code\nblock</code></pre>',
      }],
    });
  });
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch });
  assert.match(result.content, /Hello bold &/);
  assert.match(result.content, /`inline`/);
  assert.match(result.content, /```[\s\S]*code\nblock[\s\S]*```/);
});

test('stackoverflowExtractor handles missing question gracefully', async () => {
  const fakeFetch = mock.fn(async () => jsonResponse({ items: [] }));
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/99999/missing', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /not found/i);
});

test('stackoverflowExtractor surfaces non-200 response', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '' }));
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /429/);
});

test('stackoverflowExtractor returns error for malformed URL', async () => {
  const result = await stackoverflowExtractor('https://stackoverflow.com/users/123', { fetchImpl: mock.fn() });
  assert.equal(result.content, null);
  assert.ok(result.error);
});

test('stackoverflowExtractor truncates long content', async () => {
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('/answers')) return jsonResponse({
      items: [{ score: 1, body: '<p>' + 'x'.repeat(50000) + '</p>' }],
    });
    return jsonResponse({
      items: [{ title: 'Q', score: 1, view_count: 1, tags: [], body: '<p>q</p>' }],
    });
  });
  const result = await stackoverflowExtractor('https://stackoverflow.com/questions/1/x', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/stackoverflow.test.js 2>&1 | tail -5
```
Expected: FAIL (stub).

- [ ] **Step 3: Replace stub with real stackoverflow.js**

Replace contents of `src/extractors/stackoverflow.js`:

```js
import { curlFetch } from '../http.js';

const API_BASE = 'https://api.stackexchange.com/2.3';

/**
 * Fetch a Stack Overflow question + top answers via the Stack Exchange API.
 *
 * URL pattern: stackoverflow.com/questions/{id}/...
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function stackoverflowExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  const match = url.match(/stackoverflow\.com\/questions\/(\d+)/i);
  if (!match) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized SO URL pattern' };
  }
  const id = match[1];

  const headers = { 'User-Agent': 'research-mcp/0.3.0', 'Accept': 'application/json' };
  const filter = 'withbody';

  const [qRes, aRes] = await Promise.all([
    fetchImpl(`${API_BASE}/questions/${id}?site=stackoverflow&filter=${filter}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/questions/${id}/answers?site=stackoverflow&filter=${filter}&order=desc&sort=votes`, { headers, timeoutMs: 15000 }),
  ]);

  if (!qRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `SO question ${qRes.status}` };
  }

  let qData;
  try {
    qData = JSON.parse(await qRes.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `SO JSON parse failed: ${e.message}` };
  }

  const q = qData.items?.[0];
  if (!q) {
    return { url, title: null, content: null, truncated: false, error: 'question not found' };
  }

  let answers = [];
  if (aRes.ok) {
    try {
      const aData = JSON.parse(await aRes.text());
      answers = aData.items || [];
    } catch { /* skip */ }
  }

  const lines = [
    `# ${q.title}`,
    `**Score:** ${q.score} · **Views:** ${q.view_count} · **Tags:** ${(q.tags || []).join(', ')}`,
    '',
    htmlToMd(q.body || ''),
    '',
    '## Top Answers',
  ];

  answers.slice(0, 3).forEach((a, i) => {
    const acceptedMarker = a.is_accepted ? '✓ accepted, ' : '';
    lines.push('', `### Answer ${i + 1} (${acceptedMarker}score ${a.score})`, htmlToMd(a.body || ''));
  });

  const md = lines.join('\n');
  const truncated = md.length > maxChars;
  return {
    url,
    title: q.title,
    content: truncated ? md.slice(0, maxChars) : md,
    truncated,
    extractor: 'stackoverflow',
  };
}

/** Minimal HTML → markdown for SO answer bodies (which are clean HTML). */
function htmlToMd(html) {
  return html
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code>([^<]+)<\/code>/gi, '`$1`')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/stackoverflow.test.js 2>&1 | tail -12
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(extractors/stackoverflow): Q+top3 answers via api.stackexchange.com"
```

---

## Task 8: MDN extractor (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/extractors/mdn.js`
- Create: `~/Projects/research-mcp/test/extractors/mdn.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/extractors/mdn.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mdnExtractor } from '../../src/extractors/mdn.js';

const SAMPLE_MDN_HTML = `<!DOCTYPE html>
<html>
<head><title>fetch() - Web APIs | MDN</title></head>
<body>
  <nav>top nav junk</nav>
  <aside>side junk</aside>
  <main>
    <article class="main-page-content">
      <h1>fetch()</h1>
      <p>The fetch() method starts the process of fetching a resource from the network.</p>
      <p>It returns a Promise which is fulfilled once the response is available.</p>
      <div class="notecard">should be stripped</div>
      <div class="interactive-example">interactive example removed</div>
      <p>You can use it like: fetch(url).then(response => response.json())</p>
    </article>
  </main>
  <footer>footer noise</footer>
</body>
</html>`;

function mockFetch(body, ok = true, status = 200) {
  return mock.fn(async () => ({
    ok, status, statusText: ok ? 'OK' : 'Err',
    text: async () => body,
  }));
}

test('mdnExtractor extracts main-page-content via cheerio', async () => {
  const fakeFetch = mockFetch(SAMPLE_MDN_HTML);
  const result = await mdnExtractor('https://developer.mozilla.org/en-US/docs/Web/API/fetch', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /starts the process of fetching/);
  assert.match(result.content, /Promise which is fulfilled/);
  assert.doesNotMatch(result.content, /top nav junk/);
  assert.doesNotMatch(result.content, /should be stripped/);
  assert.doesNotMatch(result.content, /interactive example removed/);
  assert.equal(result.extractor, 'mdn');
});

test('mdnExtractor pulls title from h1', async () => {
  const fakeFetch = mockFetch(SAMPLE_MDN_HTML);
  const result = await mdnExtractor('https://developer.mozilla.org/foo', { fetchImpl: fakeFetch });
  assert.ok(result.title);
  assert.match(result.title, /fetch/);
});

test('mdnExtractor falls back to <main> if .main-page-content missing', async () => {
  const html = '<html><body><main><h1>Title</h1><p>Body text here.</p></main></body></html>';
  const fakeFetch = mockFetch(html);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.ok(result.content);
  assert.match(result.content, /Body text here/);
});

test('mdnExtractor returns error when no main content found', async () => {
  const html = '<html><body><p>Just floating text with no main element.</p></body></html>';
  const fakeFetch = mockFetch(html);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /main content/i);
});

test('mdnExtractor surfaces 404 as error', async () => {
  const fakeFetch = mockFetch('', false, 404);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /404/);
});

test('mdnExtractor truncates long content', async () => {
  const longContent = '<main><article class="main-page-content"><h1>T</h1><p>' + 'x'.repeat(50000) + '</p></article></main>';
  const fakeFetch = mockFetch(`<html><body>${longContent}</body></html>`);
  const result = await mdnExtractor('https://developer.mozilla.org/x', { fetchImpl: fakeFetch, maxChars: 500 });
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncated, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/mdn.test.js 2>&1 | tail -5
```
Expected: FAIL (stub).

- [ ] **Step 3: Replace stub with real mdn.js**

Replace contents of `src/extractors/mdn.js`:

```js
import { load } from 'cheerio';
import { curlFetch } from '../http.js';

/**
 * Fetch an MDN page directly and extract `.main-page-content` (or `<main>` fallback)
 * via cheerio. MDN HTML is highly structured so this is cheaper + more reliable than Jina.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function mdnExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  try {
    const res = await fetchImpl(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.3.0)', 'Accept': 'text/html' },
    });

    if (!res.ok) {
      return { url, title: null, content: null, truncated: false, error: `MDN ${res.status}` };
    }

    const html = await res.text();
    const $ = load(html);

    const title = $('h1').first().text().trim() || $('title').text().trim() || null;

    let $main = $('.main-page-content').first();
    if ($main.length === 0) {
      $main = $('main').first();
    }
    if ($main.length === 0) {
      return { url, title, content: null, truncated: false, error: 'MDN main content not found' };
    }

    // Strip well-known noise selectors
    $main.find('.notecard, .ix, .interactive-example, nav, aside, .langlist, .last-modified-date').remove();

    const raw = $main.text().replace(/\s+/g, ' ').trim();
    const truncated = raw.length > maxChars;
    return {
      url,
      title,
      content: truncated ? raw.slice(0, maxChars) : raw,
      truncated,
      extractor: 'mdn',
    };
  } catch (err) {
    return {
      url, title: null, content: null, truncated: false,
      error: String(err.message || err),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/extractors/mdn.test.js 2>&1 | tail -12
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(extractors/mdn): cheerio extraction of .main-page-content"
```

---

## Task 9: smartFetch router in fetch.js (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/smartFetch.test.js`
- Modify: `~/Projects/research-mcp/src/fetch.js`
- Modify: `~/Projects/research-mcp/src/combine.js`

- [ ] **Step 1: Write failing smartFetch tests**

Create `test/smartFetch.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { smartFetch } from '../src/fetch.js';

test('smartFetch uses extractor when URL matches', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async (url) => ({ url, title: 'EX', content: 'extractor body', truncated: false })),
  };
  const jinaImpl = mock.fn(async () => { throw new Error('jina should not be called'); });
  const readabilityImpl = mock.fn(async () => { throw new Error('readability should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'extractor body');
  assert.equal(result.extractor, undefined);  // extractor field comes from the underlying extractor's response
});

test('smartFetch falls back to jina if extractor returns error', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async (url) => ({ url, content: null, error: 'extractor failed' })),
  };
  const jinaImpl = mock.fn(async () => ({ url: 'u', title: 'J', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'jina body');
});

test('smartFetch falls back to readability if extractor + jina both fail', async () => {
  const extractorImpl = {
    name: 'fake',
    extract: mock.fn(async () => ({ url: 'u', content: null, error: 'ex fail' })),
  };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', title: 'R', content: 'readability body', truncated: false }));

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'readability body');
});

test('smartFetch returns aggregated error when all three fail', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => ({ url: 'u', content: null, error: 'ex fail' })) };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina fail' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'read fail' }));

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, null);
  assert.match(result.error, /ex fail/);
  assert.match(result.error, /jina fail/);
  assert.match(result.error, /read fail/);
});

test('smartFetch skips extractor when disableExtractors=true', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => { throw new Error('should not be called'); }) };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://github.com/a/b', {
    extractorImpl, jinaImpl, readabilityImpl,
    disableExtractors: true,
  });
  assert.equal(result.content, 'jina body');
  assert.equal(extractorImpl.extract.mock.calls.length, 0);
});

test('smartFetch uses URL-based registry lookup when no extractorImpl provided', async () => {
  // Use a URL that doesn't match any real extractor, so it should fall through to jina
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://random-blog.example.com/post', { jinaImpl, readabilityImpl });
  assert.equal(result.content, 'jina body');
});

test('smartFetch caches successful result', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: 'body', truncated: false }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no' }));

  await smartFetch('https://random.example.com/p', {
    jinaImpl, readabilityImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'fetch_url');
});

test('smartFetch returns cache hit and skips all strategies', async () => {
  const fakeCache = { get: mock.fn(() => ({ result: { url: 'u', content: 'cached', truncated: false } })), set: mock.fn() };
  const jinaImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://random.example.com/p', {
    jinaImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(result.content, 'cached');
  assert.equal(jinaImpl.mock.calls.length, 0);
});

test('smartFetch does NOT cache when all strategies fail', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina err' }));
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'read err' }));

  await smartFetch('https://random.example.com/p', {
    jinaImpl, readabilityImpl,
    cache: fakeCache, ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/smartFetch.test.js 2>&1 | tail -5
```
Expected: FAIL with `smartFetch is not a function`.

- [ ] **Step 3: Add smartFetch to fetch.js**

Append to `src/fetch.js`:

```js
import { findExtractor } from './extractorRegistry.js';
import { readabilityFetch } from './readability.js';

/**
 * Composed fetcher: tries site-specific extractor → Jina → Readability.
 * This is the new public default; jinaFetch remains exported for direct use.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {function} [opts.fetchImpl] - HTTP impl, passed through to leaf fetchers
 * @param {boolean} [opts.disableExtractors=false]
 * @param {object} [opts.extractorImpl] - inject for tests; { name, extract: fn }
 * @param {function} [opts.jinaImpl=jinaFetch] - inject for tests
 * @param {function} [opts.readabilityImpl=readabilityFetch] - inject for tests
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function smartFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    cache,
    ttlMs,
    fetchImpl,
    disableExtractors = false,
    extractorImpl,
    jinaImpl = jinaFetch,
    readabilityImpl = readabilityFetch,
  } = opts;

  // Cache check at the smart-fetch level — same key as jinaFetch alone would use
  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const attempts = [];

  // 1. Site-specific extractor
  if (!disableExtractors) {
    const extractor = extractorImpl || findExtractor(url);
    if (extractor) {
      const r = await extractor.extract(url, { maxChars, fetchImpl });
      attempts.push({ method: extractor.name, error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    }
  }

  // 2. Jina Reader
  {
    const r = await jinaImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jina', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  // 3. Mozilla Readability
  {
    const r = await readabilityImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'readability', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  return {
    url, title: null, content: null, truncated: false,
    error: `all strategies failed: ${attempts.map(a => `${a.method}=${a.error || 'no content'}`).join('; ')}`,
  };
}
```

- [ ] **Step 4: Switch combine.js default fetchImpl from jinaFetch to smartFetch**

Update `src/combine.js` import:

```js
import { duckDuckGoSearch } from './search.js';
import { jinaFetch, smartFetch } from './fetch.js';
import { cacheKeyFor } from './cacheKey.js';
```

Update the default `fetchImpl` in `searchAndRead`:

```js
    fetchImpl = smartFetch,
```

(Just change that one line — everything else in `searchAndRead` stays the same. `jinaFetch` import is no longer used in combine.js, so remove it from the import: `import { smartFetch } from './fetch.js';`.)

- [ ] **Step 5: Run tests**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: 38 (existing) + 10 (smartFetch) + 10 (searxng) + 5 (webSearch router) + 5 (readability) + 9 (extractorRegistry) + 9 (github) + 6 (npm) + 6 (stackoverflow) + 6 (mdn) = **104 tests pass**.

If combine.js tests fail, recheck the fetchImpl swap — combine.js tests inject their own `fetchImpl`, so the default shouldn't matter to them.

- [ ] **Step 6: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(fetch): smartFetch router (extractor → jina → readability) + cache integration; combine uses smartFetch by default"
```

---

## Task 10: Server env wiring + use new routers

**Files:**
- Modify: `~/Projects/research-mcp/src/server.js`

- [ ] **Step 1: Wire env vars + switch to webSearch / smartFetch**

Edit `src/server.js`:

Replace the imports section (top of file, after dns + os/path imports):

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { webSearch } from './search.js';
import { smartFetch } from './fetch.js';
import { searchAndRead } from './combine.js';
import { Cache } from './cache.js';
```

Replace the env config block:

```js
const DB_PATH = process.env.RESEARCH_MCP_DB_PATH || join(homedir(), '.research-mcp', 'cache.db');
const TTL_HOURS = Number(process.env.RESEARCH_MCP_CACHE_TTL_HOURS ?? 24);
const TTL_MS = Number.isFinite(TTL_HOURS) && TTL_HOURS > 0 ? TTL_HOURS * 3600 * 1000 : 0;

const SEARCH_BACKEND = process.env.SEARCH_BACKEND || 'auto';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';
const DISABLE_EXTRACTORS = process.env.DISABLE_EXTRACTORS === '1';

const cache = new Cache({ dbPath: DB_PATH });
```

Replace the tool handler bodies — three changes:

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

    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await smartFetch(url, {
        maxChars: max_chars,
        cache, ttlMs: TTL_MS,
        disableExtractors: DISABLE_EXTRACTORS,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
        cache, ttlMs: TTL_MS,
        // combine.js now defaults fetchImpl to smartFetch; need to also route the search
        searchImpl: (q, n) => webSearch(q, n, { cache, ttlMs: TTL_MS, backend: SEARCH_BACKEND, searxngUrl: SEARXNG_URL }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
```

Update the version + startup banner:

```js
const server = new Server(
  { name: 'research-mcp', version: '0.3.0' },
  { capabilities: { tools: {} } }
);
```

And:

```js
process.stderr.write(`[research-mcp] v0.3.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

- [ ] **Step 2: Smoke-test server starts + lists tools**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | timeout 5 node src/server.js 2>&1 | head -3
```
Expected: stderr line `[research-mcp] v0.3.0 connected | ...` + two JSON-RPC responses. The tools/list response should still show all 5 tool names.

- [ ] **Step 3: Run existing server.test.js to ensure no regressions**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/server.test.js 2>&1 | tail -10
```
Expected: 3/3 pass (existing tests still work because server.test.js doesn't depend on which backend is used).

- [ ] **Step 4: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(server): wire webSearch + smartFetch routers; env-driven backend selection"
```

---

## Task 11: Live verify + Docker + smoke + README + tag

**Files:**
- Modify: `~/Projects/research-mcp/README.md`
- Create: `~/Projects/research-mcp/scripts/smoke-searxng.js`
- Create: `~/Projects/research-mcp/scripts/smoke-extractors.js`

- [ ] **Step 1: Start SearXNG via Docker Compose**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && docker compose up -d searxng 2>&1 | tail -10
```
Expected: container starts. First run pulls the image (~5 min on slow connections).

Verify health (give it ~10s to boot):
```bash
sleep 10 && curl -sS http://localhost:8888/healthz 2>&1
```
Expected: `OK` or empty 200 response.

If 503 or empty: `docker compose logs searxng | tail -30` to diagnose.

- [ ] **Step 2: Create scripts/smoke-searxng.js**

Create `scripts/smoke-searxng.js`:

```js
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
```

- [ ] **Step 3: Run SearXNG smoke**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && timeout 30 node scripts/smoke-searxng.js 2>&1 | tail -25
```
Expected: reachable=true, both direct and router calls return 3 results each with non-empty titles + URLs.

- [ ] **Step 4: Create scripts/smoke-extractors.js**

Create `scripts/smoke-extractors.js`:

```js
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
```

- [ ] **Step 5: Run extractor smoke**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && timeout 120 node scripts/smoke-extractors.js 2>&1 | tail -10
```
Expected: at least 4 of 6 OK (some may fail due to GitHub rate limits without a token, or SO 429). Each OK row should show title + non-zero content length.

- [ ] **Step 6: Update README.md**

Replace contents of `README.md`:

```markdown
# research-mcp

Zero-cost MCP server giving Claude Code agents fresh web research via meta-search (SearXNG or DDG) + multi-strategy content extraction (site-specific extractors → Jina Reader → Mozilla Readability), with transparent SQLite caching.

## Tools

| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5)` | You just need URLs — no content. |
| `fetch_url(url, max_chars=20000)` | You have a URL and want clean markdown content. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000)` | **Default research call** — top-N results + their content in one shot. |
| `list_research(limit=20, tool_filter?)` | Browse what's already cached. Free, instant. |
| `get_research(id)` | Pull full cached content by id (from `list_research`). Zero network. |

## v0.3.0 architecture (Tier 2 + Tier 3c)

### Search backend selection

- **SearXNG** (Docker, `localhost:8888`) — meta-searches Google/Bing/Brave/DDG/etc., returns JSON. Default if reachable.
- **DuckDuckGo HTML** — built-in fallback when SearXNG is unreachable. Zero infra mode.
- Selection via `SEARCH_BACKEND` env: `auto` (default; probes SearXNG, falls back to DDG), `searxng` (force), `ddg` (force).

### Content extraction strategy (per URL)

```
fetch_url(url) and search_and_read internally use smartFetch:

   ┌──────────────────────────────────────────────────────────┐
   │  smartFetch(url)                                         │
   │                                                          │
   │  1. URL matches registered pattern?                      │
   │     • github.com/X/Y         → GitHub API extractor      │
   │     • github.com/X/Y/issues/N→ GitHub Issue extractor    │
   │     • npmjs.com/package/X    → NPM registry extractor    │
   │     • stackoverflow.com/q/N  → Stack Exchange extractor  │
   │     • developer.mozilla.org/ → MDN cheerio extractor     │
   │     → YES: try it; on success return                     │
   │                                                          │
   │  2. Fall through to Jina Reader (handles JS-rendered)    │
   │     → on success return                                  │
   │                                                          │
   │  3. Fall through to @mozilla/readability + jsdom         │
   │     → on success return                                  │
   │                                                          │
   │  4. All three failed → aggregated error                  │
   └──────────────────────────────────────────────────────────┘
```

Disable extractors with `DISABLE_EXTRACTORS=1` for debugging / opt-out.

## Setup

### One-time: start SearXNG

```bash
cd ~/Projects/research-mcp
docker compose up -d searxng
```

Verify: `curl http://localhost:8888/healthz` → 200.

Stop with `docker compose down`. Logs: `docker compose logs -f searxng`.

### Register with Claude Code (one-time, at user scope)

```bash
claude mcp add -s user research-mcp -- node ~/Projects/research-mcp/src/server.js
```

Verify: `claude mcp list | grep research-mcp` → `✓ Connected`.

## Environment variables

| Env | Default | Effect |
|-----|---------|--------|
| `RESEARCH_MCP_DB_PATH` | `~/.research-mcp/cache.db` | SQLite cache location |
| `RESEARCH_MCP_CACHE_TTL_HOURS` | `24` | Cache TTL; `0` disables caching |
| `SEARCH_BACKEND` | `auto` | `auto` / `searxng` / `ddg` |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG base URL |
| `DISABLE_EXTRACTORS` | unset | Set to `1` to skip site-specific extractors |
| `GITHUB_TOKEN` | unset | Optional; raises GitHub API limit 60/hr → 5000/hr |

## Tests

```bash
npm test                          # offline unit tests (104 tests)
npm run test:integration          # real network — end-to-end validation
node scripts/smoke-cache.js       # cache round-trip
node scripts/smoke-searxng.js     # SearXNG end-to-end
node scripts/smoke-extractors.js  # all 4 extractors + Jina fallback
```

## Architecture / files

```
src/
├── server.js              # MCP protocol wiring, env config
├── search.js              # webSearch router; parseDuckDuckGoHtml; duckDuckGoSearch
├── searxng.js             # SearXNG JSON API client + reachability probe
├── fetch.js               # smartFetch router; jinaFetch (kept exported)
├── readability.js         # Mozilla Readability + jsdom fallback
├── extractorRegistry.js   # URL pattern → extractor lookup
├── extractors/
│   ├── github.js          # api.github.com (README, issues, PRs)
│   ├── npm.js             # registry.npmjs.org
│   ├── stackoverflow.js   # api.stackexchange.com
│   └── mdn.js             # cheerio scrape of MDN .main-page-content
├── combine.js             # search_and_read composer
├── cache.js               # SQLite cache (better-sqlite3)
├── cacheKey.js            # SHA-256 cache key builder
└── http.js                # curl-backed HTTP (see SPEC.md for why)
```

## Requirements

- Node.js ≥ 20
- `curl` on PATH
- Docker (for SearXNG; optional — falls back to DDG without it)
- C toolchain for `better-sqlite3` native build (`python3` + `make`)

## Maintenance

- If `web_search` returns empty arrays, DDG markup changed: refresh `test/fixtures/ddg-results.html` and update parser.
- If SearXNG returns no results, check `docker compose logs searxng` — usually upstream engine rate limit; restart container.
- To wipe cache: `rm ~/.research-mcp/cache.db`.
```

- [ ] **Step 7: Commit + tag**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "docs: v0.3.0 README + SearXNG/extractor smoke scripts" && git tag v0.3.0 && git log --oneline | head -15
```

- [ ] **Step 8: Update memory pointer**

Update `~/.claude/projects/-home-tahseen-dar-POSSystem-Inventory-System-Root/memory/project_research-mcp-tool.md` to note v0.3.0: SearXNG backend (Docker), Readability fallback, 4 site-specific extractors. Update MEMORY.md index line.

- [ ] **Step 9: Final reachability + integration check**

```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -8 && echo "---" && claude mcp list | grep research-mcp
```
Expected: all tests pass; `research-mcp: ... - ✓ Connected`.

---

## Self-Review

**1. Spec coverage:**
- SearXNG search via Docker + JSON API → Task 0 (compose) + Task 1 (client) + Task 11 (live start) ✓
- DDG fallback preserved → Task 2 (webSearch router) ✓
- Backend auto-detection via /healthz probe → Task 2 (`reachableImpl` in auto branch) + Task 1 (`isSearxngReachable`) ✓
- Env vars (SEARCH_BACKEND, SEARXNG_URL, DISABLE_EXTRACTORS, GITHUB_TOKEN) → Task 10 (server.js) + Task 5 (GITHUB_TOKEN read in github.js) ✓
- Mozilla Readability fallback → Task 3 ✓
- Extractor registry → Task 4 ✓
- GitHub extractor (repo + issue/PR) → Task 5 ✓
- NPM extractor → Task 6 ✓
- Stack Overflow extractor → Task 7 ✓
- MDN extractor → Task 8 ✓
- smartFetch composition (extractor → Jina → Readability) → Task 9 ✓
- Cache wraps smartFetch (no double-caching) → Task 9 step 3 (cache check at smartFetch top; jinaFetch called without cache param from smartFetch) ✓
- combine.js uses smartFetch by default → Task 9 step 4 ✓
- server.js uses webSearch + smartFetch → Task 10 ✓
- search_and_read also uses webSearch for its search step → Task 10 step 1 (explicit `searchImpl` injection) ✓
- Live SearXNG smoke → Task 11 step 3 ✓
- Live extractor smoke → Task 11 step 5 ✓
- README + tag + memory → Task 11 steps 6-8 ✓

**2. Placeholder scan:** No TBDs, no "add error handling", every code block is complete and runnable. Stub extractors are filed BEFORE the real ones to unblock the registry test imports (Task 4 step 3) — clearly noted, not a placeholder violation.

**3. Type consistency:**
- `searxngSearch(query, n, opts)` signature: `opts = { baseUrl, fetchImpl, cache, ttlMs }` — consistent with how `webSearch` calls it in Task 2 step 3 (`downstreamOpts = { cache, ttlMs, baseUrl: searxngUrl }`) ✓
- `webSearch(query, n, opts)` opts include `backend, searxngUrl, cache, ttlMs, searxngImpl, ddgImpl, reachableImpl` — consistent across Task 2 tests/impl and Task 10 server.js usage ✓
- `smartFetch(url, opts)` opts: `maxChars, cache, ttlMs, fetchImpl, disableExtractors, extractorImpl, jinaImpl, readabilityImpl` — consistent across Task 9 tests/impl and Task 10 server.js ✓
- Extractor uniform return shape: `{url, title, content, truncated, error?, extractor?}` — consistent across github/npm/stackoverflow/mdn implementations and smartFetch consumption ✓
- Cache key contract: `cacheKeyFor('web_search', [query, numResults])` used identically in `searxngSearch`, existing `duckDuckGoSearch`, and (transitively) `webSearch` — same key regardless of backend, satisfies the spec contract ✓
- `findExtractor` returns `{name, pattern, extract}` — consumed correctly in `smartFetch` via `extractor.name` and `extractor.extract(url, opts)` ✓

**4. Test count sanity:** 38 (v0.2.0 baseline) + 10 (searxng) + 5 (search router) + 5 (readability) + 9 (extractorRegistry) + 9 (github) + 6 (npm) + 6 (stackoverflow) + 6 (mdn) + 10 (smartFetch) = **104 tests**. Match the Task 9 step 5 verification target.

No gaps. No inconsistencies. Plan is complete.
