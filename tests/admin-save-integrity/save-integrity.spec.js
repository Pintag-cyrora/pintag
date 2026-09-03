// Regression suite for the two P1 data-integrity fixes in admin.html's
// saveListing() (data-integrity audit, 2026-09-01):
//
//   P1 #1 -- PENDING sentinel overwrite. A Smart Import draft carries
//   contact_id = the shared PENDING sentinel (…0000000000c1). When staff typed
//   the real owner's phone into that draft and saved, saveListing() PATCHed
//   the sentinel row itself, turning the placeholder every phone-less draft
//   shares into a real person. Now the sentinel is treated as "no existing
//   contact": a NEW contacts row is POSTed and the listing is pointed at it.
//
//   P1 #2 -- non-re-entrant create. After the properties POST succeeded the
//   form stayed a "new listing" form: a retry after a later partial failure
//   (unit types / phone links), or a second click on Save, POSTed a second
//   properties row, a second contacts row and a second set of unit types. Now
//   the form becomes an edit of the new row the moment the POST returns, unit
//   types get their ids written back to their cards, and Save stays disabled
//   until the listings view takes over.
//
// This drives the REAL admin.html (auth + supabase-js stubbed, exactly like
// tests/agent-visibility/admin-new-listing-reset.spec.js) against an
// in-memory fake of the Supabase REST API that records every request and
// keeps real per-table state, so the assertions are about what the database
// WOULD contain -- row counts, which row was PATCHed, what contact_id the
// listing ended up with -- not about which functions were called.

const { test, expect } = require('@playwright/test');

const { SENTINEL, SENTINEL_ROW, fakeBackend, boot, FILL_NEW_LISTING, ADD_UNIT_TYPE, SAVE, FORM_STATE } = require('./fixtures');

// ── P1 #1: the PENDING sentinel is never PATCHed ───────────────────────────
test.describe('P1 #1 — Smart Import draft on the PENDING sentinel contact', () => {
  const draft = {
    id: 'draft-1', title_en: 'Imported draft', slug: null,
    workflow_status: 'draft', market_status: 'available', status: 'draft',
    property_type: 'house', transaction_type: 'for_rent',
    contact_id: SENTINEL, images: [], deleted_at: null,
  };

  test('entering a real phone creates a NEW contact; the sentinel row is untouched; the listing points at the new row', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW], seedProperties: [draft] });
    const pageErrors = await boot(page, backend);

    await page.evaluate(() => editListing('draft-1'));
    // The draft is on the sentinel: the form tracks it (so publish stays
    // blocked) but never shows its placeholder phone as if it were a person.
    await expect.poll(() => page.evaluate(() => _editingContactId)).toBe(SENTINEL);
    expect(await page.evaluate(() => document.getElementById('f-contact-phone').value)).toBe('');

    await page.evaluate(() => {
      document.getElementById('f-contact-role').value = 'owner';
      document.getElementById('f-contact-name').value = 'Real Owner';
      document.getElementById('f-contact-phone').value = '02055512345';
      document.getElementById('f-contact-whatsapp').value = '';
    });
    await page.evaluate(SAVE);

    const s = await page.evaluate(FORM_STATE);
    expect(s.msgClass, s.msg).toContain('success');

    // 1. No write of any kind targeted the sentinel row.
    expect(backend.count('PATCH', 'contacts', SENTINEL), 'sentinel must never be PATCHed').toBe(0);
    // 2. Exactly one new contact was created, carrying the real person.
    expect(backend.count('POST', 'contacts')).toBe(1);
    const created = Object.values(backend.state.contacts).filter((c) => c.id !== SENTINEL);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ role: 'owner', name: 'Real Owner', phone: '02055512345', whatsapp: '02055512345' });
    // 3. The sentinel is byte-for-byte what was seeded.
    expect(backend.state.contacts[SENTINEL]).toEqual(SENTINEL_ROW);
    // 4. The listing now points at the new contact, in the request AND in state.
    const propPatch = backend.state.requests.find((r) => r.method === 'PATCH' && r.table === 'properties' && r.query.includes('draft-1'));
    expect(propPatch && propPatch.body.contact_id).toBe(created[0].id);
    expect(backend.state.properties['draft-1'].contact_id).toBe(created[0].id);
    // 5. The form now tracks the new contact, so a further save PATCHes it.
    expect(s.editingContactId).toBe(created[0].id);
    expect(pageErrors).toEqual([]);
  });

  test('also when OTHER drafts share the sentinel and the fork box is unchecked (the "updates all of them" path)', async ({ page }) => {
    const other = { ...draft, id: 'draft-2', title_en: 'Another imported draft' };
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW], seedProperties: [draft, other] });
    await boot(page, backend);

    await page.evaluate(() => editListing('draft-1'));
    await expect.poll(() => page.evaluate(() => _editingContactId)).toBe(SENTINEL);
    // The shared-contact warning is showing and the fork box is deliberately
    // left unchecked -- the old code took this as "PATCH the shared row".
    await expect.poll(() => page.evaluate(() => _editingContactSharedCount)).toBe(1);
    expect(await page.evaluate(() => document.getElementById('f-contact-fork').checked)).toBe(false);

    await page.evaluate(() => {
      document.getElementById('f-contact-name').value = 'Real Owner';
      document.getElementById('f-contact-phone').value = '02055512345';
    });
    await page.evaluate(SAVE);

    expect(backend.count('PATCH', 'contacts', SENTINEL)).toBe(0);
    expect(backend.count('POST', 'contacts')).toBe(1);
    expect(backend.state.contacts[SENTINEL]).toEqual(SENTINEL_ROW);
    const newId = Object.keys(backend.state.contacts).find((id) => id !== SENTINEL);
    expect(backend.state.properties['draft-1'].contact_id).toBe(newId);
    // The other draft is still on the (unchanged) sentinel -- nothing leaked into it.
    expect(backend.state.properties['draft-2'].contact_id).toBe(SENTINEL);
  });

  test('control: a draft on an ordinary (non-sentinel) contact still PATCHes that contact in place', async ({ page }) => {
    const real = { id: 'contact-real', role: 'agent', name: 'Agent A', phone: '02011111111', whatsapp: '02011111111', languages: ['lo'] };
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW, real], seedProperties: [{ ...draft, contact_id: 'contact-real' }] });
    await boot(page, backend);

    await page.evaluate(() => editListing('draft-1'));
    await expect.poll(() => page.evaluate(() => document.getElementById('f-contact-phone').value)).toBe('02011111111');
    await page.evaluate(() => { document.getElementById('f-contact-phone').value = '02022222222'; });
    await page.evaluate(SAVE);

    expect(backend.count('POST', 'contacts'), 'no new contact for an ordinary edit').toBe(0);
    expect(backend.count('PATCH', 'contacts', 'contact-real')).toBe(1);
    expect(backend.state.contacts['contact-real'].phone).toBe('02022222222');
    expect(backend.state.properties['draft-1'].contact_id).toBe('contact-real');
  });
});

// ── P1 #2: the create path is re-entrant ───────────────────────────────────
test.describe('P1 #2 — create path becomes an edit the moment the properties POST succeeds', () => {

  test('properties POST succeeds, unit type save fails, retry Save: ONE property, ONE contact, unit types not duplicated', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW], failUnitTypePosts: 1 });
    const pageErrors = await boot(page, backend);

    await page.evaluate(() => showForm(null));
    await page.evaluate(FILL_NEW_LISTING);
    await page.evaluate(ADD_UNIT_TYPE);

    // ── First Save: the properties row lands, the unit type insert fails.
    await page.evaluate(SAVE);
    let s = await page.evaluate(FORM_STATE);
    expect(s.msg).toContain('Unit Types failed to save');
    expect(backend.count('POST', 'properties')).toBe(1);
    expect(backend.count('POST', 'contacts')).toBe(1);
    const propId = Object.keys(backend.state.properties)[0];
    const contactId = Object.keys(backend.state.contacts).find((id) => id !== SENTINEL);
    expect(backend.state.properties[propId].contact_id).toBe(contactId);
    // The form is now an EDIT of the row that was just created.
    expect(s.editId, 'edit-id must hold the new property id').toBe(propId);
    expect(s.title).toBe('Edit Listing');
    expect(s.editingContactId, 'the created contact is now the form\'s contact').toBe(contactId);
    expect(s.btnDisabled, 'Save is re-enabled so the operator can retry').toBe(false);
    expect(Object.keys(backend.state.unitTypes)).toHaveLength(0);

    // ── Retry Save: everything is an update of what already exists.
    await page.evaluate(SAVE);
    s = await page.evaluate(FORM_STATE);
    expect(s.msgClass, s.msg).toContain('success');
    expect(backend.count('POST', 'properties'), 'exactly ONE properties row').toBe(1);
    expect(backend.count('PATCH', 'properties', propId)).toBe(1);
    expect(Object.keys(backend.state.properties)).toHaveLength(1);
    expect(backend.count('POST', 'contacts'), 'exactly ONE contact').toBe(1);
    expect(backend.count('PATCH', 'contacts', contactId)).toBe(1);
    expect(Object.keys(backend.state.contacts).filter((id) => id !== SENTINEL)).toHaveLength(1);
    // Two POST attempts (one failed) but exactly one unit_types row, and the
    // card now carries its id.
    expect(backend.count('POST', 'unit_types')).toBe(2);
    const utIds = Object.keys(backend.state.unitTypes);
    expect(utIds).toHaveLength(1);
    expect(backend.state.unitTypes[utIds[0]].property_id).toBe(propId);
    expect(s.unitCardIds).toEqual([utIds[0]]);
    expect(pageErrors).toEqual([]);
  });

  test('complete save succeeds, then a second Save: still exactly ONE property', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW] });
    await boot(page, backend);

    await page.evaluate(() => showForm(null));
    await page.evaluate(FILL_NEW_LISTING);
    await page.evaluate(ADD_UNIT_TYPE);
    await page.evaluate(SAVE);

    let s = await page.evaluate(FORM_STATE);
    expect(s.msgClass, s.msg).toContain('success');
    expect(s.msg).toContain('created');
    const propId = Object.keys(backend.state.properties)[0];
    expect(s.editId).toBe(propId);
    // Save stays disabled while the success message shows -- the window in
    // which a second click used to re-run the whole create.
    expect(s.btnDisabled).toBe(true);
    expect(s.btnText).not.toBe('Saving...');

    // Worst case: the save is triggered again anyway (programmatically, as an
    // implicit form submission would). It must be an update, never a create.
    await page.evaluate(SAVE);
    s = await page.evaluate(FORM_STATE);
    expect(backend.count('POST', 'properties'), 'exactly ONE property').toBe(1);
    expect(Object.keys(backend.state.properties)).toHaveLength(1);
    expect(backend.count('PATCH', 'properties', propId)).toBe(1);
    expect(backend.count('POST', 'contacts')).toBe(1);
    expect(Object.keys(backend.state.contacts).filter((id) => id !== SENTINEL)).toHaveLength(1);
    expect(backend.count('POST', 'unit_types')).toBe(1);
    expect(Object.keys(backend.state.unitTypes)).toHaveLength(1);
    expect(s.msg).toContain('updated');

    // After the post-save pause the button is restored and the list view is shown.
    await expect.poll(() => page.evaluate(() => document.getElementById('submit-btn').disabled), { timeout: 4000 }).toBe(false);
    expect(await page.evaluate(() => document.getElementById('submit-btn').textContent)).toBe('Save Listing');
    expect(await page.evaluate(() => document.getElementById('listings-panel').style.display)).toBe('block');
  });

  test('unit type POST succeeds, its id is written to the card, and a later edit PATCHes it instead of creating another', async ({ page }) => {
    const backend = fakeBackend({ seedContacts: [SENTINEL_ROW] });
    await boot(page, backend);

    await page.evaluate(() => showForm(null));
    await page.evaluate(FILL_NEW_LISTING);
    await page.evaluate(ADD_UNIT_TYPE);
    await page.evaluate(SAVE);

    let s = await page.evaluate(FORM_STATE);
    expect(s.msgClass, s.msg).toContain('success');
    const utId = Object.keys(backend.state.unitTypes)[0];
    expect(utId).toMatch(/^ut-/);
    expect(s.unitCardIds, 'the card carries the id the POST returned').toEqual([utId]);

    // Edit the unit type and save again (still on the same form).
    await page.evaluate(() => {
      const card = document.querySelector('.ut-card');
      card.querySelector('.ut-name-en').value = 'Studio Deluxe';
      _utUpdateSummary(card.querySelector('.ut-name-en'));
    });
    await page.evaluate(SAVE);
    s = await page.evaluate(FORM_STATE);
    expect(s.msgClass, s.msg).toContain('success');
    expect(backend.count('POST', 'unit_types'), 'no second unit_types insert').toBe(1);
    expect(backend.count('PATCH', 'unit_types', utId)).toBe(1);
    expect(Object.keys(backend.state.unitTypes)).toHaveLength(1);
    expect(backend.state.unitTypes[utId].name_en).toBe('Studio Deluxe');
    expect(s.unitCardIds).toEqual([utId]);
  });
});
