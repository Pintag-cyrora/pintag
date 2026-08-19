// Regression coverage for a reported bug: a Unit Type card named "2
// Bedroom 1 Bath" was rejected by the publish validator (admin.html) with
// "Required before publishing: ... Bedrooms, ... Bathrooms" even though
// the title plainly states both numbers -- staff had typed the name but
// never touched the separate numeric inputs.
//
// Fixed by parseUnitTypeTitle() (terminology.js), wired into the Unit
// Type card's Name field oninput handler (_utUpdateSummary() /
// _utAutofillBedBathFromName(), admin.html) so Bedrooms/Bathrooms
// auto-populate the moment a recognized pattern is typed. A field the
// staff member edits directly is marked manual (dataset.utManual) and is
// never overwritten by a later Name edit again -- this suite exercises
// that override behavior directly, plus the "cannot be parsed
// confidently -> stays blank, validator still catches it" case, plus that
// loading an existing (already-saved) unit type never has its real values
// silently recomputed from the title.
const { test, expect } = require('@playwright/test');

// admin.html is gated by admin-auth.js's isVerifiedAdminSession(), which
// requires BOTH the sole administrator email AND an AAL2 (MFA-verified)
// session. This stub previously answered only getUser()/getSession() with a
// non-administrator email, so once MFA enforcement landed every test in this
// file sat on the sign-in overlay until it timed out. It must satisfy all
// three checks: getUser(), the email match, and
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
  // The "+ New Listing" button only exists once admin-auth.js has verified the
  // AAL2 admin session and removed the sign-in overlay. (This used to wait on
  // #admin-screen, an id admin.html does not have, and swallowed the timeout --
  // so a failed sign-in looked like a selector bug much further down.)
  await page.waitForSelector('button.btn-import', { state: 'visible', timeout: 15000 });
  return pageErrors;
}

// Opens a blank New Listing form and adds one fresh Unit Type card,
// expanded (a new card starts collapsed -- .ut-body is display:none until
// its .ut-head is clicked, see _utToggle()/admin.html), returning its
// locator.
async function newUnitTypeCard(page) {
  // showForm(null) is where the "+ New Listing" flow lands (via
  // showImportPanel -> resetListingForm). The old '.btn-new' selector matched
  // nothing -- that button's class is .btn-import.
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  // .btn-add-row is also the class on "+ Add nearby place", so scope to the
  // Unit Types one.
  await page.click('button.btn-add-row[onclick="addUnitType()"]');
  const card = page.locator('.ut-card').last();
  await card.locator('.ut-head').click();
  return card;
}

test('typing "2 Bedroom 1 Bath" into the Name field auto-fills Bedrooms=2, Bathrooms=1 (the reported bug)', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('2 Bedroom 1 Bath');

  await expect(card.locator('.ut-bedrooms')).toHaveValue('2');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('1');
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('Studio auto-fills Bedrooms=0 and leaves Bathrooms blank', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('Studio');

  await expect(card.locator('.ut-bedrooms')).toHaveValue('0');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('');
});

test('a title that cannot be parsed confidently leaves both fields blank, requiring manual input', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('Deluxe Suite');

  await expect(card.locator('.ut-bedrooms')).toHaveValue('');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('');
});

test('a manual edit to Bedrooms is never overwritten by a later Name edit', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('2 Bedroom 1 Bath');
  await expect(card.locator('.ut-bedrooms')).toHaveValue('2');

  // Staff overrides Bedrooms by hand (e.g. the title undersells an extra
  // maid's room the actual unit has).
  await card.locator('.ut-bedrooms').fill('3');
  // Then keeps editing the name -- the manual Bedrooms value must survive,
  // while Bathrooms (never touched by hand) keeps tracking the title.
  await card.locator('.ut-name-en').fill('2 Bedroom 2 Bath (converted)');

  await expect(card.locator('.ut-bedrooms')).toHaveValue('3');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('2');
});

test('a manually-blanked field stays blank even if the name still parses', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('2 Bedroom 1 Bath');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('1');

  // Staff explicitly clears Bathrooms by hand (e.g. shared bathroom, not
  // yet decided how to represent it) -- editing Name again must not
  // silently refill it.
  await card.locator('.ut-bathrooms').fill('');
  await card.locator('.ut-name-en').fill('2 Bedroom 1 Bath Deluxe');

  await expect(card.locator('.ut-bathrooms')).toHaveValue('');
});

test('loading an existing unit type never recomputes already-saved Bedrooms/Bathrooms from its title', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });

  // Simulates editListing()/loadUnitTypes() populating a card from a real
  // saved row whose title happens not to match its own numbers (a name
  // edited after the fact, or a deliberately mismatched label) -- the
  // stored bedrooms/bathrooms must win, never the title-driven inference.
  await page.evaluate(() => {
    addUnitType({ name_en: 'Penthouse (was 2BR, now merged)', bedrooms: 4, bathrooms: 3 });
  });
  const card = page.locator('.ut-card').last();

  await expect(card.locator('.ut-bedrooms')).toHaveValue('4');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('3');
  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
});

test('"3 Bed 2 Bath" (abbreviated wording) auto-fills correctly, matching parseUnitTypeTitle unit coverage', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await newUnitTypeCard(page);

  await card.locator('.ut-name-en').fill('3 Bed 2 Bath');

  await expect(card.locator('.ut-bedrooms')).toHaveValue('3');
  await expect(card.locator('.ut-bathrooms')).toHaveValue('2');
});
