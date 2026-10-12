// The exact reported scenario (iPhone Safari, 2026-10-12): the Price field is focused, Return is pressed, and the page
// ends up on the Admin listings. This spec logs the event sequence the page really sees and asserts the outcome.
//
//   * which handlers run, in order: keydown (was it cancelled?) -> click on the Save button -> submit -> saveListing
//   * zero writes, still on the form, the entered value still there, nothing navigated
//   * for BOTH a brand-new Smart Import form (saves a new Draft) and an EXISTING listing opened for editing (Return would
//     PATCH that listing -- an update, not a new row, so "no draft found" is expected in that case)
//
// Chromium only (WebKit is not installable in this environment): see the report for what that does and does not prove.

const { test, expect } = require('@playwright/test');
const { fakeBackend, boot, FORM_STATE } = require('./fixtures');

const IMPORT = { title_en: 'Imported Condo', property_type: 'condo', transaction_type: 'for_sale', description_en: 'x', price_amount: 100000, bedrooms: 2, bathrooms: 1 };
const EXISTING = { id: 'p-edit', title_en: 'Existing listing', slug: 'existing', workflow_status: 'active', market_status: 'available', status: 'active',
  property_type: 'house', transaction_type: 'for_sale', price_amount: 250000, price_currency: 'USD', price_frequency: 'one_time', contact_id: 'c1', images: [], deleted_at: null };
const CONTACT = { id: 'c1', role: 'owner', name: 'Owner', phone: '02055512345', whatsapp: null };
const writes = (b) => b.state.requests.filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.table);

async function logEvents(page) {
  await page.evaluate(() => {
    window.__log = []; window.__saves = 0;
    const f = window.saveListing; window.saveListing = function () { window.__saves++; window.__log.push('saveListing()'); return f.apply(this, arguments); };
    document.getElementById('listing-form').setAttribute('onsubmit', 'saveListing(event)');
    // registered LAST, on window (bubble): sees the final defaultPrevented state of each event
    window.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__log.push('keydown Enter on #' + (e.target.id || e.target.className) + ' defaultPrevented=' + e.defaultPrevented); });
    document.getElementById('submit-btn').addEventListener('click', (e) => window.__log.push('click on Save button detail=' + e.detail));
    document.getElementById('listing-form').addEventListener('submit', (e) => window.__log.push('submit event submitter=' + (e.submitter && e.submitter.id)), true);
  });
}
async function openSmartImport(page, backend, importOverride) {
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({}, IMPORT, importOverride || {})) }));
  await logEvents(page);
  await page.locator('.btn-import').click(); await page.fill('#import-description', 'x'); await page.locator('#import-gen-btn').click();
  await page.waitForFunction(() => document.getElementById('form-panel').style.display === 'block');
}
const pricePoint = (page) => page.locator('#f-price-amount:visible, #f-sale-amount:visible').first();

async function pressReturnInPrice(page, backend) {
  const price = pricePoint(page);
  await price.fill('123456');
  await price.focus();
  await page.evaluate(() => { window.__log.length = 0; });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1900);                      // past the 1.5 s save-and-return timer
  return { log: await page.evaluate(() => window.__log), saves: await page.evaluate(() => window.__saves), price };
}

test('NEW Smart Import form: Return in Price -> keydown cancelled, no click/submit, zero writes, still on the form, value kept', async ({ page }) => {
  const backend = fakeBackend(); await boot(page, backend);
  await openSmartImport(page, backend);
  const { log, saves, price } = await pressReturnInPrice(page, backend);
  console.log('EVENT ORDER (new form):', JSON.stringify(log));
  expect(log[0]).toMatch(/^keydown Enter on #f-(price|sale)-amount defaultPrevented=true$/);   // intercepted first
  expect(log.filter((l) => /^submit event|^click on Save/.test(l))).toEqual([]);              // so the form never submitted
  expect(saves).toBe(0);
  expect(writes(backend)).toEqual([]);
  const s = await page.evaluate(() => ({ form: document.getElementById('form-panel').style.display, listings: document.getElementById('listings-panel').style.display }));
  expect(s).toEqual({ form: 'block', listings: 'none' });
  expect(await price.inputValue()).toBe('123456');
  await expect(price).toBeVisible();
});

test('EXISTING listing opened for editing: Return in Price does not PATCH it or leave the editor', async ({ page }) => {
  const backend = fakeBackend({ seedProperties: [EXISTING], seedContacts: [CONTACT] }); await boot(page, backend);
  await logEvents(page);
  await page.evaluate(() => editListing('p-edit'));
  await page.waitForFunction(() => document.getElementById('form-panel').style.display === 'block' && document.getElementById('f-title-en').value === 'Existing listing');
  const { log, saves, price } = await pressReturnInPrice(page, backend);
  console.log('EVENT ORDER (edit form):', JSON.stringify(log));
  expect(saves).toBe(0);
  expect(writes(backend)).toEqual([]);                                  // no PATCH to properties / contacts / provenance
  expect(backend.state.properties['p-edit'].price_amount).toBe(250000); // the stored listing is untouched
  expect(await page.evaluate(() => document.getElementById('form-panel').style.display)).toBe('block');
  expect(await price.inputValue()).toBe('123456');                      // what the user typed is still there, unsaved
});

// ── Defence in depth: what if iPhone Safari's soft Return key raises the submit WITHOUT a (cancellable) keydown? ──
// requestSubmit(Save button) with focus in the Price field and no pointer/keyboard activity on the button is exactly the
// engine's implicit submission minus the keydown. It must not save, while every genuine way of saving still does.
test.describe('submit-level guard', () => {
  async function setup(page) {
    const backend = fakeBackend(); await boot(page, backend);
    await openSmartImport(page, backend);
    const price = pricePoint(page); await price.fill('123456'); await price.focus();
    return { backend, price };
  }
  test('an implicit submission that bypasses keydown (requestSubmit from the Price field) saves nothing and keeps the form', async ({ page }) => {
    const { backend, price } = await setup(page);
    await page.evaluate(() => { window.__log.length = 0; document.getElementById('listing-form').requestSubmit(document.getElementById('submit-btn')); });
    await page.waitForTimeout(1900);
    const log = await page.evaluate(() => window.__log);
    console.log('EVENT ORDER (keydown bypassed):', JSON.stringify(log));
    expect(writes(backend)).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('listings-panel').style.display)).toBe('none');
    expect(await page.evaluate(() => document.getElementById('submit-btn').textContent)).toBe('Save Listing');
    expect(await price.inputValue()).toBe('123456');
  });
  test('a genuine click on Save while the Price field still has focus saves once (iOS leaves focus in the field when a button is tapped)', async ({ page }) => {
    const { backend } = await setup(page);
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });
  test('Enter on the focused Save button saves once', async ({ page }) => {
    const { backend } = await setup(page);
    await page.focus('#submit-btn'); await page.keyboard.press('Enter');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });
  test('a programmatic requestSubmit() with no submitter and a direct saveListing() call still work', async ({ page }) => {
    const { backend } = await setup(page);
    await page.evaluate(() => saveListing({ preventDefault() {} }));
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });
});
test.describe('submit-level guard on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('tapping Save with the Price field focused saves once; a keydown-less implicit submit does not', async ({ page }) => {
    // 'land': house/condo pages are currently wider than a 390px phone (pre-existing layout issue), which skews touch coordinates
    const backend = fakeBackend(); await boot(page, backend); await openSmartImport(page, backend, { property_type: 'land' });
    const price = pricePoint(page); await price.fill('123456'); await price.focus();
    await page.evaluate(() => document.getElementById('listing-form').requestSubmit(document.getElementById('submit-btn')));
    await page.waitForTimeout(500);
    expect(writes(backend)).toEqual([]);
    await page.locator('#submit-btn').tap();
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });
});
