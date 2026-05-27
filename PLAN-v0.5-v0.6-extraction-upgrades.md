# research-mcp v0.5.0 + v0.6.0 — Extraction Quality Upgrades

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dramatically improve content extraction quality across two releases. v0.5.0 adds JSON-LD/Open Graph parsing + fixes Jina to use proper noise-stripping headers (no new infra). v0.6.0 adds Crawl4AI as a standalone Docker service in the smartFetch cascade, giving real JS rendering and anti-bot capabilities.

**Architecture:** Two new layers in `smartFetch`. JSON-LD parser fires first (after site-specific extractors) — cheap, fast, deterministic, wins on e-commerce/news. Jina with proper headers becomes effective for articles/docs. Crawl4AI runs as a separate Docker container (like SearXNG already does) — accessed via REST on localhost:11235, used as 4th-tier fallback for JS-heavy/anti-bot pages.

**Tech Stack:** No new npm deps for v0.5.0. v0.6.0 adds Crawl4AI Docker image (no Node dep — REST client only).

**Plan location override:** Same as prior — kept with the tool at `~/Projects/research-mcp/`.

**Existing repo state:** On `main`, last tag `v0.4.0` (commit `30d0bdc`), 118/118 tests pass, SearXNG container running.

---

## File Structure

```
src/
├── jsonld.js              # NEW (v0.5.0) — parse <script type="application/ld+json"> + <meta og:*> from HTML
├── crawl4ai.js            # NEW (v0.6.0) — REST client for self-hosted Crawl4AI on localhost:11235
├── fetch.js               # Modified — jinaFetch gets proper headers; smartFetch cascade grows two stages
├── (other files unchanged)

test/
├── jsonld.test.js         # NEW (v0.5.0)
├── crawl4ai.test.js       # NEW (v0.6.0)
├── fetch.test.js          # Modified — add Jina header test + JSON-LD integration + Crawl4AI integration
├── smartFetch.test.js     # Modified — cover new cascade steps

scripts/
├── smoke-crawl4ai.js      # NEW (v0.6.0) — live verification once Docker is up

docker-compose.yml         # Modified (v0.6.0) — add crawl4ai service alongside searxng
package.json               # Modified — bump version, add crawl4ai:* npm scripts
SPEC.md                    # Modified — add v0.5.0 + v0.6.0 sections
README.md                  # Modified — document JSON-LD layer, Crawl4AI setup, updated cascade
```

**smartFetch cascade after both releases:**

```
smartFetch(url):
  1. Cache hit?                                     (v0.2.0)  → return
  2. URL-pattern extractor (GitHub/NPM/SO/MDN)?     (v0.3.0)  → on success return
  3. ★ JSON-LD / Open Graph parser (NEW v0.5.0)              → on Product/Article hit, return
  4. Jina Reader with X-Target/X-Remove headers (FIXED v0.5.0) → on success return
  5. ★ Crawl4AI on localhost:11235 (NEW v0.6.0, if reachable) → on success return
  6. Mozilla Readability (v0.3.0)                              → on success return
  7. Aggregated error
```

---

# 🎯 v0.5.0 — JSON-LD + Open Graph + Jina header fix

## Task 0: SPEC + version bump

**Files:**
- Modify: `~/Projects/research-mcp/SPEC.md`
- Modify: `~/Projects/research-mcp/package.json`

- [ ] **Step 1: Append v0.5.0 section to SPEC.md**

Insert after the `## v0.4.0 — Source + time range filters` section, before `## Non-goals (deferred to Tier 2+)`:

```markdown
## v0.5.0 — JSON-LD/Open Graph extractor + Jina header improvements

Two complementary content-extraction upgrades:

### JSON-LD / Open Graph parser (`src/jsonld.js`)

A new extractor that runs **before** Jina Reader in `smartFetch`. Parses the raw HTML for two universally-embedded sources of structured page data:

1. **`<script type="application/ld+json">`** — Schema.org structured data (Product, Article, NewsArticle, etc.). Used by ~80% of e-commerce and news sites globally for SEO.
2. **`<meta property="og:*">`** — Open Graph tags (`og:title`, `og:description`, `og:image`, `og:price:amount`, `og:price:currency`).

Output shape:
```
{
  url,
  title,
  content,         // description from JSON-LD or og:description
  truncated: false,
  price,           // when Product schema present
  currency,        // when Product schema present
  image,           // og:image
  author,          // Article author
  datePublished,   // Article datePublished
  schemaType,      // 'Product' | 'Article' | 'NewsArticle' | etc.
  extractor: 'jsonld'
}
```

Returns `{content: null, error: 'no structured data found'}` if neither JSON-LD nor useful Open Graph tags are present — `smartFetch` falls through to next stage.

**Why this matters:** solves the "extracting product prices buried under nav chrome" problem (Vmart.pk, Daraz, etc.) deterministically — no heuristics, no LLM, just `JSON.parse()`. Tonight's WD Elements 4TB price was extractable in 100ms via this approach when 30,000 chars of Jina output couldn't surface it.

### Jina Reader header improvements (`src/fetch.js`)

`jinaFetch` now sends these HTTP headers to Jina's API by default:

- `X-Remove-Selector: header, nav, footer, .announcement, .announcement-bar, .popup, .cookie-banner, .modal, [class*="banner"]` — strips noise before extraction
- `X-Target-Selector: article, main, [itemtype], .product-detail, .post-content, .markdown-body` — focuses extraction on likely-main-content selectors (Jina returns content matching ANY of these if present, else full page)
- `X-Return-Format: markdown` (explicit, was default but now sent)

These map to documented Jina Reader parameters at https://jina.ai/reader/. Result: dramatically less noise on e-commerce and modern marketing pages where header/nav/banner content dominates DOM order.

### Updated smartFetch cascade

```
smartFetch(url):
  1. Cache check
  2. URL-pattern extractor (GitHub/NPM/SO/MDN)
  3. ★ NEW: JSON-LD / Open Graph parser
  4. Jina Reader (with new headers)
  5. Mozilla Readability fallback
  6. Aggregated error
```
```

- [ ] **Step 2: Bump package.json**

Edit `~/Projects/research-mcp/package.json`, change `"version": "0.4.0"` to `"version": "0.5.0"`. No other changes yet.

- [ ] **Step 3: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "chore: v0.5.0 spec — JSON-LD/Open Graph extractor + Jina header fix"
```

---

## Task 1: JSON-LD / Open Graph parser (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/jsonld.test.js`
- Create: `~/Projects/research-mcp/src/jsonld.js`

- [ ] **Step 1: Write failing tests**

Create `test/jsonld.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredData } from '../src/jsonld.js';

test('parseStructuredData extracts Product price from JSON-LD', () => {
  const html = `<!DOCTYPE html>
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "Product",
  "name": "Test Product",
  "description": "A great test product",
  "image": "https://example.com/img.jpg",
  "offers": {
    "@type": "Offer",
    "price": "16490.00",
    "priceCurrency": "PKR"
  }
}
</script>
</head><body><h1>Test Page</h1></body></html>`;

  const result = parseStructuredData(html, 'https://example.com/p');
  assert.equal(result.title, 'Test Product');
  assert.equal(result.price, '16490.00');
  assert.equal(result.currency, 'PKR');
  assert.equal(result.image, 'https://example.com/img.jpg');
  assert.equal(result.schemaType, 'Product');
  assert.match(result.content, /great test product/);
});

test('parseStructuredData extracts Article metadata from JSON-LD', () => {
  const html = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Breaking News Title",
  "description": "The article description",
  "author": { "@type": "Person", "name": "Jane Doe" },
  "datePublished": "2026-05-27T10:00:00Z",
  "image": "https://example.com/hero.jpg"
}
</script></head><body></body></html>`;

  const result = parseStructuredData(html, 'https://example.com/a');
  assert.equal(result.title, 'Breaking News Title');
  assert.match(result.content, /article description/);
  assert.equal(result.author, 'Jane Doe');
  assert.equal(result.datePublished, '2026-05-27T10:00:00Z');
  assert.equal(result.schemaType, 'Article');
});

test('parseStructuredData falls back to Open Graph when no JSON-LD', () => {
  const html = `<html><head>
<meta property="og:title" content="OG Title">
<meta property="og:description" content="OG description text">
<meta property="og:image" content="https://example.com/og.jpg">
<meta property="og:price:amount" content="2999">
<meta property="og:price:currency" content="USD">
</head><body></body></html>`;

  const result = parseStructuredData(html, 'https://example.com/og');
  assert.equal(result.title, 'OG Title');
  assert.match(result.content, /OG description text/);
  assert.equal(result.image, 'https://example.com/og.jpg');
  assert.equal(result.price, '2999');
  assert.equal(result.currency, 'USD');
});

test('parseStructuredData prefers JSON-LD over Open Graph when both present', () => {
  const html = `<html><head>
<meta property="og:title" content="OG Title">
<script type="application/ld+json">
{"@type": "Product", "name": "LD Title", "offers": {"price": "100", "priceCurrency": "USD"}}
</script>
</head><body></body></html>`;

  const result = parseStructuredData(html, 'https://example.com/x');
  assert.equal(result.title, 'LD Title');
  assert.equal(result.price, '100');
});

test('parseStructuredData handles nested offers (offers as array)', () => {
  const html = `<html><head><script type="application/ld+json">
{"@type":"Product","name":"P","offers":[{"@type":"Offer","price":"50","priceCurrency":"USD"}]}
</script></head></html>`;

  const result = parseStructuredData(html, 'https://example.com');
  assert.equal(result.price, '50');
  assert.equal(result.currency, 'USD');
});

test('parseStructuredData handles AggregateOffer (lowPrice/highPrice)', () => {
  const html = `<html><head><script type="application/ld+json">
{"@type":"Product","name":"P","offers":{"@type":"AggregateOffer","lowPrice":"10","highPrice":"20","priceCurrency":"EUR"}}
</script></head></html>`;

  const result = parseStructuredData(html, 'https://example.com');
  assert.equal(result.price, '10'); // takes lowPrice
  assert.equal(result.currency, 'EUR');
});

test('parseStructuredData returns null result when no structured data present', () => {
  const html = `<html><head><title>Plain HTML</title></head><body><p>nothing here</p></body></html>`;
  const result = parseStructuredData(html, 'https://example.com');
  assert.equal(result.content, null);
  assert.match(result.error, /no structured data/i);
});

test('parseStructuredData handles malformed JSON-LD gracefully (falls back to OG)', () => {
  const html = `<html><head>
<script type="application/ld+json">{ this is not valid json </script>
<meta property="og:title" content="OG Fallback">
<meta property="og:description" content="OG content">
</head></html>`;

  const result = parseStructuredData(html, 'https://example.com');
  assert.equal(result.title, 'OG Fallback');
  assert.match(result.content, /OG content/);
});

test('parseStructuredData handles @graph wrapper (common Schema.org pattern)', () => {
  const html = `<html><head><script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {"@type": "WebPage", "name": "Page"},
    {"@type": "Product", "name": "Graphed Product", "offers": {"price": "75", "priceCurrency": "USD"}}
  ]
}
</script></head></html>`;

  const result = parseStructuredData(html, 'https://example.com');
  assert.equal(result.title, 'Graphed Product');
  assert.equal(result.price, '75');
});

test('parseStructuredData includes truncated:false and url in result', () => {
  const html = `<html><head><meta property="og:title" content="T"><meta property="og:description" content="D"></head></html>`;
  const result = parseStructuredData(html, 'https://my.url/p');
  assert.equal(result.url, 'https://my.url/p');
  assert.equal(result.truncated, false);
  assert.equal(result.extractor, 'jsonld');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/jsonld.test.js 2>&1 | tail -5
```
Expected: FAIL with `Cannot find module '../src/jsonld.js'`.

- [ ] **Step 3: Implement jsonld.js**

Create `src/jsonld.js`:

```js
import { load } from 'cheerio';

/**
 * Parse <script type="application/ld+json"> and <meta property="og:*"> tags
 * from raw HTML. Returns structured data when found.
 *
 * @param {string} html - raw HTML
 * @param {string} url - source URL (passed through to result)
 * @returns {{url, title, content, truncated, price?, currency?, image?, author?, datePublished?, schemaType?, extractor: 'jsonld', error?}}
 */
export function parseStructuredData(html, url) {
  if (!html || typeof html !== 'string') {
    return { url, title: null, content: null, truncated: false, error: 'empty html', extractor: 'jsonld' };
  }

  const $ = load(html);

  // Try JSON-LD first
  const ldResult = tryJsonLd($);
  // Try Open Graph as fallback (or augmentation)
  const ogResult = tryOpenGraph($);

  // Prefer JSON-LD, augment missing fields from OG
  const merged = {
    url,
    title: ldResult.title ?? ogResult.title ?? null,
    content: ldResult.content ?? ogResult.content ?? null,
    truncated: false,
    extractor: 'jsonld',
  };

  if (ldResult.price ?? ogResult.price) merged.price = ldResult.price ?? ogResult.price;
  if (ldResult.currency ?? ogResult.currency) merged.currency = ldResult.currency ?? ogResult.currency;
  if (ldResult.image ?? ogResult.image) merged.image = ldResult.image ?? ogResult.image;
  if (ldResult.author) merged.author = ldResult.author;
  if (ldResult.datePublished) merged.datePublished = ldResult.datePublished;
  if (ldResult.schemaType) merged.schemaType = ldResult.schemaType;

  if (!merged.title && !merged.content) {
    return { url, title: null, content: null, truncated: false, error: 'no structured data found', extractor: 'jsonld' };
  }
  return merged;
}

/** Extract from JSON-LD blocks. Handles @graph wrapper and arrays. */
function tryJsonLd($) {
  const result = {};
  const blocks = $('script[type="application/ld+json"]').toArray();
  for (const el of blocks) {
    const raw = $(el).text();
    if (!raw || !raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = flattenGraph(parsed);
    for (const item of items) {
      const t = item['@type'];
      if (!t) continue;
      const typeStr = Array.isArray(t) ? t[0] : t;
      if (typeStr === 'Product') {
        result.title ??= item.name;
        result.content ??= item.description;
        result.image ??= pickImage(item.image);
        result.schemaType = 'Product';
        const offer = pickOffer(item.offers);
        if (offer) {
          result.price ??= offer.price;
          result.currency ??= offer.currency;
        }
        break; // first Product wins
      }
      if (typeStr === 'Article' || typeStr === 'NewsArticle' || typeStr === 'BlogPosting') {
        result.title ??= item.headline ?? item.name;
        result.content ??= item.description;
        result.image ??= pickImage(item.image);
        result.author ??= pickAuthor(item.author);
        result.datePublished ??= item.datePublished;
        result.schemaType = typeStr;
        break;
      }
    }
    if (result.title || result.content) break;
  }
  return result;
}

/** Flatten {@graph: [...]} or array or single object into a list of items. */
function flattenGraph(node) {
  if (Array.isArray(node)) return node.flatMap(flattenGraph);
  if (node && typeof node === 'object') {
    if (Array.isArray(node['@graph'])) return node['@graph'].flatMap(flattenGraph);
    return [node];
  }
  return [];
}

/** Offers can be a single object, array, or AggregateOffer. */
function pickOffer(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (!o) continue;
    if (o['@type'] === 'AggregateOffer' && o.lowPrice) {
      return { price: String(o.lowPrice), currency: o.priceCurrency };
    }
    if (o.price !== undefined) {
      return { price: String(o.price), currency: o.priceCurrency };
    }
  }
  return null;
}

function pickImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return typeof image[0] === 'string' ? image[0] : image[0]?.url;
  if (image.url) return image.url;
  return null;
}

function pickAuthor(author) {
  if (!author) return null;
  if (typeof author === 'string') return author;
  if (Array.isArray(author)) return author[0]?.name ?? null;
  return author.name ?? null;
}

/** Extract from <meta property="og:*"> tags. */
function tryOpenGraph($) {
  const get = (prop) => $(`meta[property="${prop}"]`).attr('content') ?? null;
  const result = {};
  const title = get('og:title');
  const description = get('og:description');
  if (title) result.title = title;
  if (description) result.content = description;
  const image = get('og:image');
  if (image) result.image = image;
  const price = get('og:price:amount');
  const currency = get('og:price:currency');
  if (price) result.price = price;
  if (currency) result.currency = currency;
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/jsonld.test.js 2>&1 | tail -15
```
Expected: 10/10 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(jsonld): JSON-LD + Open Graph parser for Product/Article structured data"
```

---

## Task 2: Jina header improvements (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/fetch.js`
- Modify: `~/Projects/research-mcp/test/fetch.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/fetch.test.js`:

```js
test('jinaFetch sends X-Remove-Selector header to strip nav/header/banner noise', async () => {
  let capturedHeaders = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, statusText: 'OK', text: async () => 'content' };
  });
  await jinaFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.ok(capturedHeaders['X-Remove-Selector'], 'X-Remove-Selector header should be sent');
  assert.match(capturedHeaders['X-Remove-Selector'], /header/);
  assert.match(capturedHeaders['X-Remove-Selector'], /footer/);
  assert.match(capturedHeaders['X-Remove-Selector'], /nav/);
});

test('jinaFetch sends X-Target-Selector header to focus extraction', async () => {
  let capturedHeaders = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, statusText: 'OK', text: async () => 'content' };
  });
  await jinaFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.ok(capturedHeaders['X-Target-Selector'], 'X-Target-Selector header should be sent');
  assert.match(capturedHeaders['X-Target-Selector'], /article|main/);
});

test('jinaFetch sends X-Return-Format header', async () => {
  let capturedHeaders = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, statusText: 'OK', text: async () => 'content' };
  });
  await jinaFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(capturedHeaders['X-Return-Format'], 'markdown');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/fetch.test.js 2>&1 | tail -8
```
Expected: 8 pre-existing pass; 3 new fail (headers not sent).

- [ ] **Step 3: Update jinaFetch to send the new headers**

Find this block in `src/fetch.js`:

```js
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: { 'Accept': 'text/markdown' },
      timeoutMs,
    });
```

Replace with:

```js
    const res = await fetchImpl(`${JINA_BASE}${url}`, {
      headers: {
        'Accept': 'text/markdown',
        'X-Return-Format': 'markdown',
        'X-Remove-Selector': 'header, nav, footer, .announcement, .announcement-bar, .popup, .cookie-banner, .modal, [class*="banner"]',
        'X-Target-Selector': 'article, main, [itemtype], .product-detail, .post-content, .markdown-body',
      },
      timeoutMs,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/fetch.test.js 2>&1 | tail -8
```
Expected: 11/11 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(fetch): Jina sends X-Remove-Selector + X-Target-Selector + X-Return-Format headers"
```

---

## Task 3: Wire JSON-LD into smartFetch cascade (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/fetch.js`
- Modify: `~/Projects/research-mcp/test/smartFetch.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/smartFetch.test.js`:

```js
test('smartFetch tries JSON-LD parser between extractor and Jina', async () => {
  const extractorImpl = { name: 'fake', extract: mock.fn(async () => ({ url: 'u', content: null, error: 'no match' })) };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', title: 'JSON-LD title', content: 'JSON-LD body', truncated: false, schemaType: 'Product', extractor: 'jsonld' }));
  const jinaImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://example.com/p', {
    extractorImpl, jsonldImpl, jinaImpl, readabilityImpl,
  });
  assert.equal(result.content, 'JSON-LD body');
  assert.equal(result.schemaType, 'Product');
});

test('smartFetch falls through to Jina when JSON-LD returns no data', async () => {
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no structured data found' }));
  const jinaImpl = mock.fn(async () => ({ url: 'u', title: 'Jina', content: 'Jina body', truncated: false }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });

  const result = await smartFetch('https://example.com/p', { jsonldImpl, jinaImpl, readabilityImpl });
  assert.equal(result.content, 'Jina body');
  assert.equal(jsonldImpl.mock.calls.length, 1);
  assert.equal(jinaImpl.mock.calls.length, 1);
});

test('smartFetch caches JSON-LD result like any other strategy', async () => {
  const fakeCache = { get: mock.fn(() => null), set: mock.fn() };
  const jsonldImpl = mock.fn(async () => ({ url: 'u', title: 'T', content: 'body', truncated: false }));

  await smartFetch('https://example.com/p', { jsonldImpl, cache: fakeCache, ttlMs: 60_000 });
  assert.equal(fakeCache.set.mock.calls.length, 1);
  assert.equal(fakeCache.set.mock.calls[0].arguments[0].tool, 'fetch_url');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/smartFetch.test.js 2>&1 | tail -8
```
Expected: pre-existing pass; 3 new fail (`jsonldImpl` not supported).

- [ ] **Step 3: Update smartFetch to call JSON-LD between extractor and Jina**

In `src/fetch.js`, add this import near the existing imports (top of file):

```js
import { parseStructuredData } from './jsonld.js';
```

Replace the `smartFetch` function with this updated version (changes: accept `jsonldImpl` opt, add new step between extractor and jina):

```js
export async function smartFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    cache,
    ttlMs,
    fetchImpl,
    disableExtractors = false,
    extractorImpl,
    jsonldImpl = defaultJsonldFetch,
    jinaImpl = jinaFetch,
    readabilityImpl = readabilityFetch,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const attempts = [];

  if (!disableExtractors) {
    const extractor = extractorImpl || findExtractor(url);
    if (extractor) {
      const r = await extractor.extract(url, { maxChars, fetchImpl });
      attempts.push({ method: extractor.name, error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    }
  }

  // NEW v0.5.0: JSON-LD / Open Graph parser
  {
    const r = await jsonldImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jsonld', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  {
    const r = await jinaImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jina', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  {
    const r = await readabilityImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'readability', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  return {
    url, title: null, content: null, truncated: false,
    error: `all strategies failed: ${attempts.map(a => `${a.method}=${a.error || 'no content'}`).join('; ')}`,
  };
}

/** Default jsonldImpl: fetches HTML via curl, then parses for JSON-LD/OG. */
async function defaultJsonldFetch(url, opts = {}) {
  const { fetchImpl = curlFetch } = opts;
  try {
    const res = await fetchImpl(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-mcp/0.5.0)' },
    });
    if (!res.ok) {
      return { url, title: null, content: null, truncated: false, error: `${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    return parseStructuredData(html, url);
  } catch (err) {
    return { url, title: null, content: null, truncated: false, error: String(err.message || err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: all tests pass (was 118 + 10 jsonld + 3 jina headers + 3 smartFetch jsonld = 134).

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(fetch): smartFetch routes through JSON-LD parser before Jina"
```

---

## Task 4: v0.5.0 README + tag

**Files:**
- Modify: `~/Projects/research-mcp/README.md`
- Modify: `~/Projects/research-mcp/src/server.js` (banner update)

- [ ] **Step 1: Update README — document JSON-LD layer + updated cascade**

Find this section in `README.md` (the "Content extraction strategy" block):

```
### Content extraction strategy (per URL)

`fetch_url` and `search_and_read` internally use `smartFetch`:

1. **URL matches registered pattern?**
   - `github.com/X/Y` → GitHub API (repo README + metadata)
   ...
2. **Fall through to Jina Reader** (handles JS-rendered pages)
3. **Fall through to `@mozilla/readability` + jsdom** (local extraction, no external dep)
4. **All three failed** → aggregated error
```

Replace with:

```
### Content extraction strategy (per URL)

`fetch_url` and `search_and_read` internally use `smartFetch`:

1. **URL matches registered site-specific extractor?**
   - `github.com/X/Y` → GitHub API (repo README + metadata)
   - `github.com/X/Y/issues/N` or `/pull/N` → GitHub API (issue + top comments)
   - `npmjs.com/package/X` → npm registry (package metadata + README)
   - `stackoverflow.com/questions/N` → Stack Exchange API (Q + top 3 answers)
   - `developer.mozilla.org/...` → MDN cheerio (.main-page-content)
   - → on success return

2. **JSON-LD / Open Graph parser** (v0.5.0)
   - Parses `<script type="application/ld+json">` for Product / Article / NewsArticle schemas
   - Falls back to `<meta property="og:*">` Open Graph tags
   - Returns clean `{title, content, price, currency, image, author, datePublished}` when found
   - Cheap (no headless browser), deterministic, wins on e-commerce + news + most modern sites

3. **Jina Reader** with proper noise-stripping headers (v0.5.0)
   - `X-Remove-Selector` strips nav/header/footer/banners
   - `X-Target-Selector` focuses on article/main/product-detail
   - Handles JS-rendered pages

4. **`@mozilla/readability` + jsdom** (local extraction, no external dep)

5. **All failed** → aggregated error
```

- [ ] **Step 2: Update server.js banner**

Find:
```js
process.stderr.write(`[research-mcp] v0.4.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

Replace with:
```js
process.stderr.write(`[research-mcp] v0.5.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

Find:
```js
const server = new Server(
  { name: 'research-mcp', version: '0.4.0' },
  { capabilities: { tools: {} } }
);
```

Replace with:
```js
const server = new Server(
  { name: 'research-mcp', version: '0.5.0' },
  { capabilities: { tools: {} } }
);
```

- [ ] **Step 3: Live verify with real Vmart URL (the test case that failed earlier)**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && cat > /tmp/test-jsonld.mjs <<'EOF'
import { parseStructuredData } from '/home/tahseen-dar/Projects/research-mcp/src/jsonld.js';
import { curlFetch } from '/home/tahseen-dar/Projects/research-mcp/src/http.js';
const url = 'https://vmart.pk/products/western-digital-elements-4tb-usb-3-0-portable-external-hard-drive-pakistan';
const res = await curlFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 15000 });
const html = await res.text();
console.log(JSON.stringify(parseStructuredData(html, url), null, 2));
EOF
timeout 30 node /tmp/test-jsonld.mjs 2>&1 | head -30
```
Expected: prints `{title: "...", price: "16490.00" or similar, currency: "PKR", schemaType: "Product", ...}` — the exact data we couldn't extract earlier via Jina.

- [ ] **Step 4: Commit + tag v0.5.0**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "docs: v0.5.0 README + server banner; live-verified JSON-LD on real e-commerce" && git tag v0.5.0 && git log --oneline | head -7
```

- [ ] **Step 5: Verify still connected**

```bash
claude mcp list | grep research-mcp
```
Expected: `✓ Connected`.

---

# 🐳 v0.6.0 — Crawl4AI standalone Docker service

## Task 5: Add Crawl4AI to docker-compose + SPEC + version bump

**Files:**
- Modify: `~/Projects/research-mcp/docker-compose.yml`
- Modify: `~/Projects/research-mcp/SPEC.md`
- Modify: `~/Projects/research-mcp/package.json`

- [ ] **Step 1: Add crawl4ai service to docker-compose.yml**

Append to `~/Projects/research-mcp/docker-compose.yml` after the existing `searxng` service:

```yaml
  crawl4ai:
    image: unclecode/crawl4ai:latest
    container_name: research-mcp-crawl4ai
    restart: unless-stopped
    ports:
      - "11235:11235"
    shm_size: "3gb"
    environment:
      - INSTALL_TYPE=basic
    logging:
      driver: "json-file"
      options:
        max-size: "5m"
        max-file: "2"
```

- [ ] **Step 2: Add npm scripts**

Edit `~/Projects/research-mcp/package.json`:

Find the `"scripts"` object. Add three new scripts after the existing `searxng:*` entries:

```json
    "crawl4ai:up": "docker compose up -d crawl4ai",
    "crawl4ai:down": "docker compose stop crawl4ai",
    "crawl4ai:logs": "docker compose logs -f crawl4ai",
```

Bump `"version"` to `"0.6.0"`.

- [ ] **Step 3: Append v0.6.0 section to SPEC.md**

Insert after the `## v0.5.0` section, before `## Non-goals`:

```markdown
## v0.6.0 — Crawl4AI standalone Docker service

Adds [Crawl4AI](https://github.com/unclecode/crawl4ai) (66k+ ⭐, Apache 2.0) as a standalone Docker service on `localhost:11235`, accessed via its REST API. Used as the 5th-tier fallback in `smartFetch` — after Jina, before Mozilla Readability — for JS-heavy SPAs and anti-bot-protected pages that defeat lighter extractors.

**Why a separate service, not bundled into our MCP:** Crawl4AI on port 11235 is generally useful beyond MCP context — any CLI script, agent, or other app can call its REST API. Same pattern as SearXNG already follows. Keeps research-mcp as the smart router; Crawl4AI is one of the engines.

**Resource cost (verified from docs.crawl4ai.com):** min 1GB RAM, recommended 4GB. Disk +500MB (Chromium binaries). Cold-start adds ~2-3s to first request; warm browser pool keeps subsequent requests fast.

**Configuration:**

- `CRAWL4AI_URL` — base URL (default `http://localhost:11235`)
- `DISABLE_CRAWL4AI=1` — skip Crawl4AI in smartFetch even if reachable

**smartFetch cascade (final):**

```
1. Cache check
2. URL-pattern extractor (GitHub/NPM/SO/MDN)
3. JSON-LD / Open Graph parser
4. Jina Reader (with stripping headers)
5. ★ Crawl4AI (if reachable, JS rendering + anti-bot)
6. Mozilla Readability fallback
```

**Setup:**

```bash
cd ~/Projects/research-mcp
docker compose up -d crawl4ai
# Verify
curl http://localhost:11235/health
# UI playground (optional)
open http://localhost:11235/playground
```
```

- [ ] **Step 4: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "chore: v0.6.0 spec + docker-compose adds Crawl4AI service"
```

---

## Task 6: Crawl4AI REST client (TDD)

**Files:**
- Create: `~/Projects/research-mcp/test/crawl4ai.test.js`
- Create: `~/Projects/research-mcp/src/crawl4ai.js`

- [ ] **Step 1: Write failing tests**

Create `test/crawl4ai.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { crawl4aiFetch, isCrawl4aiReachable } from '../src/crawl4ai.js';

function mockOk(body) {
  return mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function mockFail(status = 500) {
  return mock.fn(async () => ({
    ok: false, status, statusText: 'Err', text: async () => '',
  }));
}

test('crawl4aiFetch posts URL to /crawl and returns normalized result', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedUrl = url;
    capturedBody = opts.body;
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({
        results: [{
          url: 'https://example.com',
          success: true,
          markdown: '# Hello\n\nClean markdown content here.',
          html: '<html>...</html>',
        }],
      }),
    };
  });

  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.url, 'https://example.com');
  assert.ok(result.content);
  assert.match(result.content, /Clean markdown content/);
  assert.equal(result.truncated, false);
  assert.match(capturedUrl, /\/crawl$/);
  assert.match(capturedBody, /https:\/\/example\.com/);
});

test('crawl4aiFetch truncates content beyond max_chars', async () => {
  const longMd = 'x'.repeat(5000);
  const fakeFetch = mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ results: [{ url: 'u', success: true, markdown: longMd }] }),
  }));
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch, maxChars: 100 });
  assert.equal(result.content.length, 100);
  assert.equal(result.truncated, true);
});

test('crawl4aiFetch handles {success:false} per-result error', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ results: [{ url: 'u', success: false, error_message: 'blocked' }] }),
  }));
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /blocked/);
});

test('crawl4aiFetch surfaces transport-level errors', async () => {
  const fakeFetch = mockFail(503);
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /503/);
});

test('crawl4aiFetch uses custom baseUrl', async () => {
  let capturedUrl = null;
  const fakeFetch = mock.fn(async (url, opts) => {
    capturedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [{ success: true, markdown: '' }] }) };
  });
  await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch, baseUrl: 'http://other:9999' });
  assert.match(capturedUrl, /^http:\/\/other:9999/);
});

test('crawl4aiFetch handles malformed JSON response', async () => {
  const fakeFetch = mockOk('not json at all');
  const result = await crawl4aiFetch('https://example.com', { fetchImpl: fakeFetch });
  assert.equal(result.content, null);
  assert.match(result.error, /JSON/i);
});

test('isCrawl4aiReachable returns true on 200', async () => {
  const fakeFetch = mockOk('{"status":"ok"}');
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), true);
});

test('isCrawl4aiReachable returns false on error', async () => {
  const fakeFetch = mock.fn(async () => { throw new Error('connection refused'); });
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), false);
});

test('isCrawl4aiReachable returns false on non-200', async () => {
  const fakeFetch = mockFail(503);
  assert.equal(await isCrawl4aiReachable('http://localhost:11235', fakeFetch), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/crawl4ai.test.js 2>&1 | tail -5
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement crawl4ai.js**

Create `src/crawl4ai.js`:

```js
import { curlFetch } from './http.js';

const DEFAULT_BASE_URL = 'http://localhost:11235';

/**
 * Fetch a URL via the local Crawl4AI Docker service.
 * Calls Crawl4AI's REST API at POST /crawl with a single URL.
 *
 * @param {string} url - target URL
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000]
 * @param {string} [opts.baseUrl='http://localhost:11235']
 * @param {function} [opts.fetchImpl=curlFetch]
 * @param {number} [opts.timeoutMs=30000] - browser-based, give it more time than Jina
 * @returns {Promise<{url, title, content, truncated, error?, extractor: 'crawl4ai'}>}
 */
export async function crawl4aiFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = curlFetch,
    timeoutMs = 30000,
  } = opts;

  const body = JSON.stringify({
    urls: [url],
    browser_config: {
      headless: true,
      browser_type: 'chromium',
    },
    crawler_config: {
      cache_mode: 'bypass',
      stream: false,
    },
  });

  try {
    const res = await fetchImpl(`${baseUrl}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body,
      timeoutMs,
    });

    if (!res.ok) {
      const excerpt = (await res.text().catch(() => '')).slice(0, 200);
      return { url, title: null, content: null, truncated: false, error: `crawl4ai ${res.status} ${res.statusText}${excerpt ? `: ${excerpt}` : ''}` };
    }

    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      return { url, title: null, content: null, truncated: false, error: `crawl4ai JSON parse failed: ${e.message}` };
    }

    const first = (json.results || [])[0];
    if (!first) {
      return { url, title: null, content: null, truncated: false, error: 'crawl4ai returned no results' };
    }
    if (first.success === false) {
      return { url, title: null, content: null, truncated: false, error: `crawl4ai: ${first.error_message || 'unknown failure'}` };
    }

    const md = first.markdown || '';
    const truncated = md.length > maxChars;
    return {
      url,
      title: first.metadata?.title || null,
      content: truncated ? md.slice(0, maxChars) : md,
      truncated,
      extractor: 'crawl4ai',
    };
  } catch (err) {
    return { url, title: null, content: null, truncated: false, error: `crawl4ai ${err.message || err}` };
  }
}

/** Liveness probe for the Crawl4AI Docker service. */
export async function isCrawl4aiReachable(baseUrl = DEFAULT_BASE_URL, fetchImpl = curlFetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { timeoutMs: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/crawl4ai.test.js 2>&1 | tail -15
```
Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(crawl4ai): REST client for localhost:11235 with reachability probe"
```

---

## Task 7: Wire Crawl4AI into smartFetch (TDD)

**Files:**
- Modify: `~/Projects/research-mcp/src/fetch.js`
- Modify: `~/Projects/research-mcp/src/server.js`
- Modify: `~/Projects/research-mcp/test/smartFetch.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/smartFetch.test.js`:

```js
test('smartFetch tries Crawl4AI between Jina and Readability when reachable', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => ({ url: 'u', title: 'C4AI', content: 'crawl4ai body', truncated: false, extractor: 'crawl4ai' }));
  const readabilityImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const reachableImpl = mock.fn(async () => true);

  const result = await smartFetch('https://example.com', {
    jsonldImpl, jinaImpl, crawl4aiImpl, readabilityImpl, crawl4aiReachableImpl: reachableImpl,
  });
  assert.equal(result.content, 'crawl4ai body');
});

test('smartFetch skips Crawl4AI when not reachable', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: 'readability body', truncated: false }));
  const jsonldImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' }));
  const reachableImpl = mock.fn(async () => false);

  const result = await smartFetch('https://example.com', {
    jsonldImpl, jinaImpl, crawl4aiImpl, readabilityImpl, crawl4aiReachableImpl: reachableImpl,
  });
  assert.equal(result.content, 'readability body');
  assert.equal(crawl4aiImpl.mock.calls.length, 0);
});

test('smartFetch skips Crawl4AI when disableCrawl4ai=true', async () => {
  const jinaImpl = mock.fn(async () => ({ url: 'u', content: null, error: 'jina failed' }));
  const crawl4aiImpl = mock.fn(async () => { throw new Error('should not be called'); });
  const readabilityImpl = mock.fn(async () => ({ url: 'u', content: 'readability body', truncated: false }));
  const reachableImpl = mock.fn(async () => true);

  const result = await smartFetch('https://example.com', {
    jinaImpl, crawl4aiImpl, readabilityImpl,
    crawl4aiReachableImpl: reachableImpl,
    disableCrawl4ai: true,
    jsonldImpl: mock.fn(async () => ({ url: 'u', content: null, error: 'no schema' })),
  });
  assert.equal(result.content, 'readability body');
  assert.equal(crawl4aiImpl.mock.calls.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && node --test test/smartFetch.test.js 2>&1 | tail -8
```
Expected: pre-existing pass; 3 new fail.

- [ ] **Step 3: Update smartFetch to include Crawl4AI stage**

In `src/fetch.js`, add imports near the top:

```js
import { crawl4aiFetch, isCrawl4aiReachable } from './crawl4ai.js';
```

Replace the smartFetch function with the updated version (changes: add `crawl4aiImpl`, `crawl4aiReachableImpl`, `disableCrawl4ai`, `crawl4aiBaseUrl` opts; insert Crawl4AI stage between Jina and Readability):

```js
export async function smartFetch(url, opts = {}) {
  const {
    maxChars = 20000,
    cache,
    ttlMs,
    fetchImpl,
    disableExtractors = false,
    disableCrawl4ai = false,
    crawl4aiBaseUrl,
    extractorImpl,
    jsonldImpl = defaultJsonldFetch,
    jinaImpl = jinaFetch,
    crawl4aiImpl = crawl4aiFetch,
    crawl4aiReachableImpl = isCrawl4aiReachable,
    readabilityImpl = readabilityFetch,
  } = opts;

  let cacheKey = null;
  if (cache && ttlMs) {
    cacheKey = cacheKeyFor('fetch_url', [url, maxChars]);
    const hit = cache.get({ cacheKey, ttlMs });
    if (hit) return hit.result;
  }

  const attempts = [];

  if (!disableExtractors) {
    const extractor = extractorImpl || findExtractor(url);
    if (extractor) {
      const r = await extractor.extract(url, { maxChars, fetchImpl });
      attempts.push({ method: extractor.name, error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    }
  }

  {
    const r = await jsonldImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jsonld', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  {
    const r = await jinaImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'jina', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  // NEW v0.6.0: Crawl4AI (only if reachable + not disabled)
  if (!disableCrawl4ai) {
    const reachable = await crawl4aiReachableImpl(crawl4aiBaseUrl || 'http://localhost:11235');
    if (reachable) {
      const r = await crawl4aiImpl(url, { maxChars, fetchImpl, baseUrl: crawl4aiBaseUrl });
      attempts.push({ method: 'crawl4ai', error: r.error });
      if (!r.error && r.content) {
        if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
        return r;
      }
    } else {
      attempts.push({ method: 'crawl4ai', error: 'not reachable' });
    }
  }

  {
    const r = await readabilityImpl(url, { maxChars, fetchImpl });
    attempts.push({ method: 'readability', error: r.error });
    if (!r.error && r.content) {
      if (cache && cacheKey) cache.set({ tool: 'fetch_url', cacheKey, query: url, params: { max_chars: maxChars }, result: r });
      return r;
    }
  }

  return {
    url, title: null, content: null, truncated: false,
    error: `all strategies failed: ${attempts.map(a => `${a.method}=${a.error || 'no content'}`).join('; ')}`,
  };
}
```

- [ ] **Step 4: Update server.js to expose env config + pass to smartFetch**

In `src/server.js`, find the env-reading block:

```js
const SEARCH_BACKEND = process.env.SEARCH_BACKEND || 'auto';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';
const DISABLE_EXTRACTORS = process.env.DISABLE_EXTRACTORS === '1';
```

Add two new lines after:

```js
const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235';
const DISABLE_CRAWL4AI = process.env.DISABLE_CRAWL4AI === '1';
```

Find the `fetch_url` handler:

```js
    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await smartFetch(url, {
        maxChars: max_chars,
        cache, ttlMs: TTL_MS,
        disableExtractors: DISABLE_EXTRACTORS,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
```

Replace with:

```js
    if (name === 'fetch_url') {
      const { url, max_chars } = FetchUrlArgs.parse(args);
      const result = await smartFetch(url, {
        maxChars: max_chars,
        cache, ttlMs: TTL_MS,
        disableExtractors: DISABLE_EXTRACTORS,
        disableCrawl4ai: DISABLE_CRAWL4AI,
        crawl4aiBaseUrl: CRAWL4AI_URL,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
```

Update version banner — find:

```js
process.stderr.write(`[research-mcp] v0.5.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

Replace with:

```js
process.stderr.write(`[research-mcp] v0.6.0 connected | db=${DB_PATH} | ttl=${TTL_HOURS}h | backend=${SEARCH_BACKEND} | searxng=${SEARXNG_URL} | crawl4ai=${CRAWL4AI_URL}${DISABLE_CRAWL4AI ? ' (DISABLED)' : ''} | extractors=${DISABLE_EXTRACTORS ? 'OFF' : 'ON'}\n`);
```

And update `Server` constructor version:

```js
const server = new Server(
  { name: 'research-mcp', version: '0.6.0' },
  { capabilities: { tools: {} } }
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -10
```
Expected: 146 tests pass (134 from v0.5.0 + 9 crawl4ai + 3 smartFetch crawl4ai).

- [ ] **Step 6: Commit**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "feat(fetch+server): wire Crawl4AI into smartFetch cascade; env-driven config"
```

---

## Task 8: Live verify + README + tag v0.6.0

**Files:**
- Create: `~/Projects/research-mcp/scripts/smoke-crawl4ai.js`
- Modify: `~/Projects/research-mcp/README.md`

- [ ] **Step 1: Pull Crawl4AI image (large — start in background)**

Run:
```bash
docker pull unclecode/crawl4ai:latest 2>&1 | tail -5
```
Expected: pulls successfully. First pull ~500MB-1GB, can take 2-5 min.

- [ ] **Step 2: Start Crawl4AI container**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && docker compose up -d crawl4ai 2>&1 | tail -5
```
Expected: `Container research-mcp-crawl4ai Started`.

Wait ~15s for Chromium to initialize, then verify:
```bash
sleep 15 && curl -sS -o /dev/null -w "Crawl4AI status=%{http_code}\n" http://localhost:11235/health
```
Expected: `status=200`.

If not 200, check logs: `docker compose logs crawl4ai | tail -50`.

- [ ] **Step 3: Create live smoke script**

Create `scripts/smoke-crawl4ai.js`:

```js
#!/usr/bin/env node
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { crawl4aiFetch, isCrawl4aiReachable } from '../src/crawl4ai.js';
import { smartFetch } from '../src/fetch.js';

console.log('— Reachability —');
const reachable = await isCrawl4aiReachable();
console.log(`Crawl4AI reachable: ${reachable}`);
if (!reachable) { console.log('Start with: docker compose up -d crawl4ai'); process.exit(1); }

const cases = [
  { label: 'simple page', url: 'https://example.com' },
  { label: 'docs site', url: 'https://docs.crawl4ai.com/' },
  { label: 'JS-heavy SPA', url: 'https://react.dev/' },
];

console.log('\n— Direct crawl4aiFetch —');
for (const c of cases) {
  process.stdout.write(`${c.label.padEnd(20)} `);
  const t0 = Date.now();
  const r = await crawl4aiFetch(c.url, { maxChars: 2000 });
  const ms = Date.now() - t0;
  if (r.error) console.log(`FAIL ${ms}ms — ${r.error.slice(0, 80)}`);
  else console.log(`OK ${ms}ms — title="${(r.title || '').slice(0, 40)}" content=${r.content.length} chars`);
}

console.log('\n— Via smartFetch (full cascade) —');
for (const c of cases) {
  process.stdout.write(`${c.label.padEnd(20)} `);
  const t0 = Date.now();
  const r = await smartFetch(c.url, { maxChars: 2000 });
  const ms = Date.now() - t0;
  if (r.error) console.log(`FAIL ${ms}ms — ${r.error.slice(0, 80)}`);
  else console.log(`OK ${ms}ms — extractor="${r.extractor || 'unknown'}" content=${r.content.length} chars`);
}
```

- [ ] **Step 4: Run smoke test**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && timeout 90 node scripts/smoke-crawl4ai.js 2>&1 | tail -20
```
Expected: reachable=true, all 3 direct cases return OK with non-empty content, all 3 smartFetch cases return OK (likely with extractor=jsonld or jina for static, crawl4ai if those fail).

- [ ] **Step 5: Update README — document Crawl4AI setup**

In `README.md`, find the existing `### One-time: start SearXNG` section. Add this section just after it:

```markdown
### Optional: start Crawl4AI for JS-heavy / anti-bot sites

```bash
cd ~/Projects/research-mcp
docker compose up -d crawl4ai
```

Verify: `curl http://localhost:11235/health` → 200.

Playground UI at `http://localhost:11235/playground` for testing crawls + tweaking configs.

Crawl4AI sits in `smartFetch` between Jina Reader and Mozilla Readability. If unreachable, it's transparently skipped — Jina/Readability handle the load.

To disable Crawl4AI even when running: set `DISABLE_CRAWL4AI=1` in env.
```

Update the "Environment variables" table — add two rows:

```markdown
| `CRAWL4AI_URL` | `http://localhost:11235` | Crawl4AI service URL |
| `DISABLE_CRAWL4AI` | unset | Set to `1` to skip Crawl4AI in smartFetch cascade |
```

Update the smartFetch cascade diagram in the architecture section to include the JSON-LD + Crawl4AI layers (5 → 6 stages).

- [ ] **Step 6: Final full-suite test**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && npm test 2>&1 | tail -8
```
Expected: 146 tests pass.

- [ ] **Step 7: Verify MCP server still boots**

Run:
```bash
cd /home/tahseen-dar/Projects/research-mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 5 node src/server.js 2>&1 | head -3
```
Expected: stderr shows `[research-mcp] v0.6.0 connected | ... | crawl4ai=http://localhost:11235 | extractors=ON`.

- [ ] **Step 8: Commit + tag v0.6.0**

```bash
cd /home/tahseen-dar/Projects/research-mcp && git add -A && git commit -m "docs: v0.6.0 README + crawl4ai smoke script + live verification" && git tag v0.6.0 && git log --oneline | head -12
```

- [ ] **Step 9: Update memory pointer**

Update `~/.claude/projects/-home-tahseen-dar-POSSystem-Inventory-System-Root/memory/project_research-mcp-tool.md`:
- Tag changes to v0.6.0
- Add JSON-LD layer + Crawl4AI service to capabilities list
- Note: `docker compose up -d crawl4ai` to enable JS-heavy/anti-bot extraction
- Update LOC + test count (~1500 LOC, 146 tests)

Also update the MEMORY.md index line to match.

---

## Self-Review

**1. Spec coverage:**
- v0.5.0 JSON-LD parser → Task 1 ✓
- v0.5.0 Open Graph fallback → Task 1 (tryOpenGraph function) ✓
- v0.5.0 Jina X-Remove-Selector/X-Target-Selector headers → Task 2 ✓
- v0.5.0 smartFetch integration of JSON-LD → Task 3 ✓
- v0.5.0 SPEC + README + tag → Tasks 0, 4 ✓
- v0.6.0 docker-compose.yml addition → Task 5 ✓
- v0.6.0 src/crawl4ai.js REST client + isCrawl4aiReachable → Task 6 ✓
- v0.6.0 smartFetch Crawl4AI tier → Task 7 ✓
- v0.6.0 env vars CRAWL4AI_URL + DISABLE_CRAWL4AI → Task 7 (server.js update) ✓
- v0.6.0 live verification smoke script → Task 8 ✓
- v0.6.0 SPEC + README + tag → Tasks 5, 8 ✓

**2. Placeholder scan:** No TBDs/TODOs. Every code block is complete and runnable.

**3. Type consistency:**
- `parseStructuredData(html, url)` — same signature in jsonld.js + jsonld.test.js + defaultJsonldFetch caller ✓
- `crawl4aiFetch(url, opts)` opts: `{maxChars, baseUrl, fetchImpl, timeoutMs}` — consistent across crawl4ai.test.js + crawl4ai.js + smartFetch caller ✓
- `isCrawl4aiReachable(baseUrl, fetchImpl)` — consistent signature ✓
- smartFetch opts: `{maxChars, cache, ttlMs, fetchImpl, disableExtractors, disableCrawl4ai, crawl4aiBaseUrl, extractorImpl, jsonldImpl, jinaImpl, crawl4aiImpl, crawl4aiReachableImpl, readabilityImpl}` — consistent in tests + impl + server.js ✓
- Result shape `{url, title, content, truncated, error?, extractor?}` — consistent across all extractors (jsonld, jina, crawl4ai, readability) and consumed correctly by smartFetch ✓
- Cache key continues to use `cacheKeyFor('fetch_url', [url, maxChars])` — unchanged from v0.2.0 ✓ (no need to add jsonld/crawl4ai to key since they're cascade stages, not separate user-facing tools)

No gaps. No inconsistencies. Plan complete.
