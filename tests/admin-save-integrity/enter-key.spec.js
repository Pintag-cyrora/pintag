// Regression: pressing Return/Enter in any single-line field of the listing form used to submit the form (the browser's
// implicit submission, iPhone Safari's Return/Go key included) and run saveListing(). A Smart Import form is a Draft, which
// skips the required-field checks, so one stray Return created a listing and returned to the list ~1.5 s later.
//
// Now: Return in a single-line field writes nothing, shows no banner, does not navigate, keeps what was typed, and moves to
// the next field. Unchanged: textareas take newlines, the custom-tag box adds its tag, the Save Listing button (click or
// Enter on the focused button) saves exactly as before, and validation still blocks an incomplete Active listing.
//
// Drives the REAL admin.html against the in-memory Supabase fake (same harness as save-integrity.spec.js).

const { test, expect } = require('@playwright/test');
const { fakeBackend, boot, FILL_NEW_LISTING, FORM_STATE } = require('./fixtures');

const IMPORT = { title_en: 'Imported Condo', property_type: 'condo', transaction_type: 'for_sale', description_en: 'x', price_amount: 100000, bedrooms: 2, bathrooms: 1 };
const AGENT = { id: 'agent-k', name_en: 'Keomany', whatsapp: '+85620 5551234', agency_name: 'Pintag', is_active: true };
const writes = (b) => b.state.requests.filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.table);

async function instrument(page) {
  await page.evaluate(() => {
    window.__saves = 0;
    const f = window.saveListing; window.saveListing = function () { window.__saves++; return f.apply(this, arguments); };
    document.getElementById('listing-form').setAttribute('onsubmit', 'saveListing(event)');   // re-resolve the wrapped global
  });
}
// The Smart Import path: "+ New Listing" -> Generate -> the form arrives as a DRAFT (no required-field checks).
async function openSmartImportForm(page) {
  const backend = fakeBackend(); await boot(page, backend);
  await page.route('**/rest/v1/parties*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([AGENT]) }));
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(IMPORT) }));
  await instrument(page);
  await page.evaluate(() => loadAgentsForDropdown());                // the harness booted before the agents route existed
  await page.locator('.btn-import').click();
  await page.fill('#import-description', 'two bedroom condo');
  await page.locator('#import-gen-btn').click();
  await page.waitForFunction(() => document.getElementById('form-panel').style.display === 'block');
  await page.waitForFunction((id) => !!document.querySelector('#f-agent-id option[value="' + id + '"]'), AGENT.id);
  expect(await page.inputValue('#f-workflow-status')).toBe('draft');
  return backend;
}
async function openBlankForm(page) {
  const backend = fakeBackend(); await boot(page, backend); await instrument(page);
  await page.evaluate(() => { showForm(); });
  return backend;
}
// Press Return in `locator` and prove nothing happened -- waiting past the old 1.5 s save-and-return timer.
async function returnDoesNothing(page, backend, locator, expectValue) {
  await locator.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1900);
  const s = await page.evaluate(() => ({
    saves: window.__saves, form: document.getElementById('form-panel').style.display, listings: document.getElementById('listings-panel').style.display,
    msg: document.getElementById('form-message').style.display === 'block' ? document.getElementById('form-message').textContent : '',
    btn: document.getElementById('submit-btn').textContent,
  }));
  expect(s.saves, 'saveListing must not run').toBe(0);
  expect(writes(backend), 'no record may be written').toEqual([]);
  expect(s.form).toBe('block'); expect(s.listings).toBe('none');   // still on the form
  expect(s.msg).toBe('');                                          // no "created" or validation banner
  expect(s.btn).toBe('Save Listing');
  if (expectValue !== undefined) expect(await locator.inputValue()).toBe(expectValue);
}

test.describe('Return in a single-line field never saves (Smart Import draft form)', () => {
  test('Title', async ({ page }) => { const b = await openSmartImportForm(page); await page.fill('#f-title-en', 'Typed title'); await returnDoesNothing(page, b, page.locator('#f-title-en'), 'Typed title'); });
  test('agent search box', async ({ page }) => { const b = await openSmartImportForm(page); await page.fill('#f-agent-search', 'Keo'); await returnDoesNothing(page, b, page.locator('#f-agent-search'), 'Keo'); });
  test('Price (number)', async ({ page }) => { const b = await openSmartImportForm(page); await page.fill('#f-sale-amount, #f-price-amount', '123456').catch(() => {}); const price = page.locator('#f-price-amount:visible, #f-sale-amount:visible').first(); await price.fill('123456'); await returnDoesNothing(page, b, price, '123456'); });
  test('Contact phone', async ({ page }) => { const b = await openSmartImportForm(page); await page.fill('#f-contact-phone', '02055512345'); await returnDoesNothing(page, b, page.locator('#f-contact-phone'), '02055512345'); });
  test('Village and date fields', async ({ page }) => { const b = await openSmartImportForm(page); await page.fill('#f-village', 'Thongkang'); await returnDoesNothing(page, b, page.locator('#f-village'), 'Thongkang'); await returnDoesNothing(page, b, page.locator('#f-available-from')); });
  test('Unit Type name, bedrooms and price', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.locator('.btn-add-row', { hasText: 'Add Unit Type' }).click();
    const card = page.locator('.ut-card').first(); await card.locator('.ut-head').click();
    await card.locator('.ut-name-en').fill('1 Bedroom');
    await returnDoesNothing(page, b, card.locator('.ut-name-en'), '1 Bedroom');
    await returnDoesNothing(page, b, card.locator('.ut-bedrooms'));
    await returnDoesNothing(page, b, card.locator('.ut-price-amount'));
    expect(await page.locator('.ut-card').count()).toBe(1);                       // the card is still there, unsaved
  });
  test('dynamically added fields: extra phone number and a nearby place', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.evaluate(() => addExtraContact());
    const extra = page.locator('#extra-contacts-list input[type="text"]').first();
    await extra.fill('02099999999'); await returnDoesNothing(page, b, extra, '02099999999');
    const nearby = page.locator('#nearby-list input').first();
    await nearby.fill('That Luang'); await returnDoesNothing(page, b, nearby);   // value not asserted: this field has its own input handler
  });
  test('Return moves to the next field (the iPhone "Next" behaviour) and the keyboard hint says so', async ({ page }) => {
    await openSmartImportForm(page);
    await page.fill('#f-title-en', 'x');
    await page.focus('#f-title-en');
    expect(await page.getAttribute('#f-title-en', 'enterkeyhint')).toBe('next');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe('f-title-en');
    expect(await page.evaluate(() => !!document.activeElement.closest('#listing-form'))).toBe(true);
  });
});

test.describe('what must keep working', () => {
  test('a textarea still takes newlines and does not submit', async ({ page }) => {
    const b = await openSmartImportForm(page);
    const ta = page.locator('#f-desc-en'); await ta.fill('');
    await ta.focus(); await page.keyboard.type('line one'); await page.keyboard.press('Enter'); await page.keyboard.type('line two');
    await page.waitForTimeout(1900);
    expect(await ta.inputValue()).toBe('line one\nline two');
    expect(await page.evaluate(() => window.__saves)).toBe(0);
    expect(writes(b)).toEqual([]);
  });

  test('the custom-tag box still adds its tag on Return, and nothing is saved', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.focus('#custom-tag-input'); await page.keyboard.type('Sea view'); await page.keyboard.press('Enter');
    await expect(page.locator('#highlights-custom .tag-custom-pill')).toHaveText(/Sea view/);
    expect(await page.inputValue('#custom-tag-input')).toBe('');
    await page.waitForTimeout(1900);
    expect(await page.evaluate(() => window.__saves)).toBe(0);
    expect(writes(b)).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('form-panel').style.display)).toBe('block');
  });

  test('invalid Active form: Return shows nothing and writes nothing; the Save button still shows the same validation banner', async ({ page }) => {
    const b = await openBlankForm(page);
    await page.fill('#f-title-en', 'abc');
    await returnDoesNothing(page, b, page.locator('#f-title-en'), 'abc');
    await page.click('#submit-btn');
    const s = await page.evaluate(FORM_STATE);
    expect(s.msgClass).toContain('error');
    expect(s.msg).toContain('Required before publishing: Property Type, Transaction, Buyer Contact phone.');
    expect(writes(b)).toEqual([]);
  });

  test('complete Active form: Return does not save; the Save button then saves exactly once and returns to the list', async ({ page }) => {
    const b = await openBlankForm(page);
    await page.evaluate(FILL_NEW_LISTING);
    await returnDoesNothing(page, b, page.locator('#f-contact-phone'), '02055512345');
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    await expect.poll(() => page.evaluate(() => document.getElementById('listings-panel').style.display), { timeout: 4000 }).toBe('block');
    expect(b.count('POST', 'properties')).toBe(1);
    expect(b.count('POST', 'contacts')).toBe(1);
    expect(Object.keys(b.state.properties)).toHaveLength(1);
  });

  test('Smart Import draft: the Save button still saves it once (drafts skip required-field checks, as before)', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(b.count('POST', 'properties')).toBe(1);
  });

  test('Enter on the focused Save button still activates it (keyboard users)', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.focus('#submit-btn'); await page.keyboard.press('Enter');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(b.count('POST', 'properties')).toBe(1);
  });
});

test.describe('on a phone-sized touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('Return in Title (the iPhone keyboard Return/Go key) does not save or navigate', async ({ page }) => {
    const b = await openSmartImportForm(page);
    await page.fill('#f-title-en', 'Phone typing');
    await returnDoesNothing(page, b, page.locator('#f-title-en'), 'Phone typing');
  });
});
