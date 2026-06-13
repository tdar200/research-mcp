/**
 * Boundary-aware content truncation shared by every leaf fetcher.
 *
 * Replaces the mid-token `content.slice(0, maxChars)` that was duplicated across
 * jina/readability/crawl4ai and the extractors. Cuts at the nearest preceding
 * sentence boundary within a small lookback window, else the last whitespace,
 * else a hard cut at maxChars. The returned content length is ALWAYS <= maxChars.
 *
 * @param {string|null|undefined} text - raw content to truncate
 * @param {number} maxChars - maximum length of the returned content
 * @param {{ window?: number }} [opts] - how far back (chars) we walk for a boundary
 * @returns {{ content: string|null|undefined, truncated: boolean }}
 */
export function truncateAtBoundary(text, maxChars, opts = {}) {
  const { window = 200 } = opts;

  // Defensive: total function — callers already guard but keep it total.
  if (text == null) return { content: text, truncated: false };

  // EXACT no-op when content fits — byte-identical string, no trim (L10 invariant).
  if (text.length <= maxChars) return { content: text, truncated: false };

  const hardCut = maxChars; // never exceed maxChars
  const minCut = Math.max(0, hardCut - window);
  const slice = text.slice(0, hardCut);

  let cut = -1;

  // 1) Prefer the last sentence boundary within [minCut, hardCut].
  const sentZone = slice.slice(minCut);
  const re = /[.!?](?=\s|$)/g;
  let m;
  let lastSent = -1;
  while ((m = re.exec(sentZone)) !== null) {
    lastSent = m.index + 1; // index just after the punctuation char
  }
  if (lastSent !== -1) cut = minCut + lastSent;

  // 2) Else fall back to the last whitespace within the window.
  if (cut === -1) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= minCut) cut = lastSpace;
  }

  // 3) Else (single giant token, no boundary in window) hard-cut at maxChars.
  //    Also guard a cut at/<= 0 so we never return an empty string for non-empty input.
  if (cut === -1 || cut <= 0) cut = hardCut;

  return { content: text.slice(0, cut).trimEnd(), truncated: true };
}
