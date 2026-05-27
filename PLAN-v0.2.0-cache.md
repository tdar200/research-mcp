# research-mcp v0.2.0 — SQLite Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transparent SQLite caching to all 3 existing tools (`web_search`, `fetch_url`, `search_and_read`) plus two new agent-facing tools (`list_research`, `get_research`) so prior results are recoverable without re-hitting the network.

**Architecture:** Single SQLite table at `~/.research-mcp/cache.db` (configurable via `RESEARCH_MCP_DB_PATH`). 24h TTL by default (configurable via `RESEARCH_MCP_CACHE_TTL_HOURS`, `0` = disabled). Cache key = SHA-256 of `tool|param1|param2|...`. New `src/cache.js` module wraps `better-sqlite3`; existing modules gain an injectable `cache` opt for testability. Server bridges env → ttl → tool call.

**Tech Stack:** `better-sqlite3` (sync SQLite, ~1MB, mature), existing `node:test`, `node:crypto` for SHA-256.

**Plan location override:** Same as v0.1.0 — kept with the tool at `~/Projects/research-mcp/`.

**Spec update:** Add a "v0.2.0 — Cache layer" section to `SPEC.md` (Task 0 below).

**Existing repo state:** On `main`, last tag `v0.1.0` (commit `f4d35b2`), 6 commits, 12/12 tests pass, registered as `research-mcp` MCP at user scope.

---

## File Structure

```
~/Projects/research-mcp/
├── SPEC.md                       # Modified: add "v0.2.0 cache" section
├── PLAN-v0.2.0-cache.md          # this file
├── README.md                     # Modified: document new tools + env vars
├── package.json                  # Modified: add better-sqlite3 dep, bump to 0.2.0
├── src/
│   ├── cache.js                  # NEW: SQLite wrapper (~120 LOC)
│   ├── server.js                 # Modified: 2 new tools, env→ttl wiring
│   ├── search.js                 # Modified: optional cache injection
│   ├── fetch.js                  # Modified: optional cache injection
│   ├── combine.js                # Modified: pass cache through to fetchImpl
│   └── http.js                   # Unchanged
└── test/
    ├── cache.test.js             # NEW: cache module unit tests
    ├── server.test.js            # NEW: smoke test new tools via JSON-RPC
    ├── search.test.js            # Modified: add cache hit/miss case
    ├── fetch.test.js             # Modified: add cache hit/miss case
    └── combine.test.js           # Unchanged (cache is below it)
```

**Responsibilities:**
- `cache.js` — owns SQLite connection, schema migration, `get`/`set`/`list`/`getById`. Pure data layer.
- `search.js` / `fetch.js` — gain `cache` opt; if present, check before network, store after. Cache key built locally.
- `combine.js` — passes `cache` through to its injected `fetchImpl`. No direct cache calls (caching of `search_and_read` happens at the search.js layer for the search call, and at fetch.js for each fetch).
- `server.js` — single source of truth for env-var reading. Constructs `cache` instance once, passes to all 3 tool handlers + the 2 new ones.

**Cache key normalization:**
- `web_search`: `SHA256("web_search\x00" + query + "\x00" + num_results)`
- `fetch_url`: `SHA256("fetch_url\x00" + url + "\x00" + max_chars)`
- `search_and_read`: `SHA256("search_and_read\x00" + query + "\x00" + num_results + "\x00" + max_chars_per_result)`

`\x00` separator prevents collisions like `search_and_read|foo|3` vs `search_and_read|fo|o3`.

---

## Task 0: Spec update + dep install + DB dir

**Files:**
- Modify: `~/Projects/research-mcp/SPEC.md`
- Modify: `~/Projects/research-mcp/package.json`

- [ ] **Step 1: Append cache section to SPEC.md**

Insert this section *after* the "HTTP backend: curl, not Node fetch" section and *before* "Non-goals (deferred to Tier 2+)":

```markdown
## v0.2.0 — SQLite cache layer

Transparent caching across all 3 original tools plus two new retrieval tools.

**Storage:** Single SQLite database at `~/.research-mcp/cache.db` (override via `RESEARCH_MCP_DB_PATH` env). Auto-created on first run. Gitignored, not tracked by the tool's own repo.

**TTL:** 24 hours by default. Override via `RESEARCH_MCP_CACHE_TTL_HOURS`. Setting to `0` disables caching (always miss). Setting to a large number (e.g. `8760` = 1 year) effectively pins results.

**Cache key:** `SHA-256` of `tool_name + "\x00" + canonical_params` — for web_search uses `(query, num_results)`, for fetch_url uses `(url, max_chars)`, for search_and_read uses `(query, num_results, max_chars_per_result)`.

**Behavior:**
- On call: compute key, look up `searches` table. If row exists AND `(now - created_at) < ttl_ms` → return stored result, skip network.
- Otherwise: invoke network, store result with `INSERT OR REPLACE`, return.
- TTL check happens at read time, not eviction time — stale rows stay in DB indefinitely (cheap, helps "go back to that thing from last week" use case via `list_research`).

**Schema:**

| Column        | Type    | Notes                                            |
|---------------|---------|--------------------------------------------------|
| `id`          | INTEGER | PK autoincrement                                 |
| `tool`        | TEXT    | `web_search` \| `fetch_url` \| `search_and_read` |
| `cache_key`   | TEXT    | UNIQUE; SHA-256 hex of tool + params             |
| `query`       | TEXT    | original query string or URL                     |
| `params_json` | TEXT    | JSON of params (num_results, max_chars, etc.)    |
| `result_json` | TEXT    | JSON of full tool response                       |
| `created_at`  | INTEGER | unix ms                                          |

Indices on `(created_at DESC)` and `(tool, created_at DESC)`.

**Two new MCP tools:**

- `list_research({ limit?: 1..100, tool_filter?: string })` → `{ entries: [{id, tool, query, age_hours, created_at_iso}] }`. Sorted newest first. No `result_json` in response — call `get_research` for full content.
- `get_research({ id: integer })` → the stored `result_json` parsed back, plus `{tool, query, params, created_at_iso, age_hours}` metadata.

**Non-cached:** errors are not cached. If a tool throws or returns `error` in any result, that response is *not* stored. Rationale: network blips shouldn't pollute the cache.

**Migration:** Schema created via single `CREATE TABLE IF NOT EXISTS` at startup. No versioning yet (Tier 3 problem).
```

- [ ] **Step 2: Bump version + add dep in package.json**

Update `package.json`:

```json
{
  "name": "research-mcp",
  "version": "0.2.0",
  "description": "MCP server: DuckDuckGo search + Jina Reader extraction for Claude agents",
  "type": "module",
  "main": "src/server.js",
  "bin": {
    "research-mcp": "src/server.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/*.test.js",
    "test:integration": "RUN_INTEGRATION=1 node --test test/*.test.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "better-sqlite3": "^11.5.0",
    "cheerio": "^1.0.0",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 3: Install new dep**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm install
```
Expected: `better-sqlite3` added, no errors. If native build fails, see https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md — usually needs `python3` and `make` available (both are on Ubuntu by default).

Verify:
```bash
ls /home/tahseen-dar/Projects/research-mcp/node_modules/better-sqlite3/package.json
```
Expected: file exists.

- [ ] **Step 4: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "chore: v0.2.0 cache spec + better-sqlite3 dep"
```

---

## Task 1: Cache module (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/cache.test.js`
- Create: `~/Projects/research-mcp/src/cache.js`

- [ ] **Step 1: Write failing cache tests**

Create `test/cache.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../src/cache.js';

const TEST_DB = join(tmpdir(), `research-mcp-test-${process.pid}.db`);

function freshCache(now = () => Date.now()) {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new Cache({ dbPath: TEST_DB, now });
}

test('Cache.set then Cache.get within TTL returns stored result', () => {
  const cache = freshCache();
  const key = 'abc123';
  cache.set({
    tool: 'web_search',
    cacheKey: key,
    query: 'foo',
    params: { num_results: 5 },
    result: { query: 'foo', results: [{ title: 't', url: 'https://x.test', snippet: 's' }] },
  });

  const hit = cache.get({ cacheKey: key, ttlMs: 60_000 });
  assert.ok(hit, 'expected cache hit');
  assert.equal(hit.tool, 'web_search');
  assert.equal(hit.result.query, 'foo');
  assert.equal(hit.result.results[0].title, 't');
});

test('Cache.get past TTL returns null', () => {
  let nowMs = 1_000_000;
  const cache = freshCache(() => nowMs);

  cache.set({
    tool: 'fetch_url',
    cacheKey: 'x',
    query: 'https://x.test',
    params: { max_chars: 1000 },
    result: { url: 'https://x.test', content: 'hi' },
  });

  nowMs += 10_000; // 10s later
  assert.ok(cache.get({ cacheKey: 'x', ttlMs: 60_000 }), 'within TTL → hit');

  nowMs += 60_000; // 70s later (past 60s TTL)
  assert.equal(cache.get({ cacheKey: 'x', ttlMs: 60_000 }), null, 'past TTL → miss');
});

test('Cache.get with ttlMs=0 always returns null (caching disabled)', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q', params: {}, result: { ok: true } });
  assert.equal(cache.get({ cacheKey: 'k', ttlMs: 0 }), null);
});

test('Cache.set with same cache_key overwrites (INSERT OR REPLACE)', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q1', params: {}, result: { v: 1 } });
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q2', params: {}, result: { v: 2 } });

  const hit = cache.get({ cacheKey: 'k', ttlMs: 60_000 });
  assert.equal(hit.query, 'q2');
  assert.equal(hit.result.v, 2);
});

test('Cache.list returns metadata only, newest first', () => {
  let nowMs = 1_000_000;
  const cache = freshCache(() => nowMs);

  cache.set({ tool: 'web_search', cacheKey: 'a', query: 'q1', params: {}, result: { x: 1 } });
  nowMs += 1000;
  cache.set({ tool: 'fetch_url', cacheKey: 'b', query: 'https://b.test', params: {}, result: { x: 2 } });
  nowMs += 1000;
  cache.set({ tool: 'web_search', cacheKey: 'c', query: 'q3', params: {}, result: { x: 3 } });

  const entries = cache.list({ limit: 10 });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].query, 'q3', 'newest first');
  assert.equal(entries[2].query, 'q1', 'oldest last');
  for (const e of entries) {
    assert.ok(typeof e.id === 'number');
    assert.ok(typeof e.created_at_iso === 'string');
    assert.ok(typeof e.age_hours === 'number');
    assert.equal(e.result, undefined, 'list must not include result_json');
  }
});

test('Cache.list with tool_filter only returns matching rows', () => {
  const cache = freshCache();
  cache.set({ tool: 'web_search', cacheKey: 'a', query: 'q1', params: {}, result: {} });
  cache.set({ tool: 'fetch_url', cacheKey: 'b', query: 'https://x', params: {}, result: {} });
  cache.set({ tool: 'web_search', cacheKey: 'c', query: 'q3', params: {}, result: {} });

  const entries = cache.list({ limit: 10, toolFilter: 'web_search' });
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e => e.tool === 'web_search'));
});

test('Cache.list respects limit', () => {
  const cache = freshCache();
  for (let i = 0; i < 5; i++) {
    cache.set({ tool: 'web_search', cacheKey: `k${i}`, query: `q${i}`, params: {}, result: {} });
  }
  assert.equal(cache.list({ limit: 3 }).length, 3);
});

test('Cache.getById returns full entry with parsed JSON', () => {
  const cache = freshCache();
  cache.set({
    tool: 'search_and_read',
    cacheKey: 'k',
    query: 'q',
    params: { num_results: 2 },
    result: { query: 'q', results: [{ title: 'T', url: 'https://u', content: 'C' }] },
  });

  const entry = cache.list({ limit: 1 })[0];
  const full = cache.getById(entry.id);

  assert.ok(full);
  assert.equal(full.tool, 'search_and_read');
  assert.equal(full.query, 'q');
  assert.deepEqual(full.params, { num_results: 2 });
  assert.equal(full.result.results[0].title, 'T');
});

test('Cache.getById returns null for unknown id', () => {
  const cache = freshCache();
  assert.equal(cache.getById(999), null);
});

test('Cache initializes schema on first construction (no file yet)', () => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const cache = new Cache({ dbPath: TEST_DB });
  cache.set({ tool: 'web_search', cacheKey: 'k', query: 'q', params: {}, result: { ok: true } });
  assert.ok(existsSync(TEST_DB));
});
```

- [ ] **Step 2: Run cache tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/cache.test.js 2>&1 | tail -10
```
Expected: FAIL with `Cannot find module '../src/cache.js'` or similar.

- [ ] **Step 3: Implement cache.js**

Create `src/cache.js`:

```js
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT NOT NULL,
  cache_key   TEXT NOT NULL UNIQUE,
  query       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_searches_created    ON searches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_searches_tool_time  ON searches(tool, created_at DESC);
`;

/**
 * SQLite-backed cache for research-mcp tool results.
 *
 * Pure data layer. No knowledge of HTTP, MCP, or specific tool semantics —
 * just stores blobs keyed by cache_key with timestamps.
 */
export class Cache {
  constructor({ dbPath, now = () => Date.now() } = {}) {
    if (!dbPath) throw new Error('Cache requires dbPath');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.now = now;

    this._insert = this.db.prepare(`
      INSERT INTO searches (tool, cache_key, query, params_json, result_json, created_at)
      VALUES (@tool, @cache_key, @query, @params_json, @result_json, @created_at)
      ON CONFLICT(cache_key) DO UPDATE SET
        tool = excluded.tool,
        query = excluded.query,
        params_json = excluded.params_json,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `);
    this._getByKey = this.db.prepare(`SELECT * FROM searches WHERE cache_key = ?`);
    this._getById  = this.db.prepare(`SELECT * FROM searches WHERE id = ?`);
    this._listAll  = this.db.prepare(`
      SELECT id, tool, query, params_json, created_at
      FROM searches
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this._listByTool = this.db.prepare(`
      SELECT id, tool, query, params_json, created_at
      FROM searches
      WHERE tool = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
  }

  /** Store a result. Overwrites if same cache_key exists. */
  set({ tool, cacheKey, query, params, result }) {
    this._insert.run({
      tool,
      cache_key: cacheKey,
      query,
      params_json: JSON.stringify(params ?? {}),
      result_json: JSON.stringify(result),
      created_at: this.now(),
    });
  }

  /** Return entry if cached AND within ttlMs; else null. */
  get({ cacheKey, ttlMs }) {
    if (!ttlMs || ttlMs <= 0) return null;
    const row = this._getByKey.get(cacheKey);
    if (!row) return null;
    if (this.now() - row.created_at > ttlMs) return null;
    return rowToEntry(row);
  }

  /** Metadata-only listing, newest first. */
  list({ limit = 20, toolFilter = null } = {}) {
    const cappedLimit = Math.min(Math.max(1, limit), 100);
    const rows = toolFilter
      ? this._listByTool.all(toolFilter, cappedLimit)
      : this._listAll.all(cappedLimit);
    const nowMs = this.now();
    return rows.map(r => ({
      id: r.id,
      tool: r.tool,
      query: r.query,
      params: JSON.parse(r.params_json),
      created_at_iso: new Date(r.created_at).toISOString(),
      age_hours: Math.round((nowMs - r.created_at) / 36e4) / 100,
    }));
  }

  /** Full entry by id, including parsed result_json. */
  getById(id) {
    const row = this._getById.get(id);
    if (!row) return null;
    return rowToEntry(row);
  }

  close() {
    this.db.close();
  }
}

function rowToEntry(row) {
  return {
    id: row.id,
    tool: row.tool,
    cacheKey: row.cache_key,
    query: row.query,
    params: JSON.parse(row.params_json),
    result: JSON.parse(row.result_json),
    created_at: row.created_at,
    created_at_iso: new Date(row.created_at).toISOString(),
  };
}
```

- [ ] **Step 4: Run cache tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/cache.test.js 2>&1 | tail -15
```
Expected: all 10 tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(cache): better-sqlite3 cache module with TTL + list/getById"
```

---

## Task 2: Wire cache into search.js + fetch.js (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/search.js`
- Modify: `~/Projects/research-mcp/src/fetch.js`
- Modify: `~/Projects/research-mcp/test/search.test.js`
- Modify: `~/Projects/research-mcp/test/fetch.test.js`
- Create: `~/Projects/research-mcp/src/cacheKey.js`
- Create: `~/Projects/research-mcp/test/cacheKey.test.js`

- [ ] **Step 1: Add cacheKey helper test**

Create `test/cacheKey.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKeyFor } from '../src/cacheKey.js';

test('cacheKeyFor is deterministic for same input', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('web_search', ['foo', 5]);
  assert.equal(a, b);
});

test('cacheKeyFor differs across tools with same params', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('search_and_read', ['foo', 5]);
  assert.notEqual(a, b);
});

test('cacheKeyFor differs when params differ', () => {
  const a = cacheKeyFor('web_search', ['foo', 5]);
  const b = cacheKeyFor('web_search', ['foo', 6]);
  assert.notEqual(a, b);
});

test('cacheKeyFor avoids concat-ambiguity (NUL separator)', () => {
  // Without separator: "ab" + "c" === "a" + "bc"
  const a = cacheKeyFor('web_search', ['ab', 'c']);
  const b = cacheKeyFor('web_search', ['a', 'bc']);
  assert.notEqual(a, b);
});

test('cacheKeyFor returns hex string', () => {
  const k = cacheKeyFor('web_search', ['foo', 5]);
  assert.match(k, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run cacheKey test (fails — no module)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/cacheKey.test.js 2>&1 | tail -5
```
Expected: FAIL with `Cannot find module '../src/cacheKey.js'`.

- [ ] **Step 3: Implement cacheKey.js**

Create `src/cacheKey.js`:

```js
import { createHash } from 'node:crypto';

/**
 * Build a deterministic cache key for a tool call.
 * @param {string} tool - tool name (e.g. 'web_search')
 * @param {Array} params - ordered list of parameter values (strings/numbers)
 * @returns {string} SHA-256 hex digest
 */
export function cacheKeyFor(tool, params) {
  const h = createHash('sha256');
  h.update(tool);
  for (const p of params) {
    h.update('\x00');
    h.update(String(p));
  }
  return h.digest('hex');
}
```

- [ ] **Step 4: Run cacheKey test (passes)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/cacheKey.test.js 2>&1 | tail -10
```
Expected: 5/5 pass.

- [ ] **Step 5: Add cache hit/miss tests to search.test.js**

Append to `test/search.test.js`:

```js
import { duckDuckGoSearch } from '../src/search.js';
import { mock } from 'node:test';

test('duckDuckGoSearch returns cached results when cache hit (no network call)', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeCache = {
    get: mock.fn(() => ({
      result: [{ title: 'Cached', url: 'https://cached.example', snippet: 'from cache' }],
    })),
    set: mock.fn(),
  };

  const results = await duckDuckGoSearch('foo', 3, { cache: fakeCache, ttlMs: 60_000, fetchImpl: fakeFetch });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Cached');
  assert.equal(fakeFetch.mock.calls.length, 0);
  assert.equal(fakeCache.get.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 0);
});

test('duckDuckGoSearch fetches + stores when cache miss', async () => {
  // Minimal valid HTML the parser will pull a result from.
  const fakeHtml = `
    <div class="result">
      <a class="result__a" href="https://x.example">X</a>
      <a class="result__snippet">snippet</a>
    </div>
  `;
  const fakeFetch = mock.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => fakeHtml }));
  const fakeCache = {
    get: mock.fn(() => null),  // miss
    set: mock.fn(),
  };

  const results = await duckDuckGoSearch('foo', 3, { cache: fakeCache, ttlMs: 60_000, fetchImpl: fakeFetch });
  assert.ok(results.length >= 1);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 1);
  const stored = fakeCache.set.mock.calls[0].arguments[0];
  assert.equal(stored.tool, 'web_search');
  assert.equal(stored.query, 'foo');
});

test('duckDuckGoSearch with no cache option still works (back-compat)', async () => {
  const fakeHtml = `<div class="result"><a class="result__a" href="https://y.example">Y</a><a class="result__snippet">s</a></div>`;
  const fakeFetch = mock.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => fakeHtml }));
  const results = await duckDuckGoSearch('foo', 3, { fetchImpl: fakeFetch });
  assert.ok(results.length >= 1);
});
```

- [ ] **Step 6: Run search tests (new ones fail — search.js doesn't accept cache opts yet)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -10
```
Expected: pre-existing 3 pass; new 3 fail because `duckDuckGoSearch` ignores `cache` and the signature `(query, numResults)` doesn't accept a third opts arg.

- [ ] **Step 7: Refactor search.js to accept cache + fetchImpl opts**

Edit `src/search.js`, replacing the `duckDuckGoSearch` function with:

```js
/**
 * Perform a DuckDuckGo HTML search, optionally using a cache.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {object} [opts.cache] - Cache instance with get({cacheKey,ttlMs}) and set({...})
 * @param {number} [opts.ttlMs] - required if cache provided
 * @param {function} [opts.fetchImpl=curlFetch] - inject for tests
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function duckDuckGoSearch(query, numResults = 5, opts = {}) {
  const { cache, ttlMs, fetchImpl = curlFetch } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const params = new URLSearchParams({ q: query });
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
      params: { num_results: numResults },
      result: results,
    });
  }

  return results;
}
```

And add the import at the top:

```js
import { cacheKeyFor } from './cacheKey.js';
```

- [ ] **Step 8: Run search tests (all pass)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/search.test.js 2>&1 | tail -10
```
Expected: 6/6 pass.

- [ ] **Step 9: Add cache hit/miss tests to fetch.test.js**

Append to `test/fetch.test.js`:

```js
test('jinaFetch returns cached entry when cache hit', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('should not be called'); });
  const fakeCache = {
    get: mock.fn(() => ({
      result: { url: 'https://x.test', title: 'Cached', content: 'cached body', truncated: false },
    })),
    set: mock.fn(),
  };

  const result = await jinaFetch('https://x.test', {
    maxChars: 1000,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(result.content, 'cached body');
  assert.equal(fakeFetch.mock.calls.length, 0);
});

test('jinaFetch stores successful fetch in cache', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'Title: T\n\nbody' }));
  const fakeCache = {
    get: mock.fn(() => null),
    set: mock.fn(),
  };

  await jinaFetch('https://x.test', { maxChars: 1000, fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  const stored = fakeCache.set.mock.calls[0].arguments[0];
  assert.equal(stored.tool, 'fetch_url');
  assert.equal(stored.query, 'https://x.test');
});

test('jinaFetch does NOT cache error responses', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many', text: async () => '' }));
  const fakeCache = {
    get: mock.fn(() => null),
    set: mock.fn(),
  };

  const result = await jinaFetch('https://x.test', { maxChars: 1000, fetchImpl: fakeFetch, cache: fakeCache, ttlMs: 60_000 });
  assert.ok(result.error, 'should have error');
  assert.equal(fakeCache.set.mock.calls.length, 0, 'should not cache errors');
});
```

- [ ] **Step 10: Run fetch tests (new ones fail)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/fetch.test.js 2>&1 | tail -10
```
Expected: 5 pre-existing pass; 3 new fail because `jinaFetch` doesn't yet use `opts.cache`.

- [ ] **Step 11: Refactor fetch.js to use cache**

Edit `src/fetch.js`, replacing the entire `jinaFetch` function with:

```js
export async function jinaFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    fetchImpl = curlFetch,
    timeoutMs = 15000,
    cache,
    ttlMs,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  try {
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: { 'Accept': 'text/markdown' },
      timeoutMs,
    });

    if (!res.ok) {
      const bodyExcerpt = (await res.text().catch(() => '')).slice(0, 200);
      const error = res.status === 429
        ? `rate limit (429): ${res.statusText}`
        : `${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`;
      // Do NOT cache errors — network blips shouldn't pollute cache.
      return { url, title: null, content: null, truncated: false, error };
    }

    const raw = await res.text();
    const title = extractTitle(raw);
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;
    const result = { url, title, content, truncated };

    if (cache && cacheKey) {
      cache.set({
        tool: 'fetch_url',
        cacheKey,
        query: url,
        params: { max_chars: maxChars },
        result,
      });
    }

    return result;
  } catch (err) {
    return {
      url,
      title: null,
      content: null,
      truncated: false,
      error: String(err.message || err),
    };
  }
}
```

Add the import:
```js
import { cacheKeyFor } from './cacheKey.js';
```

- [ ] **Step 12: Run fetch tests (all pass)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/fetch.test.js 2>&1 | tail -10
```
Expected: 8/8 pass.

- [ ] **Step 13: Run full suite — nothing regressed**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: 27 tests pass (10 cache + 5 cacheKey + 6 search + 8 fetch — wait, recount: 10 cache + 5 cacheKey + 6 search + 8 fetch + 4 combine = 33).

- [ ] **Step 14: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(search,fetch): transparent cache opt-in via opts.cache + ttlMs"
```

---

## Task 3: Add combine.js cache passthrough + search_and_read top-level caching

**Files:**
- Modify: `~/Projects/research-mcp/src/combine.js`
- Modify: `~/Projects/research-mcp/test/combine.test.js`

**Design note:** `search_and_read` should cache the FULL combined result (one row per query), not just the underlying search+fetch calls. Reason: re-running `search_and_read("foo")` should be instant; if we only cached at the leaf level, we'd still pay 1 search call (cache hit) + N fetch calls (cache hits each) which adds overhead. Caching the combined result is one DB lookup.

- [ ] **Step 1: Add cache test to combine.test.js**

Append to `test/combine.test.js`:

```js
test('searchAndRead caches the combined result and returns it on hit', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.test', snippet: 's' },
  ]);
  const fakeFetch = mock.fn(async (url) => ({
    url, title: 'A', content: 'A body', truncated: false,
  }));

  let storedResult = null;
  const fakeCache = {
    get: mock.fn(() => storedResult ? { result: storedResult } : null),
    set: mock.fn((entry) => { storedResult = entry.result; }),
  };

  const out1 = await searchAndRead('q', {
    numResults: 1,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(out1.results[0].content, 'A body');
  assert.equal(fakeSearch.mock.calls.length, 1);
  assert.equal(fakeFetch.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'search_and_read');

  const out2 = await searchAndRead('q', {
    numResults: 1,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.deepEqual(out2, out1);
  assert.equal(fakeSearch.mock.calls.length, 1, 'should not search again');
  assert.equal(fakeFetch.mock.calls.length, 1, 'should not fetch again');
});

test('searchAndRead does not cache if any result has an error', async () => {
  const fakeSearch = mock.fn(async () => [
    { title: 'A', url: 'https://a.test', snippet: 'a' },
    { title: 'B', url: 'https://b.test', snippet: 'b' },
  ]);
  const fakeFetch = mock.fn(async (url) => {
    if (url.includes('b.test')) return { url, content: null, truncated: false, error: 'oops' };
    return { url, content: 'ok', truncated: false };
  });

  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };

  await searchAndRead('q', {
    numResults: 2,
    searchImpl: fakeSearch,
    fetchImpl: fakeFetch,
    cache: fakeCache,
    ttlMs: 60_000,
  });
  assert.equal(fakeCache.set.mock.calls.length, 0, 'partial failures should not be cached');
});
```

- [ ] **Step 2: Run combine tests (new ones fail)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/combine.test.js 2>&1 | tail -10
```
Expected: pre-existing 4 pass; new 2 fail.

- [ ] **Step 3: Add cache support to combine.js**

Replace the contents of `src/combine.js` with:

```js
import { duckDuckGoSearch } from './search.js';
import { jinaFetch } from './fetch.js';
import { cacheKeyFor } from './cacheKey.js';

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
 * @param {object} [opts.cache] - Cache instance
 * @param {number} [opts.ttlMs] - required if cache provided
 * @returns {Promise<{query: string, results: Array<{title, url, snippet, content, truncated, error?}>}>}
 */
export async function searchAndRead(query, opts = {}) {
  const {
    numResults = 3,
    maxCharsPerResult = 8000,
    searchImpl = duckDuckGoSearch,
    fetchImpl = jinaFetch,
    cache,
    ttlMs,
  } = opts;

  const capped = Math.min(Math.max(1, numResults), MAX_NUM_RESULTS);

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('search_and_read', [query, capped, maxCharsPerResult]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const searchResults = await searchImpl(query, capped);

  if (searchResults.length === 0) {
    const empty = { query, results: [] };
    // Don't cache empty searches — they may be transient (parser drift, DDG hiccup).
    return empty;
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

  const out = { query, results: enriched };

  // Only cache fully-successful results to avoid pinning partial failures.
  const hasErrors = enriched.some(r => r.error);
  if (cache && cacheKey && !hasErrors) {
    cache.set({
      tool: 'search_and_read',
      cacheKey,
      query,
      params: { num_results: capped, max_chars_per_result: maxCharsPerResult },
      result: out,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run combine tests (all pass)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/combine.test.js 2>&1 | tail -10
```
Expected: 6/6 pass.

- [ ] **Step 5: Run full suite**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: 35 tests pass (10 cache + 5 cacheKey + 6 search + 8 fetch + 6 combine).

- [ ] **Step 6: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(combine): cache search_and_read at the combined level; skip caching errors/empty"
```

---

## Task 4: Server-side wiring + 2 new tools + JSON-RPC smoke

**Files:**
- Modify: `~/Projects/research-mcp/src/server.js`
- Create: `~/Projects/research-mcp/test/server.test.js`

- [ ] **Step 1: Add server test (subprocess JSON-RPC roundtrip)**

Create `test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');
const TEST_DB = join(tmpdir(), `research-mcp-server-test-${process.pid}.db`);

/** Spawn the server, write a sequence of JSON-RPC messages, return parsed responses. */
async function rpc(messages, env = {}) {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, RESEARCH_MCP_DB_PATH: TEST_DB, RESEARCH_MCP_CACHE_TTL_HOURS: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let errBuf = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { errBuf += c.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean);
      try {
        resolve(lines.map(l => JSON.parse(l)));
      } catch (e) {
        reject(new Error(`Failed to parse server output. stderr=${errBuf}\nstdout=${out}`));
      }
    });

    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 200);
  });
}

test('server lists 5 tools including list_research and get_research', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const listResp = responses.find(r => r.id === 2);
  assert.ok(listResp, 'expected tools/list response');
  const names = listResp.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['fetch_url', 'get_research', 'list_research', 'search_and_read', 'web_search']);
});

test('server list_research returns empty entries on fresh DB', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_research', arguments: { limit: 10 } } },
  ]);
  const callResp = responses.find(r => r.id === 2);
  assert.ok(callResp, 'expected tools/call response');
  const payload = JSON.parse(callResp.result.content[0].text);
  assert.deepEqual(payload, { entries: [] });
});

test('server get_research returns error on unknown id', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_research', arguments: { id: 999 } } },
  ]);
  const callResp = responses.find(r => r.id === 2);
  assert.ok(callResp.result.isError, 'expected error result');
});
```

- [ ] **Step 2: Run server test (fails — new tools not registered)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/server.test.js 2>&1 | tail -10
```
Expected: 1st test fails (only 3 tools), 2nd fails (unknown tool list_research), 3rd fails similarly.

- [ ] **Step 3: Update server.js — add Cache wiring + 2 new tool handlers**

Replace the entire contents of `src/server.js` with:

```js
#!/usr/bin/env node
import dns from 'node:dns';
// Prefer IPv4-first DNS resolution. Without this, Node's undici can hang for
// 10s on AAAA records when IPv6 is broken in the local network path. curl
// handles this transparently; Node does not. Affects both search and fetch.
dns.setDefaultResultOrder('ipv4first');

import { homedir } from 'node:os';
import { join } from 'node:path';

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
import { Cache } from './cache.js';

// ── Config from env ──────────────────────────────────────────────────────────
const DB_PATH = process.env.RESEARCH_MCP_DB_PATH || join(homedir(), '.research-mcp', 'cache.db');
const TTL_HOURS = Number(process.env.RESEARCH_MCP_CACHE_TTL_HOURS ?? 24);
const TTL_MS = Number.isFinite(TTL_HOURS) && TTL_HOURS > 0 ? TTL_HOURS * 3600 * 1000 : 0;

const cache = new Cache({ dbPath: DB_PATH });

// ── Zod schemas ──────────────────────────────────────────────────────────────
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

const ListResearchArgs = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  tool_filter: z.enum(['web_search', 'fetch_url', 'search_and_read']).optional(),
});

const GetResearchArgs = z.object({
  id: z.number().int().min(1),
});

// ── Tool definitions ─────────────────────────────────────────────────────────
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
  {
    name: 'list_research',
    description:
      'List recent cached research queries (newest first). Use this BEFORE calling search_and_read ' +
      "if you suspect the user has asked something similar recently — it's free and instant. " +
      'Returns {entries: [{id, tool, query, created_at_iso, age_hours, params}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        tool_filter: { type: 'string', enum: ['web_search', 'fetch_url', 'search_and_read'] },
      },
    },
  },
  {
    name: 'get_research',
    description:
      'Retrieve the full cached result of a prior research query by its id (from list_research). ' +
      'Zero network calls. Returns {tool, query, params, result, created_at_iso, age_hours}.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
      },
      required: ['id'],
    },
  },
];

// ── Server ───────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'research-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'web_search') {
      const { query, num_results } = WebSearchArgs.parse(args);
      const results = await duckDuckGoSearch(query, num_results, { cache, ttlMs: TTL_MS });
      return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
    }

    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await jinaFetch(url, { maxChars: max_chars, cache, ttlMs: TTL_MS });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
        cache,
        ttlMs: TTL_MS,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'list_research') {
      const { limit, tool_filter } = ListResearchArgs.parse(args);
      const entries = cache.list({ limit, toolFilter: tool_filter });
      return { content: [{ type: 'text', text: JSON.stringify({ entries }, null, 2) }] };
    }

    if (name === 'get_research') {
      const { id } = GetResearchArgs.parse(args);
      const entry = cache.getById(id);
      if (!entry) throw new Error(`No cached research with id=${id}. Use list_research to find valid ids.`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: entry.id,
            tool: entry.tool,
            query: entry.query,
            params: entry.params,
            result: entry.result,
            created_at_iso: entry.created_at_iso,
            age_hours: Math.round((Date.now() - entry.created_at) / 36e4) / 100,
          }, null, 2),
        }],
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
process.stderr.write(`[research-mcp] v0.2.0 connected via stdio | db=${DB_PATH} | ttl=${TTL_HOURS}h\n`);
```

- [ ] **Step 4: Run server tests (pass)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/server.test.js 2>&1 | tail -10
```
Expected: 3/3 pass.

- [ ] **Step 5: Run full suite**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: 38 tests pass (10 cache + 5 cacheKey + 6 search + 8 fetch + 6 combine + 3 server).

- [ ] **Step 6: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(server): list_research + get_research tools, env-driven cache wiring"
```

---

## Task 5: Live verification + docs + tag v0.2.0

**Files:**
- Modify: `~/Projects/research-mcp/README.md`
- Modify: `~/Projects/research-mcp/.gitignore` (verify ~/.research-mcp is local-only — N/A since DB is in $HOME not repo)
- Create: `~/Projects/research-mcp/scripts/smoke-cache.js`

- [ ] **Step 1: Add cache smoke script**

Create `scripts/smoke-cache.js`:

```js
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
```

- [ ] **Step 2: Run cache smoke test**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && timeout 90 node scripts/smoke-cache.js 2>&1 | tail -30
```
Expected: `first: ~3000-10000ms`, `second: <50ms`, `list_research` shows 1+ entries (likely 3: one search_and_read + one web_search underneath + N fetch_url), `get_research(id=1)` shows the search_and_read entry.

If `second` is not dramatically faster than `first`, debug: check `cache.list()` output between calls — the entry should be there after call 1.

- [ ] **Step 3: Update README.md**

Replace the README contents with:

```markdown
# research-mcp

Zero-cost, zero-key MCP server giving Claude Code agents fresh web research via DuckDuckGo search + [Jina Reader](https://jina.ai/reader/) extraction, with **transparent SQLite caching** so prior results are instant and recoverable.

## Tools

| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5)` | You just need URLs — no content extraction. |
| `fetch_url(url, max_chars=20000)` | You already have a URL and want clean markdown. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000)` | **Default research call** — top-N results + their content in one shot. |
| `list_research(limit=20, tool_filter?)` | Browse what's already cached. Free, instant. Call before searching to check for prior runs. |
| `get_research(id)` | Pull full cached content by id (from `list_research`). Zero network. |

## Caching

All 3 of the search/fetch tools transparently cache to SQLite at `~/.research-mcp/cache.db` (override via `RESEARCH_MCP_DB_PATH`). Default TTL is **24 hours**.

Tune via env:

- `RESEARCH_MCP_CACHE_TTL_HOURS=8760` — cache for 1 year (effectively pin)
- `RESEARCH_MCP_CACHE_TTL_HOURS=0` — disable caching (always fetch fresh)

Errors and empty results are NOT cached — only successful responses are stored.

## Requirements

- Node.js ≥ 20
- `curl` on `$PATH` (HTTP backend — see [SPEC.md](./SPEC.md))
- C toolchain for `better-sqlite3` native build (`python3` + `make`; both default on Ubuntu)

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
npm test              # offline unit tests
npm run test:integration   # real network — only for end-to-end validation
node scripts/smoke-cache.js   # validates the cache layer round-trips
```

## Architecture

See [SPEC.md](./SPEC.md). Modules:

- `src/search.js` — DDG HTML parser (cheerio) + cached search
- `src/fetch.js` — Jina Reader wrapper + cached fetch
- `src/combine.js` — `search_and_read` composer + combined-result cache
- `src/cache.js` — SQLite wrapper (`better-sqlite3`)
- `src/cacheKey.js` — deterministic cache key from tool + params
- `src/http.js` — curl-backed HTTP (see SPEC for why)
- `src/server.js` — MCP protocol wiring, env → cache config

## Maintenance

If `web_search` starts returning empty arrays, the DDG markup has changed. Refresh the fixture:

```bash
curl -sS -A "Mozilla/5.0" --data-urlencode "q=test" "https://html.duckduckgo.com/html/" > test/fixtures/ddg-results.html
npm test
```

To wipe the cache:

```bash
rm ~/.research-mcp/cache.db
```
```

- [ ] **Step 4: Restart MCP server connection + verify still ✓ Connected**

The MCP registration already points at `src/server.js`; the new code will be picked up on next Claude Code session restart. For now verify the server still starts cleanly:

```bash
cd /home/tahseen-dar/Projects/research-mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 5 node src/server.js 2>&1 | head -5
```
Expected: one JSON-RPC initialize response with `"serverInfo":{"name":"research-mcp","version":"0.2.0"}` on stdout, plus a `[research-mcp] v0.2.0 connected via stdio | db=... | ttl=24h` line on stderr.

- [ ] **Step 5: Commit and tag**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "docs: v0.2.0 README + cache smoke script" && git tag v0.2.0 && git log --oneline | head -10
```

- [ ] **Step 6: Update memory pointer**

Append/update the existing `research-mcp tool` entry in `/home/tahseen-dar/.claude/projects/-home-tahseen-dar-POSSystem-Inventory-System-Root/memory/project_research-mcp-tool.md` to note v0.2.0 capabilities (cache + list/get tools). Keep slug + MEMORY.md line unchanged.

---

## Self-Review

**1. Spec coverage:**
- SPEC v0.2.0 section — Task 0 Step 1 ✓
- SQLite schema — Task 1 Step 3 (matches SPEC table) ✓
- TTL behavior + env-overridable — Task 4 Step 3 (server.js TTL_MS computation), tested in Task 1 ✓
- Cache key SHA-256 with NUL separator — Task 2 Steps 1-4 + cacheKey.test.js ✓
- Transparent caching for web_search — Task 2 Steps 5-8 ✓
- Transparent caching for fetch_url — Task 2 Steps 9-12 ✓
- Transparent caching for search_and_read at combined level — Task 3 ✓
- Don't cache errors — Task 2 Step 9 test + fetch.js implementation ✓
- Don't cache empty searches — Task 3 Step 3 combine.js implementation ✓
- list_research tool — Task 4 ✓
- get_research tool — Task 4 ✓
- DB at ~/.research-mcp/cache.db — Task 4 Step 3 server.js DB_PATH ✓
- ENV overrides RESEARCH_MCP_DB_PATH + RESEARCH_MCP_CACHE_TTL_HOURS — Task 4 Step 3 ✓

**2. Placeholder scan:** No TBDs, no "add error handling", every code block is complete and runnable.

**3. Type consistency:**
- `Cache` constructor: `{ dbPath, now }` — same across cache.js, cache.test.js, server.js ✓
- `cache.get({ cacheKey, ttlMs })` — same shape in cache.test.js, search.js, fetch.js, combine.js ✓
- `cache.set({ tool, cacheKey, query, params, result })` — same shape across all callers + tests ✓
- `cache.list({ limit, toolFilter })` — `toolFilter` in JS, `tool_filter` in MCP arg (intentional snake/camel bridge in server.js Step 3 — `ListResearchArgs` returns `tool_filter`, mapped via destructure rename to JS param. Verified consistent.) ✓
- `cache.getById(id)` — consistent ✓
- `cacheKeyFor(tool, params[])` — consistent ✓
- Tool names: `web_search`, `fetch_url`, `search_and_read`, `list_research`, `get_research` — consistent in TOOLS array, switch handlers, Zod schemas, tests ✓
- Result-row shape from `cache.list()` includes `params` (not `params_json`) — consistent with test in Task 1 Step 1 ✓

No gaps. No inconsistencies.
