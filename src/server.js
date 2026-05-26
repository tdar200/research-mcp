#!/usr/bin/env node
import dns from 'node:dns';
// Prefer IPv4-first DNS resolution. Without this, Node's undici can hang for
// 10s on AAAA records when IPv6 is broken in the local network path. curl
// handles this transparently; Node does not. Affects both search and fetch.
dns.setDefaultResultOrder('ipv4first');

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
];

const server = new Server(
  { name: 'research-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'web_search') {
      const { query, num_results } = WebSearchArgs.parse(args);
      const results = await duckDuckGoSearch(query, num_results);
      return {
        content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }],
      };
    }

    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await jinaFetch(url, { maxChars: max_chars });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === 'search_and_read') {
      const { query, num_results, max_chars_per_result } = SearchAndReadArgs.parse(args);
      const result = await searchAndRead(query, {
        numResults: num_results,
        maxCharsPerResult: max_chars_per_result,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
process.stderr.write('[research-mcp] connected via stdio\n');
