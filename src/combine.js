import { duckDuckGoSearch } from './search.js';
import { jinaFetch } from './fetch.js';
import { cacheKeyFor } from './cacheKey.js';

const MAX_NUM_RESULTS = 10;

/**
 * Search the web and extract content from the top N results.
 * Returns partial results — a failed extraction surfaces as `content: null, error: ...`
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.numResults=3] - capped at 10
 * @param {number} [opts.maxCharsPerResult=8000]
 * @param {function} [opts.searchImpl=duckDuckGoSearch] - inject for tests
 * @param {function} [opts.fetchImpl=jinaFetch] - inject for tests
 * @returns {Promise<{query: string, results: Array<{title, url, snippet, content, truncated, error?}>}>}
 */
export async function searchAndRead(query, opts = {}) {
  const {
    numResults = 3,
    maxCharsPerResult = 8000,
    searchImpl = duckDuckGoSearch,
    fetchImpl = jinaFetch,
    cache,
    ttlMs,
  } = opts;

  const capped = Math.min(Math.max(1, numResults), MAX_NUM_RESULTS);

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('search_and_read', [query, capped, maxCharsPerResult]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const searchResults = await searchImpl(query, capped);

  if (searchResults.length === 0) {
    // Don't cache empty searches — may be transient (parser drift, DDG hiccup).
    return { query, results: [] };
  }

  const enriched = await Promise.all(
    searchResults.map(async (r) => {
      const fetched = await fetchImpl(r.url, { maxChars: maxCharsPerResult });
      return {
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: fetched.content,
        truncated: fetched.truncated ?? false,
        ...(fetched.error ? { error: fetched.error } : {}),
      };
    })
  );

  const out = { query, results: enriched };

  const hasErrors = enriched.some(r => r.error);
  if (cache && cacheKey && !hasErrors) {
    cache.set({
      tool: 'search_and_read',
      cacheKey,
      query,
      params: { num_results: capped, max_chars_per_result: maxCharsPerResult },
      result: out,
    });
  }

  return out;
}
