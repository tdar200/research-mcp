// Open each eBay item page and extract the REAL title/price/location/seller.
import { chromium } from 'playwright';

const urls = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://www.ebay.co.uk/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const out = [];
for (const url of urls) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const d = await page.evaluate(() => {
      const q = s => document.querySelector(s)?.innerText?.replace(/\s+/g, ' ').trim() || null;
      const body = document.body.innerText;
      const locM = body.match(/Located in:?\s*([^\n]+)/i);
      const ended = /This listing (was ended|sold)|item is out of stock|no longer available/i.test(body) || null;
      const importM = body.match(/(?:Import charges|International shipping)[^\n]*/i);
      return {
        title: q('h1.x-item-title__mainTitle') || q('h1'),
        price: q('.x-price-primary') || (body.match(/£\s?[\d,]+\.\d\d/) || [null])[0],
        location: locM ? locM[1].trim() : null,
        seller: q('.x-sellercard-atf__info__about-seller') || null,
        importNote: importM ? importM[0].slice(0, 90) : null,
        ended,
      };
    });
    out.push({ url, ...d });
  } catch (e) {
    out.push({ url, error: String(e).slice(0, 120) });
  }
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
