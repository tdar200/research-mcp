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
  const ldResult = tryJsonLd($);
  const ogResult = tryOpenGraph($);

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
        break;
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

function flattenGraph(node) {
  if (Array.isArray(node)) return node.flatMap(flattenGraph);
  if (node && typeof node === 'object') {
    if (Array.isArray(node['@graph'])) return node['@graph'].flatMap(flattenGraph);
    return [node];
  }
  return [];
}

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
