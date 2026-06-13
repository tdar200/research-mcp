import { curlFetch, guardedCurlFetch } from './http.js';
import { cacheKeyFor } from './cacheKey.js';
import { findExtractor } from './extractorRegistry.js';
import { readabilityFetch } from './readability.js';
import { parseStructuredData } from './jsonld.js';
import { crawl4aiFetch, isCrawl4aiReachable } from './crawl4ai.js';
import { truncateAtBoundary } from './truncate.js';
import { cleanContent } from './clean.js';
import { checkUrlIdentity } from './urlIdentity.js';
import { makeGuardedFetch, assertUrlAllowed } from './ssrf.js';

const JINA_BASE = 'https://r.jina.ai/';

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Full-jitter exponential backoff: attempt 0 -> [500,1000)ms, attempt 1 -> [1000,2000)ms. */
function backoffDelay(attempt, rng) {
  const base = 500 * Math.pow(2, attempt);
  const jitter = Math.floor(rng() * base);
  return base + jitter;
}

/**
 * Fetch a URL via Jina Reader and return cleaned markdown.
 * Retries ONCE on a transient 429/503 with jittered backoff (injectable sleep).
 *
 * @param {string} url - target URL to extract
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000] - truncate content to this length
 * @param {function} [opts.fetchImpl=curlFetch] - inject for tests
 * @param {number} [opts.timeoutMs=15000]
 * @param {function} [opts.sleepImpl] - inject to avoid real delays in tests
 * @param {number} [opts.maxRetries=1] - retries on 429/503 only (0 = no retry)
 * @param {function} [opts.rngImpl=Math.random] - inject for deterministic jitter
 * @returns {Promise<{url, title, content, truncated, error?}>}
 */
export async function jinaFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    fetchImpl = curlFetch,
    timeoutMs = 15000,
    cache,
    ttlMs,
    sleepImpl = defaultSleep,
    maxRetries = 1,
    rngImpl = Math.random,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        const retriable = res.status === 429 || res.status === 503;
        const bodyExcerpt = (await res.text().catch(() => '')).slice(0, 200);
        const error = res.status === 429
          ? `rate limit (429): ${res.statusText}`
          : `${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`;
        if (retriable && attempt < maxRetries) {
          await sleepImpl(backoffDelay(attempt, rngImpl));
          continue; // retry the transient status
        }
        // Do NOT cache errors — network blips shouldn't pollute the cache.
        return { url, title: null, content: null, truncated: false, error };
      }

      const raw = await res.text();
      const title = extractTitle(raw);
      const { content, truncated } = truncateAtBoundary(raw, maxChars);
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
      // Thrown (network) errors are NOT retried — fall through to the cascade.
      return { url, title: null, content: null, truncated: false, error: String(err.message || err) };
    }
  }
  // Unreachable in practice — every loop path returns; defensive fallback.
  return { url, title: null, content: null, truncated: false, error: 'jina: retries exhausted' };
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
 * Composed fetcher: site extractor → JSON-LD → Jina → Crawl4AI → Readability.
 *
 * Cross-cutting behavior added in v0.7.0:
 *  - SSRF: in production (no injected leaf impls) the user URL is validated up
 *    front and every user-facing leaf fetches through a guarded fetch that
 *    re-checks each redirect hop. Crawl4AI keeps the raw fetch (it POSTs to the
 *    trusted localhost service). Injecting a leaf impl marks "test mode" and
 *    skips the top-level guard so unit tests stay hermetic (no real DNS).
 *  - Cleaning + URL identity: each winning result is run through finalize()
 *    which strips ad/nav chrome and flags landed-URL mismatches.
 *  - Observability: the returned (not cached) result carries `strategy` and
 *    `elapsed_ms`; a cache hit is marked `strategy:'cache', elapsed_ms:0`.
 *
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<{url, title, content, truncated, error?, strategy?, elapsed_ms?, cleaned?, urlMismatch?}>}
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
    nowImpl = Date.now,
    cleanImpl = cleanContent,
    disableClean = false,
    ssrfResolver,
    ssrfEnv = process.env,
  } = opts;

  // "Test mode": any injected leaf/fetch impl means a unit test is driving mocks.
  // Production injects NONE of these, so the top-level SSRF pre-check (which does
  // real DNS) runs only in production and never breaks hermetic unit tests.
  const injectedLeaf = !!(
    opts.fetchImpl || opts.extractorImpl || opts.jsonldImpl ||
    opts.jinaImpl || opts.crawl4aiImpl || opts.readabilityImpl
  );

  const startedAt = nowImpl();

  // User-facing leaves (extractor APIs aside) fetch through this guarded wrapper,
  // which re-validates SSRF on every redirect hop. Tests injecting fetchImpl use
  // it verbatim. Crawl4AI deliberately does NOT use this (it POSTs to localhost).
  const guardedFetch = fetchImpl || makeGuardedFetch(guardedCurlFetch, { resolver: ssrfResolver, env: ssrfEnv });

  // Cache key includes the clean flag so cleaned vs raw content never collide.
  const cacheKey = (cache && ttlMs)
    ? cacheKeyFor('fetch_url', [url, maxChars, disableClean ? 'raw' : 'clean'])
    : null;

  // Single success chokepoint: resolve strategy -> clean -> identity ->
  // cache(clean, no strategy/elapsed) -> return(tagged). The internal `extractor`
  // field is dropped from the public/cached shape (mirrored by `strategy`).
  const finalize = (r, strategyLiteral) => {
    const out = { ...r };
    const strategy = out.extractor || strategyLiteral;
    if (!disableClean && out.content) {
      const c = cleanImpl(out.content, {});
      // If cleaning emptied the content, keep the original — never cascade on it.
      if (c.content) {
        out.content = c.content;
        if (c.removedLineCount > 0) out.cleaned = { removedLineCount: c.removedLineCount, removedKinds: c.removedKinds };
      }
    }
    const landed = out.landedUrl || out._finalUrl;
    if (landed) {
      const mm = checkUrlIdentity(url, landed);
      if (mm) out.urlMismatch = mm;
    }
    if ('_finalUrl' in out) delete out._finalUrl; // internal redirect signal
    if ('extractor' in out) delete out.extractor; // mirrored by `strategy`
    if (cache && cacheKey) {
      cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: out });
    }
    return { ...out, strategy, elapsed_ms: nowImpl() - startedAt };
  };

  try {
    if (!injectedLeaf) {
      // Top-level SSRF pre-check FIRST: a blocked URL never runs a leaf, never
      // reads the cache, never returns a (possibly now-unsafe) cached entry.
      // (Skipped in test mode to keep unit tests off the network.)
      await assertUrlAllowed(url, { resolver: ssrfResolver, env: ssrfEnv });
    }

    if (cacheKey) {
      const hit = cache.get({ cacheKey, ttlMs });
      if (hit) return { ...hit.result, strategy: 'cache', elapsed_ms: 0 };
    }

    const attempts = [];

    if (!disableExtractors) {
      const extractor = extractorImpl || findExtractor(url);
      if (extractor) {
        // Use the guarded fetch: some extractors (MDN) fetch the user URL directly
        // and could otherwise follow a redirect into a private range. Extractors
        // hitting hardcoded public APIs (github/npm/SO) are unaffected.
        const r = await extractor.extract(url, { maxChars, fetchImpl: guardedFetch });
        attempts.push({ method: extractor.name, error: r.error });
        if (!r.error && r.content) return finalize(r, extractor.name);
      }
    }

    {
      const r = await jsonldImpl(url, { maxChars, fetchImpl: guardedFetch });
      attempts.push({ method: 'jsonld', error: r.error });
      if (!r.error && r.content) return finalize(r, 'jsonld');
    }

    {
      const r = await jinaImpl(url, { maxChars, fetchImpl: guardedFetch });
      attempts.push({ method: 'jina', error: r.error });
      if (!r.error && r.content) return finalize(r, 'jina');
    }

    if (!disableCrawl4ai) {
      const reachable = await crawl4aiReachableImpl(crawl4aiBaseUrl || 'http://localhost:11235');
      if (reachable) {
        // Crawl4AI POSTs to the trusted localhost service — use the raw fetch,
        // NOT guardedFetch (which would block localhost). The target page is
        // fetched server-side by the browser (accepted residual, like Jina).
        const r = await crawl4aiImpl(url, { maxChars, fetchImpl, baseUrl: crawl4aiBaseUrl });
        attempts.push({ method: 'crawl4ai', error: r.error });
        if (!r.error && r.content) return finalize(r, 'crawl4ai');
      } else {
        attempts.push({ method: 'crawl4ai', error: 'not reachable' });
      }
    }

    {
      const r = await readabilityImpl(url, { maxChars, fetchImpl: guardedFetch });
      attempts.push({ method: 'readability', error: r.error });
      if (!r.error && r.content) return finalize(r, 'readability');
    }

    return {
      url, title: null, content: null, truncated: false,
      error: `all strategies failed: ${attempts.map(a => `${a.method}=${a.error || 'no content'}`).join('; ')}`,
    };
  } catch (err) {
    if (err && err.ssrf) {
      // Blocked by SSRF guard — surface a clear, uncached error.
      return { url, title: null, content: null, truncated: false, error: `blocked: ${err.message}` };
    }
    throw err;
  }
}

/** Default jsonldImpl: fetches HTML via the guarded fetch, then parses JSON-LD/OG. */
async function defaultJsonldFetch(url, opts = {}) {
  const { fetchImpl = curlFetch } = opts;
  try {
    const res = await fetchImpl(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.7.0)' },
    });
    if (!res.ok) {
      return { url, title: null, content: null, truncated: false, error: `${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    const parsed = parseStructuredData(html, url);
    // Surface curl's effective (post-redirect) URL for the identity check.
    if (res.finalUrl) parsed._finalUrl = res.finalUrl;
    return parsed;
  } catch (err) {
    return { url, title: null, content: null, truncated: false, error: String(err.message || err) };
  }
}
