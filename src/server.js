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

import { webSearch } from './search.js';
import { smartFetch } from './fetch.js';
import { searchAndRead } from './combine.js';
import { Cache } from './cache.js';

const DB_PATH = process.env.RESEARCH_MCP_DB_PATH || join(homedir(), '.research-mcp', 'cache.db');
const TTL_HOURS = Number(process.env.RESEARCH_MCP_CACHE_TTL_HOURS ?? 24);
const TTL_MS = Number.isFinite(TTL_HOURS) && TTL_HOURS > 0 ? TTL_HOURS * 3600 * 1000 : 0;

const SEARCH_BACKEND = process.env.SEARCH_BACKEND || 'auto';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';
const DISABLE_EXTRACTORS = process.env.DISABLE_EXTRACTORS === '1';

const cache = new Cache({ dbPath: DB_PATH });

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

const server = new Server(
  { name: 'research-mcp', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
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
        cache,
        ttlMs: TTL_MS,
        searchImpl: (q, n) => webSearch(q, n, { cache, ttlMs: TTL_MS, backend: SEARCH_BACKEND, searxngUrl: SEARXNG_URL }),
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
process.stderr.write(`[research-mcp] v0.3.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
