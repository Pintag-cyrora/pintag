// Regression: after a successful save (or publish) admin.html scheduled a bare setTimeout(showListings, 1500/1800)
// that nothing could cancel. Anyone who tapped "+ New Listing" (or opened an Edit) in the next second and a half --
// the obvious move after "Saved ✓", especially when entering listings back to back -- was thrown back to the
// listings page when the timer fired, away from the form they had just opened. The return is now tracked and any
// other view cancels it. The normal behaviour (saving returns to the listings) is unchanged.
//
// Drives the REAL admin.html against the in-memory Supabase fake (same harness as save-integrity.spec.js).

const { test, expect } = require('@playwright/test');
const { SENTINEL, fakeBackend, boot, FILL_NEW_LISTING, SAVE, FORM_STATE } = require('./fixtures');

const panels = (page) => page.evaluate(() => ({
  listings: document.getElementById('listings-panel').style.display,
  import: document.getElementById('import-panel').style.display,
  form: document.getElementById('form-panel').style.display,
  title: document.getElementById('form-title').textContent,
  btnText: document.getElementById('submit-btn').textContent,
  btnDisabled: document.getElementById('submit-btn').disabled,
}));

async function createListingAndSeeSavedBanner(page) {
  await page.evaluate(() => { showForm(); });
  await page.evaluate(FILL_NEW_LISTING);
  await page.evaluate(SAVE);
  await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
}

test.describe('post-save return to the listings is cancelled by opening another view', () => {
  test('unchanged: with nothing else touched, a successful save returns to the listings (and re-arms the Save button)', async ({ page }) => {
    await boot(page, fakeBackend());
    await createListingAndSeeSavedBanner(page);
    expect((await panels(page)).btnText).toBe('Saved ✓');
    await expect.poll(async () => (await panels(page)).listings, { timeout: 5000 }).toBe('block');
    const p = await panels(page);
    expect(p.form).toBe('none');
    expect(p.btnText).toBe('Save Listing');
    expect(p.btnDisabled).toBe(false);
  });

  test('"+ New Listing" tapped right after "Saved ✓" stays on the new listing (was: yanked back to the list)', async ({ page }) => {
    await boot(page, fakeBackend());
    await createListingAndSeeSavedBanner(page);
    await page.locator('.btn-import').click();
    await page.fill('#import-description', 'second listing, typed while the old timer was pending');
    await page.waitForTimeout(2200);                                    // well past the old 1500 ms timer
    const p = await panels(page);
    expect(p.import).toBe('block');
    expect(p.listings).toBe('none');
    expect(await page.inputValue('#import-description')).toBe('second listing, typed while the old timer was pending');
    expect(p.btnText).toBe('Save Listing');                            // not left frozen on "Saved ✓"
    expect(p.btnDisabled).toBe(false);
  });

  test('opening the editor (Edit another listing) right after "Saved ✓" stays on that editor', async ({ page }) => {
    const other = { id: 'other-1', title_en: 'Another listing', slug: 'another', workflow_status: 'active', market_status: 'available',
      status: 'active', property_type: 'house', transaction_type: 'for_rent', contact_id: null, images: [], deleted_at: null };
    await boot(page, fakeBackend({ seedProperties: [other] }));
    await createListingAndSeeSavedBanner(page);
    await page.evaluate(() => editListing('other-1'));
    await page.waitForTimeout(2200);
    const p = await panels(page);
    expect(p.form).toBe('block');
    expect(p.listings).toBe('none');
    expect(p.title).toBe('Edit Listing');
    expect(await page.inputValue('#f-title-en')).toBe('Another listing');
  });

  test('tapping Back/Cancel during the window still returns immediately, and nothing fires twice', async ({ page }) => {
    await boot(page, fakeBackend());
    await createListingAndSeeSavedBanner(page);
    await page.evaluate(() => { window.__n = 0; const f = window.loadListings; window.loadListings = function () { window.__n++; return f.apply(this, arguments); }; });
    await page.evaluate(() => showListings());
    expect((await panels(page)).listings).toBe('block');
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => window.__n)).toBe(1);             // the cancelled timer did not call showListings() again
    expect((await panels(page)).btnText).toBe('Save Listing');
  });

  test('publishing a draft: the 1.8 s return is cancelled the same way', async ({ page }) => {
    const contact = { id: 'c-draft', role: 'owner', name: 'Owner', phone: '02055512345', whatsapp: null };
    const draft = { id: 'draft-1', title_en: 'A draft', slug: null, workflow_status: 'draft', market_status: 'available', status: 'draft',
      property_type: 'house', transaction_type: 'for_rent', contact_id: 'c-draft', images: [], deleted_at: null };
    await boot(page, fakeBackend({ seedContacts: [contact], seedProperties: [draft] }));
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => editListing('draft-1'));
    await expect.poll(() => page.evaluate(() => _editingContactId)).toBe('c-draft');
    await page.evaluate(() => publishDraft());
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msg).toContain('published');
    await page.locator('.btn-import').click();
    await page.waitForTimeout(2400);                                    // past the old 1800 ms timer
    const p = await panels(page);
    expect(p.import).toBe('block');
    expect(p.listings).toBe('none');
  });
});
