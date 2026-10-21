import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEbayClient, buildFilterParam } from '../src/ebay.js';

const TOKEN_RESPONSE = { access_token: 'tok-abc', expires_in: 7200, token_type: 'Application Access Token' };

const SEARCH_RESPONSE = {
  total: 2,
  itemSummaries: [
    {
      title: 'Ryzen 9 7950X Gaming PC 64GB DDR5',
      price: { value: '950.00', currency: 'GBP' },
      condition: 'Used',
      itemWebUrl: 'https://www.ebay.co.uk/itm/111',
      seller: { username: 'pcseller', feedbackPercentage: '99.1', feedbackScore: 412 },
      itemLocation: { city: 'Leeds', country: 'GB' },
      shippingOptions: [{ shippingCost: { value: '15.00', currency: 'GBP' } }],
    },
    {
      title: 'Ryzen 9 7950X barebones',
      price: { value: '700.00', currency: 'GBP' },
      condition: 'Used',
      itemWebUrl: 'https://www.ebay.co.uk/itm/222',
      seller: { username: 'other', feedbackPercentage: '97.0', feedbackScore: 88 },
      itemLocation: { city: 'Hull', country: 'GB' },
    },
  ],
};

/** fetchImpl that answers the OAuth POST then the Browse GET. */
function mockEbayFetch({ tokenBody = TOKEN_RESPONSE, searchBody = SEARCH_RESPONSE, tokenStatus = 200, searchStatus = 200 } = {}) {
  return mock.fn(async (url) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return { ok: tokenStatus === 200, status: tokenStatus, statusText: '', text: async () => JSON.stringify(tokenBody) };
    }
    return { ok: searchStatus === 200, status: searchStatus, statusText: '', text: async () => JSON.stringify(searchBody) };
  });
}

test('search returns normalized listings', async () => {
  const fetchImpl = mockEbayFetch();
  const client = createEbayClient({ clientId: 'id', clientSecret: 'sec', fetchImpl });
  const out = await client.search('ryzen 9 7950x 64gb', {});
  assert.equal(out.total, 2);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], {
    title: 'Ryzen 9 7950X Gaming PC 64GB DDR5',
    price: 950,
    currency: 'GBP',
    condition: 'Used',
    url: 'https://www.ebay.co.uk/itm/111',
    seller: 'pcseller',
    feedbackPercent: 99.1,
    feedbackScore: 412,
    location: 'Leeds, GB',
    shipping: 15,
  });
  // second item has no shippingOptions → shipping null
  assert.equal(out.results[1].shipping, null);
});

test('search sends marketplace header and bearer token', async () => {
  const fetchImpl = mockEbayFetch();
  const client = createEbayClient({ clientId: 'id', clientSecret: 'sec', fetchImpl });
  await client.search('foo', { marketplace: 'EBAY_GB' });
  const searchCall = fetchImpl.mock.calls.find(c => c.arguments[0].includes('item_summary/search'));
  assert.ok(searchCall, 'browse search was called');
  const { headers } = searchCall.arguments[1];
  assert.equal(headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_GB');
  assert.equal(headers['Authorization'], 'Bearer tok-abc');
});

test('token is cached across searches until expiry', async () => {
  const fetchImpl = mockEbayFetch();
  let fakeNow = 1_000_000;
  const client = createEbayClient({ clientId: 'id', clientSecret: 'sec', fetchImpl, now: () => fakeNow });
  await client.search('a', {});
  await client.search('b', {});
  const tokenCalls = fetchImpl.mock.calls.filter(c => c.arguments[0].includes('oauth2/token'));
  assert.equal(tokenCalls.length, 1, 'token fetched once while fresh');
  // advance past expiry (7200s minus safety margin)
  fakeNow += 7200 * 1000;
  await client.search('c', {});
  const tokenCallsAfter = fetchImpl.mock.calls.filter(c => c.arguments[0].includes('oauth2/token'));
  assert.equal(tokenCallsAfter.length, 2, 'token re-fetched after expiry');
});

test('missing credentials returns setup error, does not throw', async () => {
  const client = createEbayClient({ clientId: '', clientSecret: '', fetchImpl: mockEbayFetch() });
  const out = await client.search('foo', {});
  assert.equal(out.results.length, 0);
  assert.match(out.error, /EBAY_CLIENT_ID/);
  assert.match(out.error, /developer\.ebay\.com/);
});

test('oauth failure surfaces as error result', async () => {
  const fetchImpl = mockEbayFetch({ tokenStatus: 401, tokenBody: { error: 'invalid_client' } });
  const client = createEbayClient({ clientId: 'bad', clientSecret: 'bad', fetchImpl });
  const out = await client.search('foo', {});
  assert.equal(out.results.length, 0);
  assert.match(out.error, /401/);
});

test('search API failure surfaces as error result', async () => {
  const fetchImpl = mockEbayFetch({ searchStatus: 500, searchBody: {} });
  const client = createEbayClient({ clientId: 'id', clientSecret: 'sec', fetchImpl });
  const out = await client.search('foo', {});
  assert.equal(out.results.length, 0);
  assert.match(out.error, /500/);
});

test('buildFilterParam composes condition and price filters', () => {
  assert.equal(buildFilterParam({}), '');
  assert.equal(buildFilterParam({ condition: 'used' }), 'conditions:{USED}');
  assert.equal(
    buildFilterParam({ condition: 'refurbished', priceMin: 100 }),
    'conditions:{CERTIFIED_REFURBISHED|SELLER_REFURBISHED},price:[100..],priceCurrency:GBP'
  );
  assert.equal(
    buildFilterParam({ priceMin: 100, priceMax: 900, currency: 'GBP' }),
    'price:[100..900],priceCurrency:GBP'
  );
  assert.equal(buildFilterParam({ priceMax: 900 }), 'price:[..900],priceCurrency:GBP');
});

test('query, limit and sort are encoded into the browse URL', async () => {
  const fetchImpl = mockEbayFetch();
  const client = createEbayClient({ clientId: 'id', clientSecret: 'sec', fetchImpl });
  await client.search('ryzen 9 & more', { limit: 25, sort: 'price', condition: 'used' });
  const url = fetchImpl.mock.calls.find(c => c.arguments[0].includes('item_summary/search')).arguments[0];
  assert.match(url, /q=ryzen(%20|\+)9(%20|\+)(%26|&)(%20|\+)more/);
  assert.match(url, /limit=25/);
  assert.match(url, /sort=price/);
  assert.match(url, /filter=conditions/);
});
