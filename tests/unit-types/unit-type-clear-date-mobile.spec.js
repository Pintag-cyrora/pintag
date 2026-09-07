// Regression coverage for a reported bug: the Next Available Date "Clear"
// button (unit-type-clear-date.spec.js) was invisible/unreachable on real
// iPhone Safari, even though it rendered fine in desktop-viewport tests.
//
// Root cause: admin.html's .ut-grid switches from 3 columns to 2 at
// max-width:640px (mobile), narrowing each .ut-field's track. Neither
// .ut-field (a CSS Grid item) nor .ut-date-row (the flex row inside it) had
// min-width:0, so the grid item could not shrink below the flex row's
// min-content width -- a classic CSS Grid "blowout." Native
// <input type="date"> also has a browser-enforced minimum intrinsic width
// that ignores flexbox min-width:0/flex-shrink on the input itself; iOS
// Safari's is wider than desktop Chromium's, so the same layout that fit in
// every desktop-viewport test in this suite pushed the Clear button past the
// edge of a real iPhone screen, with no obvious scroll affordance.
//
// Fixed by adding min-width:0 (lets the grid item/flex row actually shrink)
// and flex-wrap:wrap (a browser-difference-proof fallback: the button drops
// to its own line rather than disappearing off-screen if the date input
// still needs more room than is available) to .ut-date-row.
//
// This suite runs at an iPhone-width viewport specifically -- the gap every
// other test in this directory (all default-viewport) could not catch.
const { test, expect } = require('@playwright/test');

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

// iPhone SE viewport width -- inside admin.html's max-width:640px mobile
// breakpoint (.ut-grid drops from 3 to 2 columns). Verified by mutation
// testing to be the narrowest width where the CSS Grid blowout this fix
// addresses is provably reproducible even under Chromium's own (narrower
// than iOS Safari's) native date-input rendering: at wider phone widths
// (360-428px) Chromium's date input happens to fit either way, masking the
// defect -- only at 320px does the pre-fix CSS genuinely overflow in this
// browser too, which is what makes this test a real regression guard rather
// than a tautology.
test.use({ viewport: { width: 320, height: 568 } });

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

// Same production-shaped fixture as the desktop suite: a unit re-marked
// Available with a real count, but a stale Next Available Date left over
// from when it was fully occupied. Uses a short name ('Studio') deliberately
// -- a long name (e.g. "1 Bedroom 1 Bathroom") overflows the unrelated,
// pre-existing .ut-head row at this viewport width (.ut-name-display has no
// shrink/truncation, unlike its sibling .ut-summary), which is a separate,
// out-of-scope bug in the card's collapsed header, not the Next Available
// Date row this suite targets. A short name keeps that unrelated defect out
// of these assertions.
async function unitTypeCardWithStaleDate(page) {
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  await page.evaluate(() => {
    addUnitType({
      name_en: 'Studio',
      bedrooms: 0,
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

test('at iPhone width, the Clear button is visible and fully inside the viewport', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);
  const clearBtn = card.locator('.ut-clear-date-btn');

  await expect(clearBtn).toBeVisible();
  const box = await clearBtn.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
});

test('at iPhone width, the date row itself never overflows its own field width', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  // Scoped to .ut-date-row's own box, not page-wide scrollWidth -- the page
  // has other, unrelated content (e.g. the card header's name display) whose
  // own responsiveness is out of scope here; this assertion isolates exactly
  // what .ut-date-row's min-width:0 + flex-wrap:wrap fix is responsible for.
  const dateRowBox = await card.locator('.ut-date-row').boundingBox();
  expect(dateRowBox.x + dateRowBox.width).toBeLessThanOrEqual(page.viewportSize().width);
});

test('at iPhone width, clicking Clear still empties the field and the save payload sends null', async ({ page }) => {
  await loadAdminAsStaff(page);
  const card = await unitTypeCardWithStaleDate(page);

  await card.locator('.ut-clear-date-btn').click();

  await expect(card.locator('.ut-next-available-date')).toHaveValue('');
  const rows = await page.evaluate(() => getUnitTypesFromDom());
  expect(rows[0].next_available_date).toBeNull();
});

test('at iPhone width, a brand-new unit type card still shows a clickable Clear button', async ({ page }) => {
  await loadAdminAsStaff(page);
  await page.evaluate(() => showForm(null));
  await page.waitForSelector('#f-transaction', { state: 'visible' });
  await page.click('button.btn-add-row[onclick="addUnitType()"]');
  const card = page.locator('.ut-card').last();
  await card.locator('.ut-head').click();

  const clearBtn = card.locator('.ut-clear-date-btn');
  await expect(clearBtn).toBeVisible();
  const box = await clearBtn.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
});
