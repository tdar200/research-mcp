/**
 * URL-identity verification.
 *
 * After a fetcher follows redirects, the URL the browser/curl actually landed
 * on may not be the page the agent asked for. checkUrlIdentity compares the
 * requested URL against the landed URL and returns a NON-FATAL advisory note
 * when they look like genuinely different pages.
 *
 * The comparison is deliberately lenient to avoid false positives on
 * canonicalizing redirects (www-stripping, trailing slashes, query/fragment
 * churn). For Reddit specifically, the reliable identity token is the base36 id
 * in /comments/<id>/ — the human-readable slug after it is ignored by Reddit
 * and must NOT be treated as an identity change.
 */

/**
 * Normalize a URL for identity comparison.
 *   - lowercase host, strip leading 'www.'
 *   - strip trailing slash from path
 *   - ignore query string and fragment
 *   - decode %-escapes in the path where possible
 * @returns {{host: string, path: string, segments: string[]}|null}
 */
function normalize(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  let path = u.pathname || '/';
  try {
    path = decodeURIComponent(path);
  } catch {
    // leave path as-is if it contains malformed escapes
  }
  // strip trailing slash(es) but keep root as ''
  path = path.replace(/\/+$/, '');

  const segments = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
  return { host, path, segments };
}

/**
 * Reddit comment threads identify the post by a base36 id in
 * /r/<sub>/comments/<id>/<slug>/. Extract that id token if present so we can
 * compare it and ignore the slug.
 * @returns {string|null}
 */
function redditCommentId(segments) {
  const idx = segments.indexOf('comments');
  if (idx === -1) return null;
  const id = segments[idx + 1];
  if (!id) return null;
  // base36 id, typically 5-8 chars; accept any alnum token here.
  return /^[a-z0-9]+$/.test(id) ? id : null;
}

/**
 * Compare requested vs landed URL identity.
 *
 * @param {string} requestedUrl
 * @param {string} landedUrl
 * @returns {null | {requested: string, landed: string, reason: string}}
 *   null when they share identity; otherwise an advisory mismatch note.
 */
export function checkUrlIdentity(requestedUrl, landedUrl) {
  const req = normalize(requestedUrl);
  const land = normalize(landedUrl);

  // If either side can't be parsed, we have no reliable signal — don't flag.
  if (!req || !land) return null;

  if (req.host !== land.host) {
    return { requested: requestedUrl, landed: landedUrl, reason: 'host differs' };
  }

  // Reddit comment-id rule: compare the base36 id, ignore the slug.
  const reqId = redditCommentId(req.segments);
  const landId = redditCommentId(land.segments);
  if (reqId !== null && landId !== null) {
    if (reqId === landId) return null; // slug-only change is fine
    return { requested: requestedUrl, landed: landedUrl, reason: 'path identity differs' };
  }

  // Generic rule: same normalized path => same identity. Trailing-slash and
  // query/fragment differences were already normalized away.
  if (req.path === land.path) return null;

  return { requested: requestedUrl, landed: landedUrl, reason: 'path identity differs' };
}
