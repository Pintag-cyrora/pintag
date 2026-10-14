// Expired availability dates on the real listing page (listing.html, mocked Supabase). See expired-availability-dates.test.js
// (repo root) for the rule itself; this pins that every customer-facing unit-status surface follows it:
//   * unit cards (status text + the separate move-in line), their order ("Available Soon" bucket), the selected-unit text
//   * the contact-intent availability answer (per-unit lines)
//   * the property-level "Available <date>" line (ptResolveNextAvailable)
//
// The clock is FIXED, not the machine's: 2026-10-13T18:00:00Z is 01:00 on 14 Oct in Vientiane while it is still 13 Oct in
// UTC and in the US. So '2026-10-13' is YESTERDAY (expired) and '2026-10-14' is TODAY (live) only if "today" is the LAO day.
const { test, expect } = require('@playwright/test');

const NOW = '2026-10-13T18:00:00Z';
const EXPIRED = '2026-10-13', TODAY = '2026-10-14', SOON = '2026-10-20';
const STALE_TEXT = /13 Oct 2026/;

const UNIT = (id, name, o) => Object.assign({ id, name_en: name, name_lo: name + ' (lo)', name_zh: name + ' (zh)', bedrooms: 1, bathrooms: 1, sqm: 30,
  price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 0, total_units: null,
  next_available_date: null, images: [], sort_order: 0 }, o || {});
const prop = (o) => Object.assign({
  id: 'p-exp', slug: 'exp-test', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
  property_type: 'apartment', transaction_type: 'for_rent',
  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
  images: ['https://example.com/a.jpg'], amenities: [], features: [], district_en: 'Sisattanak', workflow_status: 'active',
  market_status: 'available', status: 'active', created_at: '2026-01-01T00:00:00Z', bedrooms: 2, bathrooms: 1, sqm: 60,
  contacts: { id: 'c-1', role: 'agent', name: 'Somchai', phone: '+8562099999999', whatsapp: '+8562099999999' },
  managed_by_party_id: 'party-1', parties: null, unit_types: [], available_from: null,
}, o || {});

async function open(page, row) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => { window.open = () => null; });
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    const ok = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.indexOf('/properties?slug=eq.') !== -1) return ok([row]);
    return ok(url.indexOf('/rpc/') !== -1 ? {} : []);
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listing.html?slug=' + row.slug + '&lang=en');
  await page.waitForSelector('#section-price');
  await page.waitForTimeout(500);
  return errors;
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const cards = (page) => page.locator('.unit-card');

const MIXED = () => prop({ unit_types: [
  UNIT('stale', 'Stale Studio', { next_available_date: EXPIRED, sort_order: 0 }),
  UNIT('soon', 'Soon Studio', { next_available_date: SOON, sort_order: 1 }),
  UNIT('open', 'Open Studio', { available_count: 2, sort_order: 2 }),
  UNIT('today', 'Today Studio', { next_available_date: TODAY, sort_order: 3 }),
  UNIT('none', 'None Studio', { next_available_date: null, sort_order: 4 }),
] });

test.describe('unit cards', () => {
  test('an expired date shows no "Available from" and no date; today and future dates are unchanged', async ({ page }) => {
    const errors = await open(page, MIXED());
    await expect(cards(page)).toHaveCount(5);
    const card = (name) => cards(page).filter({ hasText: name });
    await expect(card('Open Studio').locator('.unit-status')).toContainText('Available Now');
    await expect(card('Today Studio').locator('.unit-status')).toContainText('Fully Occupied — Available from 14 Oct 2026');
    await expect(card('Soon Studio').locator('.unit-status')).toContainText('Fully Occupied — Available from 20 Oct 2026');
    await expect(card('Stale Studio').locator('.unit-status')).toContainText('Currently Unavailable');
    await expect(card('Stale Studio')).not.toContainText(STALE_TEXT);
    await expect(card('Stale Studio')).not.toContainText(/Available from/);
    await expect(card('None Studio').locator('.unit-status')).toContainText('Currently Unavailable');
    expect(await bodyText(page)).not.toMatch(STALE_TEXT);
    expect(errors).toEqual([]);
  });

  test('"Available Soon" ordering: Available Now, then live dates soonest first, then unavailable (the expired unit is NOT in the Soon bucket)', async ({ page }) => {
    await open(page, MIXED());
    const names = await cards(page).locator('.unit-name').allInnerTexts();
    expect(names).toEqual(['Open Studio', 'Today Studio', 'Soon Studio', 'Stale Studio', 'None Studio']);
  });

  test('an expired date on a unit with a positive count: still Available Now, no date, count unchanged', async ({ page }) => {
    await open(page, prop({ unit_types: [
      UNIT('a', 'Room A', { available_count: 3, total_units: 8, next_available_date: EXPIRED }),
      UNIT('b', 'Room B', { available_count: 1, next_available_date: SOON }),
    ] }));
    const a = cards(page).filter({ hasText: 'Room A' });
    await expect(a.locator('.unit-status')).toContainText('Available Now');
    await expect(a.locator('.unit-status')).toContainText('3 of 8 units available');
    await expect(a).not.toContainText(STALE_TEXT);
  });

  test('selected unit: choosing the expired unit shows no stale date anywhere on the page', async ({ page }) => {
    await open(page, MIXED());
    await cards(page).filter({ hasText: 'Stale Studio' }).first().click();
    await page.waitForTimeout(400);
    const t = await bodyText(page);
    expect(t).not.toMatch(STALE_TEXT);
    expect(t).not.toMatch(/Fully Occupied\s*—\s*Available from 13/);
    await expect(page.locator('.unit-card-selected')).toContainText('Stale Studio');
    await expect(page.locator('.unit-card-selected .unit-status')).toContainText('Currently Unavailable');
  });
});

test.describe('contact-intent availability answer', () => {
  async function ask(page, row) {
    await open(page, row);
    await page.evaluate(() => {
      const b = document.createElement('button'); b.id = 'ci-test-btn'; b.type = 'button'; b.textContent = 'availability';
      b.setAttribute('data-contact-intent', 'availability'); b.style.cssText = 'position:fixed;top:60px;right:8px;z-index:99999';
      document.body.appendChild(b);
    });
    await page.click('#ci-test-btn');
    await page.waitForTimeout(500);
  }
  test('per-unit lines: the expired unit reads "Currently Unavailable" with no date; live dates keep theirs', async ({ page }) => {
    await ask(page, MIXED());
    const lines = (await page.locator('#contact-intent-answer li').allInnerTexts()).join(' | ');
    expect(lines).toMatch(/Stale Studio\s+Currently Unavailable/);
    expect(lines).toMatch(/Today Studio\s+Fully Occupied — Available from 14 Oct 2026/);
    expect(lines).toMatch(/Soon Studio\s+Fully Occupied — Available from 20 Oct 2026/);
    expect(lines).not.toMatch(STALE_TEXT);
    await expect(page.locator('#contact-intent-answer')).not.toContainText(STALE_TEXT);
  });
  test('a single selected unit headline carries no stale date', async ({ page }) => {
    await open(page, MIXED());
    await cards(page).filter({ hasText: 'Stale Studio' }).first().click();
    await page.evaluate(() => {
      const b = document.createElement('button'); b.id = 'ci-test-btn'; b.type = 'button'; b.textContent = 'availability';
      b.setAttribute('data-contact-intent', 'availability'); b.style.cssText = 'position:fixed;top:60px;right:8px;z-index:99999';
      document.body.appendChild(b);
    });
    await page.click('#ci-test-btn');
    await page.waitForTimeout(500);
    const head = await page.locator('#contact-intent-answer .ci-answer-head').innerText();
    expect(head).toMatch(/Stale Studio/);
    expect(head).not.toMatch(STALE_TEXT);
    expect(head).toMatch(/Currently Unavailable/);
  });
});

test.describe('property-level "Available <date>" (listings without unit types)', () => {
  test('rented + expired available_from (yesterday in Laos): no date line; the listing stays Rented', async ({ page }) => {
    await open(page, prop({ market_status: 'rented', available_from: EXPIRED }));
    const t = await bodyText(page);
    expect(t).not.toMatch(STALE_TEXT);
    expect(t).not.toMatch(/Available\s+13 Oct/);
    expect(t).toMatch(/rented/i);
  });
  test('rented + available_from TODAY (Laos) and a future date: the date line is shown', async ({ page }) => {
    await open(page, prop({ market_status: 'rented', available_from: TODAY }));
    expect(await bodyText(page)).toMatch(/Available\s+14 Oct 2026/);
    const p2 = await page.context().newPage();
    await open(p2, prop({ market_status: 'rented', available_from: SOON }));
    expect(await bodyText(p2)).toMatch(/Available\s+20 Oct 2026/);
    await p2.close();
  });
  test('an impossible date is never rendered', async ({ page }) => {
    await open(page, prop({ market_status: 'rented', available_from: '2026-02-31' }));
    const t = await bodyText(page);
    expect(t).not.toMatch(/Feb 2026|31 Feb|3 Mar 2026/);
  });
  test('an AVAILABLE listing with an expired available_from is still available: no date, no unavailable treatment', async ({ page }) => {
    await open(page, prop({ market_status: 'available', available_from: EXPIRED }));
    const t = await bodyText(page);
    expect(t).not.toMatch(STALE_TEXT);
    expect(t).not.toMatch(/Rented|Fully Occupied|Currently Unavailable|Sold/i);
  });
});
