// Shared harness for the admin-save-integrity suite: the in-memory Supabase
// REST fake, the admin.html boot (auth + supabase-js stubbed) and the form
// helpers every spec here drives the REAL admin.html with.

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


module.exports = { SENTINEL, SENTINEL_ROW, fakeBackend, boot, FILL_NEW_LISTING, ADD_UNIT_TYPE, SAVE, FORM_STATE };
