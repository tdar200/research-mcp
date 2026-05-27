import { curlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';
import { findExtractor } from './extractorRegistry.js';
import { readabilityFetch } from './readability.js';
import { parseStructuredData } from './jsonld.js';
import { crawl4aiFetch, isCrawl4aiReachable } from './crawl4ai.js';

const JINA_BASE = 'https://r.jina.ai/';

/**
 * Fetch a URL via Jina Reader and return cleaned markdown.
 * @param {string} url - target URL to extract
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000] - truncate content to this length
 * @param {function} [opts.fetchImpl=fetch] - inject for tests
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{url: string, title: string|null, content: string|null, truncated: boolean, error?: string}>}
 */
export async function jinaFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    fetchImpl = curlFetch,
    timeoutMs = 15000,
    cache,
    ttlMs,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  try {
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: {
        'Accept': 'text/markdown',
        'X-Return-Format': 'markdown',
        'X-Remove-Selector': 'header, nav, footer, .announcement, .announcement-bar, .popup, .cookie-banner, .modal, [class*="banner"]',
        'X-Target-Selector': 'article, main, [itemtype], .product-detail, .post-content, .markdown-body',
      },
      timeoutMs,
    });

    if (!res.ok) {
      const bodyExcerpt = (await res.text().catch(() => '')).slice(0, 200);
      const error = res.status === 429
        ? `rate limit (429): ${res.statusText}`
        : `${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`;
      // Do NOT cache errors — network blips shouldn't pollute the cache.
      return { url, title: null, content: null, truncated: false, error };
    }

    const raw = await res.text();
    const title = extractTitle(raw);
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;
    const result = { url, title, content, truncated };

    if (cache && cacheKey) {
      cache.set({
        tool: 'fetch_url',
        cacheKey,
        query: url,
        params: { max_chars: maxChars },
        result,
      });
    }

    return result;
  } catch (err) {
    return {
      url,
      title: null,
      content: null,
      truncated: false,
      error: String(err.message || err),
    };
  }
}

/** Jina prepends "Title: ..." then first h1. Use whichever appears first. */
function extractTitle(markdown) {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return null;
}

/**
 * Composed fetcher: tries site-specific extractor → Jina → Readability.
 * This is the new public default; jinaFetch remains exported for direct use.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {object} [opts.cache]
 * @param {number} [opts.ttlMs]
 * @param {function} [opts.fetchImpl] - HTTP impl, passed through to leaf fetchers
 * @param {boolean} [opts.disableExtractors=false]
 * @param {object} [opts.extractorImpl] - inject for tests; { name, extract: fn }
 * @param {function} [opts.jinaImpl=jinaFetch] - inject for tests
 * @param {function} [opts.readabilityImpl=readabilityFetch] - inject for tests
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function smartFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    cache,
    ttlMs,
    fetchImpl,
    disableExtractors = false,
    disableCrawl4ai = false,
    crawl4aiBaseUrl,
    extractorImpl,
    jsonldImpl = defaultJsonldFetch,
    jinaImpl = jinaFetch,
    crawl4aiImpl = crawl4aiFetch,
    crawl4aiReachableImpl = isCrawl4aiReachable,
    readabilityImpl = readabilityFetch,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const attempts = [];

  if (!disableExtractors) {
    const extractor = extractorImpl || findExtractor(url);
    if (extractor) {
      const r = await extractor.extract(url, { maxChars, fetchImpl });
      attempts.push({ method: extractor.name, error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    }
  }

  // v0.5.0: JSON-LD / Open Graph parser
  {
    const r = await jsonldImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jsonld', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  {
    const r = await jinaImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jina', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  // v0.6.0: Crawl4AI (only if reachable + not disabled)
  if (!disableCrawl4ai) {
    const reachable = await crawl4aiReachableImpl(crawl4aiBaseUrl || 'http://localhost:11235');
    if (reachable) {
      const r = await crawl4aiImpl(url, { maxChars, fetchImpl, baseUrl: crawl4aiBaseUrl });
      attempts.push({ method: 'crawl4ai', error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    } else {
      attempts.push({ method: 'crawl4ai', error: 'not reachable' });
    }
  }

  {
    const r = await readabilityImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'readability', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  return {
    url, title: null, content: null, truncated: false,
    error: `all strategies failed: ${attempts.map(a => `${a.method}=${a.error || 'no content'}`).join('; ')}`,
  };
}

/** Default jsonldImpl: fetches HTML via curl, then parses for JSON-LD/OG. */
async function defaultJsonldFetch(url, opts = {}) {
  const { fetchImpl = curlFetch } = opts;
  try {
    const res = await fetchImpl(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.5.0)' },
    });
    if (!res.ok) {
      return { url, title: null, content: null, truncated: false, error: `${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    return parseStructuredData(html, url);
  } catch (err) {
    return { url, title: null, content: null, truncated: false, error: String(err.message || err) };
  }
}
