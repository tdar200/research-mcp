// DOM-based eBay UK search — extracts title/price/link from the SAME card node,
// so results can't get misaligned like the regex event-stream parser.
import { chromium } from 'playwright';

const query = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await (await browser.newContext({ locale: 'en-GB', viewport: { width: 1366, height: 900 } })).newPage();
await page.goto('https://www.ebay.co.uk/', { waitUntil: 'domcontentloaded' });
await page.fill('#gh-ac', query);
await page.keyboard.press('Enter');
await page.waitForURL(/_nkw/, { timeout: 20000 });
await page.waitForLoadState('domcontentloaded');
if (process.env.UK_ONLY) {
  const u = new URL(page.url()); u.searchParams.set('LH_PrefLoc', '1');
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
}
await page.waitForTimeout(5000);

const results = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  // Every result card contains an /itm/ link; walk up from the link to the card container.
  for (const a of document.querySelectorAll('a[href*="/itm/"]')) {
    const m = a.href.match(/\/itm\/(\d{9,})/);
    if (!m || seen.has(m[1])) continue;
    const card = a.closest('li, .su-card-container, .s-card');
    if (!card) continue;
    // Organic results only: sponsored carousels ignore the UK-location filter.
    if (card.closest('[class*="carousel"], .s-answer-region, [class*="srp-related"], [data-testid*="carousel"]')) continue;
    if (!card.closest('ul.srp-results, .srp-river-results')) continue;
    const text = card.innerText || '';
    const priceM = text.match(/£\s?[\d,]+(?:\.\d\d)?/);
    const titleEl = card.querySelector('.s-card__title, .su-item-card__title, [role="heading"], h3, .s-item__title');
    const title = (titleEl?.innerText || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 12 || !priceM) continue;
    const condM = text.match(/Pre-owned|Brand new|Refurbished|Parts only|New \(other\)|Opened – never used/);
    const locM = text.match(/from\s+([A-Za-z ]+)/i);
    seen.add(m[1]);
    out.push({ title: title.slice(0, 120), price: priceM[0], condition: condM ? condM[0] : null,
               location: locM ? locM[1].trim() : null, url: 'https://www.ebay.co.uk/itm/' + m[1] });
  }
  return out;
});
await browser.close();
console.log(JSON.stringify({ query, count: results.length, results }, null, 1));
