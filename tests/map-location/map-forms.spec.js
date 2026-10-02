// add-property.html and edit-listing.html: the Google Maps link field.
//
// Both agent-facing pages previously had no way to set a map location, so every
// listing created or edited there depended on staff adding one in admin.html.
// They now carry the same field, classify the link the same way (exact / named
// place / unusable), expand short links the same way, and save the same column.
//
// The invariant that matters most on EDIT: saving any OTHER field must never send
// map_embed_url (and certainly not NULL), so a stored link cannot be wiped by accident.
const { test, expect } = require('@playwright/test');

const PLACE_ID = '0x3123456789abcdef:0x7f9e8d7c6b5a4f3e';
const PLACE = 'https://www.google.com/maps?q=Lao+Plaza+Hotel,+Vientiane&ftid=' + PLACE_ID + '&entry=gps';
const EXACT = 'https://www.google.com/maps?q=17.9757,102.6331';

const PROPERTY = (over) => Object.assign({
  id: 'prop-1', title_en: 'Riverside House', title_lo: 'Riverside House', transaction_type: 'for_rent',
  price_amount: 500, price_currency: 'USD', price_frequency: 'monthly', description_lo: 'desc', district_lo: 'Sisattanak', village_lo: 'Thongkang',
  workflow_status: 'active', market_status: 'available', property_type: 'house', amenities: [], images: [],
  contact_id: 'c1', owner_id: null, rental_terms: null, map_embed_url: null,
  contacts: { id: 'c1', name: 'Souksavanh', phone: '02055512345' },
}, over);

// A permissive in-page stand-in for supabase-js: records every write, answers reads from a seed.
const FAKE_SUPABASE = `
window.__calls = [];
function __mk(table){
  var st = { table: table, op: 'select', filters: {}, payload: null, single: false };
  var b = {
    select: function(){ if (st.op !== 'select') st.returning = true; return b; },
    insert: function(p){ st.op = 'insert'; st.payload = p; return b; },
    update: function(p){ st.op = 'update'; st.payload = p; return b; },
    upsert: function(p){ st.op = 'upsert'; st.payload = p; return b; },
    delete: function(){ st.op = 'delete'; return b; },
    eq: function(k, v){ st.filters[k] = v; return b; },
    neq: function(){ return b; }, in: function(){ return b; }, is: function(){ return b; }, or: function(){ return b; },
    order: function(){ return b; }, limit: function(){ return b; }, range: function(){ return b; },
    single: function(){ st.single = true; return b; }, maybeSingle: function(){ st.single = true; return b; },
    then: function(res, rej){ var out; try { out = window.__resolve(st); } catch (e) { return Promise.reject(e).then(res, rej); } return Promise.resolve(out).then(res, rej); }
  };
  return b;
}
window.__resolve = function(st){
  window.__calls.push({ table: st.table, op: st.op, payload: st.payload, filters: st.filters });
  var one = function(v){ return { data: v, error: null }; };
  if (st.table === 'properties') {
    if (st.op === 'select' && st.single) return one(window.__seed && window.__seed.property || null);
    if (st.op === 'select') return { data: window.__seed && window.__seed.property ? [{ id: window.__seed.property.id }] : [], error: null };
    if (st.op === 'insert') return { data: [{ id: 'new-prop' }], error: null };
    return { data: null, error: null };
  }
  if (st.table === 'parties') return st.single ? one({ id: 'party-1' }) : { data: [{ id: 'party-1' }], error: null };
  if (st.table === 'contacts' && st.op === 'insert') return { data: [{ id: 'c-new' }], error: null };
  return { data: st.single ? null : [], error: null };
};
window.supabase = { createClient: function(){ return {
  auth: {
    getSession: async function(){ return { data: { session: { access_token: 'agent-token' } } }; },
    getUser: async function(){ return { data: { user: { id: 'u1' } } }; },
    onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; }
  },
  from: __mk,
  storage: { from: function(){ return { upload: async function(){ return { error: null }; }, getPublicUrl: function(){ return { data: { publicUrl: 'x' } }; } }; } },
  rpc: async function(){ return { data: null, error: null }; }
}; } };
`;

async function open(page, url, seed) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => { window.__seed = s; }, seed || {});
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/fonts.g*apis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(url);
  return errors;
}
const calls = (page, table, op) => page.evaluate(([t, o]) => window.__calls.filter((c) => c.table === t && c.op === o), [table, op]);
const hint = (page) => page.locator('#mapHint');
const paste = (page, v) => page.evaluate((val) => { const el = document.getElementById('mapEmbedUrl'); el.value = val; el.dispatchEvent(new Event('input')); }, v);
const blur = (page) => page.evaluate(() => document.getElementById('mapEmbedUrl').dispatchEvent(new Event('blur')));
const settle = (page) => page.waitForTimeout(150);

// ═════════════════════════ edit-listing.html ═════════════════════════
test.describe('edit-listing.html', () => {
  const URL = '/edit-listing.html?id=prop-1';
  const loaded = async (page, stored) => {
    const errors = await open(page, URL, { property: PROPERTY({ map_embed_url: stored }) });
    await expect.poll(() => page.evaluate(() => document.getElementById('title').value)).toBe('Riverside House');
    return errors;
  };
  const save = async (page) => { await page.evaluate(() => saveProperty()); await settle(page); };

  test('the field exists, is optional, and is prefilled from the listing with its classification', async ({ page }) => {
    const errors = await loaded(page, PLACE);
    await expect(page.locator('#mapEmbedUrl')).toBeVisible();
    await expect(page.locator('#mapEmbedUrl')).toHaveValue(PLACE);
    await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
    await expect(hint(page)).toContainText('Named place');
    await expect(hint(page)).toContainText('Lao Plaza Hotel, Vientiane');
    expect(errors).toEqual([]);
  });

  test('a listing with no link starts empty', async ({ page }) => {
    await loaded(page, null);
    await expect(page.locator('#mapEmbedUrl')).toHaveValue('');
    await expect(hint(page)).toHaveAttribute('data-map-state', 'empty');
  });

  test('INVARIANT: editing an unrelated field never sends map_embed_url (a stored link is not overwritten)', async ({ page }) => {
    await loaded(page, PLACE);
    await page.evaluate(() => { document.getElementById('title').value = 'Renamed House'; });
    await save(page);
    const upd = await calls(page, 'properties', 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].payload.title_en).toBe('Renamed House');
    expect('map_embed_url' in upd[0].payload).toBe(false);
  });

  test('INVARIANT: the same holds for a listing that has NO link (blank is not sent as NULL)', async ({ page }) => {
    await loaded(page, null);
    await page.evaluate(() => { document.getElementById('title').value = 'Renamed House'; });
    await save(page);
    const upd = await calls(page, 'properties', 'update');
    expect('map_embed_url' in upd[0].payload).toBe(false);
  });

  test('INVARIANT: if the listing failed to load, saving cannot touch the link', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.dismiss());
    await page.addInitScript(() => { window.__seed = { property: null }; });
    await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.goto(URL);
    await settle(page);
    const change = await page.evaluate(() => { document.getElementById('mapEmbedUrl').value = 'https://www.google.com/maps?q=17.9,102.6'; return mapField.changeFor(); });
    expect(change).toBeNull();
  });

  test('changing the link to a named place saves exactly that URL', async ({ page }) => {
    await loaded(page, EXACT);
    await paste(page, PLACE);
    await save(page);
    const upd = await calls(page, 'properties', 'update');
    expect(upd[0].payload.map_embed_url).toBe(PLACE);
  });

  test('changing the link to an exact location saves it; an unusable link warns but is not blocked', async ({ page }) => {
    await loaded(page, null);
    await paste(page, 'https://www.google.com/maps?q=17.9757, 102.6331');
    await expect(hint(page)).toHaveAttribute('data-map-state', 'exact');
    await expect(hint(page)).toContainText('Exact location');
    await paste(page, 'https://www.google.com/maps?q=apartments+in+Vientiane');
    await expect(hint(page)).toHaveAttribute('data-map-state', 'invalid');
    await expect(hint(page)).toContainText('Unusable link');
    await save(page);
    const upd = await calls(page, 'properties', 'update');
    expect(upd[0].payload.map_embed_url).toBe('https://www.google.com/maps?q=apartments+in+Vientiane');
  });

  test('clearing a stored link needs confirmation: declining aborts the save without touching it', async ({ page }) => {
    await loaded(page, PLACE);
    let asked = 0;
    page.on('dialog', (d) => { asked++; d.dismiss(); });
    await paste(page, '');
    await save(page);
    expect(asked).toBe(1);
    expect(await calls(page, 'properties', 'update')).toHaveLength(0);
  });

  test('clearing a stored link and confirming writes NULL', async ({ page }) => {
    await loaded(page, PLACE);
    page.on('dialog', (d) => d.accept());
    await paste(page, '');
    await save(page);
    const upd = await calls(page, 'properties', 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].payload.map_embed_url).toBeNull();
  });

  test('a short link is expanded through resolve-map-url (with the agent session token) and the expanded URL is saved', async ({ page }) => {
    let auth = null;
    await page.route('**/functions/v1/resolve-map-url', (r) => { auth = r.request().headers()['authorization']; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved_url: PLACE }) }); });
    await loaded(page, null);
    await paste(page, 'https://maps.app.goo.gl/AbCdEf');
    await blur(page);
    await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
    await expect(page.locator('#mapEmbedUrl')).toHaveValue(PLACE);
    expect(auth).toBe('Bearer agent-token');
    await save(page);
    expect((await calls(page, 'properties', 'update'))[0].payload.map_embed_url).toBe(PLACE);
  });

  test('a short link pasted right before Save is saved EXPANDED (save waits for the resolver)', async ({ page }) => {
    await page.route('**/functions/v1/resolve-map-url', async (r) => {
      await new Promise((res) => setTimeout(res, 500));
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved_url: EXACT }) });
    });
    await loaded(page, null);
    await paste(page, 'https://maps.app.goo.gl/AbCdEf');
    await blur(page);
    await page.evaluate(() => saveProperty());
    await page.waitForTimeout(900);
    expect((await calls(page, 'properties', 'update'))[0].payload.map_embed_url).toBe(EXACT);
  });

  test('a failed short-link expansion is reported, and the link is saved as typed', async ({ page }) => {
    await page.route('**/functions/v1/resolve-map-url', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Short link did not redirect' }) }));
    await loaded(page, null);
    await paste(page, 'https://maps.app.goo.gl/AbCdEf');
    await blur(page);
    await expect(hint(page)).toHaveAttribute('data-map-state', 'invalid');
    await expect(hint(page)).toContainText('Short link did not redirect');
    await save(page);
    expect((await calls(page, 'properties', 'update'))[0].payload.map_embed_url).toBe('https://maps.app.goo.gl/AbCdEf');
  });

  test('a place label with markup is text, not HTML', async ({ page }) => {
    await loaded(page, null);
    await paste(page, 'https://www.google.com/maps?q=' + encodeURIComponent('<img src=x onerror=window.__pwned=1>') + '&ftid=' + PLACE_ID);
    await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await hint(page).locator('img').count()).toBe(0);
  });
});

// ═════════════════════════ add-property.html ═════════════════════════
test.describe('add-property.html', () => {
  const URL = '/add-property.html';
  const prepare = async (page) => {
    const errors = await open(page, URL, {});
    await page.evaluate(() => {
      document.getElementById('title').value = 'New House';
      document.getElementById('propertyType').value = 'house';
      document.getElementById('listingType').value = 'for_rent';
      document.getElementById('priceAmount').value = '500';
      document.getElementById('contactPhone').value = '02055512345';
    });
    return errors;
  };
  const save = async (page) => { await page.evaluate(() => saveProperty()); await settle(page); };

  test('the field exists, is optional, and starts in the empty state', async ({ page }) => {
    const errors = await prepare(page);
    await expect(page.locator('#mapEmbedUrl')).toBeVisible();
    await expect(hint(page)).toHaveAttribute('data-map-state', 'empty');
    expect(errors).toEqual([]);
  });

  test('a new listing with no link inserts map_embed_url = NULL (a new row has nothing to protect)', async ({ page }) => {
    await prepare(page);
    await save(page);
    const ins = await calls(page, 'properties', 'insert');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload.map_embed_url).toBeNull();
  });

  for (const [name, url, state] of [
    ['an exact location', EXACT, 'exact'],
    ['an exact location (newer ?q=lat+lng format)', 'https://www.google.com/maps?q=17.9757+102.6331', 'exact'],
    ['a named place', PLACE, 'place'],
  ]) {
    test(`${name} is classified and inserted exactly as pasted`, async ({ page }) => {
      await prepare(page);
      await paste(page, url);
      await expect(hint(page)).toHaveAttribute('data-map-state', state);
      await save(page);
      expect((await calls(page, 'properties', 'insert'))[0].payload.map_embed_url).toBe(url);
    });
  }

  test('an unusable link warns but the listing can still be created', async ({ page }) => {
    await prepare(page);
    await paste(page, 'https://www.google.com/maps?q=apartments+in+Vientiane');
    await expect(hint(page)).toHaveAttribute('data-map-state', 'invalid');
    await expect(hint(page)).toContainText('Unusable link');
    await save(page);
    expect(await calls(page, 'properties', 'insert')).toHaveLength(1);
  });

  test('a short link pasted right before Save is inserted EXPANDED', async ({ page }) => {
    await page.route('**/functions/v1/resolve-map-url', async (r) => {
      await new Promise((res) => setTimeout(res, 500));
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved_url: PLACE }) });
    });
    await prepare(page);
    await paste(page, 'https://maps.app.goo.gl/AbCdEf');
    await blur(page);
    await page.evaluate(() => saveProperty());
    await page.waitForTimeout(900);
    expect((await calls(page, 'properties', 'insert'))[0].payload.map_embed_url).toBe(PLACE);
  });

  test('both agent pages save the SAME column with the SAME value shape as admin (a plain URL string)', async ({ page }) => {
    await prepare(page);
    await paste(page, '  ' + PLACE + '  ');                                   // surrounding whitespace is trimmed
    await save(page);
    expect((await calls(page, 'properties', 'insert'))[0].payload.map_embed_url).toBe(PLACE);
  });
});
