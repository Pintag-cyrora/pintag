// Bedroom Count filter (Any / 1 / 2 / 3 / 4 / 5+) -- listings.html.
// Drives the REAL listings.html against its own small, dedicated fixture
// set (NOT the shared fixtures.js ROWS array -- listings-filters.spec.js's
// own tests assert exact counts/orders across all of ROWS, so adding
// bedroom-specific rows there would mean hand-updating every one of those
// pre-existing assertions instead of actually testing anything new).
const { test, expect } = require('@playwright/test');
const { row, mockRest } = require('./fixtures');

const ROWS = [
  row({ slug: 'bed-1', property_type: 'apartment', transaction_type: 'for_rent', bedrooms: 1, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', price_display: '$300/month' }),
  row({ slug: 'bed-2', property_type: 'condo', transaction_type: 'for_rent', bedrooms: 2, price_amount: 500, price_currency: 'USD', price_frequency: 'monthly', price_display: '$500/month' }),
  row({ slug: 'bed-3', property_type: 'house', transaction_type: 'for_rent', bedrooms: 3, price_amount: 700, price_currency: 'USD', price_frequency: 'monthly', price_display: '$700/month' }),
  row({ slug: 'bed-4', property_type: 'house', transaction_type: 'for_rent', bedrooms: 4, price_amount: 900, price_currency: 'USD', price_frequency: 'monthly', price_display: '$900/month' }),
  row({ slug: 'bed-5', property_type: 'house', transaction_type: 'for_rent', bedrooms: 5, price_amount: 1200, price_currency: 'USD', price_frequency: 'monthly', price_display: '$1,200/month' }),
  // Comfortably past 5 -- proves "5+" is an open-ended catch, not literally 5.
  row({ slug: 'bed-6', property_type: 'house', transaction_type: 'for_rent', bedrooms: 6, price_amount: 1500, price_currency: 'USD', price_frequency: 'monthly', price_display: '$1,500/month' }),
  // Land: terminology.js's PHASE 1 scope deliberately gives Land no bedrooms
  // field at all -- bedrooms:null, exactly like a real Land row.
  row({ slug: 'land-null', property_type: 'land', transaction_type: 'for_sale', bedrooms: null, bathrooms: null, sqm: null, sqm_land: 800, price_amount: 95000, price_currency: 'USD', price_frequency: 'one_time', price_display: '$95,000' }),
];

const slugsShown = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.pt-card')].filter((c) => c.offsetParent !== null)
    .map((c) => { const a = c.matches('a') ? c : c.querySelector('a[href*="slug="]'); const m = a && /slug=([^&]+)/.exec(a.getAttribute('href') || ''); return m ? decodeURIComponent(m[1]) : null; }).filter(Boolean));
const countText = (page) => page.evaluate(() => document.getElementById('count-text').innerText.replace(/\s+/g, ' ').trim());
const bedroomLabels = (page) => page.evaluate(() => [...document.getElementById('bedroom-select').options].map((o) => o.text));
const pageErrors = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(e.message)); return errs; };
const settled = (page) => page.waitForFunction(() => window._listingsLoaded === true || !!document.getElementById('listings-retry'));
async function open(page, query) {
  const errs = pageErrors(page);
  mockRest(page, { rows: ROWS });
  await page.goto('/listings.html' + (query || ''));
  await page.waitForFunction(() => typeof window.setBedroomFilter === 'function');
  await settled(page);
  return errs;
}
const FAKE_LEAFLET = () => {
  window.L = {
    divIcon: () => ({}), latLngBounds: () => ({}), DomEvent: { stopPropagation() {} },
    marker: () => ({ on() {}, getElement() { return null; } }),
  };
  window.initMap = function () { window._map = { setView() {}, fitBounds() {} }; window._clusters = { clearLayers() {}, addLayers() {} }; };
};

test.describe('Bedroom Count filter', () => {
  test('each exact band (1-4) shows only its own listing', async ({ page }) => {
    const errs = await open(page, '?lang=en');
    for (const [key, slug] of [['1', 'bed-1'], ['2', 'bed-2'], ['3', 'bed-3'], ['4', 'bed-4']]) {
      await page.selectOption('#bedroom-select', key);
      expect(await slugsShown(page)).toEqual([slug]);
    }
    expect(errs).toEqual([]);
  });

  test('"5+" catches both 5 and 6+ bedrooms, never 4', async ({ page }) => {
    await open(page, '?lang=en');
    await page.selectOption('#bedroom-select', '5plus');
    expect(await slugsShown(page)).toEqual(expect.arrayContaining(['bed-5', 'bed-6']));
    expect(await slugsShown(page)).toHaveLength(2);
  });

  test('"Any" shows every listing, including the Land row with bedrooms:null', async ({ page }) => {
    await open(page, '?lang=en');
    expect(await slugsShown(page)).toHaveLength(7);
    expect(await slugsShown(page)).toContain('land-null');
  });

  test('bedrooms:null (Land) is excluded from every SPECIFIC band, not just left out of one', async ({ page }) => {
    await open(page, '?lang=en');
    for (const key of ['1', '2', '3', '4', '5plus']) {
      await page.selectOption('#bedroom-select', key);
      expect(await slugsShown(page)).not.toContain('land-null');
    }
  });

  test('Lao/English/Chinese labels, and the select relabels on a language switch', async ({ page }) => {
    await open(page, '?lang=en');
    expect(await bedroomLabels(page)).toEqual(['Any', '1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5+ bedrooms']);
    await page.evaluate(() => setLang('lo'));
    expect(await bedroomLabels(page)).toEqual(['ທັງໝົດ', '1 ຫ້ອງນອນ', '2 ຫ້ອງນອນ', '3 ຫ້ອງນອນ', '4 ຫ້ອງນອນ', '5+ ຫ້ອງນອນ']);
    await page.evaluate(() => setLang('zh'));
    expect(await bedroomLabels(page)).toEqual(['不限', '1 卧室', '2 卧室', '3 卧室', '4 卧室', '5+ 卧室']);
    // The selection itself must survive the relabel, not silently reset.
    await page.selectOption('#bedroom-select', '3');
    await page.evaluate(() => setLang('en'));
    expect(await page.evaluate(() => document.getElementById('bedroom-select').value)).toBe('3');
  });

  test('?beds= round-trips through the URL like every other filter (refresh keeps it)', async ({ page }) => {
    await open(page, '?lang=en');
    await page.selectOption('#bedroom-select', '3');
    expect(new URL(page.url()).searchParams.get('beds')).toBe('3');
    await page.reload();
    await page.waitForFunction(() => typeof window.setBedroomFilter === 'function');
    await settled(page);
    expect(await page.evaluate(() => document.getElementById('bedroom-select').value)).toBe('3');
    expect(await slugsShown(page)).toEqual(['bed-3']);
    // Back to "Any" removes the param entirely, exactly like ?price=/?type=.
    await page.selectOption('#bedroom-select', 'all');
    expect(new URL(page.url()).searchParams.get('beds')).toBeNull();
  });

  test('a crafted/invalid ?beds= value neither throws nor stops the listings from loading -- resets to "Any"', async ({ page }) => {
    const errs = await open(page, '?lang=en&beds=a%22b');
    expect(errs).toEqual([]);
    expect(await slugsShown(page)).toHaveLength(7);
    expect(await page.evaluate(() => document.getElementById('bedroom-select').value)).toBe('all');
  });

  test('a deep link straight to a specific band (?beds=5plus) applies on load', async ({ page }) => {
    await open(page, '?lang=en&beds=5plus');
    expect(await slugsShown(page)).toEqual(expect.arrayContaining(['bed-5', 'bed-6']));
    expect(await slugsShown(page)).toHaveLength(2);
    expect(await page.evaluate(() => document.getElementById('bedroom-select').value)).toBe('5plus');
  });

  test('Map view respects the same filter (count reflects it, not just the List-view grid)', async ({ page }) => {
    await open(page, '?lang=en');
    await page.evaluate(FAKE_LEAFLET);
    await page.evaluate(() => showMapView());
    expect(await countText(page)).toContain('7 listings');
    await page.selectOption('#bedroom-select', '5plus');
    expect(await countText(page)).toContain('2 listings');
    // ...and survives the round trip back to List view.
    await page.evaluate(() => showListView());
    expect(await slugsShown(page)).toEqual(expect.arrayContaining(['bed-5', 'bed-6']));
    expect(await slugsShown(page)).toHaveLength(2);
  });

  test('composes (AND) with an existing filter (price band), same as District/Price already do', async ({ page }) => {
    await open(page, '?lang=en');
    await page.click('.tx-btn[data-filter="for_rent"]');
    await page.selectOption('#price-select', 'r2');           // $300-600
    await page.selectOption('#bedroom-select', '2');
    expect(await slugsShown(page)).toEqual(['bed-2']);         // $500, 2BR -- matches both
    await page.selectOption('#bedroom-select', '3');
    expect(await slugsShown(page)).toEqual([]);                // 3BR is $700 -- out of the $300-600 band
  });

  // ── search_events tracking (product spec: include the selected bedroom
  // value, null for "Any", using the existing event structure) ───────────
  test('search_events carries the selected bedroom band\'s value, and null for "Any"', async ({ page }) => {
    await open(page, '?lang=en');
    let lastBody = null;
    await page.route('**/rest/v1/search_events', (r) => {
      lastBody = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.selectOption('#bedroom-select', '3');
    await page.waitForTimeout(700);   // scheduleBehavioralEvents() debounces 500ms
    expect(lastBody).not.toBeNull();
    expect(lastBody.bedrooms).toBe(3);

    await page.selectOption('#bedroom-select', '5plus');
    await page.waitForTimeout(700);
    expect(lastBody.bedrooms).toBe(5);   // the band's own min, same value matchesBedroomFilter() itself uses

    await page.selectOption('#bedroom-select', 'all');
    await page.waitForTimeout(700);
    expect(lastBody.bedrooms).toBeNull();

    // Every other existing field on the payload is untouched.
    expect(Object.keys(lastBody).sort()).toEqual(
      ['bedrooms', 'district', 'price_max', 'price_min', 'property_type', 'result_count', 'session_id', 'transaction_type'].sort());
  });
});
