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
- `curl` on `$PATH` (HTTP backend — see [SPEC.md](./SPEC.md) for why)
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
npm test                       # offline unit tests (38 tests)
npm run test:integration       # real network — only for end-to-end validation
node scripts/smoke-cache.js    # validates the cache layer round-trips
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
