import { curlFetch } from '../http.js';

const API_BASE = 'https://api.github.com';

/**
 * Extract GitHub repo README + metadata, or issue/PR content + comments.
 *
 * Handles URL patterns:
 *   github.com/{owner}/{repo}          → repo README + metadata
 *   github.com/{owner}/{repo}/issues/N → issue content + top 5 comments
 *   github.com/{owner}/{repo}/pull/N   → PR (same API endpoint as issues)
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.maxChars=20000]
 * @param {string} [opts.token=process.env.GITHUB_TOKEN] - optional
 * @returns {Promise<{url, title, content, truncated, error?, extractor?}>}
 */
export async function githubExtractor(url, opts = {}) {
  const {
    fetchImpl = curlFetch,
    maxChars = 20000,
    token = process.env.GITHUB_TOKEN,
  } = opts;

  const repoMatch = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\/|$|\?|#)/i);
  if (!repoMatch) {
    return { url, title: null, content: null, truncated: false, error: 'unrecognized github URL pattern' };
  }
  const [, owner, repoRaw] = repoMatch;
  const repo = repoRaw.replace(/\.git$/i, '');

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'research-mcp/0.3.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  const issueMatch = url.match(/\/(?:issues|pull)\/(\d+)/i);
  if (issueMatch) {
    return await fetchIssue({ fetchImpl, headers, url, owner, repo, number: issueMatch[1], maxChars });
  }
  return await fetchRepoReadme({ fetchImpl, headers, url, owner, repo, maxChars });
}

async function fetchRepoReadme({ fetchImpl, headers, url, owner, repo, maxChars }) {
  const [repoRes, readmeRes] = await Promise.all([
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/readme`, { headers, timeoutMs: 15000 }),
  ]);

  if (!repoRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `repo ${repoRes.status}` };
  }

  let repoInfo;
  try {
    repoInfo = JSON.parse(await repoRes.text());
  } catch (e) {
    return { url, title: null, content: null, truncated: false, error: `repo JSON parse failed: ${e.message}` };
  }

  let readmeText = '';
  if (readmeRes.ok) {
    try {
      const readmeJson = JSON.parse(await readmeRes.text());
      if (readmeJson.content) {
        readmeText = Buffer.from(readmeJson.content, 'base64').toString('utf8');
      }
    } catch { /* skip */ }
  }

  const header = [
    `# ${repoInfo.full_name || `${owner}/${repo}`}`,
    repoInfo.description || '',
    `★ ${repoInfo.stargazers_count ?? '?'} · ${repoInfo.language || 'mixed'} · ${(repoInfo.topics || []).join(', ')}`,
    '',
    '---',
    '',
  ].join('\n');

  const full = header + readmeText;
  const truncated = full.length > maxChars;
  return {
    url,
    title: repoInfo.full_name || `${owner}/${repo}`,
    content: truncated ? full.slice(0, maxChars) : full,
    truncated,
    extractor: 'github',
  };
}

async function fetchIssue({ fetchImpl, headers, url, owner, repo, number, maxChars }) {
  const [issueRes, commentsRes] = await Promise.all([
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/issues/${number}`, { headers, timeoutMs: 15000 }),
    fetchImpl(`${API_BASE}/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`, { headers, timeoutMs: 15000 }),
  ]);

  if (!issueRes.ok) {
    return { url, title: null, content: null, truncated: false, error: `issue ${issueRes.status}` };
  }

  const issue = JSON.parse(await issueRes.text());
  const comments = commentsRes.ok ? JSON.parse(await commentsRes.text()) : [];

  const lines = [
    `# ${issue.title}`,
    `**State:** ${issue.state} · **Author:** ${issue.user?.login ?? '?'} · **Comments:** ${issue.comments ?? '?'}`,
    '',
    issue.body || '_(no description)_',
  ];

  for (const c of comments.slice(0, 5)) {
    lines.push('', '---', `**${c.user?.login ?? '?'}:**`, c.body || '');
  }

  const md = lines.join('\n');
  const truncated = md.length > maxChars;
  return {
    url,
    title: issue.title,
    content: truncated ? md.slice(0, maxChars) : md,
    truncated,
    extractor: 'github',
  };
}
