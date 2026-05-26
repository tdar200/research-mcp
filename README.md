# research-mcp

Zero-cost, zero-key MCP server giving Claude Code agents fresh web research via DuckDuckGo search + [Jina Reader](https://jina.ai/reader/) extraction.

## Tools

| Tool | Use when |
|------|----------|
| `web_search(query, num_results=5)` | You just need URLs — no content extraction. |
| `fetch_url(url, max_chars=20000)` | You already have a URL and want clean markdown. |
| `search_and_read(query, num_results=3, max_chars_per_result=8000)` | **Default research call** — top-N results + their content in one shot. |

## Requirements

- Node.js ≥ 20
- `curl` on `$PATH` (used as the HTTP backend — see [SPEC.md](./SPEC.md) for why)

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

See [SPEC.md](./SPEC.md). Three modules:

- `src/search.js` — DDG HTML parser (cheerio)
- `src/fetch.js` — Jina Reader wrapper (truncation + error surfacing)
- `src/combine.js` — `search_and_read` composer (partial-failure tolerant)
- `src/server.js` — MCP protocol wiring only, no business logic

## Maintenance

The DDG parser depends on DuckDuckGo HTML markup. If `web_search` starts returning empty arrays, refresh the fixture:

```bash
curl -sS -A "Mozilla/5.0" --data-urlencode "q=test" "https://html.duckduckgo.com/html/" > test/fixtures/ddg-results.html
npm test  # see what breaks, update parser
```
