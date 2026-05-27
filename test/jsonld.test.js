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
  assert.equal(result.price, '10');
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
