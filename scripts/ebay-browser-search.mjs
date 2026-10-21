// Keyless eBay UK search via headed Chrome (bypasses the /sch 403 by acquiring
// homepage cookies first, then searching through the site UI).
// Run from a project with playwright installed, with a live X display:
//   cd ~/Projects/ai-research-academy && DISPLAY=:1 node ~/Projects/research-mcp/scripts/ebay-browser-search.mjs "<query>"
// Complements the ebay_search MCP tool (official API), which is the durable
// path once EBAY_CLIENT_ID/SECRET are approved.
//
// Parser is an event-stream walk over the raw HTML because eBay serves at
// least two card markups (su-item-card lists and s-card carousels) and
// splitting on card containers breaks when class prefixes collide.
import { chromium } from 'playwright';

const query = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await (await browser.newContext({ locale: 'en-GB', viewport: { width: 1366, height: 900 } })).newPage();
await page.goto('https://www.ebay.co.uk/', { waitUntil: 'domcontentloaded' });
await page.fill('#gh-ac', query);
await page.keyboard.press('Enter');
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(4500);
const html = await page.content();
await browser.close();

const unescape = s => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const EVENT_RE = new RegExp(
  '(?:(?:s-card__title|su-item-card__title)[^>]*>(?:<[^>]+>)*(?<title>[^<]{15,160}))' +
  '|(?<price>£\\s?[\\d,]+(?:\\.\\d\\d)?)' +
  '|(?<cond>Pre-owned|Brand new|Refurbished|Parts only|New \\(other\\)|Opened – never used)' +
  '|/itm/(?<itm>\\d{9,})',
  'g'
);

const out = [];
const seen = new Set();
let cur = null;
const flush = () => {
  if (cur?.title && cur?.itm && !seen.has(cur.itm)) {
    seen.add(cur.itm);
    out.push({ title: cur.title, price: cur.price ?? null, condition: cur.cond ?? null, url: `https://www.ebay.co.uk/itm/${cur.itm}` });
  }
};
for (const m of html.matchAll(EVENT_RE)) {
  const g = m.groups;
  if (g.title) { flush(); cur = { title: unescape(g.title) }; }
  else if (cur && g.price && cur.price == null) cur.price = g.price;
  else if (cur && g.cond && cur.cond == null) cur.cond = g.cond;
  else if (cur && g.itm && cur.itm == null) cur.itm = g.itm;
}
flush();
console.log(JSON.stringify({ query, count: out.length, results: out }, null, 1));
