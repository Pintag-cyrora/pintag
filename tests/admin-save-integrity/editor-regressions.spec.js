// Regression suite for the admin.html editor fixes of 2026-09-03. Same
// harness as save-integrity.spec.js: the REAL admin.html against the
// in-memory REST fake, asserting what the database would contain.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { SENTINEL, SENTINEL_ROW, fakeBackend, boot, SAVE, FORM_STATE } = require('./fixtures');

const REAL_CONTACT = { id: 'c-real', role: 'agent', name: 'Souksavanh', phone: '02055512345', whatsapp: '02055512345', party_id: null, is_verified: true, languages: ['lo'] };
const baseProp = (o) => Object.assign({
  id: 'prop-1', title_en: 'Studio House', slug: 'studio-house',
  workflow_status: 'active', market_status: 'available', status: 'active',
  property_type: 'house', transaction_type: 'for_rent', price_amount: 500, price_currency: 'USD', price_frequency: 'monthly',
  contact_id: 'c-real', images: [], deleted_at: null, owner_id: null,
}, o);
const patchOf = (backend, id) => backend.state.requests.find((r) => r.method === 'PATCH' && r.table === 'properties' && r.query.includes(id));

test('typed number fields: 0 is saved as 0 (not NULL) and a numeric column keeps its decimals on a load-then-save', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp({ bedrooms: 0, bathrooms: 1, sqm: 120.5, parking_spaces: 0 })] });
  const errors = await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-bedrooms') && document.getElementById('f-bedrooms').value)).toBe('0');
  expect(await page.evaluate(() => document.getElementById('f-sqm').value)).toBe('120.5');
  await page.evaluate(SAVE);
  const s = await page.evaluate(FORM_STATE);
  expect(s.msgClass, s.msg).toContain('success');
  const body = patchOf(backend, 'prop-1').body;
  expect(body.bedrooms).toBe(0);
  expect(body.bathrooms).toBe(1);
  expect(body.sqm).toBe(120.5);
  expect(body.parking_spaces).toBe(0);
  expect(errors).toEqual([]);
});

test('typed number fields: blank stays NULL, an integer column is still written as an integer', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp({ bedrooms: 2, sqm: null })] });
  await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-bedrooms').value)).toBe('2');
  await page.evaluate(() => { document.getElementById('f-bedrooms').value = '2.7'; document.getElementById('f-sqm').value = ''; });
  await page.evaluate(SAVE);
  const body = patchOf(backend, 'prop-1').body;
  expect(body.bedrooms).toBe(2);
  expect(body.sqm).toBeNull();
});

test.describe('PENDING sentinel contact on edit', () => {
  const draft = baseProp({ id: 'draft-1', title_en: 'Imported draft', slug: null, workflow_status: 'draft', status: 'draft', contact_id: SENTINEL });

  test('the placeholder name/phone are never loaded into the Buyer Contact form; the section is flagged for review', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW], seedProperties: [draft] });
    const errors = await boot(page, backend);
    await page.evaluate(() => editListing('draft-1'));
    await expect.poll(() => page.evaluate(() => _editingContactId)).toBe(SENTINEL);
    const f = await page.evaluate(() => ({
      name: document.getElementById('f-contact-name').value, phone: document.getElementById('f-contact-phone').value,
      wa: document.getElementById('f-contact-whatsapp').value,
      outline: document.getElementById('f-contact-phone').closest('.form-section').style.outline,
    }));
    expect(f.name).toBe(''); expect(f.phone).toBe(''); expect(f.wa).toBe('');
    expect(f.outline).toContain('rgb(184, 134, 11)');   // #B8860B amber
    expect(errors).toEqual([]);
  });

  test('publishing straight from the draft is refused: no contact carrying 0000000000 is ever created', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW], seedProperties: [draft] });
    await boot(page, backend);
    await page.evaluate(() => editListing('draft-1'));
    await expect.poll(() => page.evaluate(() => _editingContactId)).toBe(SENTINEL);
    await page.evaluate(() => { document.getElementById('f-workflow-status').value = 'active'; });
    await page.evaluate(SAVE);
    const s = await page.evaluate(FORM_STATE);
    expect(s.msgClass).toContain('error');
    expect(s.msg).toContain('Buyer Contact phone');
    expect(backend.count('POST', 'contacts')).toBe(0);
    expect(Object.values(backend.state.contacts).some((c) => c.phone === '0000000000' && c.id !== SENTINEL)).toBe(false);
    expect(backend.state.contacts[SENTINEL]).toEqual(SENTINEL_ROW);
  });
});

test('Smart Import review flags do not leak onto the next listing opened for edit', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp()] });
  await boot(page, backend);
  await page.evaluate(() => {
    showForm(null);
    applyConfidence('f-title-en', { value: 'x', confidence: 0.2 });
    flagContactSectionForReview(true);
  });
  expect(await page.evaluate(() => document.querySelectorAll('.field-low-confidence').length)).toBe(1);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-title-en').value)).toBe('Studio House');
  expect(await page.evaluate(() => ({
    low: document.querySelectorAll('.field-low-confidence').length,
    outline: document.getElementById('f-contact-phone').closest('.form-section').style.outline,
  }))).toEqual({ low: 0, outline: '' });
});

test('a short Google Maps link pasted right before Save is persisted EXPANDED, not verbatim', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp()] });
  const RESOLVED = 'https://www.google.com/maps/place/Test/@17.9757,102.6331,17z/';
  await page.route('**/functions/v1/resolve-map-url', async (r) => {
    await new Promise((res) => setTimeout(res, 600));
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved_url: RESOLVED }) });
  });
  const errors = await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-title-en').value)).toBe('Studio House');
  // blur fires resolveMapUrl on the way to the Save click; the save must wait for it
  await page.evaluate(() => { const el = document.getElementById('f-map'); el.value = 'https://maps.app.goo.gl/abc123'; resolveMapUrl(el); });
  await page.evaluate(SAVE);
  const s = await page.evaluate(FORM_STATE);
  expect(s.msgClass, s.msg).toContain('success');
  expect(patchOf(backend, 'prop-1').body.map_embed_url).toBe(RESOLVED);
  expect(errors).toEqual([]);
});

test('AI generation sends the free-text district of a non-capital listing (same resolver as save)', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp()] });
  const bodies = [];
  await page.route('**/functions/v1/smart-listing-importer', (r) => { bodies.push(r.request().postDataJSON()); r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); });
  await boot(page, backend);
  await page.evaluate(() => {
    showForm(null);
    document.getElementById('f-type').value = 'house'; renderPropertyTypeFields('house');
    document.getElementById('f-transaction').value = 'for_rent'; onTransactionChange();
    document.getElementById('f-province').value = 'Luang Prabang'; onProvinceChange();
    document.getElementById('f-district-free').value = 'Nam Bak';
  });
  await page.evaluate(() => generateAIContent());
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].description).toContain('Nam Bak');
});

test('unit-type photo upload appends to the card\'s CURRENT gallery (a removal during the upload survives)', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT] });
  const errors = await boot(page, backend);
  await page.evaluate(() => {
    showForm(null);
    addUnitType({ name_en: 'Studio', bedrooms: 0, bathrooms: 1, images: ['https://x/a.jpg', 'https://x/b.jpg'] });
    _adminToken = 'test-token';
    window._deferred = {}; window._deferred.p = new Promise((res) => { window._deferred.resolve = res; });
    window.uploadImageFileToStorage = () => window._deferred.p;
    const card = document.querySelector('.ut-card');
    const input = card.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: [new File([''], 'new.png', { type: 'image/png' })] });
    window._uploadDone = handleUnitImageUpload(input);
  });
  // While the upload is in flight the operator removes a.jpg
  await page.evaluate(() => { const card = document.querySelector('.ut-card'); _utSetUnitImages(card, _utGetUnitImages(card).filter((u) => u !== 'https://x/a.jpg')); });
  await page.evaluate(() => { window._deferred.resolve('https://x/new.jpg'); return window._uploadDone; });
  expect(await page.evaluate(() => _utGetUnitImages(document.querySelector('.ut-card')))).toEqual(['https://x/b.jpg', 'https://x/new.jpg']);
  expect(errors).toEqual([]);
});

test('a linked owner whose row did not load is kept on save, never written NULL and never PATCHed from empty fields', async ({ page }) => {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp({ owner_id: 'own-1' })] });   // owners GET answers []
  const errors = await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-owner-select').value)).toBe('own-1');
  await page.evaluate(SAVE);
  const s = await page.evaluate(FORM_STATE);
  expect(s.msgClass, s.msg).toContain('success');
  expect(patchOf(backend, 'prop-1').body.owner_id).toBe('own-1');
  expect(backend.count('PATCH', 'owners')).toBe(0);
  expect(errors).toEqual([]);
});

test('Facebook Smart Import provenance reads the fetched payload (source string is the adapter\'s, not a stale literal)', () => {
  // The provenance block is an inline IIFE inside runSmartImport(); a source
  // assertion is the cheapest guard that it keys on the fetched URL again.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'admin.html'), 'utf8');
  expect(src).not.toMatch(/importSource === 'facebook'\)/);
  expect(src).toMatch(/const _fb = fbUrl \? \(window\._importFbData \|\| \{\}\) : \{\};/);
});
