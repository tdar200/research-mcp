# research-mcp — Tier 1 MVP Spec

**Date:** 2026-05-27
**Author:** Tahseen Dar (designed with Claude)
**Status:** Approved for implementation

## Purpose

A zero-cost, zero-key MCP server that gives Claude Code agents fresh web research capability beyond the built-in `WebSearch` / `WebFetch`. Specifically, a single combined `search_and_read` tool that returns top-N search results *with their content already extracted to clean markdown* — so the agent does one tool call instead of N+1.

## HTTP backend: curl, not Node fetch

Both `search.js` and `fetch.js` shell out to `curl` (via `src/http.js`) instead of using Node's built-in `fetch` (undici). Empirically, on this machine, undici and `node:https` both time out at TCP-connect time on Cloudflare-fronted hosts (e.g. `r.jina.ai`, `example.com`) while curl reaches the very same IPs without issue. Rather than chase TLS fingerprinting or kernel TCP knobs, we shell out — curl is universally available, stable, and handles redirects/MTU/dual-stack better than any drop-in alternative we tried. Trade: ~50ms per call for process spawn, no big deal at agent-research volume. Tests inject `fetchImpl` so they remain offline-deterministic.

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

## v0.5.0 — JSON-LD/Open Graph extractor + Jina header improvements

Two complementary content-extraction upgrades:

### JSON-LD / Open Graph parser (`src/jsonld.js`)

A new extractor that runs **before** Jina Reader in `smartFetch`. Parses the raw HTML for two universally-embedded sources of structured page data:

1. **`<script type="application/ld+json">`** — Schema.org structured data (Product, Article, NewsArticle, etc.). Used by ~80% of e-commerce and news sites globally for SEO.
2. **`<meta property="og:*">`** — Open Graph tags (`og:title`, `og:description`, `og:image`, `og:price:amount`, `og:price:currency`).

Output shape: `{url, title, content, truncated, price?, currency?, image?, author?, datePublished?, schemaType?, extractor: 'jsonld'}`. Returns `{content: null, error: 'no structured data found'}` if neither source has useful data — `smartFetch` falls through to next stage.

**Why this matters:** solves the "extracting product prices buried under nav chrome" problem (Vmart.pk, Daraz, etc.) deterministically — no heuristics, no LLM, just `JSON.parse()`. Tonight's WD Elements 4TB price was extractable in 100ms via this approach when 30,000 chars of Jina output couldn't surface it.

### Jina Reader header improvements (`src/fetch.js`)

`jinaFetch` now sends these HTTP headers to Jina's API by default:

- `X-Remove-Selector: header, nav, footer, .announcement, .announcement-bar, .popup, .cookie-banner, .modal, [class*="banner"]` — strips noise before extraction
- `X-Target-Selector: article, main, [itemtype], .product-detail, .post-content, .markdown-body` — focuses extraction on likely-main-content selectors
- `X-Return-Format: markdown` (explicit)

Result: dramatically less noise on e-commerce and marketing pages where header/nav/banner dominates DOM order.

### Updated smartFetch cascade

```
1. Cache check
2. URL-pattern extractor (GitHub/NPM/SO/MDN)
3. ★ NEW: JSON-LD / Open Graph parser
4. Jina Reader (with new headers)
5. Mozilla Readability fallback
6. Aggregated error
```

## v0.6.0 — Crawl4AI standalone Docker service

Adds [Crawl4AI](https://github.com/unclecode/crawl4ai) (66k+ ⭐, Apache 2.0) as a standalone Docker service on `localhost:11235`, accessed via its REST API. Used as the 5th-tier fallback in `smartFetch` — after Jina, before Mozilla Readability — for JS-heavy SPAs and anti-bot-protected pages.

**Why a separate service, not bundled into our MCP:** Crawl4AI on port 11235 is generally useful beyond MCP context — any CLI script, agent, or other app can call its REST API. Same pattern as SearXNG already follows. Keeps research-mcp as the smart router; Crawl4AI is one of the engines.

**Resource cost:** min 1GB RAM, recommended 4GB. Disk +500MB (Chromium binaries). Cold-start adds ~2-3s to first request; warm browser pool keeps subsequent requests fast.

**Configuration:**

- `CRAWL4AI_URL` — base URL (default `http://localhost:11235`)
- `DISABLE_CRAWL4AI=1` — skip Crawl4AI in smartFetch even if reachable

**Setup:**

```bash
cd ~/Projects/research-mcp
docker compose up -d crawl4ai
curl http://localhost:11235/health    # verify
```

**smartFetch cascade (final):**

```
1. Cache check
2. URL-pattern extractor (GitHub/NPM/SO/MDN)
3. JSON-LD / Open Graph parser
4. Jina Reader (with stripping headers)
5. ★ Crawl4AI (if reachable, JS rendering + anti-bot)
6. Mozilla Readability fallback
```

## Non-goals (deferred to Tier 2+)

- Self-hosted search (SearXNG) — DuckDuckGo HTML scrape is enough for MVP.
- Self-hosted extraction (Mozilla Readability + jsdom) — Jina Reader is free and good.
- ~~Caching — premature for MVP volume.~~ Added in v0.2.0 (above).
- Query expansion / reranking / site-specific extractors — Tier 3.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code                                                │
│      │                                                      │
│      │ MCP (stdio)                                          │
│      ▼                                                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  research-mcp server (Node.js, ESM)                    │ │
│  │  ┌──────────────┐ ┌────────────────┐ ┌──────────────┐  │ │
│  │  │ web_search   │ │ fetch_url      │ │ search_and_  │  │ │
│  │  │              │ │                │ │ read (combo) │  │ │
│  │  └──────┬───────┘ └───────┬────────┘ └──────┬───────┘  │ │
│  │         ▼                 ▼                 ▼          │ │
│  │   ┌──────────┐       ┌──────────┐    ┌──────────────┐  │ │
│  │   │ search.js│       │ fetch.js │    │  combine.js  │  │ │
│  │   └────┬─────┘       └────┬─────┘    └──────┬───────┘  │ │
│  └────────┼──────────────────┼────────────────┼───────────┘ │
│           ▼                  ▼                ▼             │
│   html.duckduckgo.com  r.jina.ai/<url>   (uses both above)  │
└─────────────────────────────────────────────────────────────┘
```

## Tools

### 1. `web_search`
Input: `{ query: string, num_results?: number (default 5, max 20) }`
Output: `{ results: [{ title, url, snippet }] }`
Implementation: POST `html.duckduckgo.com/html/` with `q=<query>`, parse `<a class="result__a">` and `<a class="result__snippet">` from HTML. Uses `cheerio` for resilience.

### 2. `fetch_url`
Input: `{ url: string, max_chars?: number (default 20000) }`
Output: `{ url, title, content, truncated: bool }`
Implementation: GET `https://r.jina.ai/<encoded-url>`. Response is markdown. Truncate by chars; set `truncated: true` if cut.

### 3. `search_and_read` *(the agent-friendly one)*
Input: `{ query: string, num_results?: number (default 3, max 10), max_chars_per_result?: number (default 8000) }`
Output: `{ query, results: [{ title, url, snippet, content, truncated }] }`
Implementation: Calls `web_search` then maps results through `fetch_url` (parallel, `Promise.allSettled`). Failed extractions surface as `{ ..., content: null, error: "..." }` — partial success is better than total failure.

## File Layout

```
~/Projects/research-mcp/
├── package.json          # ESM, single dependency: @modelcontextprotocol/sdk + cheerio + zod
├── SPEC.md               # this file
├── README.md             # install/use instructions
├── src/
│   ├── server.js         # MCP wiring; registers 3 tools, starts stdio transport
│   ├── search.js         # duckDuckGoSearch(query, n) → results[]
│   ├── fetch.js          # jinaFetch(url, maxChars) → {title, content, truncated}
│   └── combine.js        # searchAndRead(query, n, maxChars) → enriched results
└── test/
    ├── fixtures/
    │   └── ddg-results.html  # captured DDG response for parser tests
    ├── search.test.js    # parser against fixture
    └── fetch.test.js     # truncation logic, mocked jina response
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| DDG returns non-200 or empty | Throw with clear message. Agent can retry or fall back to built-in `WebSearch`. |
| DDG markup parser yields zero results | Return `{ results: [] }` with `warning: "parser may need update"` |
| Jina 429 (rate limit) | Return `{ url, error: "rate limited", retry_after }`. In combo tool, partial. |
| Jina non-200 | Return `{ url, error: "<status>: <body excerpt>" }`. Partial in combo. |
| Network timeout | 15s timeout per HTTP call. Surface as timeout error. |

## Testing

- **Unit tests** (run on every change): parser against committed DDG fixture, truncation behavior, error wrapping. Use Node's built-in `node:test` — no Jest/Vitest needed.
- **Integration smoke** (gated by `RUN_INTEGRATION=1` env var, run manually): one real DDG query, one real Jina fetch, one combo call. Skipped by default so unit tests stay deterministic and offline.

## Registration

```bash
claude mcp add -s user research-mcp -- node /home/tahseen-dar/Projects/research-mcp/src/server.js
```

User scope means it auto-loads in every project.

## Risks & Mitigations

1. **DDG markup changes** → parser breaks. Mitigation: fixture-based unit test catches this immediately; warning in `web_search` output when zero results parsed makes it diagnosable from the agent side.
2. **Jina Reader rate-limited or down** → fetch fails. Mitigation: graceful per-URL error in combo, partial results returned. Tier 2 adds direct Mozilla Readability fallback.
3. **DDG IP-blocks aggressive usage** → all searches fail. Mitigation: this is a personal-use tool with low volume. If it happens, Tier 2 SearXNG migration path is documented.

## Success Criteria

- `claude mcp list` shows `research-mcp: ✓ Connected`.
- Calling `search_and_read({query: "TanStack Query v5 partialMatchKey"})` from an agent returns ≥1 result with non-empty `content` containing relevant text.
- Unit tests pass (`node --test`).
- Total LOC excluding tests/fixtures: ≤ 250.
