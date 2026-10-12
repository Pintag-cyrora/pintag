// index.html — featured cards follow the canonical availability resolver (property-availability.js).
//
// The homepage promotes genuinely contactable listings ahead of the rest and badges each card with the EFFECTIVE
// status: coming_soon is unavailable (ranks after live listings) but keeps its Coming Soon badge and price; a property
// whose unit rows are all closed reads Fully Occupied even while market_status says 'available'; a stale 'rented' on a
// multi-unit property with an open unit reads as available (no badge).
const { test, expect } = require('@playwright/test');

const UT = (id, o) => Object.assign({ id, is_available: true, available_count: 2, total_units: null, next_available_date: null }, o || {});
const FULL = (id) => UT(id, { available_count: 0, next_available_date: '2999-01-01' });
const row = (i, o) => Object.assign({
  id: 'h-' + i, slug: 'h-' + i, title_en: 'Home ' + i, title_lo: 'ເຮືອນ ' + i, title_zh: '房 ' + i, property_type: 'house', transaction_type: 'for_rent',
  district_en: 'Chanthabouly', images: ['https://example.invalid/a.jpg'], price_amount: 500 + i, price_currency: 'USD', price_frequency: 'monthly',
  bedrooms: 2, bathrooms: 1, sqm: 90, workflow_status: 'active', status: 'active', market_status: 'available', is_featured: true,
  created_at: '2026-07-01T00:00:00Z', contacts: null, parties: null, unit_types: [],
}, o);

async function mount(page, rows) {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/rest/v1/properties**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
  for (const t of ['listing_events', 'ui_events', 'page_views', 'search_events']) await page.route('**/rest/v1/' + t + '**', (r) => r.fulfill({ status: 201, body: '' }));
  await page.goto('/index.html?lang=en');
  await expect(page.locator('#card-grid .pt-card').first()).toBeVisible();
  return errors;
}

test('homepage ranks contactable listings first and badges by the effective status', async ({ page }) => {
  const errors = await mount(page, [
    row(1, { title_en: 'Soon One', market_status: 'coming_soon', price_amount: 321 }),
    row(2, { title_en: 'Closed Units', market_status: 'available', unit_types: [FULL('c')] }),
    row(3, { title_en: 'Sold One', market_status: 'sold' }),
    row(4, { title_en: 'Plain Live', market_status: 'available' }),
    row(5, { title_en: 'Stale Rented Multi', market_status: 'rented', unit_types: [UT('m1'), FULL('m2')] }),
    row(6, { title_en: 'Lone Rented', market_status: 'rented', unit_types: [UT('l1')] }),
  ]);
  const order = await page.locator('#card-grid .pt-card').evaluateAll((els) => els.map((e) => (e.textContent.match(/(Soon One|Closed Units|Sold One|Plain Live|Stale Rented Multi|Lone Rented)/) || [])[1]));
  expect(order).toHaveLength(4);
  expect(order.slice(0, 2)).toEqual(['Plain Live', 'Stale Rented Multi']);      // contactable first, original order kept within each group
  const card = (t) => page.locator('#card-grid .pt-card', { hasText: t });
  expect((await card('Stale Rented Multi').locator('.pt-badge-status').count())).toBe(0);   // available: no badge
  await expect(card('Soon One').locator('.pt-badge-status').first()).toHaveText(/coming soon/i);
  await expect(card('Soon One')).toContainText('321');                                      // the advertised price stays
  await expect(card('Closed Units').locator('.pt-badge-status').first()).toHaveText(/fully occupied/i);
  expect(errors).toEqual([]);
});
