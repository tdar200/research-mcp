import { curlFetch } from './http.js';

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
  } = opts;

  try {
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: { 'Accept': 'text/markdown' },
      timeoutMs,
    });

    if (!res.ok) {
      const bodyExcerpt = (await res.text().catch(() => '')).slice(0, 200);
      const error = res.status === 429
        ? `rate limit (429): ${res.statusText}`
        : `${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`;
      return { url, title: null, content: null, truncated: false, error };
    }

    const raw = await res.text();
    const title = extractTitle(raw);
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;

    return { url, title, content, truncated };
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
