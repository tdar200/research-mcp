// Pure, dependency-free TTL policy. Maps a tool call's shape
// (tool, source, time_range, url) to a TTL class, then resolves a concrete
// ttlMs from a caller-supplied base TTL. No I/O, no deps.

// All durations in ms. Base unit overridable by env via server.js, but the
// MULTIPLIERS/shape live here as pure data so tests don't need env.
export const TTL_CLASS = { SHORT: 'short', LONG: 'long', STATIC: 'static' };

// Multipliers applied to a caller-supplied baseTtlMs (default = the env
// RESEARCH_MCP_CACHE_TTL_HOURS value). Keeps one knob while differentiating.
export const TTL_MULTIPLIERS = { short: 1 / 24, long: 7, static: 30 };
//  short  = baseTtl/24   (~1h when base=24h)  -> fast-moving
//  long   = baseTtl*7    (~7d)                 -> docs/github/so/npm/mdn
//  static = baseTtl*30   (~30d)                -> static asset-ish/doc hosts

// Whole-host match: the host ends with (or equals) a known doc/code host, OR
// begins with a `docs.` label. Anchored to the host string only.
const STATIC_HOST_RE =
  /(?:^|\.)(developer\.mozilla\.org|readthedocs\.io|npmjs\.com|github\.com|stackoverflow\.com)$|^docs\./i;
// Static asset: a `.pdf` resource (path or query terminator).
const STATIC_PATH_RE = /\.(pdf)(?:$|[?#])/i;

/**
 * Classify a tool call into a TTL class.
 * @param {object} [a]
 * @param {string} [a.tool]       - 'web_search'|'fetch_url'|'search_and_read'
 * @param {string} [a.source]     - 'web'|'news'|'reddit'|'hackernews'
 * @param {string} [a.timeRange]  - 'all'|'day'|'week'|'month'|'year'
 * @param {string} [a.url]        - for fetch_url
 * @returns {'short'|'long'|'static'}
 */
export function ttlClassFor({ tool, source, timeRange, url } = {}) {
  // News, or any explicitly recency-filtered search, is volatile.
  if (source === 'news') return TTL_CLASS.SHORT;
  if (timeRange === 'day' || timeRange === 'week') return TTL_CLASS.SHORT;
  // Doc/code hosts (whether via extractor or direct fetch) are stable, as are
  // static asset URLs (.pdf).
  if (url) {
    const { host, path } = partsOf(url);
    if (STATIC_HOST_RE.test(host) || STATIC_PATH_RE.test(path)) {
      return TTL_CLASS.STATIC;
    }
  }
  // search_and_read / web_search default + fetch_url default.
  if (tool === 'web_search' || tool === 'search_and_read') return TTL_CLASS.LONG;
  return TTL_CLASS.LONG; // fetch_url of an arbitrary page
}

/**
 * Resolve concrete ttlMs. baseTtlMs<=0 (caching disabled) short-circuits to 0.
 * @param {object} spec - same shape as ttlClassFor's argument
 * @param {number} baseTtlMs
 * @returns {number} ms
 */
export function resolveTtlMs(spec, baseTtlMs) {
  if (!Number.isFinite(baseTtlMs) || baseTtlMs <= 0) return 0;
  const cls = ttlClassFor(spec);
  return Math.round(baseTtlMs * TTL_MULTIPLIERS[cls]);
}

// Split a URL into its lowercased host and its path+query (for the two
// STATIC matchers). Returns empty strings on a bad/non-URL input.
function partsOf(url) {
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', path: '' };
  }
}
