import { load } from 'cheerio';
import { curlFetch } from './http.js';
import { searchCacheKey, readSearchCache, SEARCH_CACHE_TOOL } from './searchCacheKey.js';
import { searxngSearch, isSearxngReachable } from './searxng.js';

/**
 * Parse a DuckDuckGo HTML search results page into structured results.
 * @param {string} html - raw HTML from html.duckduckgo.com/html/
 * @param {number} numResults - max results to return
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function parseDuckDuckGoHtml(html, numResults) {
  if (!html || typeof html !== 'string') return [];

  const $ = load(html);
  const results = [];

  $('.result').each((_, el) => {
    if (results.length >= numResults) return false;

    const $el = $(el);
    const $a = $el.find('a.result__a').first();
    const title = $a.text().trim();
    let url = $a.attr('href') || '';

    // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>&...
    const ddgWrapMatch = url.match(/[?&]uddg=([^&]+)/);
    if (ddgWrapMatch) {
      try {
        url = decodeURIComponent(ddgWrapMatch[1]);
      } catch {
        /* leave as-is */
      }
    }
    // Strip leading // if relative-protocol
    if (url.startsWith('//')) url = 'https:' + url;

    const snippet = $el.find('.result__snippet').first().text().trim();

    if (title && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  });

  return results;
}

/**
 * Perform a live DuckDuckGo HTML search.
 * @param {string} query
 * @param {number} numResults
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
/** Map our `source` enum to a `site:` prefix for DDG queries. */
function ddgSourcePrefix(source) {
  switch (source) {
    case 'reddit':     return 'site:reddit.com ';
    case 'hackernews': return 'site:news.ycombinator.com ';
    case 'news':       return 'site:reuters.com OR site:bloomberg.com OR site:techcrunch.com ';
    case 'web':
    case undefined:
    case null:
    case '':
      return '';
    default:
      return '';
  }
}

/** Map our `time_range` enum to DDG's `df` form param value (or null). */
function ddgTimeParam(timeRange) {
  switch (timeRange) {
    case 'day':   return 'd';
    case 'week':  return 'w';
    case 'month': return 'm';
    case 'year':  return 'y';
    case 'all':
    case undefined:
    case null:
    case '':
      return null;
    default:
      return null;
  }
}

export async function duckDuckGoSearch(query, numResults = 5, opts = {}) {
  const { cache, ttlMs, fetchImpl = curlFetch, source = 'web', timeRange = 'all' } = opts;

  // Unified search-results cache (shared with searxng + search_and_read):
  // keyed on (query, source, time_range) only — independent of numResults — so a
  // superset fetch satisfies any smaller-N request. See searchCacheKey.js.
  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = searchCacheKey({ query, source, timeRange });
    const hit = readSearchCache({ cache, ttlMs, key: cacheKey, want: numResults });
    if (hit) return hit;
  }

  const finalQuery = ddgSourcePrefix(source) + query;
  const params = new URLSearchParams({ q: finalQuery });
  const df = ddgTimeParam(timeRange);
  if (df) params.set('df', df);

  const res = await fetchImpl('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: params.toString(),
    timeoutMs: 15000,
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo returned ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const results = parseDuckDuckGoHtml(html, numResults);

  // Don't cache empty results — a transient parser/HTML hiccup shouldn't be
  // locked in for the TTL window (mirrors the searxng empty-guard).
  if (cache && cacheKey && results.length > 0) {
    cache.set({
      tool: SEARCH_CACHE_TOOL,
      cacheKey,
      query,
      params: { num_results: numResults, source, time_range: timeRange },
      result: results,
    });
  }

  return results;
}

/**
 * Route a search query to either SearXNG or DuckDuckGo based on env/opts.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {object} [opts]
 * @param {string} [opts.backend='auto'] - 'auto' | 'searxng' | 'ddg'
 * @param {string} [opts.searxngUrl] - passed through to searxng backend
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {function} [opts.searxngImpl=searxngSearch] - inject for tests
 * @param {function} [opts.ddgImpl=duckDuckGoSearch] - inject for tests
 * @param {function} [opts.reachableImpl=isSearxngReachable] - inject for tests
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
export async function webSearch(query, numResults = 5, opts = {}) {
  const {
    backend = 'auto',
    searxngUrl,
    cache,
    ttlMs,
    source = 'web',
    timeRange = 'all',
    searxngImpl = searxngSearch,
    ddgImpl = duckDuckGoSearch,
    reachableImpl = isSearxngReachable,
  } = opts;

  const downstreamOpts = { cache, ttlMs, baseUrl: searxngUrl, source, timeRange };

  if (backend === 'searxng') {
    return await searxngImpl(query, numResults, downstreamOpts);
  }
  if (backend === 'ddg') {
    return await ddgImpl(query, numResults, downstreamOpts);
  }
  const reachable = await reachableImpl(searxngUrl || 'http://localhost:8888');
  if (reachable) {
    const sxResults = await searxngImpl(query, numResults, downstreamOpts);
    if (sxResults.length > 0) return sxResults;
    // Empty SearXNG response often means a backing engine timed out
    // (reddit/hackernews are routinely flaky). Fall back to DDG so the
    // source/time_range pathway still returns data.
    return await ddgImpl(query, numResults, downstreamOpts);
  }
  return await ddgImpl(query, numResults, downstreamOpts);
}
