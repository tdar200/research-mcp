import { createHash } from 'node:crypto';

/**
 * Build a deterministic cache key for a tool call.
 * @param {string} tool - tool name (e.g. 'web_search')
 * @param {Array} params - ordered list of parameter values (strings/numbers)
 * @returns {string} SHA-256 hex digest
 */
export function cacheKeyFor(tool, params) {
  const h = createHash('sha256');
  h.update(tool);
  for (const p of params) {
    h.update('\x00');
    h.update(String(p));
  }
  return h.digest('hex');
}
