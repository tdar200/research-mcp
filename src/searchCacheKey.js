import { cacheKeyFor } from './cacheKey.js';

// Unified search-results cache. NOTE: numResults is deliberately EXCLUDED from
// the key. A single cached entry holds the largest result set fetched for
// (query, source, time_range); reads slice it down to the requested count.
// tool tag is the literal 'web_search' so existing list_research/tool_filter
// and the on-disk schema stay backward compatible.
export const SEARCH_CACHE_TOOL = 'web_search';

export function searchCacheKey({ query, source = 'web', timeRange = 'all' }) {
  return cacheKeyFor(SEARCH_CACHE_TOOL, [query, source, timeRange]);
}

// Read helper: returns sliced results if the cached superset is >= want,
// else null (forces a fresh, larger fetch). A cached set of length L can only
// satisfy a request for N if L >= N OR the original fetch was already maxed
// out (the engine simply had no more). We store `fetchedCount` (what we asked
// the engine for) in params so we can tell 'engine returned fewer than asked'
// (authoritative — reuse) from 'we only asked for a few' (not enough — refetch).
export function readSearchCache({ cache, ttlMs, key, want }) {
  if (!cache || !ttlMs) return null;
  const hit = cache.get({ cacheKey: key, ttlMs });
  if (!hit) return null;
  const results = hit.result;
  const asked = hit.params?.num_results ?? results.length;
  // Superset satisfies subset: enough rows present, OR engine was asked for
  // >= want but returned fewer (so a refetch wouldn't yield more).
  if (results.length >= want || asked >= want) {
    return results.slice(0, want);
  }
  return null;
}

// Centralized empty-result note (L1). Kept here so both tools match verbatim.
export function emptySearchNote(source = 'web') {
  return (
    'No results returned. This is usually a transient backend issue ' +
    '(SearXNG engine timeout or a DuckDuckGo parser/HTML hiccup), not an empty web. ' +
    'Suggested next steps: retry the same query once, broaden or rephrase the query, ' +
    (source && source !== 'web'
      ? "or drop the `source` restriction (try source='web'), "
      : '') +
    'or widen `time_range` to all.'
  );
}
