# research-mcp — Tier 1 MVP Spec

**Date:** 2026-05-27
**Author:** Tahseen Dar (designed with Claude)
**Status:** Approved for implementation

## Purpose

A zero-cost, zero-key MCP server that gives Claude Code agents fresh web research capability beyond the built-in `WebSearch` / `WebFetch`. Specifically, a single combined `search_and_read` tool that returns top-N search results *with their content already extracted to clean markdown* — so the agent does one tool call instead of N+1.

## HTTP backend: curl, not Node fetch

Both `search.js` and `fetch.js` shell out to `curl` (via `src/http.js`) instead of using Node's built-in `fetch` (undici). Empirically, on this machine, undici and `node:https` both time out at TCP-connect time on Cloudflare-fronted hosts (e.g. `r.jina.ai`, `example.com`) while curl reaches the very same IPs without issue. Rather than chase TLS fingerprinting or kernel TCP knobs, we shell out — curl is universally available, stable, and handles redirects/MTU/dual-stack better than any drop-in alternative we tried. Trade: ~50ms per call for process spawn, no big deal at agent-research volume. Tests inject `fetchImpl` so they remain offline-deterministic.

## Non-goals (deferred to Tier 2+)

- Self-hosted search (SearXNG) — DuckDuckGo HTML scrape is enough for MVP.
- Self-hosted extraction (Mozilla Readability + jsdom) — Jina Reader is free and good.
- Caching — premature for MVP usage volume.
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
