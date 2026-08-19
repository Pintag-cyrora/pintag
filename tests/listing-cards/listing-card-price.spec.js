// The PUBLIC listing/search page, on a MOBILE viewport (iPhone 13) — the
// surface the bug was reported on, not Admin and not the detail page.
//
// Drives the real listings.html with the real components.js renderer, feeding
// the real REST query through a route intercept. The critical assertion: a
// listing whose price exists only under its unit types, and whose units are all
// occupied, still shows its price on the card.
const { test, expect } = require('@playwright/test');

// The exact column list listings.html now requests; the intercept asserts the
// query really embeds unit_types, because without that the card has nothing to
// fall back to and the whole fix is inert.
let lastQuery = '';

function property(o) {
  return Object.assign({
    id: 'p-' + Math.abs(String(o.slug || 'x').split('').reduce((a, c) => a + c.charCodeAt(0), 0)),
    slug: o.slug || 'x', status: 'active', workflow_status: 'active', market_status: 'available',
    transaction_type: 'for_rent', property_type: 'apartment',
    title_en: 'T', title_lo: 'T', title_zh: 'T',
    district_en: 'Sisattanak', district_lo: 'Sisattanak', district_zh: 'Sisattanak',
    village_en: 'Thongkang', images: [], features: [], amenities: [],
    bedrooms: 1, bathrooms: 1, sqm: 40, created_at: '2026-08-01T00:00:00Z',
    contacts: null, parties: null, unit_types: []
  }, o);
}
const unit = (o) => Object.assign(
  { id: 'u', sort_order: 0, name_en: 'Studio', is_available: true, available_count: 3, total_units: null }, o);

// The five required scenarios, as five real cards on one page.
const FIXTURES = [
  property({ slug: 'avail-prop-price', market_status: 'available',
             price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450 / month' }),
  property({ slug: 'unavail-prop-price', market_status: 'rented',
             price_amount: 500, price_currency: 'USD', price_frequency: 'monthly', price_display: '$500 / month' }),
  property({ slug: 'avail-unit-price', market_status: 'available',
             price_amount: null, price_display: null,
             unit_types: [unit({ id: 'a1', price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', available_count: 4 })] }),
  // THE REPORTED BUG: fully occupied, property price nulled by admin, price
  // lives only on an unavailable unit type.
  property({ slug: 'unavail-unit-price', market_status: 'fully_occupied',
             price_amount: null, price_display: null,
             unit_types: [unit({ id: 'b1', price_amount: 380, price_currency: 'USD', price_frequency: 'monthly',
                                 is_available: false, available_count: 0 })] }),
  property({ slug: 'no-price', market_status: 'available', price_amount: null, price_display: null }),
  // Next Available — unavailable, price present, future date on the property.
  property({ slug: 'next-avail-prop', market_status: 'rented',
             price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450 / month',
             available_from: '2099-09-15' }),
  // Next Available — multi-unit, EARLIEST of three future dates.
  property({ slug: 'next-avail-earliest', market_status: 'fully_occupied',
             price_amount: null, price_display: null,
             unit_types: [
               unit({ id: 'e1', price_amount: 300, price_currency: 'USD', price_frequency: 'monthly',
                      is_available: false, available_count: 0, next_available_date: '2099-12-01' }),
               unit({ id: 'e2', price_amount: 320, price_currency: 'USD', price_frequency: 'monthly',
                      is_available: false, available_count: 0, next_available_date: '2099-09-15' }),
               unit({ id: 'e3', price_amount: 340, price_currency: 'USD', price_frequency: 'monthly',
                      is_available: false, available_count: 0, next_available_date: '2099-10-20' })
             ] }),
  // Real scarcity, for the FOMO axis.
  property({ slug: 'one-left', market_status: 'available',
             price_amount: 600, price_currency: 'USD', price_frequency: 'monthly',
             unit_types: [unit({ id: 'c1', price_amount: 600, price_currency: 'USD', price_frequency: 'monthly', available_count: 1 })] })
];

async function openListings(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?/.test(u.toString()), (r, req) => {
    lastQuery = req.url();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES) });
  });
  await page.goto('/listings.html');
  await page.waitForSelector('.pt-card', { timeout: 15000 });
  return errors;
}

// renderPropertyCard() makes the CARD ITSELF the <a> (href="listing.html?slug=…"),
// so the card is not a container holding a link — it IS one.
const cardFor = (page, slug) => page.locator(`.pt-card[href*="slug=${slug}"]`).first();

test('the public query embeds unit_types (without it the fallback is inert)', async ({ page }) => {
  await openListings(page);
  expect(decodeURIComponent(lastQuery)).toContain('unit_types(');
  for (const col of ['price_amount', 'is_available', 'available_count', 'total_units']) {
    expect(decodeURIComponent(lastQuery)).toContain(col);
  }
});

test('1. available + property price → price on the card', async ({ page }) => {
  const errors = await openListings(page);
  await expect(cardFor(page, 'avail-prop-price').locator('.pt-card-price')).toContainText('$450');
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('2. UNAVAILABLE + property price → price still visible', async ({ page }) => {
  const card = cardFor(page, 'unavail-prop-price');
  await openListings(page);
  await expect(card.locator('.pt-card-price')).toBeVisible();
  await expect(card.locator('.pt-card-price')).toContainText('$500');
});

test('3. available + unit-type price → price on the card', async ({ page }) => {
  await openListings(page);
  await expect(cardFor(page, 'avail-unit-price').locator('.pt-card-price')).toContainText('$300');
});

test('4. THE BUG — unavailable + unit-type price → price IS visible', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'unavail-unit-price');
  const price = card.locator('.pt-card-price');
  await expect(price).toBeVisible();
  await expect(price).toContainText('$380');
  await expect(card.locator('.pt-card-price-req')).toHaveCount(0);
  await expect(card).not.toContainText('Price on request');
});

test('5. no price anywhere → honest "Price on request", no invented number', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'no-price');
  await expect(card.locator('.pt-card-price-req')).toBeVisible();
  await expect(card.locator('.pt-card-price')).toHaveCount(0);
});

test('AVAILABILITY renders as its own line, not instead of the price', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'unavail-prop-price');
  await expect(card.locator('.pt-card-price')).toContainText('$500');
  // Rented → the "missed it" FOMO line carries the status (never both).
  await expect(card.locator('.pt-card-fomo')).toContainText('Just rented');
});

test('FOMO: real scarcity shows urgency ALONGSIDE the price', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'one-left');
  await expect(card.locator('.pt-card-price')).toContainText('$600');
  await expect(card.locator('.pt-card-fomo-urgent')).toContainText('Only 1 left');
});

test('FOMO is never fabricated for a listing with no inventory data', async ({ page }) => {
  await openListings(page);
  await expect(cardFor(page, 'avail-prop-price').locator('.pt-card-fomo')).toHaveCount(0);
});

test('an unavailable listing is never given scarcity urgency', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'unavail-unit-price');
  await expect(card.locator('.pt-card-fomo-urgent')).toHaveCount(0);
  await expect(card.locator('.pt-card-fomo')).toContainText('Fully occupied');
});

test('on a mobile viewport the price is actually rendered, not clipped away', async ({ page }) => {
  await openListings(page);
  for (const slug of ['avail-prop-price', 'unavail-prop-price', 'avail-unit-price', 'unavail-unit-price']) {
    const price = cardFor(page, slug).locator('.pt-card-price').first();
    await expect(price, slug).toBeVisible();
    const box = await price.boundingBox();
    expect(box, slug).not.toBeNull();
    expect(box.width, slug + ' has zero width').toBeGreaterThan(0);
    expect(box.height, slug + ' has zero height').toBeGreaterThan(0);
  }
});


// ═══════════════════════════════════════════════════════════════════════
// 7 — "NEXT AVAILABLE" beside the price
// ═══════════════════════════════════════════════════════════════════════

test('unavailable + future date → "· Available 15 Sep 2099" inline with the price', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'next-avail-prop');
  await expect(card.locator('.pt-card-price')).toContainText('$450');
  await expect(card.locator('.pt-card-next-available')).toContainText('Available 15 Sep 2099');
  // Inline: the suffix lives INSIDE the price paragraph, not as a sibling block.
  const insidePrice = await card.locator('.pt-card-price .pt-card-next-available').count();
  expect(insidePrice, 'the date must sit inside the price line').toBe(1);
});

test('multi-unit → the EARLIEST future date is the one shown', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'next-avail-earliest');
  await expect(card.locator('.pt-card-price')).toContainText('$300');   // cheapest unit
  await expect(card.locator('.pt-card-next-available')).toContainText('Available 15 Sep 2099');
  await expect(card.locator('.pt-card-next-available')).not.toContainText('Dec');
  await expect(card.locator('.pt-card-next-available')).not.toContainText('Oct');
});

test('an AVAILABLE listing shows no future date', async ({ page }) => {
  await openListings(page);
  await expect(cardFor(page, 'avail-prop-price').locator('.pt-card-next-available')).toHaveCount(0);
});

test('unavailable with NO date on file → no fabricated date', async ({ page }) => {
  await openListings(page);
  // unavail-prop-price is rented with no available_from and no unit dates.
  await expect(cardFor(page, 'unavail-prop-price').locator('.pt-card-next-available')).toHaveCount(0);
  await expect(cardFor(page, 'unavail-prop-price').locator('.pt-card-price')).toContainText('$500');
});

test('the date sits on ONE line with the price — the card does not grow a row', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'next-avail-prop');
  const price = card.locator('.pt-card-price');
  const suffix = card.locator('.pt-card-next-available');
  const [pb, sb] = [await price.boundingBox(), await suffix.boundingBox()];
  expect(pb).not.toBeNull(); expect(sb).not.toBeNull();
  // Same visual row: the suffix's vertical centre falls within the price block.
  const suffixMid = sb.y + sb.height / 2;
  expect(suffixMid, 'suffix should share the price row').toBeGreaterThanOrEqual(pb.y - 1);
  expect(suffixMid).toBeLessThanOrEqual(pb.y + pb.height + 1);
});

// ── SEARCH: sorting and price-band filtering for a fully occupied listing ──
// The same decoupling bug, on the search controls rather than the card body.
// `unavail-unit-price` is fully occupied with properties.price_amount = NULL
// and $380 living only on an occupied unit_types row — the exact shape an
// older admin build saved. Before the fix its sort key was 0 and it matched
// every price band, so it floated to the top of Price: Low→High and could not
// be filtered out. These drive the REAL <select>s on the real page.

const slugsInOrder = (page) => page.locator('.pt-card').evaluateAll(
  (els) => els.map((e) => (e.getAttribute('href').match(/slug=([^&]+)/) || [])[1]));

test('SORT: an occupied listing sorts on its unit-type price, not as 0', async ({ page }) => {
  await openListings(page);
  await page.selectOption('#sort-select', 'price_asc');
  const asc = await slugsInOrder(page);
  // Within the unavailable group, $380 must precede $500 and $450.
  const idx = (s) => asc.indexOf(s);
  expect(idx('unavail-unit-price')).toBeGreaterThan(-1);
  expect(idx('unavail-unit-price')).toBeLessThan(idx('unavail-prop-price'));   // 380 < 500
  expect(idx('unavail-unit-price')).toBeLessThan(idx('next-avail-prop'));      // 380 < 450
  // A genuinely unpriced listing still sorts as 0, and is available, so it
  // leads its own group — the occupied one must not be sitting alongside it.
  expect(idx('no-price')).toBeLessThan(idx('unavail-unit-price'));

  await page.selectOption('#sort-select', 'price_desc');
  const desc = await slugsInOrder(page);
  expect(desc.indexOf('unavail-unit-price')).toBeGreaterThan(desc.indexOf('unavail-prop-price'));
});

test('FILTER: an occupied listing lands in its real price band', async ({ page }) => {
  await openListings(page);
  await page.click('.tx-btn[data-filter="for_rent"]');
  await page.selectOption('#price-select', 'r2');            // $300–600
  await expect(cardFor(page, 'unavail-unit-price')).toHaveCount(1);
  await expect(cardFor(page, 'unavail-unit-price').locator('.pt-card-price')).toContainText('$380');

  await page.selectOption('#price-select', 'r1');            // Under $300
  await expect(cardFor(page, 'unavail-unit-price')).toHaveCount(0);  // was waved through before the fix
  // r1 is {min:null, max:300}, so the $300 listing is inside it — asserted to
  // pin the inclusive-bound behaviour this change did not touch.
  await expect(cardFor(page, 'avail-unit-price')).toHaveCount(1);

  await page.selectOption('#price-select', 'r4');            // Over $1,000
  await expect(cardFor(page, 'unavail-unit-price')).toHaveCount(0);

  await page.selectOption('#price-select', 'all');
  await expect(cardFor(page, 'unavail-unit-price')).toHaveCount(1);
});

test('FILTER: a genuinely unpriced listing is never hidden by a band', async ({ page }) => {
  await openListings(page);
  await page.click('.tx-btn[data-filter="for_rent"]');
  await page.selectOption('#price-select', 'r1');
  await expect(cardFor(page, 'no-price')).toHaveCount(1);
  await expect(cardFor(page, 'no-price')).toContainText(/request|ຕິດຕໍ່|询价/);
});

test('the occupied listing shows price, next-available and no scarcity together', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'next-avail-earliest');
  await expect(card.locator('.pt-card-price')).toContainText('$300');
  await expect(card.locator('.pt-card-next-available')).toContainText('15 Sep 2099');
  await expect(card).not.toContainText(/Only 1 left|of \d+ available/);
});
