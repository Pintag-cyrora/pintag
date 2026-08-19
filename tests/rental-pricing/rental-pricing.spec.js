// End-to-end coverage for the three rental-pricing additions, driven through
// the real admin.html form:
//
//   1. A DAILY rate tier, at both the building and the unit level, displayed
//      as "$X / day".
//   2. Per-unit-type lease-term pricing (Daily / Monthly / 3 / 6 / 12 months)
//      for apartment & condo buildings, attached to unit_types rather than
//      derived from properties.price_amount.
//   3. The TRASH FEE rental term: a dropdown (Included | Amount) that reveals
//      a numeric field only when Amount is chosen, stored as a real number so
//      cards, the listing page, filters and the AI generator can use it.
//
// The assertions read back the exact payload builders saveListing() spreads
// into its request body (computeLeaseDurationPricing, getUnitTypesFromDom,
// buildRentalTermsPayload) plus one genuine captured POST, so a break in the
// form wiring fails here rather than in production. Existing-listing
// behaviour is covered explicitly: a listing with none of these fields set
// must still save exactly the columns it saved before this feature existed.
const { test, expect } = require('@playwright/test');

// admin.html is gated by admin-auth.js's isVerifiedAdminSession(), which
// requires BOTH the sole administrator email AND an AAL2 (MFA-verified)
// session -- checked against the live client, never localStorage. The stub
// therefore has to satisfy all three calls it makes: getUser(), the email
// match, and mfa.getAuthenticatorAssuranceLevel(). A stub missing
// `auth.mfa` leaves the page sitting on the sign-in overlay forever, which
// is exactly what a missing-AAL2 session should do.
const ADMIN_EMAIL = 'cyrora.trading@gmail.com';
const STUB_SUPABASE = `
window.supabase = {
  createClient: function() {
    return {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'fake', user: { id: 'u1', email: '${ADMIN_EMAIL}' } } }, error: null }),
        getUser: async () => ({ data: { user: { id: 'u1', email: '${ADMIN_EMAIL}' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signOut: async () => ({ error: null }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
          listFactors: async () => ({ data: { totp: [] }, error: null }),
        },
      },
    };
  }
};
`;

// `rows` seeds the properties endpoint so editListing() can load a fixture --
// every other REST call still answers with an empty list.
async function loadAdminAsStaff(page, rows) {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err));
  await page.route('**cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', body: STUB_SUPABASE }));
  await page.route('**fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  // Order matters: Playwright checks routes in REVERSE registration order, so
  // the catch-all is registered FIRST and the specific properties handler last.
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // A URL PREDICATE, not a glob: Playwright glob patterns treat '?' as a
  // single-character wildcard, so '**/properties?id=eq*' never matches a real
  // query string.
  await page.route(url => /\/rest\/v1\/properties\?id=eq\./.test(url.toString()), route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(rows || [])
  }));
  await page.goto('/admin.html');
  // The "+ New Listing" button only exists once admin-auth.js has verified
  // the AAL2 admin session and removed the sign-in overlay.
  await page.waitForSelector('button.btn-import', { state: 'visible', timeout: 15000 });
  return pageErrors;
}

// A blank listing form set to a rental transaction. showForm(null) is the same
// entry point the "+ New Listing" flow lands on (via showImportPanel ->
// resetListingForm), and selectOption fires #f-transaction's real
// onTransactionChange() handler.
async function newRentalListing(page, transaction = 'for_rent') {
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  await page.selectOption('#f-transaction', transaction);
  return page;
}

// Scoped to the Unit Types "+ Add Unit Type" button -- .btn-add-row is also
// the class on "+ Add nearby place".
async function addUnitCard(page, name) {
  await page.click('button.btn-add-row[onclick="addUnitType()"]');
  const card = page.locator('.ut-card').last();
  await card.locator('.ut-head').click();      // new cards start collapsed
  if (name) await card.locator('.ut-name-en').fill(name);
  return card;
}

const leasePayload = page => page.evaluate(() => computeLeaseDurationPricing());
const unitRows     = page => page.evaluate(() => getUnitTypesFromDom());
const buildingTerms = page => page.evaluate(() => buildRentalTermsPayload(_buildingRentalTermsValues));

// ═══════════════════════════════════════════════════════════════════════
// 1 — DAILY RATE
// ═══════════════════════════════════════════════════════════════════════

test('the Daily rate field appears for a rental and is hidden for a sale', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await expect(page.locator('#lease-duration-block')).toBeVisible();
  await expect(page.locator('#f-rent-daily')).toBeVisible();

  await page.selectOption('#f-transaction', 'for_sale');
  await expect(page.locator('#lease-duration-block')).toBeHidden();
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('a daily rate saves to rent_price_daily and previews as "$X / day"', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-price-amount', '450');
  await page.fill('#f-rent-daily', '45');

  expect(await leasePayload(page)).toMatchObject({ rent_price_daily: 45 });
  await expect(page.locator('#lease-duration-preview')).toContainText('Daily — $45 / day');
});

test('Daily is selectable as the listing\'s primary rental period', async ({ page }) => {
  // Distinct from the daily TIER above: a short-stay listing whose headline
  // price is itself per-day, which formatPropertyPrice() renders as "/ day".
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await expect(page.locator('#f-price-frequency option[value="daily"]')).toHaveCount(1);
  await page.selectOption('#f-price-frequency', 'daily');
  await page.fill('#f-price-amount', '60');

  // admin.html doesn't load components.js (that's the public pages' renderer),
  // so the assertion goes through the derivation admin itself writes: the
  // legacy display text saved alongside the structured columns.
  expect(await page.evaluate(() => computeStructuredPrice()))
    .toMatchObject({ price_amount: 60, price_frequency: 'daily', price_display: '$60 / day' });
});

test('a daily rate alone does not store a lease basis', async ({ page }) => {
  // lease_price_basis describes the 3/6/12-month tiers only; a daily-only
  // listing has nothing for it to describe.
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-price-amount', '450');
  await page.fill('#f-rent-daily', '45');
  expect((await leasePayload(page)).lease_price_basis).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════
// 2 — BUILDING-LEVEL LEASE TERMS (the product's worked example)
// ═══════════════════════════════════════════════════════════════════════

test('3 / 6 / 12-month rates save as monthly rates for that term', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-price-amount', '450');
  await page.fill('#f-rent-3mo', '420');
  await page.fill('#f-rent-6mo', '400');
  await page.fill('#f-rent-12mo', '350');

  expect(await leasePayload(page)).toEqual({
    rent_price_daily: null, rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350,
    lease_price_basis: 'monthly'
  });
  const preview = page.locator('#lease-duration-preview');
  await expect(preview).toContainText('3 months — $420 / month');
  await expect(preview).toContainText('6 months — $400 / month');
  await expect(preview).toContainText('1 year — $350 / month');
});

test('switching the basis to Total re-labels the tiers but never the daily rate', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-price-amount', '450');
  await page.fill('#f-rent-daily', '45');
  await page.fill('#f-rent-6mo', '2400');
  await page.check('#lease-basis-total');

  const preview = page.locator('#lease-duration-preview');
  await expect(preview).toContainText('6 months — $2,400 total');
  await expect(preview).toContainText('Daily — $45 / day');
  expect((await leasePayload(page)).lease_price_basis).toBe('total');
});

// ═══════════════════════════════════════════════════════════════════════
// 3 — PER-UNIT-TYPE LEASE PRICING (apartments / condos)
// ═══════════════════════════════════════════════════════════════════════

test('each unit type carries its own Daily / 3 / 6 / 12-month pricing', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.selectOption('#f-type', 'apartment');

  const studio = await addUnitCard(page, 'Studio');
  await studio.locator('.ut-price-amount').fill('300');
  await studio.locator('.ut-lease-daily').fill('35');
  await studio.locator('.ut-lease-3mo').fill('290');
  await studio.locator('.ut-lease-6mo').fill('280');
  await studio.locator('.ut-lease-12mo').fill('260');

  const twoBr = await addUnitCard(page, '2 Bedroom');
  await twoBr.locator('.ut-price-amount').fill('700');
  await twoBr.locator('.ut-lease-3mo').fill('660');
  await twoBr.locator('.ut-lease-12mo').fill('600');

  const rows = await unitRows(page);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    name_en: 'Studio', price_amount: 300,
    rent_price_daily: 35, rent_price_3mo: 290, rent_price_6mo: 280, rent_price_12mo: 260,
    lease_price_basis: 'monthly'
  });
  expect(rows[1]).toMatchObject({
    name_en: '2 Bedroom', price_amount: 700,
    rent_price_daily: null, rent_price_3mo: 660, rent_price_6mo: null, rent_price_12mo: 600,
    lease_price_basis: 'monthly'
  });
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('unit pricing stays on the unit — it is not folded into the building price', async ({ page }) => {
  // The explicit requirement: "Do not rely solely on property-level
  // price_amount; unit-level pricing must remain attached to unit_types."
  // The building keeps only the calculated "starting from" MIN.
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const studio = await addUnitCard(page, 'Studio');
  await studio.locator('.ut-price-amount').fill('300');
  await studio.locator('.ut-lease-12mo').fill('260');
  const twoBr = await addUnitCard(page, '2 Bedroom');
  await twoBr.locator('.ut-price-amount').fill('700');
  await twoBr.locator('.ut-lease-12mo').fill('620');

  const rows = await unitRows(page);
  expect(rows.map(r => r.rent_price_12mo)).toEqual([260, 620]);

  // ...and the building-level tier columns stay null in multi-unit mode, so a
  // building tier can never be shown against a unit with a different base.
  expect(await leasePayload(page)).toEqual({
    rent_price_daily: null, rent_price_3mo: null, rent_price_6mo: null, rent_price_12mo: null,
    lease_price_basis: null
  });
});

test('the per-unit preview shows that unit\'s own rates, resolved live', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const studio = await addUnitCard(page, 'Studio');
  await studio.locator('.ut-price-amount').fill('300');
  await studio.locator('.ut-lease-daily').fill('35');
  await studio.locator('.ut-lease-12mo').fill('260');

  const preview = studio.locator('.ut-lease-preview');
  await expect(preview).toContainText('Daily — $35 / day');
  await expect(preview).toContainText('1 month — $300 / month');
  await expect(preview).toContainText('1 year — $260 / month');
});

test('a unit type with no lease terms says so instead of borrowing the building\'s', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const card = await addUnitCard(page, 'Studio');
  await card.locator('.ut-price-amount').fill('300');
  await expect(card.locator('.ut-lease-preview')).toContainText('No lease-term rates for this unit');
  const rows = await unitRows(page);
  expect(rows[0].rent_price_12mo).toBeNull();
  expect(rows[0].lease_price_basis).toBeNull();
});

test('unit lease-term fields are hidden, and cleared, for a sale listing', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const card = await addUnitCard(page, 'Studio');
  await card.locator('.ut-lease-12mo').fill('260');

  await page.selectOption('#f-transaction', 'for_sale');
  await expect(card.locator('.ut-lease-row')).toBeHidden();
  const rows = await unitRows(page);
  expect(rows[0].rent_price_12mo).toBeNull();
  expect(rows[0].lease_price_basis).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════
// 4 — TRASH FEE
// ═══════════════════════════════════════════════════════════════════════

// The Trash Fee control is registry-driven (RENTAL_TERMS_FIELDS) -- no id, no
// hand-written markup. It is the only field of the `included_or_amount` kind,
// so that kind's own control class identifies it; the label is asserted
// separately below so a second such field later fails loudly here rather than
// silently matching the wrong control.
function trashFeeField(scope) {
  return scope.locator('.rt-field-included-amount');
}
function trashFeeRowLabel(scope) {
  return scope.locator('.rt-row', { has: scope.page().locator('.rt-field-included-amount') }).locator('.form-label');
}

test('Trash Fee is a dropdown in Rental Terms, revealing an amount only for "Amount"', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const field = trashFeeField(page.locator('#rental-terms-building'));
  const [typeSel, amountInput, currencySel] = ['select', 'input[type=number]', 'select'].map((s, i) =>
    i === 0 ? field.locator('select').first() : (i === 1 ? field.locator('input[type=number]') : field.locator('select').nth(1)));

  await expect(trashFeeRowLabel(page.locator('#rental-terms-building'))).toHaveText('Trash Fee');
  await expect(field).toHaveCount(1);
  await expect(typeSel).toBeVisible();
  await expect(typeSel.locator('option')).toHaveText([/select/, 'Included', 'Amount']);
  // Nothing chosen yet -> no money box at all.
  await expect(amountInput).toBeHidden();

  await typeSel.selectOption('included');
  await expect(amountInput).toBeHidden();

  await typeSel.selectOption('amount');
  await expect(amountInput).toBeVisible();
  await expect(currencySel).toBeVisible();
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('Trash Fee "Included" stores a clean value, distinct from unanswered', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  expect((await buildingTerms(page)).trash_fee).toBeUndefined();

  await trashFeeField(page.locator('#rental-terms-building')).locator('select').first().selectOption('included');
  expect((await buildingTerms(page)).trash_fee).toEqual({ type: 'included' });
});

test('Trash Fee "Amount" stores a real number + currency, labelled per month', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  const field = trashFeeField(page.locator('#rental-terms-building'));
  await field.locator('select').first().selectOption('amount');
  await field.locator('input[type=number]').fill('15');

  expect((await buildingTerms(page)).trash_fee).toEqual({ type: 'amount', value: 15, currency: 'USD' });
  await expect(field.locator('.rt-period-hint')).toHaveText('per month');

  const display = await page.evaluate(() =>
    formatRentalTermValue('trash_fee', { type: 'amount', value: 15, currency: 'USD' }, 'en'));
  expect(display).toBe('Trash Fee: $15 / month');
});

test('Trash Fee "Amount" with nothing typed stores nothing, never $0', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await trashFeeField(page.locator('#rental-terms-building')).locator('select').first().selectOption('amount');
  expect((await buildingTerms(page)).trash_fee).toBeUndefined();
});

test('a unit type can override the building\'s Trash Fee', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await trashFeeField(page.locator('#rental-terms-building')).locator('select').first().selectOption('included');

  const card = await addUnitCard(page, 'Studio');
  await card.locator('.ut-rt-override-btn').click();
  const unitField = trashFeeField(card.locator('.ut-rt-fields'));
  await unitField.locator('select').first().selectOption('amount');
  await unitField.locator('input[type=number]').fill('12');

  const rows = await unitRows(page);
  expect(rows[0].rental_terms_overrides.trash_fee).toEqual({ type: 'amount', value: 12, currency: 'USD' });

  const resolved = await page.evaluate(rows2 => resolveRentalTerms(
    { rental_terms: buildRentalTermsPayload(_buildingRentalTermsValues) },
    { rental_terms_overrides: rows2[0].rental_terms_overrides }
  ).values.trash_fee, rows);
  expect(resolved).toEqual({ type: 'amount', value: 12, currency: 'USD' });
});

// ═══════════════════════════════════════════════════════════════════════
// 5 — EXISTING LISTINGS ARE UNAFFECTED
// ═══════════════════════════════════════════════════════════════════════

test('a plain rental with none of the new fields saves them all as null/absent', async ({ page }) => {
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-price-amount', '500');

  expect(await leasePayload(page)).toEqual({
    rent_price_daily: null, rent_price_3mo: null, rent_price_6mo: null, rent_price_12mo: null,
    lease_price_basis: null
  });
  expect((await buildingTerms(page)).trash_fee).toBeUndefined();
});

test('loading an existing listing that predates these fields leaves them blank', async ({ page }) => {
  // A row with none of the new columns is exactly what a pre-migration listing
  // looks like coming back from PostgREST.
  await loadAdminAsStaff(page, [{
    id: 'legacy-1', transaction_type: 'for_rent', property_type: 'house',
    price_amount: 500, price_currency: 'USD', price_frequency: 'monthly',
    title_en: 'Legacy listing', rental_terms: { version: 1, deposit: { type: 'months_of_rent', value: 2 } },
    unit_types: []
  }]);
  await page.evaluate(() => editListing('legacy-1'));
  await page.waitForFunction(() => document.getElementById('f-price-amount').value === '500');

  await expect(page.locator('#f-rent-daily')).toHaveValue('');
  await expect(page.locator('#f-rent-3mo')).toHaveValue('');
  await expect(page.locator('#f-rent-6mo')).toHaveValue('');
  await expect(page.locator('#f-rent-12mo')).toHaveValue('');
  await expect(page.locator('#lease-basis-monthly')).toBeChecked();
  expect(await leasePayload(page)).toEqual({
    rent_price_daily: null, rent_price_3mo: null, rent_price_6mo: null, rent_price_12mo: null,
    lease_price_basis: null
  });
  // The legacy deposit survives untouched, and no trash fee is invented.
  const terms = await buildingTerms(page);
  expect(terms.deposit).toEqual({ type: 'months_of_rent', value: 2 });
  expect(terms.trash_fee).toBeUndefined();
});

test('an existing listing WITH lease pricing round-trips through load and save', async ({ page }) => {
  await loadAdminAsStaff(page, [{
    id: 'priced-1', transaction_type: 'for_rent', property_type: 'condo',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
    rent_price_daily: 45, rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350,
    lease_price_basis: 'monthly',
    rental_terms: { version: 1, trash_fee: { type: 'amount', value: 15, currency: 'USD' } },
    unit_types: []
  }]);
  await page.evaluate(() => editListing('priced-1'));
  await page.waitForFunction(() => document.getElementById('f-rent-daily').value === '45');

  await expect(page.locator('#f-rent-daily')).toHaveValue('45');
  await expect(page.locator('#f-rent-12mo')).toHaveValue('350');
  expect(await leasePayload(page)).toEqual({
    rent_price_daily: 45, rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350,
    lease_price_basis: 'monthly'
  });
  expect((await buildingTerms(page)).trash_fee).toEqual({ type: 'amount', value: 15, currency: 'USD' });
});

test('an existing apartment building round-trips its per-unit lease pricing', async ({ page }) => {
  await loadAdminAsStaff(page, [{
    id: 'apt-1', transaction_type: 'for_rent', property_type: 'apartment',
    price_amount: 300, price_currency: 'USD', price_frequency: 'monthly',
    rental_terms: { version: 1, trash_fee: { type: 'included' } },
    unit_types: [
      { id: 'u1', sort_order: 0, name_en: 'Studio', price_amount: 300, price_currency: 'USD',
        price_frequency: 'monthly', is_available: true, available_count: 4,
        rent_price_daily: 35, rent_price_3mo: 290, rent_price_6mo: 280, rent_price_12mo: 260,
        lease_price_basis: 'monthly', rental_terms_overrides: { version: 1 } },
      { id: 'u2', sort_order: 1, name_en: '2 Bedroom', price_amount: 700, price_currency: 'USD',
        price_frequency: 'monthly', is_available: true, available_count: 2,
        rent_price_daily: null, rent_price_3mo: 660, rent_price_6mo: null, rent_price_12mo: 600,
        lease_price_basis: 'monthly', rental_terms_overrides: { version: 1 } }
    ]
  }]);
  await page.evaluate(() => editListing('apt-1'));
  await page.waitForFunction(() => document.querySelectorAll('.ut-card').length === 2);

  const cards = page.locator('.ut-card');
  await expect(cards.nth(0).locator('.ut-lease-daily')).toHaveValue('35');
  await expect(cards.nth(0).locator('.ut-lease-12mo')).toHaveValue('260');
  await expect(cards.nth(1).locator('.ut-lease-daily')).toHaveValue('');
  await expect(cards.nth(1).locator('.ut-lease-12mo')).toHaveValue('600');

  // Saving again must reproduce the same per-unit columns, unchanged.
  const rows = await unitRows(page);
  expect(rows[0]).toMatchObject({ id: 'u1', rent_price_daily: 35, rent_price_3mo: 290, rent_price_6mo: 280, rent_price_12mo: 260, lease_price_basis: 'monthly' });
  expect(rows[1]).toMatchObject({ id: 'u2', rent_price_daily: null, rent_price_3mo: 660, rent_price_6mo: null, rent_price_12mo: 600, lease_price_basis: 'monthly' });
  expect((await buildingTerms(page)).trash_fee).toEqual({ type: 'included' });
});

test('opening a fresh form clears a previous listing\'s daily rate and trash fee', async ({ page }) => {
  // resetListingForm() is the single authoritative blank-slate reset; a new
  // field that it misses would leak the previous listing's price into a new one.
  await loadAdminAsStaff(page);
  await newRentalListing(page, 'for_rent');
  await page.fill('#f-rent-daily', '45');
  await trashFeeField(page.locator('#rental-terms-building')).locator('select').first().selectOption('included');

  await newRentalListing(page, 'for_rent');
  await expect(page.locator('#f-rent-daily')).toHaveValue('');
  expect((await buildingTerms(page)).trash_fee).toBeUndefined();
});

// ═══════════════════════════════════════════════════════════════════════
// 6 — THE PUBLIC LISTING PAGE
// ═══════════════════════════════════════════════════════════════════════
// The display half of the feature. These drive listing.html itself, so a
// change that saves the data correctly but never shows it fails here.

const LISTING_STUB = `
window.supabase = { createClient: function() { return { auth: {
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
} }; } };
`;

async function openListing(page, property) {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err));
  await page.route('**cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', body: LISTING_STUB }));
  await page.route('**fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(url => /\/rest\/v1\/properties\?slug=eq\./.test(url.toString()), route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([property])
  }));
  await page.goto('/listing.html?slug=' + property.slug);
  await page.waitForSelector('.section-label', { timeout: 15000 });
  return pageErrors;
}

const BASE_LISTING = {
  id: 'p1', slug: 'test-listing', status: 'active', workflow_status: 'active', market_status: 'available',
  transaction_type: 'for_rent', property_type: 'condo',
  title_en: 'Test rental', title_lo: 'Test rental', title_zh: 'Test rental',
  description_en: 'A place.', district_en: 'Sisattanak', village_en: 'Thongkang',
  images: [], features: [], amenities: [], contacts: null, parties: null, unit_types: [],
  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
  rental_terms: { version: 1 }
};

test('the public listing page shows the full lease-term price list', async ({ page }) => {
  const pageErrors = await openListing(page, Object.assign({}, BASE_LISTING, {
    rent_price_daily: 45, rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350,
    lease_price_basis: 'monthly'
  }));
  const block = page.locator('[data-track="lease-pricing-section"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('Daily — $45 / day');
  await expect(block).toContainText('1 month — $450 / month');
  await expect(block).toContainText('3 months — $420 / month');
  await expect(block).toContainText('6 months — $400 / month');
  await expect(block).toContainText('1 year — $350 / month');
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('a listing with no lease terms shows no lease-pricing block at all', async ({ page }) => {
  await openListing(page, BASE_LISTING);
  await expect(page.locator('[data-track="lease-pricing-section"]')).toHaveCount(0);
});

test('the Trash Fee appears in the listing page\'s Rental Terms', async ({ page }) => {
  await openListing(page, Object.assign({}, BASE_LISTING, {
    rental_terms: { version: 1, trash_fee: { type: 'amount', value: 15, currency: 'USD' } }
  }));
  await expect(page.locator('[data-track="rental-terms-section"]')).toContainText('Trash Fee: $15 / month');
});

test('an "Included" Trash Fee reads as included, not as a price', async ({ page }) => {
  await openListing(page, Object.assign({}, BASE_LISTING, {
    rental_terms: { version: 1, trash_fee: { type: 'included' } }
  }));
  await expect(page.locator('[data-track="rental-terms-section"]')).toContainText('Trash Fee: Included');
});

test('each unit card shows that unit\'s own lease-term rates', async ({ page }) => {
  await openListing(page, Object.assign({}, BASE_LISTING, {
    property_type: 'apartment',
    unit_types: [
      { id: 'u1', sort_order: 0, name_en: 'Studio', price_amount: 300, price_currency: 'USD',
        price_frequency: 'monthly', is_available: true, available_count: 3, images: [],
        rent_price_daily: 35, rent_price_12mo: 260, lease_price_basis: 'monthly',
        rental_terms_overrides: { version: 1 } },
      { id: 'u2', sort_order: 1, name_en: '2 Bedroom', price_amount: 700, price_currency: 'USD',
        price_frequency: 'monthly', is_available: true, available_count: 1, images: [],
        rent_price_12mo: 620, lease_price_basis: 'monthly',
        rental_terms_overrides: { version: 1 } }
    ]
  }));
  const cards = page.locator('.unit-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.unit-lease-terms')).toContainText('Daily — $35 / day');
  await expect(cards.nth(0).locator('.unit-lease-terms')).toContainText('1 year — $260 / month');
  await expect(cards.nth(1).locator('.unit-lease-terms')).toContainText('1 year — $620 / month');
  // The 2BR quotes no daily rate; it must not borrow the Studio's or the
  // building's (lease-pricing.js rule 8).
  await expect(cards.nth(1).locator('.unit-lease-terms')).not.toContainText('/ day');
});

test('a unit type with no lease terms shows no lease list on its card', async ({ page }) => {
  await openListing(page, Object.assign({}, BASE_LISTING, {
    property_type: 'apartment',
    rent_price_12mo: 400, lease_price_basis: 'monthly',
    unit_types: [{ id: 'u1', sort_order: 0, name_en: 'Studio', price_amount: 300, price_currency: 'USD',
      price_frequency: 'monthly', is_available: true, available_count: 3, images: [],
      rental_terms_overrides: { version: 1 } }]
  }));
  await expect(page.locator('.unit-card .unit-lease-terms')).toHaveCount(0);
});

test('a daily-only rental renders its headline price as "$X / day"', async ({ page }) => {
  await openListing(page, Object.assign({}, BASE_LISTING, {
    price_amount: 60, price_frequency: 'daily'
  }));
  await expect(page.locator('.price-main, .price-value, [class*=price]').first()).toContainText('$60');
  const text = await page.locator('body').innerText();
  expect(text).toContain('/ day');
});
