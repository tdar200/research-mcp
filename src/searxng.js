import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';

const DEFAULT_BASE_URL = 'http://localhost:8888';

/**
 * Query a local SearXNG instance via its JSON API.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.baseUrl='http://localhost:8888']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {object} [opts.cache] - Cache instance
 * @param {number} [opts.ttlMs] - required if cache provided
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function searxngSearch(query, numResults = 5, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    cache,
    ttlMs,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetchImpl(url, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.3.0' },
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
      params: { num_results: numResults },
      result: results,
    });
  }

  return results;
}

/**
 * Quick liveness probe — does SearXNG answer at this baseUrl?
 * @param {string} baseUrl
 * @param {function} [fetchImpl=curlFetch]
 * @returns {Promise<boolean>}
 */
export async function isSearxngReachable(baseUrl = DEFAULT_BASE_URL, fetchImpl = curlFetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/healthz`, { timeoutMs: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}
