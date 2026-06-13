/**
 * Conservative, line-based markdown content cleaner.
 *
 * Removes ad/nav/promo boilerplate ("Promoted" ad cards, "Skip to main
 * content", login/nav chrome, cookie banners) that leaks into extracted
 * markdown — WITHOUT eating real article content.
 *
 * Core safety invariant: only SHORT lines (<= MAX_DROP_LINE_LEN) are eligible
 * for line-based removal. Real prose and headings are long; chrome is short.
 *
 * Pure function, no I/O. Fully unit-testable with fixture strings.
 */

// Only lines this short are eligible for single-line drop. Real prose/headings
// run longer than this; chrome strings ("Log In", "Skip to main content") are
// short. This is the primary guard against eating content.
export const MAX_DROP_LINE_LEN = 120;

// A runaway "Promoted" match can never consume more than this many lines, so a
// malformed page without a clean boundary still keeps the bulk of its article.
export const MAX_PROMO_BLOCK_LINES = 12;

// Exact, anchored, case-insensitive chrome patterns. Matched against the
// TRIMMED line and against a markdown-link-stripped form of the line so that
// '[Skip to main content](#main)' is caught.
export const LINE_DROP_PATTERNS = [
  /^skip to (main )?content$/i,
  /^(log ?in|sign ?in|sign ?up|register|create account)$/i,
  /^(menu|navigation|nav|breadcrumb)$/i,
  /^(home|back to top|jump to content)$/i,
  /^(accept( all)?( cookies)?|reject( all)?|manage cookies|cookie (settings|preferences))$/i,
  /^we use cookies\b/i,
  /^(share|save|report|reply|upvote|downvote|award)$/i,
  /^promoted$/i,
  /^(advertisement|sponsored|ad)$/i,
];

// A breadcrumb-ish nav line like 'Home / r/selfhosted' — a short line joined by
// a SPACED ' / ' separator (the nav convention). Requiring the spaces avoids
// eating tight technical strings like 'src/main/java', 'TCP/IP', or 'and/or'
// (whose slashes are not space-separated).
const BREADCRUMB_RE = /^.+ \/ .+$/;

const HEADING_RE = /^#{1,6}\s/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;

/** Replace '[text](url)' wrappers with just 'text' so anchored chrome matches. */
function stripMarkdownLinks(s) {
  return s.replace(MD_LINK_RE, '$1');
}

/**
 * Is this trimmed line the start of a 'Promoted' ad card? Ad labels are short;
 * a long line that merely begins with the word 'Promoted' is prose, so apply
 * the same length guard used for single-line drops.
 */
function isPromoStart(trimmed) {
  // Only a BARE ad label starts a promo block — never arbitrary prose that
  // merely begins with the word "Promoted" (e.g. "Promoted by the community…").
  // Matches 'Promoted', '[Promoted]', '![Promoted]', 'Promoted ·', etc.
  return /^!?\[?\s*promoted\s*\]?\s*[·:|-]?\s*$/i.test(trimmed);
}

/**
 * Count how many lines the Promoted block at index `start` consumes. The block
 * runs until (but NOT including) the first blank line / heading / hr boundary,
 * capped at MAX_PROMO_BLOCK_LINES.
 */
function consumePromoBlock(lines, start) {
  let n = 1; // the 'Promoted' line itself
  for (let i = start + 1; i < lines.length && n < MAX_PROMO_BLOCK_LINES; i++) {
    const t = lines[i].trim();
    if (t === '' || HEADING_RE.test(t) || HR_RE.test(t)) break; // boundary: keep it
    n++;
  }
  return n;
}

/** Does this short line match a chrome drop pattern? */
function matchesDrop(trimmed, extraPatterns) {
  const stripped = stripMarkdownLinks(trimmed).trim();
  for (const re of LINE_DROP_PATTERNS) {
    if (re.test(trimmed) || re.test(stripped)) return true;
  }
  for (const re of extraPatterns) {
    if (re.test(trimmed) || re.test(stripped)) return true;
  }
  if (BREADCRUMB_RE.test(stripped) && stripped.includes('/')) return true;
  return false;
}

/** Coarse kind label for telemetry / removedKinds. */
function kindFor(trimmed) {
  const stripped = stripMarkdownLinks(trimmed).trim();
  if (/^promoted$/i.test(stripped) || /^(advertisement|sponsored|ad)$/i.test(stripped)) return 'ad';
  if (/^skip to (main )?content$/i.test(stripped)) return 'skip';
  if (/cookie|we use cookies/i.test(stripped)) return 'cookie';
  if (/^(log ?in|sign ?in|sign ?up|register|create account)$/i.test(stripped)) return 'auth';
  if (BREADCRUMB_RE.test(stripped) && stripped.includes('/')) return 'nav';
  if (/^(menu|navigation|nav|breadcrumb|home|back to top|jump to content)$/i.test(stripped)) return 'nav';
  return 'chrome';
}

/** Collapse runs of 3+ consecutive blank lines down to a single blank line. */
function collapseBlanks(lines) {
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 1) out.push('');
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out;
}

/** Trim leading/trailing blank lines from a joined document string. */
function trimDoc(s) {
  return s.replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim();
}

/**
 * Clean ad/nav/promo boilerplate out of markdown content.
 *
 * @param {string|null} content
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true]            allow env/global disable
 * @param {RegExp[]} [opts.extraLinePatterns=[]]   caller/test-injected drop patterns
 * @returns {{content: string|null, removedLineCount: number, removedKinds: string[]}}
 */
export function cleanContent(content, opts = {}) {
  const { enabled = true, extraLinePatterns = [] } = opts;

  if (typeof content !== 'string' || content.length === 0) {
    return { content: null, removedLineCount: 0, removedKinds: [] };
  }
  if (!enabled) {
    return { content, removedLineCount: 0, removedKinds: [] };
  }

  const lines = content.split(/\r?\n/);
  const out = [];
  let removed = 0;
  const kinds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (isPromoStart(t)) {
      const n = consumePromoBlock(lines, i);
      i += n - 1;
      removed += n;
      kinds.add('promoted');
      continue;
    }

    if (t.length > 0 && t.length <= MAX_DROP_LINE_LEN && matchesDrop(t, extraLinePatterns)) {
      removed++;
      kinds.add(kindFor(t));
      continue;
    }

    out.push(line);
  }

  const joined = trimDoc(collapseBlanks(out).join('\n'));

  return {
    content: joined.length > 0 ? joined : null,
    removedLineCount: removed,
    removedKinds: [...kinds],
  };
}
