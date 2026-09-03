// Regression suite for the public-search fixes of the 2026-09-02 QA audit.
// Drives the REAL listings.html against the REST fake in fixtures.js and
// asserts what a visitor sees: which cards are rendered, what the count says,
// what the address bar holds, what the sort <select> is labelled.
const { test, expect } = require('@playwright/test');
const { mockRest } = require('./fixtures');

const slugsShown = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.pt-card')].filter((c) => c.offsetParent !== null)
    .map((c) => { const a = c.matches('a') ? c : c.querySelector('a[href*="slug="]'); const m = a && /slug=([^&]+)/.exec(a.getAttribute('href') || ''); return m ? decodeURIComponent(m[1]) : null; }).filter(Boolean));
const countText = (page) => page.evaluate(() => document.getElementById('count-text').innerText.replace(/\s+/g, ' ').trim());
const sortLabels = (page) => page.evaluate(() => [...document.getElementById('sort-select').options].map((o) => o.text));
const pageErrors = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(e.message)); return errs; };
async function open(page, query, opts) {
  const errs = pageErrors(page); const state = mockRest(page, opts);
  await page.goto('/listings.html' + (query || ''));
  await page.waitForFunction(() => typeof window.setTxFilter === 'function');
  await page.waitForTimeout(600);
  return { errs, state };
}
// Leaflet is not loaded here; stand in for the two map entry points so Map
// view can be entered without the CDN.
const STUB_MAP = () => { window.initMap = function () { window._map = {}; }; window.renderMap = function () {}; };

test.describe('listings.html — filter fixes', () => {
  test('province select APPLIES (no dangling applyFilters) and narrows the grid', async ({ page }) => {
    const { errs } = await open(page, '?lang=en');
    expect(await page.evaluate(() => [...document.querySelectorAll('#province-select option')].map((o) => o.value))).toContain('Luang Prabang');
    await page.evaluate(() => setProvinceFilter('Luang Prabang'));
    await page.waitForTimeout(300);
    expect(errs, 'no ReferenceError').toEqual([]);
    expect(await slugsShown(page)).toEqual(['villa-both']);
    expect(await countText(page)).toContain('1 listings');
    expect(page.url()).toContain('province=Luang+Prabang');
  });

  test('filters chosen in Map view are applied the moment List view returns', async ({ page }) => {
    const { errs } = await open(page, '?lang=en');
    await page.evaluate(STUB_MAP);
    await page.evaluate(() => showMapView());
    await page.evaluate(() => setTxFilter('for_sale', document.querySelector('.tx-btn[data-filter="for_sale"]')));
    await page.evaluate(() => setSort('price_desc'));
    await page.evaluate(() => showListView());
    await page.waitForTimeout(300);
    expect(errs).toEqual([]);
    expect(await slugsShown(page)).toEqual(['villa-both', 'land-sale']);
    expect(await countText(page)).toContain('2 listings');
  });

  test('sale_or_rent listings appear under BOTH For Rent and For Sale, banded on the matching leg', async ({ page }) => {
    await open(page, '?lang=en');
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    expect(await slugsShown(page)).toContain('villa-both');
    // $1,200/month rent leg -> "Over $1,000" (r4) keeps it; "$300-600" (r2) drops it
    await page.evaluate(() => setPriceFilter('r4'));
    expect(await slugsShown(page)).toContain('villa-both');
    await page.evaluate(() => setPriceFilter('r2'));
    expect(await slugsShown(page)).not.toContain('villa-both');
    await page.evaluate(() => setTxFilter('for_sale', document.querySelector('.tx-btn[data-filter="for_sale"]')));
    expect(await slugsShown(page)).toEqual(expect.arrayContaining(['villa-both', 'land-sale']));
    expect(await slugsShown(page)).not.toContain('house-rent');
  });

  test('sort <select> is labelled in the page language on FIRST load (en / zh / lo)', async ({ page }) => {
    await open(page, '?lang=en');
    expect(await sortLabels(page)).toEqual(['Newest', 'Featured', 'Price: Low→High', 'Price: High→Low']);
    await open(page, '?lang=zh');
    expect(await sortLabels(page)).toEqual(['最新', '精选', '价格: 低→高', '价格: 高→低']);
    await open(page, '?lang=lo');
    expect((await sortLabels(page))[0]).toBe('ໃໝ່ສຸດ');
  });

  test('price sort: un-priced listings last, rentals before sales under All', async ({ page }) => {
    await open(page, '?lang=en');
    await page.evaluate(() => setSort('price_asc'));
    expect(await slugsShown(page)).toEqual(['house-rent', 'condo-lak', 'land-sale', 'villa-both', 'apt-noprice']);
    await page.evaluate(() => setSort('price_desc'));
    expect(await slugsShown(page)).toEqual(['villa-both', 'land-sale', 'condo-lak', 'house-rent', 'apt-noprice']);
    // Within one transaction the ordering is plain numeric, still nulls last.
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.evaluate(() => setSort('price_asc'));
    expect(await slugsShown(page)).toEqual(['house-rent', 'villa-both', 'condo-lak', 'apt-noprice']);
  });

  test('deep links: ?tx / ?filter / ?type / ?sort / ?province are applied on load', async ({ page }) => {
    await open(page, '?lang=en&tx=for_rent&type=house');
    expect(await slugsShown(page)).toEqual(['house-rent']);
    expect(await page.evaluate(() => document.querySelector('.tx-btn.active').getAttribute('data-filter'))).toBe('for_rent');
    expect(await page.evaluate(() => document.querySelector('.filter-btn.active').getAttribute('data-filter'))).toBe('house');

    await open(page, '?lang=en&filter=for_sale');   // listing.html's Buy/Rent nav links
    expect(await slugsShown(page)).toEqual(expect.arrayContaining(['land-sale', 'villa-both']));
    expect(await slugsShown(page)).toHaveLength(2);

    await open(page, '?lang=en&sort=price_asc&province=Vientiane%20Capital');
    expect(await page.evaluate(() => document.getElementById('sort-select').value)).toBe('price_asc');
    expect(await slugsShown(page)).toEqual(['house-rent', 'condo-lak', 'land-sale', 'apt-noprice']);
  });

  test('filter changes are mirrored into the address bar (refresh/share keeps them)', async ({ page }) => {
    await open(page, '?lang=en&filter=for_sale');
    await page.evaluate(() => setTypeFilter('villa', document.querySelector('.filter-btn[data-filter="villa"]')));
    const u = new URL(page.url());
    expect(u.searchParams.get('tx')).toBe('for_sale');
    expect(u.searchParams.get('type')).toBe('villa');
    expect(u.searchParams.get('filter')).toBeNull();
    expect(u.searchParams.get('lang')).toBe('en');
    await page.reload(); await page.waitForTimeout(800);
    expect(await slugsShown(page)).toEqual(['villa-both']);
    await page.evaluate(() => setTypeFilter('all', document.querySelector('.filter-btn[data-filter="all"]')));
    expect(new URL(page.url()).searchParams.get('type')).toBeNull();
  });

  test('a failed fetch: header is not stuck on Loading, Retry exists and works, later clicks do not throw', async ({ page }) => {
    const { errs, state } = await open(page, '?lang=en', { fail: true });
    expect(await countText(page)).toBe('Could not load listings');
    await expect(page.locator('#listings-retry')).toBeVisible();
    await page.evaluate(() => setTypeFilter('house', document.querySelector('.filter-btn[data-filter="house"]')));
    expect(errs, 'no throw while in the error state').toEqual([]);
    state.fail = false;
    await page.click('#listings-retry');
    await page.waitForTimeout(800);
    expect(await slugsShown(page)).toEqual(['house-rent']);
    expect(await countText(page)).toContain('1 listings');
  });
});

test.describe('phone-number normalisation (the ONE helper) on the public pages', () => {
  test('ptNormalizePhoneDigits handles every stored format', async ({ page }) => {
    await open(page, '?lang=en');
    const out = await page.evaluate(() => ['020 5551 2345', '02055512345', '+856 20 5551 2345', '00856 20 5551 2345', '2055512345', '+66 81 234 5678', '030 123 4567', '', null]
      .map((v) => ptNormalizePhoneDigits(v)));
    expect(out).toEqual(['8562055512345', '8562055512345', '8562055512345', '8562055512345', '8562055512345', '66812345678', '856301234567', '', '']);
    expect(await page.evaluate(() => [ptTelHref('020 5551 2345'), ptTelHref('')])).toEqual(['tel:+8562055512345', '#']);
  });

  test('listing.html builds every WhatsApp / Call link from the normalised number', async ({ page }) => {
    const errs = pageErrors(page); mockRest(page);
    await page.goto('/listing.html?slug=house-rent&lang=en');
    await page.waitForFunction(() => !!document.querySelector('a[href*="wa.me"]'));
    const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"]')].map((a) => a.href.split('?')[0]));
    expect(wa.length).toBeGreaterThan(0);
    wa.forEach((h) => expect(h).toBe('https://wa.me/8562055512345'));
    const tel = await page.evaluate(() => [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href')));
    tel.forEach((h) => expect(h).toBe('tel:+8562055512345'));
    // Picking the Thai number in the contact picker re-points the CTAs to +66.
    const rows = await page.locator('.contact-picker .cpick-row').count();
    expect(rows).toBe(3);
    await page.locator('.contact-picker .cpick-row').nth(2).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.getElementById('pt-wa-primary').getAttribute('href').split('?')[0])).toBe('https://wa.me/66812345678');
    expect(await page.evaluate(() => document.getElementById('pt-call-primary').getAttribute('href'))).toBe('tel:+66812345678');
    expect(errs).toEqual([]);
  });

  test('a sold listing with an internationally-stored number still links correctly', async ({ page }) => {
    mockRest(page);
    await page.goto('/listing.html?slug=land-sale&lang=en');
    await page.waitForFunction(() => !!document.querySelector('a[href*="wa.me"]'));
    const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"]')].map((a) => a.href.split('?')[0]));
    wa.forEach((h) => expect(h).toBe('https://wa.me/8562077788899'));
  });
});
