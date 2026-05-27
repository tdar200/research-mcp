import { curlFetch } from './http.js';

const DEFAULT_BASE_URL = 'http://localhost:11235';

/**
 * Fetch a URL via the local Crawl4AI Docker service.
 * Calls Crawl4AI's REST API at POST /crawl with a single URL.
 *
 * @param {string} url - target URL
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {string} [opts.baseUrl='http://localhost:11235']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.timeoutMs=30000] - browser-based, give it more time than Jina
 * @returns {Promise<{url, title, content, truncated, error?, extractor: 'crawl4ai'}>}
 */
export async function crawl4aiFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    timeoutMs = 30000,
  } = opts;

  const body = JSON.stringify({
    urls: [url],
    browser_config: {
      headless: true,
      browser_type: 'chromium',
    },
    crawler_config: {
      cache_mode: 'bypass',
      stream: false,
    },
  });

  try {
    const res = await fetchImpl(`${baseUrl}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body,
      timeoutMs,
    });

    if (!res.ok) {
      const excerpt = (await res.text().catch(() => '')).slice(0, 200);
      return { url, title: null, content: null, truncated: false, error: `crawl4ai ${res.status} ${res.statusText}${excerpt ? `: ${excerpt}` : ''}` };
    }

    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      return { url, title: null, content: null, truncated: false, error: `crawl4ai JSON parse failed: ${e.message}` };
    }

    const first = (json.results || [])[0];
    if (!first) {
      return { url, title: null, content: null, truncated: false, error: 'crawl4ai returned no results' };
    }
    if (first.success === false) {
      return { url, title: null, content: null, truncated: false, error: `crawl4ai: ${first.error_message || 'unknown failure'}` };
    }

    const md = first.markdown || '';
    const truncated = md.length > maxChars;
    return {
      url,
      title: first.metadata?.title || null,
      content: truncated ? md.slice(0, maxChars) : md,
      truncated,
      extractor: 'crawl4ai',
    };
  } catch (err) {
    return { url, title: null, content: null, truncated: false, error: `crawl4ai ${err.message || err}` };
  }
}

/** Liveness probe for the Crawl4AI Docker service. */
export async function isCrawl4aiReachable(baseUrl = DEFAULT_BASE_URL, fetchImpl = curlFetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { timeoutMs: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}
