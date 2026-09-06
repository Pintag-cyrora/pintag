// Regression coverage for a reported bug: once a Unit Type's Next
// Available Date had been set (e.g. while the unit was fully occupied),
// there was no way to blank it again after the unit became available.
// Native <input type="date"> on iOS Safari has no "clear" affordance in
// its date-wheel picker once a date is selected -- unlike desktop
// browsers' built-in "x" -- so operators were stuck with a stale date
// they could not remove through the UI.
//
// Fixed by an explicit "Clear" button (_utClearNextAvailableDate(),
// admin.html) that sets the input's .value directly via JS, bypassing the
// native picker entirely, then re-runs the same
// _utOnAvailabilityFieldChange() the field's own oninput already uses so
// the admin availability-badge preview stays in sync. getUnitTypesFromDom()
// already sent null for an empty date string before this fix -- this
// suite proves the field can actually reach that empty state through the
// UI, and that the resulting saved payload is null, not that the null
// mapping itself is new.
//
// Intentionally does NOT touch resolveUnitAvailability(), resolveListingStatus(),
// _ptIsUnavailableNow(), or any FOMO/market_status logic -- this is a
// UI-only fix, isolated to the Next Available Date field.
const { test, expect } = require('@playwright/test');

// admin.html is gated by admin-auth.js's isVerifiedAdminSession(), which
// requires BOTH the sole administrator email AND an AAL2 (MFA-verified)
// session. Must satisfy all three checks: getUser(), the email match, and
// mfa.getAuthenticatorAssuranceLevel().
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

async function loadAdminAsStaff(page) {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err));
  await page.route('**cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', body: STUB_SUPABASE }));
  await page.route('**fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/admin.html');
  await page.waitForSelector('button.btn-import', { state: 'visible', timeout: 15000 });
  return pageErrors;
}

// Simulates loadUnitTypes()/editListing() populating a card from a real
// saved row that already has a Next Available Date on file -- the exact
// shape of the reported production case: a unit that used to be fully
// occupied (hence the date), now re-marked Available with a real count.
async function unitTypeCardWithStaleDate(page) {
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  await page.evaluate(() => {
    addUnitType({
      name_en: '1 Bedroom 1 Bathroom',
      bedrooms: 1,
      bathrooms: 1,
      price_amount: 250,
      is_available: true,
      available_count: 2,
      next_available_date: '2026-08-22'
    });
  });
  const card = page.locator('.ut-card').last();
  await card.locator('.ut-head').click();
  return card;
}

test('Next Available Date starts populated with the saved stale date', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await expect(card.locator('.ut-next-available-date')).toHaveValue('2026-08-22');
});

test('clicking Clear empties the Next Available Date field', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await card.locator('.ut-clear-date-btn').click();

  await expect(card.locator('.ut-next-available-date')).toHaveValue('');
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('after Clear, the saved payload sends null for next_available_date, not the stale string', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await card.locator('.ut-clear-date-btn').click();

  const rows = await page.evaluate(() => getUnitTypesFromDom());
  expect(rows).toHaveLength(1);
  expect(rows[0].next_available_date).toBeNull();
  // Clear must not touch any other field on the row.
  expect(rows[0].is_available).toBe(true);
  expect(rows[0].available_count).toBe(2);
});

test('Clear does not affect the Available checkbox or Available Count', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await card.locator('.ut-clear-date-btn').click();

  await expect(card.locator('.ut-is-available')).toBeChecked();
  await expect(card.locator('.ut-available-count')).toHaveValue('2');
});

test('after Clear, the admin availability badge still reads Available (2/-), not affected by the cleared date', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await card.locator('.ut-clear-date-btn').click();

  await expect(card.locator('.ut-avail-badge')).toHaveClass(/ut-avail-available/);
});

test('Clear works even on a brand-new unit type card that never had a date to begin with', async ({ page }) => {
  await loadAdminAsStaff(page);
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  await page.click('button.btn-add-row[onclick="addUnitType()"]');
  const card = page.locator('.ut-card').last();
  await card.locator('.ut-head').click();

  await expect(card.locator('.ut-next-available-date')).toHaveValue('');
  await card.locator('.ut-clear-date-btn').click();
  await expect(card.locator('.ut-next-available-date')).toHaveValue('');
});
