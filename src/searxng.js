import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';

const DEFAULT_BASE_URL = 'http://localhost:8888';

/** Map our `source` enum to SearXNG URL params. */
function searxngSourceParams(source) {
  switch (source) {
    case 'news':       return { categories: 'news' };
    case 'reddit':     return { engines: 'reddit' };
    case 'hackernews': return { engines: 'hackernews' };
    case 'web':
    case undefined:
    case null:
    case '':
      return {};
    default:
      return {};
  }
}

/**
 * Query a local SearXNG instance via its JSON API.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.baseUrl='http://localhost:8888']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {string} [opts.source='web'] - 'web' | 'news' | 'reddit' | 'hackernews'
 * @param {string} [opts.timeRange='all'] - 'all' | 'day' | 'week' | 'month' | 'year'
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function searxngSearch(query, numResults = 5, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    cache,
    ttlMs,
    source = 'web',
    timeRange = 'all',
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults, source, timeRange]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const params = new URLSearchParams({ q: query, format: 'json' });
  const sourceParams = searxngSourceParams(source);
  for (const [k, v] of Object.entries(sourceParams)) params.set(k, v);
  if (timeRange && timeRange !== 'all') {
    params.set('time_range', timeRange);
  }

  const url = `${baseUrl}/search?${params.toString()}`;
  const res = await fetchImpl(url, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.4.0' },
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
      params: { num_results: numResults, source, time_range: timeRange },
      result: results,
    });
  }

  return results;
}

/**
 * Quick liveness probe — does SearXNG answer at this baseUrl?
 */
export async function isSearxngReachable(baseUrl = DEFAULT_BASE_URL, fetchImpl = curlFetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/healthz`, { timeoutMs: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}
