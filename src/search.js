import { load } from 'cheerio';

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
export async function duckDuckGoSearch(query, numResults = 5) {
  const params = new URLSearchParams({ q: query });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo returned ${res.status}: ${res.statusText}`);
    }

    const html = await res.text();
    return parseDuckDuckGoHtml(html, numResults);
  } finally {
    clearTimeout(timeoutId);
  }
}
