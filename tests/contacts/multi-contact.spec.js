// The real listing page, driven with a real multi-number payload.
// Unit tests prove the resolver; these prove the PAGE: that the picker renders,
// that choosing a number re-points WhatsApp/Call, and that a single-contact
// listing looks exactly like it did before.
const { test, expect } = require('@playwright/test');

const LISTING_STUB = `
window.supabase = { createClient: function() { return { auth: {
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
} }; } };
`;

const contact = (o) => Object.assign(
  { id: 'c1', role: 'agent', name: null, phone: '02011111111', whatsapp: null, is_verified: false, languages: null }, o);

const BASE = {
  id: 'p1', slug: 'multi', status: 'active', workflow_status: 'active', market_status: 'available',
  transaction_type: 'for_rent', property_type: 'apartment',
  title_en: 'Riverside', title_lo: 'Riverside', title_zh: 'Riverside',
  description_en: 'A place.', district_en: 'Sisattanak', village_en: 'Thongkang',
  images: [], features: [], amenities: [], parties: null, unit_types: [],
  price_amount: 500, price_currency: 'USD', price_frequency: 'monthly'
};

async function openListing(page, property) {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: LISTING_STUB }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?slug=eq\./.test(u.toString()),
    r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([property]) }));
  await page.goto('/listing.html?slug=' + property.slug + '&lang=en');
  await page.waitForSelector('.section-label', { timeout: 15000 });
  return errors;
}

const THREE = Object.assign({}, BASE, {
  contacts: contact({ id: 'a', phone: '+856 20 111 1111', languages: ['lo', 'en'] }),
  property_contacts: [
    { sort_order: 2, contacts: contact({ id: 'cc', name: 'Ms. Li', phone: '+856 20 333 3333', languages: ['zh', 'en'] }) },
    { sort_order: 0, contacts: contact({ id: 'a',  name: 'Somchai', phone: '+856 20 111 1111', languages: ['lo', 'en'] }) },
    { sort_order: 1, contacts: contact({ id: 'bb', name: 'Nok',     phone: '+856 20 222 2222', languages: ['th'] }) }
  ]
});

test('the picker lists every number with its own languages, in staff order', async ({ page }) => {
  const errors = await openListing(page, THREE);
  const rows = page.locator('.contact-picker .cpick-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('+856 20 111 1111');
  await expect(rows.nth(0).locator('.cpick-langs')).toHaveText('Lao, English');
  await expect(rows.nth(1)).toContainText('+856 20 222 2222');
  await expect(rows.nth(1).locator('.cpick-langs')).toHaveText('Thai');
  await expect(rows.nth(2)).toContainText('+856 20 333 3333');
  await expect(rows.nth(2).locator('.cpick-langs')).toHaveText('English, Chinese');
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('the primary is preselected and drives the CTAs before any choice', async ({ page }) => {
  await openListing(page, THREE);
  await expect(page.locator('.cpick-row.is-active')).toHaveCount(1);
  await expect(page.locator('.cpick-row').nth(0)).toHaveClass(/is-active/);
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856201111111/);
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856 20 111 1111');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
});

test('choosing the Thai number re-points BOTH WhatsApp and Call', async ({ page }) => {
  await openListing(page, THREE);
  await page.locator('.cpick-row').nth(1).click();
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856202222222/);
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856 20 222 2222');
  await expect(page.locator('.cpick-row').nth(1)).toHaveClass(/is-active/);
  await expect(page.locator('.cpick-row').nth(0)).not.toHaveClass(/is-active/);
});

test('lead attribution follows the selection — contactId changes with the number', async ({ page }) => {
  await openListing(page, THREE);
  await page.locator('.cpick-row').nth(2).click();
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'cc');
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('data-contact-id', 'cc');
});

test('the prefilled WhatsApp message survives switching numbers', async ({ page }) => {
  await openListing(page, THREE);
  const before = await page.locator('#pt-wa-primary').getAttribute('href');
  const text = before.slice(before.indexOf('?'));
  await page.locator('.cpick-row').nth(1).click();
  const after = await page.locator('#pt-wa-primary').getAttribute('href');
  expect(after.slice(after.indexOf('?'))).toBe(text);
  expect(after).not.toBe(before);
});

test('a SINGLE-contact listing renders no picker at all (unchanged UI)', async ({ page }) => {
  const one = Object.assign({}, BASE, { slug: 'single', contacts: contact({ id: 'solo', phone: '02055555555' }) });
  const errors = await openListing(page, one);
  await expect(page.locator('.contact-picker')).toHaveCount(0);
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/02055555555/);
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('a number with no languages recorded shows no language line — no guess', async ({ page }) => {
  const mixed = Object.assign({}, BASE, {
    slug: 'mixed',
    contacts: contact({ id: 'x', phone: '020111', languages: ['lo'] }),
    property_contacts: [
      { sort_order: 0, contacts: contact({ id: 'x', phone: '020111', languages: ['lo'] }) },
      { sort_order: 1, contacts: contact({ id: 'y', phone: '020222', languages: null }) }
    ]
  });
  await openListing(page, mixed);
  await expect(page.locator('.cpick-row').nth(0).locator('.cpick-langs')).toHaveText('Lao');
  await expect(page.locator('.cpick-row').nth(1).locator('.cpick-langs')).toHaveCount(0);
});

test('languages localize with the page', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: LISTING_STUB }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?slug=eq\./.test(u.toString()),
    r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([THREE]) }));
  await page.goto('/listing.html?slug=multi&lang=lo');
  await page.waitForSelector('.contact-picker', { timeout: 15000 });
  await expect(page.locator('.cpick-row').nth(0).locator('.cpick-langs')).toHaveText('ລາວ, ອັງກິດ');
  await expect(page.locator('.cpick-row').nth(1).locator('.cpick-langs')).toHaveText('ໄທ');
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});
