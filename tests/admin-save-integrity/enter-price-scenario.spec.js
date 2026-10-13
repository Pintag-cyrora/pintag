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
const { fakeBackend, boot, FORM_STATE, FILL_NEW_LISTING } = require('./fixtures');

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

// ── The 1.5 s activity window and the click-level cancel: edge cases ─────────────────────────────────────────────
test.describe('submit-level guard: false-positive and bypass edge cases', () => {
  async function setup(page, opts) {
    opts = opts || {};
    const backend = fakeBackend(); await boot(page, backend);
    await openSmartImport(page, backend, opts.import);
    const price = pricePoint(page); await price.fill('123456'); await price.focus();
    // iOS Safari does not move focus to a button on tap, so the field keeps focus; mimic that for mouse presses.
    await page.evaluate(() => document.getElementById('submit-btn').addEventListener('mousedown', (e) => e.preventDefault()));
    return { backend, price };
  }
  const bypassKeydown = (page) => page.evaluate(() => window.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopImmediatePropagation(); }, true));

  test('keydown NEVER reaches the guard (stopped before it) -> the engine\'s implicit click is cancelled: no submit, no save, form kept', async ({ page }) => {
    const { backend, price } = await setup(page);
    await bypassKeydown(page);
    await page.evaluate(() => { window.__log.length = 0; });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1900);
    const log = await page.evaluate(() => window.__log);
    console.log('EVENT ORDER (keydown stopped before the guard):', JSON.stringify(log));
    expect(log.filter((l) => /^click on Save/.test(l)).length).toBe(1);        // the engine did click Save for the user...
    expect(log.filter((l) => /^submit event|^saveListing/.test(l))).toEqual([]);   // ...but the click was cancelled
    expect(writes(backend)).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('form-panel').style.display)).toBe('block');
    expect(await price.inputValue()).toBe('123456');
  });

  test('same on an EXISTING listing: no PATCH, still in the editor', async ({ page }) => {
    const backend = fakeBackend({ seedProperties: [EXISTING], seedContacts: [CONTACT] }); await boot(page, backend);
    await logEvents(page);
    await page.evaluate(() => editListing('p-edit'));
    await page.waitForFunction(() => document.getElementById('f-title-en').value === 'Existing listing');
    const price = pricePoint(page); await price.fill('999999'); await price.focus();
    await bypassKeydown(page);
    await page.keyboard.press('Enter'); await page.waitForTimeout(1900);
    expect(writes(backend)).toEqual([]);
    expect(backend.state.properties['p-edit'].price_amount).toBe(250000);
    expect(await page.evaluate(() => document.getElementById('form-panel').style.display)).toBe('block');
  });

  test('a LONG press on Save (held 2.2 s, longer than the window) with focus still in the Price field still saves once', async ({ page }) => {
    const { backend } = await setup(page);
    await page.locator('#submit-btn').scrollIntoViewIfNeeded();
    const box = await page.locator('#submit-btn').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(2200); await page.mouse.up();
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });

  test('assistive-style activation: a click with detail>0 but no pointer/touch events, focus still in a field, saves once', async ({ page }) => {
    const { backend } = await setup(page);
    await page.evaluate(() => document.getElementById('submit-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });

  test('Space on the focused Save button saves once', async ({ page }) => {
    const backend = fakeBackend(); await boot(page, backend); await openSmartImport(page, backend);
    await page.focus('#submit-btn'); await page.keyboard.press('Space');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });

  // Counts how many times the app navigates back to the listings (the post-save timer) -- the "jumped back to Admin" symptom.
  const countNavigation = (page) => page.evaluate(() => {
    window.__nav = 0; const f = window.showListings;
    window.showListings = function () { window.__nav++; return f.apply(this, arguments); };
  });

  test('SINGLE-USE on a VALID form: a genuine Save consumes the activity, so an implicit submit right after cannot save again (1 write, 1 navigation)', async ({ page }) => {
    const { backend } = await setup(page);
    await countNavigation(page);
    await page.click('#submit-btn');                                         // genuine press on a complete, valid form
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    const afterSave = writes(backend);
    expect(backend.count('POST', 'properties')).toBe(1);
    await page.focus('#f-title-en');                                         // focus in a text field, well inside the 1.5 s window
    await page.evaluate(() => document.getElementById('listing-form').requestSubmit(document.getElementById('submit-btn')));
    await page.waitForTimeout(300);
    expect(writes(backend)).toEqual(afterSave);                              // the implicit submit added NOTHING (no PATCH, no second POST)
    await page.waitForTimeout(1900);
    expect(await page.evaluate(() => window.__nav)).toBe(1);                 // and exactly one navigation: the normal post-save return
    expect(backend.count('POST', 'properties')).toBe(1);
    expect(backend.count('PATCH', 'properties')).toBe(0);
  });

  test('REPEATED Return presses (keydown guard defeated): three implicit submissions, zero writes, zero navigation, value kept', async ({ page }) => {
    const { backend, price } = await setup(page);
    await bypassKeydown(page); await countNavigation(page);
    await page.evaluate(() => { window.__log.length = 0; });
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
    await page.waitForTimeout(1900);
    const log = await page.evaluate(() => window.__log);
    expect(log.filter((l) => /^click on Save/.test(l)).length).toBe(3);
    expect(log.filter((l) => /^submit event|^saveListing/.test(l))).toEqual([]);
    expect(writes(backend)).toEqual([]);
    expect(await page.evaluate(() => window.__nav)).toBe(0);
    expect(await page.evaluate(() => document.getElementById('form-panel').style.display)).toBe('block');
    expect(await price.inputValue()).toBe('123456');
  });

  test('REPEATED Return presses with the keydown guard working: zero writes, zero navigation', async ({ page }) => {
    const { backend, price } = await setup(page);
    await countNavigation(page);
    for (let i = 0; i < 3; i++) { await price.focus(); await page.keyboard.press('Enter'); }
    await page.waitForTimeout(1900);
    expect(writes(backend)).toEqual([]);
    expect(await page.evaluate(() => window.__nav)).toBe(0);
  });

  test('FAILED validation, then a Return inside the window (blocked), then a deliberate Save of the corrected form: saves exactly once', async ({ page }) => {
    const backend = fakeBackend(); await boot(page, backend); await logEvents(page);
    await page.evaluate(() => { showForm(); });                              // blank Active form: validation fails
    await page.evaluate(() => document.getElementById('submit-btn').addEventListener('mousedown', (e) => e.preventDefault()));
    await page.fill('#f-title-en', 'abc');
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('error');
    expect(writes(backend)).toEqual([]);
    await bypassKeydown(page);
    await page.focus('#f-title-en'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);   // implicit submit riding the failed press
    expect(writes(backend)).toEqual([]);
    await page.evaluate(FILL_NEW_LISTING);                                   // the user fixes the form...
    await page.click('#submit-btn');                                         // ...and deliberately saves
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
  });

  test('a REFUSED implicit submit never poisons the next deliberate Save, and tells the user (aria-live) that nothing was saved', async ({ page }) => {
    const { backend } = await setup(page);
    await page.evaluate(() => document.getElementById('listing-form').requestSubmit(document.getElementById('submit-btn')));
    await page.waitForTimeout(200);
    expect(writes(backend)).toEqual([]);
    const note = page.locator('#save-guard-note');
    await expect(note).toHaveText(/Nothing was saved/);
    expect(await note.getAttribute('role')).toBe('status');
    expect(await note.getAttribute('aria-live')).toBe('polite');
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
    await expect(note).toHaveText('');                                       // cleared as soon as Save is pressed
  });

  test('BACK-TO-BACK deliberate saves of an existing listing: two clicks 1 s apart in one window still save once; a later Save after the return saves again', async ({ page }) => {
    const backend = fakeBackend({ seedProperties: [EXISTING], seedContacts: [CONTACT] }); await boot(page, backend); await logEvents(page);
    await countNavigation(page);
    await page.evaluate(() => editListing('p-edit'));
    await page.waitForFunction(() => document.getElementById('f-title-en').value === 'Existing listing');
    await page.evaluate(() => document.getElementById('submit-btn').addEventListener('mousedown', (e) => e.preventDefault()));
    const price = pricePoint(page); await price.fill('260000'); await price.focus();
    await page.click('#submit-btn');
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    await page.locator('#submit-btn').click({ force: true });                // second click while "Saved ✓" is disabled: nothing
    await page.waitForTimeout(1900);
    expect(backend.count('PATCH', 'properties')).toBe(1);
    expect(await page.evaluate(() => window.__nav)).toBe(1);
    await page.evaluate(() => editListing('p-edit'));                         // open it again and save again: a new deliberate press
    await page.waitForFunction(() => document.getElementById('listings-panel').style.display === 'none' && document.getElementById('f-title-en').value === 'Existing listing');
    await page.evaluate(() => document.getElementById('submit-btn').addEventListener('mousedown', (e) => e.preventDefault()));
    await pricePoint(page).focus();
    await page.click('#submit-btn');
    await expect.poll(async () => backend.count('PATCH', 'properties')).toBe(2);
  });

  test('an old, unused press (no submit followed) expires: after 1.5 s an implicit submit is blocked again', async ({ page }) => {
    const { backend } = await setup(page);
    await page.evaluate(() => document.getElementById('submit-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));   // a press that never became a click
    await page.waitForTimeout(1700);
    await page.evaluate(() => document.getElementById('listing-form').requestSubmit(document.getElementById('submit-btn')));
    await page.waitForTimeout(500);
    expect(writes(backend)).toEqual([]);
  });
});
