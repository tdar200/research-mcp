import { githubExtractor } from './extractors/github.js';
import { npmExtractor } from './extractors/npm.js';
import { stackoverflowExtractor } from './extractors/stackoverflow.js';
import { mdnExtractor } from './extractors/mdn.js';

const REGISTRY = [
  {
    name: 'github',
    pattern: /^https?:\/\/(?:www\.)?github\.com\/[^\/]+\/[^\/]+/i,
    extract: githubExtractor,
  },
  {
    name: 'npm',
    pattern: /^https?:\/\/(?:www\.)?npmjs\.com\/package\//i,
    extract: npmExtractor,
  },
  {
    name: 'stackoverflow',
    pattern: /^https?:\/\/(?:[a-z]+\.)?stackoverflow\.com\/questions\/\d+/i,
    extract: stackoverflowExtractor,
  },
  {
    name: 'mdn',
    pattern: /^https?:\/\/developer\.mozilla\.org\//i,
    extract: mdnExtractor,
  },
];

/** Return the first matching extractor for this URL, or null. */
export function findExtractor(url) {
  for (const e of REGISTRY) {
    if (e.pattern.test(url)) return e;
  }
  return null;
}

/** Metadata listing for debugging / introspection. */
export function listExtractors() {
  return REGISTRY.map(e => ({ name: e.name, pattern: e.pattern.source }));
}
