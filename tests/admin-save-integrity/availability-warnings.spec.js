// Admin: warnings (never blocks) when Market Status and the unit rows disagree in a way that changes what visitors see.
// The REAL admin.html against the in-memory REST fake. The warning text comes from the same canonical summary the public
// site uses (property-availability.js describePropertyAvailabilityConflict), so these cover the rule table too.
const { test, expect } = require('@playwright/test');
const { fakeBackend, boot } = require('./fixtures');

const CONTACT = { id: 'c-real', role: 'agent', name: 'Souksavanh', phone: '02055512345', whatsapp: '02055512345', party_id: null, is_verified: true, languages: ['lo'] };
const prop = (o) => Object.assign({
  id: 'prop-1', title_en: 'Studio House', slug: 'studio-house', workflow_status: 'active', market_status: 'available', status: 'active',
  property_type: 'house', transaction_type: 'for_rent', price_amount: 500, price_currency: 'USD', price_frequency: 'monthly',
  contact_id: 'c-real', images: [], deleted_at: null, owner_id: null,
}, o);
const OPEN = (n) => ({ name_en: 'Unit ' + n, bedrooms: 1, bathrooms: 1, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2 });
const FULL = (n) => ({ name_en: 'Unit ' + n, bedrooms: 1, bathrooms: 1, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 0, next_available_date: '2999-01-01' });

async function open(page) {
  const backend = fakeBackend({ seedContacts: [CONTACT], seedProperties: [prop({})] });
  const errors = await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-market-status').value)).toBe('available');
  return { backend, errors };
}
async function setup(page, market, units) {
  await page.evaluate(([m, us]) => {
    document.querySelectorAll('.ut-card').forEach((c) => c.remove());
    document.getElementById('f-market-status').value = m;
    us.forEach((u) => addUnitType(u));
  }, [market, units]);
}
const warning = (page) => page.locator('#availability-conflict-warning');
async function expectCode(page, code) {
  if (code) {
    await expect(warning(page)).toBeVisible();
    await expect(warning(page)).toHaveAttribute('data-conflict', code);
  } else {
    await expect(warning(page)).toBeHidden();
  }
}

test.describe('editor warning', () => {
  const CASES = [
    ['available, no unit rows', 'available', [], null],
    ['available, an open unit', 'available', [OPEN(1)], null],
    ['available, one open one full (normal unit-level state)', 'available', [OPEN(1), FULL(2)], null],
    ['available but every unit closed', 'available', [FULL(1)], 'available_units_closed'],
    ['available, two closed units', 'available', [FULL(1), FULL(2)], 'available_units_closed'],
    ['rented single-unit with its lone unit open', 'rented', [OPEN(1)], 'single_unit_status_wins'],
    ['reserved single-unit with its lone unit open', 'reserved', [OPEN(1)], 'single_unit_status_wins'],
    ['fully_occupied single-unit with its lone unit open', 'fully_occupied', [OPEN(1)], 'single_unit_status_wins'],
    ['rented multi-unit with an open unit (stale dropdown)', 'rented', [OPEN(1), FULL(2)], 'multi_unit_status_stale'],
    ['rented, everything closed (consistent)', 'rented', [FULL(1)], null],
    ['rented with no unit rows (consistent)', 'rented', [], null],
    ['sold with an open unit', 'sold', [OPEN(1)], 'closed_property_open_units'],
    ['off_market with open units', 'off_market', [OPEN(1), OPEN(2)], 'closed_property_open_units'],
    ['sold, everything closed (consistent)', 'sold', [FULL(1)], null],
    ['coming_soon with an open unit', 'coming_soon', [OPEN(1)], 'coming_soon_open_units'],
    ['coming_soon with no units (consistent)', 'coming_soon', [], null],
  ];
  for (const [label, market, units, code] of CASES) {
    test(label + (code ? ' -> ' + code : ' -> no warning'), async ({ page }) => {
      const { errors } = await open(page);
      await setup(page, market, units);
      await expectCode(page, code);
      expect(errors).toEqual([]);
    });
  }

  test('it updates live: changing Market Status, toggling a unit, and removing a unit', async ({ page }) => {
    await open(page);
    await setup(page, 'available', [FULL(1)]);
    await expectCode(page, 'available_units_closed');
    // the unit card is collapsed, so drive the controls the way the browser does: set the value and fire the event
    await page.evaluate(() => { const el = document.querySelector('.ut-card .ut-available-count'); el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); });   // the unit opens
    await expectCode(page, null);
    await page.selectOption('#f-market-status', 'rented');
    await expectCode(page, 'single_unit_status_wins');
    await page.selectOption('#f-market-status', 'available');
    await page.evaluate(() => { const el = document.querySelector('.ut-card .ut-is-available'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });   // the unit closes again
    await expectCode(page, 'available_units_closed');
    await page.evaluate(() => document.querySelector('.ut-card').remove());  // no unit rows left: nothing to disagree with
    await expectCode(page, null);
  });

  test('the warning is advisory: it never blocks Save and writes nothing by itself', async ({ page }) => {
    const { backend } = await open(page);
    await setup(page, 'rented', [OPEN(1)]);
    await expectCode(page, 'single_unit_status_wins');
    const writesBefore = backend.state.requests.filter((r) => r.method !== 'GET').length;
    await page.waitForTimeout(400);
    expect(backend.state.requests.filter((r) => r.method !== 'GET').length).toBe(writesBefore);
    expect(await page.evaluate(() => document.getElementById('submit-btn').disabled)).toBe(false);
  });
});

test.describe('listings table badge', () => {
  test('flags only the listings whose Market Status and units disagree, with the reason on hover', async ({ page }) => {
    const rows = [
      prop({ id: 'p-ok', title_en: 'Consistent', unit_types: [] }),
      prop({ id: 'p-closed', title_en: 'Closed units', unit_types: [{ id: 'u1', is_available: true, available_count: 0, total_units: null, next_available_date: '2999-01-01' }] }),
      prop({ id: 'p-lone', title_en: 'Lone rented', market_status: 'rented', unit_types: [{ id: 'u2', is_available: true, available_count: 2, total_units: null, next_available_date: null }] }),
      prop({ id: 'p-draft', title_en: 'A draft', workflow_status: 'draft', status: 'draft', unit_types: [{ id: 'u3', is_available: true, available_count: 0, total_units: null, next_available_date: null }] }),
    ];
    const backend = fakeBackend({ seedContacts: [CONTACT] });
    await boot(page, backend);
    await page.route('**/rest/v1/properties?*order=created_at.desc*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
    const reqs = [];
    page.on('request', (r) => { if (r.url().indexOf('/rest/v1/properties?') !== -1) reqs.push(decodeURIComponent(r.url())); });
    await page.evaluate(() => loadListings());
    await expect(page.locator('#listings-container tr[data-property-id]')).toHaveCount(4);
    expect(reqs.some((u) => u.indexOf('unit_types(id,is_available,available_count,total_units,next_available_date)') !== -1)).toBe(true);
    const badge = (id) => page.locator(`#listings-container tr[data-property-id="${id}"] .status-conflict`);
    await expect(badge('p-ok')).toHaveCount(0);
    await expect(badge('p-draft')).toHaveCount(0);                                   // drafts are not public: no warning
    await expect(badge('p-closed')).toHaveAttribute('data-conflict', 'available_units_closed');
    await expect(badge('p-lone')).toHaveAttribute('data-conflict', 'single_unit_status_wins');
    await expect(badge('p-lone')).toHaveAttribute('title', /Market Status is Rented/);
  });
});
