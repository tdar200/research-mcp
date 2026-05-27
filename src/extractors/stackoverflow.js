import { curlFetch } from '../http.js';

const API_BASE = 'https://api.stackexchange.com/2.3';

/**
 * Fetch a Stack Overflow question + top answers via the Stack Exchange API.
 *
 * URL pattern: stackoverflow.com/questions/{id}/...
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function stackoverflowExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  const match = url.match(/stackoverflow\.com\/questions\/(\d+)/i);
  if (!match) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized SO URL pattern' };
  }
  const id = match[1];

  const headers = { 'User-Agent': 'research-mcp/0.3.0', 'Accept': 'application/json' };
  const filter = 'withbody';

  const [qRes, aRes] = await Promise.all([
    fetchImpl(`${API_BASE}/questions/${id}?site=stackoverflow&filter=${filter}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/questions/${id}/answers?site=stackoverflow&filter=${filter}&order=desc&sort=votes`, { headers, timeoutMs: 15000 }),
  ]);

  if (!qRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `SO question ${qRes.status}` };
  }

  let qData;
  try {
    qData = JSON.parse(await qRes.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `SO JSON parse failed: ${e.message}` };
  }

  const q = qData.items?.[0];
  if (!q) {
    return { url, title: null, content: null, truncated: false, error: 'question not found' };
  }

  let answers = [];
  if (aRes.ok) {
    try {
      const aData = JSON.parse(await aRes.text());
      answers = aData.items || [];
    } catch { /* skip */ }
  }

  const lines = [
    `# ${q.title}`,
    `**Score:** ${q.score} · **Views:** ${q.view_count} · **Tags:** ${(q.tags || []).join(', ')}`,
    '',
    htmlToMd(q.body || ''),
    '',
    '## Top Answers',
  ];

  answers.slice(0, 3).forEach((a, i) => {
    const acceptedMarker = a.is_accepted ? '✓ accepted, ' : '';
    lines.push('', `### Answer ${i + 1} (${acceptedMarker}score ${a.score})`, htmlToMd(a.body || ''));
  });

  const md = lines.join('\n');
  const truncated = md.length > maxChars;
  return {
    url,
    title: q.title,
    content: truncated ? md.slice(0, maxChars) : md,
    truncated,
    extractor: 'stackoverflow',
  };
}

/** Minimal HTML → markdown for SO answer bodies (which are clean HTML). */
function htmlToMd(html) {
  return html
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code>([^<]+)<\/code>/gi, '`$1`')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
