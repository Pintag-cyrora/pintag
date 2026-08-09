// listings.html — default listing visibility.
//
// WHY THIS SUITE EXISTS
// A production incident took the public site down to a single visible
// listing. The cause was not a missing row, a broken query, an RLS change,
// or a join: every listing was fetched successfully and then discarded in
// the browser by `currentAvailOnly`, which commit 9eccd79 flipped from
// false to true. That turned `market_status` into a silent, default-on
// gate on the only page that lists inventory, so every row whose
// market_status was in LISTING_UNAVAILABLE_MARKET_STATUSES vanished with
// no error, no empty state, and no console warning -- the page looked
// like it was working perfectly.
//
// The invariant these tests protect: **a listing that exists must be
// visible on first load.** Narrowing is something the visitor opts into,
// never something the page does to itself before they have touched a
// control. Test 1 is the one that would have caught the incident.
//
// Everything is driven through mocked Supabase REST responses, so these
// tests exercise the real page (real fetch -> real renderListings() ->
// real card components) without needing network or credentials.

const { test, expect } = require('@playwright/test');

const UNAVAILABLE = ['reserved', 'rented', 'sold', 'fully_occupied', 'off_market'];
const AVAILABLE = ['available', 'coming_soon'];

function listing(i, over) {
  return Object.assign({
    id: 'id-' + i,
    slug: 'slug-' + i,
    title_en: 'Listing ' + i, title_lo: 'ລາຍການ ' + i, title_zh: '房源 ' + i,
    property_type: 'house',
    transaction_type: 'for_rent',
    district_en: 'Chanthabouly',
    images: ['https://example.invalid/a.jpg'],
    price_amount: 500 + i, price_currency: 'USD', price_frequency: 'monthly',
    bedrooms: 2, bathrooms: 1, sqm: 100,
    workflow_status: 'active', status: 'active',
    market_status: 'available',
    is_featured: false,
    created_at: '2026-07-01T00:00:00Z',
    views_week: 3, view_count: 30,
    contacts: null, parties: null,
  }, over);
}

// One listing per market_status, plus a row with market_status absent
// entirely (a pre-migration row, or any environment where that column was
// never backfilled -- resolveListingStatus() must treat it as available).
function oneOfEveryStatus() {
  const rows = [];
  UNAVAILABLE.concat(AVAILABLE).forEach((ms, i) => rows.push(listing(i, { market_status: ms, title_en: 'MS ' + ms })));
  rows.push(listing(90, { market_status: null, title_en: 'MS null' }));
  rows.push(listing(91, { title_en: 'MS missing' }));
  delete rows[rows.length - 1].market_status;
  return rows;
}

async function mount(page, rows) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.route('**/rest/v1/properties**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
  // Fire-and-forget analytics writes -- stubbed so a blocked network call
  // can never be mistaken for a rendering failure.
  for (const t of ['search_events', 'listing_events', 'ui_events', 'page_views']) {
    await page.route('**/rest/v1/' + t + '**', r => r.fulfill({ status: 201, body: '' }));
  }
  await page.route('**/rest/v1/rpc/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('/listings.html');
  await expect(page.locator('#listings-container > *').first()).toBeVisible();
  return errors;
}

const cards = page => page.locator('#listings-container > .pt-card');

test('every listing in the database is visible on first load, whatever its market_status', async ({ page }) => {
  // THE REGRESSION TEST. With currentAvailOnly defaulting to true this
  // renders 3 of 9 and fails here.
  const rows = oneOfEveryStatus();
  await mount(page, rows);
  await expect(cards(page)).toHaveCount(rows.length);
});

test('a listing is never silently dropped: the result count matches the cards actually rendered', async ({ page }) => {
  // Guards the other shape this class of bug takes -- an exception midway
  // through the card loop leaves the count claiming N while the DOM holds
  // fewer. The count and the DOM must always agree.
  const rows = oneOfEveryStatus();
  await mount(page, rows);
  const countText = await page.locator('#count-text').innerText();
  const claimed = parseInt(countText.match(/\d+/)[0], 10);
  await expect(cards(page)).toHaveCount(claimed);
  expect(claimed).toBe(rows.length);
});

test('the availability toggle defaults to "All Listings", matching currentAvailOnly', async ({ page }) => {
  // The JS default and the button marked .active in the static markup are
  // two separate declarations of the same fact; if they drift, the control
  // lies about what the visitor is looking at.
  await mount(page, oneOfEveryStatus());
  await expect(page.locator('.avail-btn[data-avail="all"]')).toHaveClass(/active/);
  await expect(page.locator('.avail-btn[data-avail="available"]')).not.toHaveClass(/active/);
});

test('"Available Only" still narrows to available listings when the visitor opts in', async ({ page }) => {
  // The fix must not disable the feature -- only stop it being the default.
  const rows = oneOfEveryStatus();
  await mount(page, rows);
  await page.locator('.avail-btn[data-avail="available"]').click();
  const expected = rows.filter(r => UNAVAILABLE.indexOf(r.market_status || 'available') === -1).length;
  await expect(cards(page)).toHaveCount(expected);
  expect(expected).toBeLessThan(rows.length); // proves the filter really is doing something
});

test('switching back to "All Listings" restores every listing', async ({ page }) => {
  const rows = oneOfEveryStatus();
  await mount(page, rows);
  await page.locator('.avail-btn[data-avail="available"]').click();
  await page.locator('.avail-btn[data-avail="all"]').click();
  await expect(cards(page)).toHaveCount(rows.length);
});

test('rows with legacy/NULL/unknown values still render, and no listing throws', async ({ page }) => {
  // The card loop is shared (renderPropertyCard) and a single throw inside
  // it truncates the whole grid at the offending row. Feed it the shapes
  // real production data actually contains -- unbackfilled prices, absent
  // images, property types outside PROPERTY_TYPE_DISPLAY's 7 keys, missing
  // embeds -- and require all of them through.
  const rows = [
    listing(1, { price_amount: null, price_display: '$450/month' }),          // unbackfilled price
    listing(2, { price_amount: null, price_display: null }),                   // price on request
    listing(3, { images: null }),                                              // no images
    listing(4, { images: [] }),
    listing(5, { property_type: 'warehouse' }),                                // outside the display registry
    listing(6, { property_type: null }),
    listing(7, { transaction_type: 'sale_or_rent', price_amount: null, sale_price: '$120,000', rent_price: '$800' }),
    listing(8, { district_en: null, bedrooms: null, bathrooms: null, sqm: null }),
    listing(9, { contacts: { role: 'owner', name: 'Somchai' }, parties: { type: 'agent', name_en: 'Agent A', photo_url: null } }),
    listing(10, { slug: null }),
  ];
  const errors = await mount(page, rows);
  await expect(cards(page)).toHaveCount(rows.length);
  expect(errors, 'no listing may throw during render').toEqual([]);
});

test('a card links by ?slug= when the listing has a slug', async ({ page }) => {
  // The canonical, shareable form. Nothing here changes it.
  await mount(page, [listing(1, { slug: 'riverside-villa' })]);
  await expect(cards(page).first()).toHaveAttribute('href', 'listing.html?slug=riverside-villa');
});

test('a slugless card falls back to ?id= instead of a dead ?slug=', async ({ page }) => {
  // THE FIX. Listings finished via the admin edit path can be saved without
  // a slug. Before the fix these cards linked to a bare "listing.html?slug="
  // (empty), and listing.html answered "No property selected." -- a public
  // dead end. The card must now carry the row id so the detail page can
  // still resolve the listing.
  await mount(page, [listing(1, { slug: null, id: 'abc-123' })]);
  await expect(cards(page).first()).toHaveAttribute('href', 'listing.html?id=abc-123');
});

test('a corrupted range price still renders its card rather than breaking the grid', async ({ page }) => {
  // "$280-300" was turned into 280300 by the old digit-stripping backfill
  // (see scripts/README.md, "Legacy Price Range Repair"). That is a DATA
  // defect with its own repair workflow -- what this asserts is only that
  // such a row degrades to a wrong-looking price on its own card, and
  // never takes the rest of the grid down with it.
  const rows = [listing(1, { price_amount: 400450 }), listing(2), listing(3)];
  const errors = await mount(page, rows);
  await expect(cards(page)).toHaveCount(3);
  expect(errors).toEqual([]);
});
