import { load } from 'cheerio';
import { curlFetch } from '../http.js';
import { truncateAtBoundary } from '../truncate.js';

/**
 * Fetch an MDN page directly and extract `.main-page-content` (or `<main>` fallback)
 * via cheerio. MDN HTML is highly structured so this is cheaper + more reliable than Jina.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function mdnExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  try {
    const res = await fetchImpl(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.3.0)', 'Accept': 'text/html' },
    });

    if (!res.ok) {
      return { url, title: null, content: null, truncated: false, error: `MDN ${res.status}` };
    }

    const html = await res.text();
    const $ = load(html);

    const title = $('h1').first().text().trim() || $('title').text().trim() || null;

    let $main = $('.main-page-content').first();
    if ($main.length === 0) {
      $main = $('main').first();
    }
    if ($main.length === 0) {
      return { url, title, content: null, truncated: false, error: 'MDN main content not found' };
    }

    $main.find('.notecard, .ix, .interactive-example, nav, aside, .langlist, .last-modified-date').remove();

    const raw = $main.text().replace(/\s+/g, ' ').trim();
    const { content, truncated } = truncateAtBoundary(raw, maxChars);
    return {
      url,
      title,
      content,
      truncated,
      extractor: 'mdn',
    };
  } catch (err) {
    return {
      url, title: null, content: null, truncated: false,
      error: String(err.message || err),
    };
  }
}
