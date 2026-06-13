import { duckDuckGoSearch } from './search.js';
import { smartFetch } from './fetch.js';
import { cacheKeyFor } from './cacheKey.js';
import { emptySearchNote } from './searchCacheKey.js';

const MAX_NUM_RESULTS = 10;

/**
 * Race a promise against a deadline. On timeout, resolves to {__timedOut:true}
 * (never rejects on timeout). The underlying fetch is NOT aborted — it runs to
 * completion in the background and its result is discarded (acceptable: result
 * is unused). setTimeout/clearTimeout are injectable for deterministic tests.
 */
function withDeadline(promise, ms, { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeoutImpl(() => resolve({ __timedOut: true }), ms);
  });
  return Promise.race([
    promise.then(
      (v) => { clearTimeoutImpl(t); return v; },
      (e) => { clearTimeoutImpl(t); throw e; },
    ),
    timeout,
  ]);
}

/**
 * Map `worker` over `items` with bounded concurrency, writing results by index
 * (so output order matches input order regardless of completion order). The
 * worker must not throw — it owns its own error handling (allSettled-like).
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner);
  await Promise.all(runners);
  return results;
}

/**
 * Search the web and extract content from the top N results.
 * Returns partial results — a failed/slow extraction surfaces as
 * `content: null, error: ...` and does not abort the batch.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.numResults=3] - capped at 10
 * @param {number} [opts.maxCharsPerResult=8000]
 * @param {number} [opts.perFetchTimeoutMs=10000] - per-URL deadline; a slow fetch
 *        (e.g. the 30s Crawl4AI stage) degrades to {error:'fetch timeout'} instead
 *        of stalling the whole batch. Raise it if you rely on Crawl4AI for batches.
 * @param {number} [opts.concurrency=4] - max simultaneous fetches (bounds upstream load)
 * @param {function} [opts.searchImpl=duckDuckGoSearch] - inject for tests
 * @param {function} [opts.fetchImpl=smartFetch] - inject for tests
 * @returns {Promise<{query: string, results: Array, note?: string}>}
 */
export async function searchAndRead(query, opts = {}) {
  const {
    numResults = 3,
    maxCharsPerResult = 8000,
    searchImpl = duckDuckGoSearch,
    fetchImpl = smartFetch,
    cache,
    ttlMs,
    perFetchTimeoutMs = 10000,
    concurrency = 4,
    disableClean = false,
    timerImpl,
  } = opts;

  const capped = Math.min(Math.max(1, numResults), MAX_NUM_RESULTS);

  // Content cache key MUST include source + time_range (different origins/recency
  // yield different result sets) and the clean flag (cleaned vs raw content).
  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('search_and_read', [
      query, capped, maxCharsPerResult,
      opts.source ?? 'web', opts.timeRange ?? 'all', disableClean ? 'raw' : 'clean',
    ]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  // The underlying search-results cache is shared with web_search and keyed
  // independent of which tool triggered it (see searchCacheKey.js), so a fresh
  // web_search of the same (query, source, time_range) is reused here for free.
  const searchResults = await searchImpl(query, capped, { source: opts.source, timeRange: opts.timeRange });

  if (searchResults.length === 0) {
    // Don't cache empty searches — may be transient (parser drift, engine timeout).
    // Surface a note so the agent never sees a silently-empty result (L1).
    return { query, results: [], note: emptySearchNote(opts.source) };
  }

  const enriched = await mapWithConcurrency(searchResults, concurrency, async (r) => {
    let fetched;
    try {
      const raced = await withDeadline(
        Promise.resolve(fetchImpl(r.url, { maxChars: maxCharsPerResult, disableClean })),
        perFetchTimeoutMs,
        timerImpl,
      );
      fetched = raced && raced.__timedOut
        ? { content: null, truncated: false, error: 'fetch timeout' }
        : raced;
    } catch (err) {
      // fetchImpl threw — degrade like any other partial failure.
      fetched = { content: null, truncated: false, error: String(err.message || err) };
    }
    return {
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      content: fetched.content ?? null,
      truncated: fetched.truncated ?? false,
      ...(fetched.strategy ? { strategy: fetched.strategy } : {}),
      ...(fetched.elapsed_ms != null ? { elapsed_ms: fetched.elapsed_ms } : {}),
      ...(fetched.urlMismatch ? { urlMismatch: fetched.urlMismatch } : {}),
      ...(fetched.error ? { error: fetched.error } : {}),
    };
  });

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
