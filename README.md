# research-mcp

Zero-cost MCP server giving Claude Code agents fresh web research via meta-search (SearXNG or DDG) + multi-strategy content extraction (site-specific extractors → JSON-LD → Jina Reader → Crawl4AI → Mozilla Readability), with transparent SQLite caching, SSRF protection, and untrusted-content fencing.

## Tools

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

**Known limitation:** SearXNG's `reddit` and `hackernews` engines have weak full-text search for niche queries — they may return irrelevant recent posts. For better reddit-quality results on niche topics, force the DDG backend (`SEARCH_BACKEND=ddg`) which uses `site:reddit.com` instead.

## v0.3.0 architecture (Tier 2 + Tier 3c)

### Search backend selection

- **SearXNG** (Docker, `localhost:8888`) — meta-searches Google/Bing/Brave/DDG/etc., returns JSON. Default if reachable.
- **DuckDuckGo HTML** — built-in fallback when SearXNG is unreachable. Zero infra mode.
- Selection via `SEARCH_BACKEND` env: `auto` (default; probes SearXNG, falls back to DDG), `searxng` (force), `ddg` (force).

### Content extraction strategy (per URL)

`fetch_url` and `search_and_read` internally use `smartFetch`:

1. **URL matches registered site-specific extractor?**
   - `github.com/X/Y` → GitHub API (repo README + metadata)
   - `github.com/X/Y/issues/N` or `/pull/N` → GitHub API (issue + top comments)
   - `npmjs.com/package/X` → npm registry (package metadata + README)
   - `stackoverflow.com/questions/N` → Stack Exchange API (Q + top 3 answers)
   - `developer.mozilla.org/...` → MDN cheerio (.main-page-content)
   - → on success return

2. **JSON-LD / Open Graph parser** (v0.5.0)
   - Parses `<script type="application/ld+json">` for Product / Article / NewsArticle schemas
   - Falls back to `<meta property="og:*">` Open Graph tags
   - Returns clean `{title, content, price, currency, image, author, datePublished}` when found
   - Cheap (no headless browser), deterministic, wins on e-commerce + news + most modern sites

3. **Jina Reader** with proper noise-stripping headers (v0.5.0)
   - `X-Remove-Selector` strips nav/header/footer/banners
   - `X-Target-Selector` focuses on article/main/product-detail
   - Handles JS-rendered pages

4. **Crawl4AI** self-hosted Docker service (v0.6.0, optional)
   - Real Chromium via Playwright — handles JS-heavy SPAs + anti-bot detection
   - Skipped transparently if container isn't running
   - `DISABLE_CRAWL4AI=1` to skip even when running

5. **`@mozilla/readability` + jsdom** (local extraction, no external dep)

6. **All failed** → aggregated error so the agent knows nothing worked

Disable extractors with `DISABLE_EXTRACTORS=1` (debugging / opt-out).

## v0.7.0 — reliability + security

Cross-cutting hardening on top of the v0.3–v0.6 pipeline:

- **SSRF protection** — `fetch_url` validates every target (and every redirect hop) against a private/loopback/link-local/cloud-metadata blocklist, pinning the validated IP into `curl` (`--resolve`) to defeat DNS rebinding. Internal SearXNG/Crawl4AI calls are unaffected. Escape hatch: `RESEARCH_MCP_ALLOW_PRIVATE=1`.
- **Untrusted-content fencing** — fetched `content` is wrapped in `[BEGIN/END UNTRUSTED WEB CONTENT]` markers warning the model not to obey instructions inside it (indirect prompt-injection mitigation). Disable with `DISABLE_UNTRUSTED_WRAP=1`.
- **Content cleaning** — conservative, line-based stripping of ad/promo/nav chrome ("Promoted" cards, "Skip to main content", login/cookie lines) from extracted markdown. Disable with `DISABLE_CONTENT_CLEAN=1`.
- **Observability** — every fetch result carries `strategy` (which stage won: `jsonld`/`jina`/`crawl4ai`/`readability`/extractor name/`cache`) and `elapsed_ms`. A mismatch between the requested and landed URL surfaces as `urlMismatch`.
- **Search reliability** — empty searches return an explanatory `note` instead of a silent `[]`; the search-results cache is unified across `web_search`/`search_and_read` (keyed on query+source+time_range, independent of `num_results`) so the two tools stop double-spending on the same query.
- **Fetch robustness** — per-URL deadline + bounded concurrency in `search_and_read`; one retry with jittered backoff on Jina `429`/`503`; boundary-aware truncation (no mid-word cuts).
- **Cache policy** — per-query-class TTLs (volatile news expires fast, doc/code hosts live long) and age/row-cap eviction so the DB no longer grows unbounded.

## Setup

### One-time: start SearXNG

```bash
cd ~/Projects/research-mcp
docker compose up -d searxng
```

Verify: `curl http://localhost:8888/healthz` → 200.

Stop with `docker compose down`. Logs: `docker compose logs -f searxng`.

### Optional: start Crawl4AI for JS-heavy / anti-bot sites

```bash
cd ~/Projects/research-mcp
docker compose up -d crawl4ai
```

Verify: `curl http://localhost:11235/health` → 200.

Playground UI at `http://localhost:11235/playground` for testing crawls + tweaking configs.

Crawl4AI sits in `smartFetch` between Jina Reader and Mozilla Readability. If unreachable, it's transparently skipped — Jina/Readability handle the load.

To disable Crawl4AI even when running: set `DISABLE_CRAWL4AI=1` in env.

### Register with Claude Code (one-time, at user scope)

```bash
claude mcp add -s user research-mcp -- node ~/Projects/research-mcp/src/server.js
```

Verify: `claude mcp list | grep research-mcp` → `✓ Connected`.

## Environment variables

| Env | Default | Effect |
|-----|---------|--------|
| `RESEARCH_MCP_DB_PATH` | `~/.research-mcp/cache.db` | SQLite cache location |
| `RESEARCH_MCP_CACHE_TTL_HOURS` | `24` | **Base** cache TTL; multiplied per query class (news/recent ÷24, docs ×7, doc-hosts/PDF ×30). `0` disables caching |
| `RESEARCH_MCP_CACHE_MAX_ROWS` | `5000` | Cache row cap (oldest evicted opportunistically). `0` = uncapped |
| `RESEARCH_MCP_CACHE_MAX_AGE_DAYS` | `30` | Age-based cache eviction (floored to the longest class TTL) |
| `SEARCH_BACKEND` | `auto` | `auto` / `searxng` / `ddg` |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG base URL |
| `DISABLE_EXTRACTORS` | unset | Set to `1` to skip site-specific extractors |
| `GITHUB_TOKEN` | unset | Optional; raises GitHub API limit 60/hr → 5000/hr |
| `CRAWL4AI_URL` | `http://localhost:11235` | Crawl4AI service URL |
| `DISABLE_CRAWL4AI` | unset | Set to `1` to skip Crawl4AI in smartFetch cascade |
| `RESEARCH_MCP_FETCH_TIMEOUT_MS` | `10000` | Per-URL deadline in `search_and_read` (a slow page degrades to `error:'fetch timeout'`) |
| `RESEARCH_MCP_FETCH_CONCURRENCY` | `4` | Max simultaneous fetches during `search_and_read` fan-out |
| `RESEARCH_MCP_ALLOW_PRIVATE` | unset | Set to `1` to **disable** SSRF protection (allow private/loopback/metadata URLs) |
| `DISABLE_UNTRUSTED_WRAP` | unset | Set to `1` to disable fencing fetched `content` as untrusted |
| `DISABLE_CONTENT_CLEAN` | unset | Set to `1` to disable ad/nav boilerplate stripping |

## Tests

```bash
npm test                          # offline unit tests (265 tests)
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

- If `web_search` returns empty arrays from DDG fallback, DDG markup changed: refresh `test/fixtures/ddg-results.html` and update parser.
- If SearXNG returns no results, check `docker compose logs searxng` — usually upstream engine rate limit; restart container.
- To wipe cache: `rm ~/.research-mcp/cache.db`.
