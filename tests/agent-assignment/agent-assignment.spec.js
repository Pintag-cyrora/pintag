// Regression coverage for a reported bug: opening an existing listing for
// edit could show its Agent ("Platform Identity", #f-agent-id, backed by
// properties.managed_by_party_id) as unselected, and saving without
// touching the field could silently clear the assignment.
//
// Root cause #1 (the actual disappearing-on-open bug): showForm(id) fires
// loadAgentsForDropdown() (an async fetch of the parties table) but
// editListing() never awaited it before setting #f-agent-id.value to the
// listing's managed_by_party_id. Setting a <select>'s .value to an id with
// no matching <option> yet is not an error -- the browser just resets it
// to "" -- and the correct value was never reapplied once the real
// options arrived, because buildAgentOptions() only preserves whatever's
// *currently* selected. Fixed by awaiting the agent list load before
// applying the value (admin.html showForm()/editListing()).
//
// Root cause #2 (a related, quieter data-loss path): the save payload
// derived managed_by_party_id by re-looking up the selected id in the
// module-level _agentsAll array (`_agentsAll.find(a => a.id === id)`)
// instead of using the dropdown's own value directly. If _agentsAll was
// ever out of sync with the dropdown for any reason, that lookup could
// return null and silently write NULL over a valid assignment on save.
// Fixed by saving the dropdown's own value directly (admin.html
// saveListing()).
const { test, expect } = require('@playwright/test');

const AGENT_A = { id: 'agent-aaaaaaaa-0000-0000-0000-000000000001', type: 'agent', name_en: 'Agent A', name_lo: '', slug: 'agent-a', photo_url: null, whatsapp: '2020000001', agency_name: 'Pintag Realty', bio_en: '' };
const AGENT_B = { id: 'agent-bbbbbbbb-0000-0000-0000-000000000002', type: 'agent', name_en: 'Agent B', name_lo: '', slug: 'agent-b', photo_url: null, whatsapp: '2020000002', agency_name: 'Pintag Realty', bio_en: '' };
const PROPERTY_ID = 'prop-00000000-0000-0000-0000-000000000099';

function baseProperty(overrides) {
  return Object.assign({
    id: PROPERTY_ID,
    slug: 'test-listing',
    title_en: 'Original Title', title_lo: '', title_zh: '',
    property_type: 'house', property_style: '', transaction_type: 'for_sale',
    workflow_status: 'active', market_status: 'available',
    price_amount: 500000, price_currency: 'USD', price_frequency: 'one_time',
    rent_price_amount: null, rent_price_currency: 'USD', rent_price_frequency: 'monthly',
    price_previous: null, land_title_type: '', is_featured: false,
    property_highlight_en: '', property_highlight_lo: '', property_highlight_zh: '',
    description_en: '', description_lo: '', description_zh: '',
    features: [], amenities: [],
    district_en: '', village_en: '', map_embed_url: '',
    nearby_places: [], highlights: [],
    neighborhood_insight_en: '', neighborhood_insight_lo: '', neighborhood_insight_zh: '',
    images: [], video_embed_url: '', facebook_video_url: '', download_url: '',
    agent_title: '', managed_by_party_id: null,
    contact_id: 'contact-0000-0000-0000-000000000001',
    contacts: { id: 'contact-0000-0000-0000-000000000001', role: 'agent', name: 'Buyer Contact', phone: '2099999999', whatsapp: '2099999999' },
    owner_id: null,
    unit_types: [],
  }, overrides);
}

const STUB_SUPABASE = `
window.supabase = {
  createClient: function() {
    return {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'fake', user: { id: 'u1', email: 'admin@pintag.io' } } }, error: null }),
        getUser: async () => ({ data: { user: { id: 'u1', email: 'admin@pintag.io' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
      },
    };
  }
};
`;

// agentsDelayMs: how long to hold the parties?type=eq.agent response before
// fulfilling it -- the direct lever for reproducing/verifying the fix for
// root cause #1's race condition.
async function loadAdminAsStaff(page, { agentsDelayMs = 0, property = baseProperty() } = {}) {
  const pageErrors = [];
  const patchedProperties = [];
  page.on('pageerror', err => pageErrors.push(err));
  await page.route('**cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', body: STUB_SUPABASE }));
  await page.route('**fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  // admin-auth.js enforces the AAL2 (MFA) admin gate since 2026-08; with the
  // stub session above the real module keeps #admin-screen hidden, so every
  // click/fill step timed out. Same stub the other admin suites use.
  await page.route('**/admin-auth.js*', route => route.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"test-token",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));

  // Catch-all first (Playwright matches the most-recently-registered route
  // first, so specific routes registered after this one correctly win).
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.route('**/rest/v1/parties**', async route => {
    if (agentsDelayMs) await new Promise(r => setTimeout(r, agentsDelayMs));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([AGENT_A, AGENT_B]) });
  });

  await page.route(`**/rest/v1/properties?id=eq.${PROPERTY_ID}*`, route => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patchedProperties.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([Object.assign({}, property, body)]) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([property]) });
  });

  await page.route('**/rest/v1/unit_types**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('/admin.html');
  await page.waitForSelector('#admin-screen', { state: 'visible', timeout: 15000 }).catch(() => {});
  return { pageErrors, patchedProperties };
}

test('opening an existing listing pre-selects its current agent, even when the agent list resolves after the property fetch (the actual race that caused the bug)', async ({ page }) => {
  const property = baseProperty({ managed_by_party_id: AGENT_A.id });
  // parties resolves noticeably slower than the properties fetch -- this
  // is exactly the ordering that produced the reported bug pre-fix.
  const { pageErrors } = await loadAdminAsStaff(page, { agentsDelayMs: 400, property });

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await expect(page.locator('#f-agent-id')).toHaveValue(AGENT_A.id, { timeout: 5000 });

  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('opening an existing listing pre-selects its current agent under normal (fast) load too', async ({ page }) => {
  const property = baseProperty({ managed_by_party_id: AGENT_A.id });
  await loadAdminAsStaff(page, { agentsDelayMs: 0, property });

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await expect(page.locator('#f-agent-id')).toHaveValue(AGENT_A.id);
});

test('saving without changing the agent preserves the existing managed_by_party_id (never sends null/empty/undefined)', async ({ page }) => {
  const property = baseProperty({ managed_by_party_id: AGENT_A.id, title_en: 'Original Title' });
  const { patchedProperties } = await loadAdminAsStaff(page, { agentsDelayMs: 300, property });

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await expect(page.locator('#f-agent-id')).toHaveValue(AGENT_A.id, { timeout: 5000 });

  // Edit only the title -- the exact scenario from the bug report.
  await page.fill('#f-title-en', 'Updated Title Only');
  await page.click('#submit-btn');
  await expect(page.locator('#form-message.success')).toBeVisible({ timeout: 5000 });

  expect(patchedProperties).toHaveLength(1);
  expect(patchedProperties[0].managed_by_party_id).toBe(AGENT_A.id);
  expect(patchedProperties[0].title_en).toBe('Updated Title Only');
});

test('changing the agent and saving persists the new agent on reopen', async ({ page }) => {
  const property = baseProperty({ managed_by_party_id: AGENT_A.id });
  const { patchedProperties } = await loadAdminAsStaff(page, { property });

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await expect(page.locator('#f-agent-id')).toHaveValue(AGENT_A.id);

  await page.selectOption('#f-agent-id', AGENT_B.id);
  await page.click('#submit-btn');
  await expect(page.locator('#form-message.success')).toBeVisible({ timeout: 5000 });

  expect(patchedProperties).toHaveLength(1);
  expect(patchedProperties[0].managed_by_party_id).toBe(AGENT_B.id);

  // Reopen -- simulates step 6 of the bug report's test plan: confirm the
  // change survives a fresh load, not just the in-memory form state.
  const updatedProperty = Object.assign({}, property, { managed_by_party_id: AGENT_B.id });
  await page.unroute(`**/rest/v1/properties?id=eq.${PROPERTY_ID}*`);
  await page.route(`**/rest/v1/properties?id=eq.${PROPERTY_ID}*`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([updatedProperty]) }));

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await expect(page.locator('#f-agent-id')).toHaveValue(AGENT_B.id);
});

test('a listing with no agent assigned opens with the dropdown correctly blank, not stuck on a stale value', async ({ page }) => {
  const property = baseProperty({ managed_by_party_id: null });
  await loadAdminAsStaff(page, { agentsDelayMs: 200, property });

  await page.evaluate((id) => editListing(id), PROPERTY_ID);
  await page.waitForTimeout(300); // let the delayed agents fetch resolve
  await expect(page.locator('#f-agent-id')).toHaveValue('');
});
