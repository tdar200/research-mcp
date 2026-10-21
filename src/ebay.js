import { curlFetch } from './http.js';

// eBay Browse API client (official, keyed) — the durable answer to eBay's
// anti-bot wall, which 403s every scraping strategy in smartFetch.
// Free tier: 5,000 calls/day. Keys: https://developer.ebay.com → create app →
// production keyset → set EBAY_CLIENT_ID + EBAY_CLIENT_SECRET.

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const TOKEN_SAFETY_MS = 60_000; // refresh a minute early

const CONDITION_IDS = {
  new: 'NEW',
  used: 'USED',
  refurbished: 'CERTIFIED_REFURBISHED|SELLER_REFURBISHED',
};

/**
 * Compose the Browse API `filter` param from friendly options.
 * https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search#uri.filter
 * @param {{condition?: string, priceMin?: number, priceMax?: number, currency?: string}} opts
 * @returns {string} e.g. "conditions:{USED},price:[100..900],priceCurrency:GBP"
 */
export function buildFilterParam({ condition, priceMin, priceMax, currency = 'GBP' } = {}) {
  const parts = [];
  const ids = CONDITION_IDS[condition];
  if (ids) parts.push(`conditions:{${ids}}`);
  if (priceMin != null || priceMax != null) {
    parts.push(`price:[${priceMin ?? ''}..${priceMax ?? ''}]`, `priceCurrency:${currency}`);
  }
  return parts.join(',');
}

function normalizeItem(item) {
  const loc = item.itemLocation || {};
  const shippingCost = item.shippingOptions?.[0]?.shippingCost?.value;
  return {
    title: item.title ?? null,
    price: item.price?.value != null ? Number(item.price.value) : null,
    currency: item.price?.currency ?? null,
    condition: item.condition ?? null,
    url: item.itemWebUrl ?? null,
    seller: item.seller?.username ?? null,
    feedbackPercent: item.seller?.feedbackPercentage != null ? Number(item.seller.feedbackPercentage) : null,
    feedbackScore: item.seller?.feedbackScore ?? null,
    location: [loc.city, loc.country].filter(Boolean).join(', ') || null,
    shipping: shippingCost != null ? Number(shippingCost) : null,
  };
}

/**
 * Create an eBay Browse API client with an in-memory app token cache.
 * All I/O goes through fetchImpl (curlFetch-shaped) for testability.
 *
 * @param {{clientId?: string, clientSecret?: string, fetchImpl?: function, now?: function}} cfg
 * @returns {{search(query: string, opts?: object): Promise<{query, marketplace, total, results, error?}>}}
 */
export function createEbayClient({ clientId, clientSecret, fetchImpl = curlFetch, now = Date.now } = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && now() < tokenExpiresAt - TOKEN_SAFETY_MS) return token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      timeoutMs: 15000,
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
    });
    if (!res.ok) throw new Error(`ebay oauth ${res.status}`);
    const data = JSON.parse(await res.text());
    token = data.access_token;
    tokenExpiresAt = now() + (data.expires_in ?? 7200) * 1000;
    return token;
  }

  async function search(query, opts = {}) {
    const {
      limit = 10,
      marketplace = 'EBAY_GB',
      sort, // undefined = best match; 'price' | '-price' | 'newlyListed'
      condition,
      priceMin,
      priceMax,
      currency,
    } = opts;

    const base = { query, marketplace, total: 0, results: [] };

    if (!clientId || !clientSecret) {
      return {
        ...base,
        error:
          'eBay API credentials not configured. Create a free app at https://developer.ebay.com ' +
          '(production keyset), then set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in the research-mcp environment.',
      };
    }

    try {
      const bearer = await getToken();
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (sort) params.set('sort', sort);
      const filter = buildFilterParam({ condition, priceMin, priceMax, currency });
      if (filter) params.set('filter', filter);

      const res = await fetchImpl(`${BROWSE_URL}?${params.toString()}`, {
        timeoutMs: 15000,
        headers: {
          'Authorization': `Bearer ${bearer}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplace,
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return { ...base, error: `ebay browse ${res.status}` };

      const data = JSON.parse(await res.text());
      return {
        ...base,
        total: data.total ?? 0,
        results: (data.itemSummaries ?? []).map(normalizeItem),
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  }

  return { search };
}
