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

const SENTINEL = '00000000-0000-0000-0000-0000000000c1';
const SENTINEL_ROW = Object.freeze({
  id: SENTINEL, role: 'other', name: 'PENDING — Pintag staff to confirm buyer contact',
  phone: '0000000000', whatsapp: null, party_id: null, is_verified: false, languages: null,
});

// ── In-memory Supabase REST fake ───────────────────────────────────────────
// Only the tables saveListing()/editListing() write are modelled with state;
// everything else (parties, owners, leads, provenance, links) answers [].
function fakeBackend(opts) {
  opts = opts || {};
  const state = {
    requests: [],            // every REST call: { method, table, query, body }
    properties: {}, contacts: {}, unitTypes: {},
    seq: 0,
    failUnitTypePosts: opts.failUnitTypePosts || 0,   // first N unit_types POSTs return 500
  };
  (opts.seedProperties || []).forEach((p) => { state.properties[p.id] = { ...p }; });
  (opts.seedContacts   || []).forEach((c) => { state.contacts[c.id]   = { ...c }; });

  const embed = (p) => ({
    ...p,
    contacts: p.contact_id ? (state.contacts[p.contact_id] || null) : null,
    property_contacts: [],
    unit_types: [],
  });

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = null; }
    state.requests.push({ method, table, query: url.search, body });
    const json = (status, data) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data),
    });
    const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '');
    const idEq = eq('id');

    if (table === 'properties') {
      if (method === 'GET') {
        if (idEq) return json(200, state.properties[idEq] ? [embed(state.properties[idEq])] : []);
        const cEq = eq('contact_id');
        if (cEq) return json(200, Object.values(state.properties)
          .filter((p) => p.contact_id === cEq).map((p) => ({ id: p.id })));
        return json(200, []);
      }
      if (method === 'POST') {
        const id = 'prop-' + (++state.seq);
        state.properties[id] = { id, ...body };
        return json(201, [state.properties[id]]);
      }
      if (method === 'PATCH') {
        const p = state.properties[idEq];
        if (!p) return json(200, []);
        Object.assign(p, body);
        return json(200, [p]);
      }
    }
    if (table === 'contacts') {
      if (method === 'GET') return json(200, (idEq && state.contacts[idEq]) ? [{ id: idEq }] : []);
      if (method === 'POST') {
        const id = (body && body.id) || ('contact-' + (++state.seq));
        state.contacts[id] = { id, ...body };
        return json(201, [state.contacts[id]]);
      }
      if (method === 'PATCH') {
        const c = state.contacts[idEq];
        if (c) Object.assign(c, body);
        return json(200, c ? [c] : []);
      }
    }
    if (table === 'unit_types') {
      if (method === 'POST') {
        if (state.failUnitTypePosts > 0) {
          state.failUnitTypePosts--;
          return json(500, { message: 'simulated unit_types insert failure' });
        }
        const id = 'ut-' + (++state.seq);
        state.unitTypes[id] = { id, ...body };
        return json(201, [state.unitTypes[id]]);
      }
      if (method === 'PATCH') {
        const u = state.unitTypes[idEq];
        if (u) Object.assign(u, body);
        return json(200, u ? [u] : []);
      }
      if (method === 'DELETE') { delete state.unitTypes[idEq]; return json(200, []); }
    }
    return json(200, []);
  }

  const count = (method, table, queryIncludes) => state.requests.filter((r) =>
    r.method === method && r.table === table &&
    (queryIncludes === undefined || r.query.includes(queryIncludes))).length;

  return { state, handle, count };
}

// Boot admin.html without real auth or the supabase-js CDN.
async function boot(page, backend) {
  await page.route('**/cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript',
      body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),refreshSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}},storage:{from:function(){return {upload:async()=>({}),getPublicUrl:function(){return {data:{publicUrl:""}};}};}}};}};' }));
  await page.route('**/admin-auth.js*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript',
      body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"test-token",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));
  await page.route('**/rest/v1/**', backend.handle);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/admin.html');
  await page.waitForFunction(() => typeof window.saveListing === 'function'
    && typeof window.editListing === 'function'
    && typeof window.showForm === 'function'
    && typeof window.addUnitType === 'function');
  return pageErrors;
}

// Fills a complete, publishable new listing (workflow=active so the required-
// field validation in saveListing() is exercised, not skipped).
const FILL_NEW_LISTING = () => {
  document.getElementById('f-type').value = 'house';
  renderPropertyTypeFields('house');
  document.getElementById('f-transaction').value = 'for_rent';
  onTransactionChange();
  document.getElementById('f-workflow-status').value = 'active';
  document.getElementById('f-title-en').value = 'Integrity Test House';
  document.getElementById('f-price-amount').value = '500';
  document.getElementById('f-contact-role').value = 'owner';
  document.getElementById('f-contact-name').value = 'Real Owner';
  document.getElementById('f-contact-phone').value = '02055512345';
};
const ADD_UNIT_TYPE = () => addUnitType({
  name_en: 'Studio', bedrooms: 0, bathrooms: 1,
  price_amount: 300, price_currency: 'USD', price_frequency: 'monthly',
  is_available: true, available_count: 1, sort_order: 0,
});
const SAVE = () => saveListing({ preventDefault() {} });
const FORM_STATE = () => ({
  editId: document.getElementById('edit-id').value,
  title: document.getElementById('form-title').textContent,
  msg: document.getElementById('form-message').textContent,
  msgClass: document.getElementById('form-message').className,
  btnDisabled: document.getElementById('submit-btn').disabled,
  btnText: document.getElementById('submit-btn').textContent,
  unitCardIds: [...document.querySelectorAll('.ut-card')].map((c) => c.dataset.id || null),
  editingContactId: _editingContactId,
});

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
    // The draft loaded the sentinel's placeholder phone into the form -- this
    // is the exact state in which the old code PATCHed the sentinel.
    await expect.poll(() => page.evaluate(() => document.getElementById('f-contact-phone').value)).toBe('0000000000');
    expect(await page.evaluate(() => _editingContactId)).toBe(SENTINEL);

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
    await expect.poll(() => page.evaluate(() => document.getElementById('f-contact-phone').value)).toBe('0000000000');
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
