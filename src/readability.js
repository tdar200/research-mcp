import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { curlFetch } from './http.js';
import { truncateAtBoundary } from './truncate.js';

/**
 * Fetch a URL and extract main content using Mozilla Readability + jsdom.
 * Offline fallback when Jina Reader fails.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{url, title, content, truncated, error?}>}
 */
export async function readabilityFetch(url, opts = {}) {
  const { maxChars = 20000, fetchImpl = curlFetch, timeoutMs = 15000 } = opts;

  try {
    const res = await fetchImpl(url, {
      timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.3.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok) {
      return {
        url, title: null, content: null, truncated: false,
        error: `${res.status} ${res.statusText}`,
      };
    }

    const html = await res.text();
    let dom;
    try {
      dom = new JSDOM(html, { url });
    } catch (e) {
      return { url, title: null, content: null, truncated: false, error: `jsdom parse failed: ${e.message}` };
    }

    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length === 0) {
      return { url, title: null, content: null, truncated: false, error: 'Readability parse returned no content' };
    }

    const raw = article.textContent.trim();
    const { content, truncated } = truncateAtBoundary(raw, maxChars);
    return {
      url,
      title: article.title || null,
      content,
      truncated,
      // readabilityFetch hits the real target URL directly (not a proxy), so
      // curl's effective URL is a reliable post-redirect identity signal.
      _finalUrl: res.finalUrl ?? null,
    };
  } catch (err) {
    return {
      url, title: null, content: null, truncated: false,
      error: String(err.message || err),
    };
  }
}
