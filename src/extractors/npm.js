import { curlFetch } from '../http.js';
import { truncateAtBoundary } from '../truncate.js';

const REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * Fetch a package's metadata + README from the npm registry.
 *
 * URL pattern: npmjs.com/package/<pkg> or npmjs.com/package/@scope/pkg
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function npmExtractor(url, opts = {}) {
  const { fetchImpl = curlFetch, maxChars = 20000 } = opts;

  const match = url.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/(@[^\/?#]+\/[^\/?#]+|[^\/?#]+)/i);
  if (!match) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized npm package URL' };
  }
  const pkg = decodeURIComponent(match[1]);

  const res = await fetchImpl(`${REGISTRY_BASE}/${pkg}`, {
    timeoutMs: 15000,
    headers: { 'User-Agent': 'research-mcp/0.3.0', 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return { url, title: null, content: null, truncated: false, error: `npm ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `npm JSON parse failed: ${e.message}` };
  }

  const latest = data['dist-tags']?.latest ?? 'unknown';
  const version = data.versions?.[latest] ?? {};
  const author = version.author?.name || data.author?.name || 'unknown';

  const deps = Object.entries(version.dependencies || {});
  const depsBlock = deps.length
    ? deps.map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '_(none)_';

  const lines = [
    `# ${data.name} (${latest})`,
    '',
    data.description || '',
    '',
    `**Author:** ${author}`,
    `**License:** ${version.license || data.license || 'unknown'}`,
    `**Homepage:** ${data.homepage || 'n/a'}`,
    `**Repository:** ${data.repository?.url || 'n/a'}`,
    `**Keywords:** ${(data.keywords || []).join(', ') || 'none'}`,
    '',
    '## Dependencies',
    depsBlock,
    '',
    '## README',
    data.readme || version.readme || '_(no README)_',
  ];

  const md = lines.join('\n');
  const { content, truncated } = truncateAtBoundary(md, maxChars);
  return {
    url,
    title: `${data.name} (${latest})`,
    content,
    truncated,
    extractor: 'npm',
  };
}
