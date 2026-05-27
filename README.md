# research-mcp

Zero-cost MCP server giving Claude Code agents fresh web research via meta-search (SearXNG or DDG) + multi-strategy content extraction (site-specific extractors → Jina Reader → Mozilla Readability), with transparent SQLite caching.

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
| `RESEARCH_MCP_CACHE_TTL_HOURS` | `24` | Cache TTL; `0` disables caching |
| `SEARCH_BACKEND` | `auto` | `auto` / `searxng` / `ddg` |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG base URL |
| `DISABLE_EXTRACTORS` | unset | Set to `1` to skip site-specific extractors |
| `GITHUB_TOKEN` | unset | Optional; raises GitHub API limit 60/hr → 5000/hr |
| `CRAWL4AI_URL` | `http://localhost:11235` | Crawl4AI service URL |
| `DISABLE_CRAWL4AI` | unset | Set to `1` to skip Crawl4AI in smartFetch cascade |

## Tests

```bash
npm test                          # offline unit tests (103 tests)
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
