import { load } from 'cheerio';
import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';
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
export async function duckDuckGoSearch(query, numResults = 5, opts = {}) {
  const { cache, ttlMs, fetchImpl = curlFetch } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('web_search', [query, numResults]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const params = new URLSearchParams({ q: query });
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
    searxngImpl = searxngSearch,
    ddgImpl = duckDuckGoSearch,
    reachableImpl = isSearxngReachable,
  } = opts;

  const downstreamOpts = { cache, ttlMs, baseUrl: searxngUrl };

  if (backend === 'searxng') {
    return await searxngImpl(query, numResults, downstreamOpts);
  }
  if (backend === 'ddg') {
    return await ddgImpl(query, numResults, downstreamOpts);
  }
  const reachable = await reachableImpl(searxngUrl || 'http://localhost:8888');
  if (reachable) {
    return await searxngImpl(query, numResults, downstreamOpts);
  }
  return await ddgImpl(query, numResults, downstreamOpts);
}
