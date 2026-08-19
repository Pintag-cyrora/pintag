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
