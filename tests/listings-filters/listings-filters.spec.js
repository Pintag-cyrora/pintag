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
  await settled(page);
  return { errs, state };
}
// Loaded, or failed with the Retry state showing: the two end states a
// visitor can be in (a fixed sleep here was the one timing-based wait).
const settled = (page) => page.waitForFunction(() => window._listingsLoaded === true || !!document.getElementById('listings-retry'));
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
    await page.reload(); await settled(page);
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

// A Leaflet stand-in that lets the REAL renderMap() run (the STUB_MAP above
// replaces it), so what the header/notice/bubble say in Map view is asserted
// against the production code path, not a stub.
const FAKE_LEAFLET = () => {
  window.L = {
    divIcon: () => ({}), latLngBounds: () => ({}), DomEvent: { stopPropagation() {} },
    marker: () => ({ on() {}, getElement() { return null; } }),
  };
  window.initMap = function () { window._map = { setView() {}, fitBounds() {} }; window._clusters = { clearLayers() {}, addLayers() {} }; };
};

test.describe('listings.html — 2026-09-03 search fixes', () => {
  test('the result count is kept current while in Map view, and language switching repaints the map surface', async ({ page }) => {
    const { errs } = await open(page, '?lang=en');
    await page.evaluate(FAKE_LEAFLET);
    await page.evaluate(() => showMapView());
    expect(await countText(page)).toContain('5 listings');
    await page.evaluate(() => setTxFilter('for_sale', document.querySelector('.tx-btn[data-filter="for_sale"]')));
    expect(await countText(page)).toContain('2 listings');
    await page.evaluate(() => setTypeFilter('land', document.querySelector('.filter-btn[data-filter="land"]')));
    expect(await countText(page)).toContain('1 listings');
    // Every fixture row has no map link, so the "not on the map" notice is up;
    // it must follow the language like everything else on the visible surface.
    expect(await page.evaluate(() => document.getElementById('map-unmapped').textContent)).toContain('1 of 1 listings');
    await page.evaluate(() => setLang('zh'));
    expect(await page.evaluate(() => document.getElementById('map-unmapped').textContent)).toContain('尚无确切位置');
    // <html lang>, the tab title and the OG tags follow the language in Map view too
    expect(await page.evaluate(() => document.documentElement.getAttribute('lang'))).toBe('zh');
    expect(await page.evaluate(() => document.title)).toMatch(/[\u4e00-\u9fff]/);
    expect(errs).toEqual([]);
  });

  test('Province/District selects are rebuilt after a type / transaction / price change (never offer inventory that is not there)', async ({ page }) => {
    await open(page, '?lang=en');
    const districtOpts = () => page.evaluate(() => [...document.getElementById('district-select').options].map((o) => o.value + ':' + o.text));
    expect(await districtOpts()).toEqual(['all:All districts', 'Chanthabouly:Chanthabouly (1)', 'Luang Prabang:Luang Prabang (1)', 'Sisattanak:Sisattanak (2)', 'Xaythany:Xaythany (1)']);
    await page.evaluate(() => setTypeFilter('land', document.querySelector('.filter-btn[data-filter="land"]')));
    expect(await districtOpts()).toEqual(['all:All districts', 'Xaythany:Xaythany (1)']);
    expect(await page.evaluate(() => [...document.getElementById('province-select').options].map((o) => o.value))).toEqual(['all', 'Vientiane Capital']);
    // A selection stranded by the new axis resets instead of yielding an empty grid.
    await page.evaluate(() => setTypeFilter('all', document.querySelector('.filter-btn[data-filter="all"]')));
    await page.evaluate(() => setDistrictFilter('Sisattanak'));
    expect(await slugsShown(page)).toEqual(['house-rent', 'condo-lak']);
    await page.evaluate(() => setTxFilter('for_sale', document.querySelector('.tx-btn[data-filter="for_sale"]')));
    expect(await page.evaluate(() => currentDistrictFilter)).toBe('all');
    expect(await slugsShown(page)).toHaveLength(2);
    expect(new URL(page.url()).searchParams.get('district')).toBeNull();
  });

  test('price bands are half-open [min, max): a $300 rental is in "$300–600" only, a $50,000 sale in "$50k–150k" only', async ({ page }) => {
    await open(page, '?lang=en');
    const inBand = (tx, band, p) => page.evaluate(([tx, band, p]) => { currentTxFilter = tx; currentPriceBand = band; return matchesPriceBand(p); }, [tx, band, p]);
    const rent300 = { transaction_type: 'for_rent', price_amount: 300, price_currency: 'USD' };
    expect(await inBand('for_rent', 'r1', rent300)).toBe(false);
    expect(await inBand('for_rent', 'r2', rent300)).toBe(true);
    expect(await inBand('for_rent', 'r1', { transaction_type: 'for_rent', price_amount: 299, price_currency: 'USD' })).toBe(true);
    expect(await inBand('for_rent', 'r3', { transaction_type: 'for_rent', price_amount: 1000, price_currency: 'USD' })).toBe(false);
    expect(await inBand('for_rent', 'r4', { transaction_type: 'for_rent', price_amount: 1000, price_currency: 'USD' })).toBe(true);
    const sale50k = { transaction_type: 'for_sale', price_amount: 50000, price_currency: 'USD' };
    expect(await inBand('for_sale', 's1', sale50k)).toBe(false);
    expect(await inBand('for_sale', 's2', sale50k)).toBe(true);
  });

  test('map bubble of a sale_or_rent listing shows its RENT leg under For Rent (the leg the band kept it for)', async ({ page }) => {
    await open(page, '?lang=en');
    const bubble = (tx) => page.evaluate((tx) => { currentTxFilter = tx; return formatPriceBubble(allProperties.find((p) => p.slug === 'villa-both')); }, tx);
    expect(await bubble('all')).toBe('$250k');
    expect(await bubble('for_sale')).toBe('$250k');
    expect(await bubble('for_rent')).toBe('$1k');
  });

  test('count line and map preview name the province actually browsed, not "Vientiane" for everything', async ({ page }) => {
    await open(page, '?lang=en');
    expect(await countText(page)).toBe('5 listings · Laos');
    await page.evaluate(() => setProvinceFilter('Luang Prabang'));
    expect(await countText(page)).toBe('1 listings · Luang Prabang');
    await page.evaluate(() => setProvinceFilter('Vientiane Capital'));
    expect(await countText(page)).toBe('4 listings · Vientiane');
    // Under "All provinces" the suffix names the province of what is SHOWN
    await page.evaluate(() => setProvinceFilter('all'));
    await page.evaluate(() => setTypeFilter('land', document.querySelector('.filter-btn[data-filter="land"]')));
    expect(await countText(page)).toBe('1 listings · Vientiane');
    await page.evaluate(() => setTypeFilter('all', document.querySelector('.filter-btn[data-filter="all"]')));
    expect(await countText(page)).toBe('5 listings · Laos');
    await page.evaluate(() => showMapPreview(allProperties.find((p) => p.slug === 'villa-both')));
    expect(await page.evaluate(() => document.getElementById('mp-loc').textContent.trim())).toBe('Luang Prabang, Luang Prabang');
    await page.evaluate(() => showMapPreview(allProperties.find((p) => p.slug === 'house-rent')));
    expect(await page.evaluate(() => document.getElementById('mp-loc').textContent.trim())).toBe('Sisattanak, Vientiane');
  });

  test('District options are labelled in the page language (value stays the English key the filter compares)', async ({ page }) => {
    await open(page, '?lang=lo');
    const opts = await page.evaluate(() => [...document.getElementById('district-select').options].map((o) => [o.value, o.text]));
    expect(opts).toContainEqual(['Sisattanak', 'ສີສັດຕະນາກ (2)']);
    expect(opts).toContainEqual(['Luang Prabang', 'Luang Prabang (1)']);   // no Lao column on that row -> English fallback
    await page.evaluate(() => setDistrictFilter('Sisattanak'));
    expect(await slugsShown(page)).toEqual(['house-rent', 'condo-lak']);
    await page.evaluate(() => setLang('zh'));
    expect(await page.evaluate(() => document.getElementById('district-select').selectedOptions[0].text)).toBe('西沙塔纳克 (2)');
  });

  test('a crafted ?type= value neither throws nor stops the listings from loading', async ({ page }) => {
    const { errs } = await open(page, '?lang=en&type=a%22b');
    expect(errs).toEqual([]);
    expect(await slugsShown(page)).toHaveLength(5);
    expect(await page.evaluate(() => document.querySelector('.filter-btn.active').getAttribute('data-filter'))).toBe('all');
  });

  test('Pet Friendly / Smoking Allowed round-trip through the URL like every other filter', async ({ page }) => {
    await open(page, '?lang=en&tx=for_rent');
    await page.evaluate(() => toggleRentalFilter('pet', document.getElementById('rf-pet')));
    expect(new URL(page.url()).searchParams.get('pet')).toBe('1');
    await page.reload(); await settled(page);
    expect(await page.evaluate(() => [currentPetFriendly, document.getElementById('rf-pet').classList.contains('active')])).toEqual([true, true]);
    await page.evaluate(() => toggleRentalFilter('pet', document.getElementById('rf-pet')));
    expect(new URL(page.url()).searchParams.get('pet')).toBeNull();
    // Leaving For Rent clears the rental-only filters from state AND the URL.
    await page.evaluate(() => toggleRentalFilter('smoking', document.getElementById('rf-smoking-allowed')));
    await page.evaluate(() => setTxFilter('all', document.querySelector('.tx-btn[data-filter="all"]')));
    expect(new URL(page.url()).searchParams.get('smoking')).toBeNull();
  });

  test('a stale ?price= from the other Rent/Sale band set is dropped from the URL once the page settles', async ({ page }) => {
    await open(page, '?lang=en&price=r3');   // rent band, but no tx -> "All" uses the single Any-price band
    expect(await page.evaluate(() => [currentPriceBand, document.getElementById('price-select').value])).toEqual(['all', 'all']);
    expect(new URL(page.url()).searchParams.get('price')).toBeNull();
  });

  test('map preview: a gallery holding a falsy entry renders the no-photo block, never <img src="">; a real one carries the fallback', async ({ page }) => {
    await open(page, '?lang=en');
    await page.evaluate(() => showMapPreview(Object.assign({}, allProperties[0], { images: [null] })));
    expect(await page.evaluate(() => document.getElementById('mp-img-inner').innerHTML)).not.toContain('<img');
    await page.evaluate(() => showMapPreview(allProperties[0]));
    const img = await page.evaluate(() => { const i = document.querySelector('#mp-img-inner img'); return i ? { src: i.getAttribute('src'), orig: i.getAttribute('data-pt-original'), onerror: i.getAttribute('onerror') } : null; });
    expect(img.src).toContain('pintag-hero.png');
    expect(img.orig).toContain('pintag-hero.png');
    expect(img.onerror).toContain('ptImageFallback');
  });

  test('the activity line is escaped exactly once (a district with & is not rendered as &amp;amp;)', async ({ page }) => {
    await open(page, '?lang=en');
    const p = { created_at: new Date().toISOString(), trending_score: 150, district_en: 'Ban Kao & Mai', transaction_type: 'for_rent' };
    expect(await page.evaluate((p) => getActivityLine(p, 'en'), p)).toBe('Popular rental in Ban Kao & Mai');
    await page.evaluate((p) => { allProperties = [Object.assign({}, allProperties[0], p)]; renderListings(); }, p);
    expect(await page.evaluate(() => document.querySelector('.card-activity-line').textContent)).toBe('Popular rental in Ban Kao & Mai');
  });
});

test('the Province select stays visible while a type/price choice narrows inventory to one province (it is decided on the whole inventory)', async ({ page }) => {
  await open(page, '?lang=en');
  const state = () => page.evaluate(() => ({ display: document.getElementById('province-select').style.display, opts: [...document.getElementById('province-select').options].map((o) => o.value) }));
  expect(await state()).toEqual({ display: '', opts: ['all', 'Vientiane Capital', 'Luang Prabang'] });
  await page.evaluate(() => setTypeFilter('land', document.querySelector('.filter-btn[data-filter="land"]')));   // only the capital has land
  expect(await state()).toEqual({ display: '', opts: ['all', 'Vientiane Capital'] });
  await page.evaluate(() => setTypeFilter('all', document.querySelector('.filter-btn[data-filter="all"]')));
  expect((await state()).opts).toEqual(['all', 'Vientiane Capital', 'Luang Prabang']);
});

test('DOM path: the real controls drive the same pipeline (select change, chip click, sort change)', async ({ page }) => {
  const { errs } = await open(page, '?lang=en');
  await page.selectOption('#province-select', 'Luang Prabang');
  expect(await slugsShown(page)).toEqual(['villa-both']);
  await page.selectOption('#province-select', 'all');
  await page.click('.tx-btn[data-filter="for_sale"]');
  await page.selectOption('#sort-select', 'price_desc');
  expect(await slugsShown(page)).toEqual(['villa-both', 'land-sale']);
  const u = new URL(page.url());
  expect([u.searchParams.get('tx'), u.searchParams.get('sort')]).toEqual(['for_sale', 'price_desc']);
  await page.selectOption('#price-select', 's1');   // Under $50k: neither sale listing
  expect(await slugsShown(page)).toEqual([]);
  expect(await countText(page)).toContain('0 listings');
  expect(errs).toEqual([]);
});

test('price sort under For Rent uses the rent leg of a sale_or_rent listing, like the band and the bubble', async ({ page }) => {
  await open(page, '?lang=en');
  const order = await page.evaluate(() => {
    currentTxFilter = 'for_rent'; currentSort = 'price_asc';
    return sortProperties([
      { slug: 'rent-2000', transaction_type: 'for_rent', price_amount: 2000, price_currency: 'USD', market_status: 'available' },
      { slug: 'sor', transaction_type: 'sale_or_rent', price_amount: 250000, price_currency: 'USD', rent_price_amount: 1200, rent_price_currency: 'USD', market_status: 'available' },
      { slug: 'rent-850', transaction_type: 'for_rent', price_amount: 850, price_currency: 'USD', market_status: 'available' },
    ]).map((p) => p.slug);
  });
  expect(order).toEqual(['rent-850', 'sor', 'rent-2000']);
});
