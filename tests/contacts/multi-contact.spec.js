// The real listing page, driven with a real multi-number payload.
// Unit tests prove the resolver; these prove the PAGE: that the picker renders,
// that choosing a number re-points WhatsApp/Call, and that a single-contact
// listing looks exactly like it did before.
const { test, expect } = require('@playwright/test');

const { contact, BASE, openListing } = require('./fixtures');

const THREE = Object.assign({}, BASE, {
  contacts: contact({ id: 'a', phone: '+856 20 111 1111', languages: ['lo', 'en'] }),
  property_contacts: [
    { sort_order: 2, contacts: contact({ id: 'cc', name: 'Ms. Li', phone: '+856 20 333 3333', languages: ['zh', 'en'] }) },
    { sort_order: 0, is_primary: true, contacts: contact({ id: 'a',  name: 'Somchai', phone: '+856 20 111 1111', languages: ['lo', 'en'] }) },
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
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856201111111');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
});

test('choosing the Thai number re-points BOTH WhatsApp and Call', async ({ page }) => {
  await openListing(page, THREE);
  await page.locator('.cpick-row').nth(1).click();
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856202222222/);
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856202222222');
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
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/8562055555555/);
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('a number with no languages recorded shows no language line — no guess', async ({ page }) => {
  const mixed = Object.assign({}, BASE, {
    slug: 'mixed',
    contacts: contact({ id: 'x', phone: '020111', languages: ['lo'] }),
    property_contacts: [
      { sort_order: 0, is_primary: true, contacts: contact({ id: 'x', phone: '020111', languages: ['lo'] }) },
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

// ── LANGUAGE TOGGLE -> CONTACT NUMBER ────────────────────────────────────
// The headline behaviour: the visitor picks a language with Pintag's existing
// toggle and the Call/WhatsApp actions retarget automatically. These drive the
// REAL .lang-btn controls on the real page, so a regression in setLang()'s
// re-render is caught here rather than in a unit test that can't see it.

const LANG_ROUTED = Object.assign({}, BASE, {
  slug: 'routed',
  contacts: contact({ id: 'a', phone: '+856 20 111 1111', languages: ['lo', 'en'] }),
  property_contacts: [
    { sort_order: 0, is_primary: true,  contacts: contact({ id: 'a', name: 'Somchai', phone: '+856 20 111 1111', languages: ['lo', 'en'] }) },
    { sort_order: 1, is_primary: false, contacts: contact({ id: 'b', name: 'Nok',     phone: '+856 20 222 2222', languages: ['th'] }) },
    { sort_order: 2, is_primary: false, contacts: contact({ id: 'c', name: 'Ms. Li',  phone: '+856 20 333 3333', languages: ['zh'] }) }
  ]
});

async function openAt(page, property, lang) {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: LISTING_STUB }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?slug=eq\./.test(u.toString()),
    r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([property]) }));
  await page.goto('/listing.html?slug=' + property.slug + '&lang=' + lang);
  await page.waitForSelector('.section-label', { timeout: 15000 });
  return errors;
}

test('LANG: arriving in Chinese routes the CTAs to the Chinese number', async ({ page }) => {
  const errors = await openAt(page, LANG_ROUTED, 'zh');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856203333333/);
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856203333333');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'c');
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('LANG: arriving in Lao routes to the Lao+English number', async ({ page }) => {
  await openAt(page, LANG_ROUTED, 'lo');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856201111111/);
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
});

test('LANG: ONE number serves both Lao and English', async ({ page }) => {
  await openAt(page, LANG_ROUTED, 'en');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
});

test('LANG: switching the toggle mid-visit retargets the CTAs immediately', async ({ page }) => {
  const errors = await openAt(page, LANG_ROUTED, 'en');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
  // Click the REAL language toggle, not a test-only hook.
  await page.locator('.lang-btn').filter({ hasText: /中文|ZH/i }).first().click();
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'c');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856203333333/);
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', 'tel:+856203333333');
  expect(errors, errors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('LANG: the picker preselects the routed number, so no manual choice is needed', async ({ page }) => {
  await openAt(page, LANG_ROUTED, 'zh');
  await expect(page.locator('.cpick-row.is-active')).toHaveCount(1);
  await expect(page.locator('.cpick-row').nth(2)).toHaveClass(/is-active/);
  await expect(page.locator('.cpick-label')).toContainText('中文');
});

test('LANG: with no match the CTA still works and claims no language', async ({ page }) => {
  const noZh = Object.assign({}, BASE, {
    slug: 'nozh',
    contacts: contact({ id: 'a', phone: '020111', languages: ['lo'] }),
    property_contacts: [
      { sort_order: 0, is_primary: true,  contacts: contact({ id: 'a', phone: '020111', languages: ['lo'] }) },
      { sort_order: 1, is_primary: false, contacts: contact({ id: 'b', phone: '020222', languages: ['th'] }) }
    ]
  });
  await openAt(page, noZh, 'zh');
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/85620111\b/);
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'a');
  await expect(page.locator('.cpick-label')).not.toContainText('中文');
});

test('LANG: a legacy single-number listing keeps its CTA in every language', async ({ page }) => {
  const legacy = Object.assign({}, BASE, { slug: 'legacy', contacts: contact({ id: 'solo', phone: '02055555555' }) });
  for (const l of ['lo', 'en', 'zh']) {
    await openAt(page, legacy, l);
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/8562055555555/);
    await expect(page.locator('.contact-picker')).toHaveCount(0);
  }
});
