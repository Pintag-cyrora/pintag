// Admin <-> Analytics navigation.
//
// THE BUG. admin.html has an in-page "📊 Analytics" tab that swaps the listings
// table for a lead-count panel. The "All Listings" tab next to it was a bare
// <button> with no handler, so once Analytics was open the only way back to the
// listings was to click "📊 Analytics" a second time. And showListings() (the
// target of New Listing's Cancel / Back / post-save) never reset that state, so
// leaving Analytics open, starting a New Listing and coming back showed the
// listings PANEL with the listings TABLE still hidden: an empty Admin page.
//
// These tests drive the real admin.html. Only the network edge is faked: the
// Supabase client (a signed-in AAL2 admin, so admin-auth.js boots the page
// exactly as in production) and /rest/v1/*. They read the VISIBLE state
// (computed display / offsetParent), not just inline style strings.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_EMAIL = 'cyrora.trading@gmail.com';

async function stubSupabase(page) {
  await page.addInitScript((email) => {
    const user = { id: 'u1', email };
    const session = { access_token: 'fake-token', user };
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session }, error: null }),
          getUser: async () => ({ data: { user }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null }),
          mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' }, error: null }) },
        },
      }),
    };
  }, ADMIN_EMAIL);
  // admin.html loads the real supabase-js from jsdelivr with a <script> tag. On a
  // machine with network access that script REPLACES window.supabase and undoes
  // the stub above (the page then runs real auth, finds no session and stays
  // behind the login overlay). Serve it an empty script so the stub always wins,
  // with or without internet access.
  await page.route('**/cdn.jsdelivr.net/npm/@supabase/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/rest/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/0' }, body: '[]' }));
}

async function openAdmin(page) {
  await stubSupabase(page);
  await page.goto('/admin.html', { waitUntil: 'domcontentloaded' });
  // The signed-in boot path must have run: admin-auth.js removed its overlay
  // and showAdminScreen() revealed the page.
  await expect(page.locator('#admin-screen')).toBeVisible();
  await expect(page.locator('#listings-container')).toBeVisible();
}

// Tabs are found by their visible label, so these behaviour tests mean the same
// thing on the old markup (no ids) and the new.
const view = (page) => page.evaluate(() => {
  const shown = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
  return {
    listings: shown('listings-container'),
    analytics: shown('analytics-panel'),
    listingsTabActive: [...document.querySelectorAll('.tabs button.tab')].find((b) => b.textContent.trim() === 'All Listings').classList.contains('active'),
    analyticsTabActive: document.getElementById('analytics-tab').classList.contains('active'),
  };
});

const LISTINGS_VIEW = { listings: true, analytics: false, listingsTabActive: true, analyticsTabActive: false };
const ANALYTICS_VIEW = { listings: false, analytics: true, listingsTabActive: false, analyticsTabActive: true };

test.describe('in-page Analytics view', () => {
  test('starts on the listings view', async ({ page }) => {
    await openAdmin(page);
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('📊 Analytics toggles on, and a second click toggles it off again', async ({ page }) => {
    await openAdmin(page);
    await page.locator('#analytics-tab').click();
    expect(await view(page)).toEqual(ANALYTICS_VIEW);
    await page.locator('#analytics-tab').click();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
    await page.locator('#analytics-tab').click();
    expect(await view(page)).toEqual(ANALYTICS_VIEW);
  });

  test('THE BUG: Analytics -> All Listings restores the listings view', async ({ page }) => {
    await openAdmin(page);
    await page.locator('#analytics-tab').click();
    expect(await view(page)).toEqual(ANALYTICS_VIEW);
    await page.getByRole('button', { name: 'All Listings' }).click();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('All Listings while already on the listings view is a no-op, not a toggle', async ({ page }) => {
    await openAdmin(page);
    await page.getByRole('button', { name: 'All Listings' }).click();
    await page.getByRole('button', { name: 'All Listings' }).click();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('THE BUG: Analytics -> + New Listing -> listing form -> Cancel restores the listings view', async ({ page }) => {
    await openAdmin(page);
    await page.locator('#analytics-tab').click();
    // + New Listing opens Smart Import; the listing form (with its Cancel
    // button) is the next step of that same flow.
    await page.locator('button.btn-import').click();
    await expect(page.locator('#import-panel')).toBeVisible();
    await page.evaluate(() => { showForm(null); });
    await expect(page.locator('#form-panel')).toBeVisible();
    await expect(page.locator('#listings-panel')).toBeHidden();
    await page.locator('#form-panel .form-submit .btn-cancel').click();
    await expect(page.locator('#listings-panel')).toBeVisible();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('THE BUG: Analytics -> + New Listing -> Back arrow restores the listings view', async ({ page }) => {
    await openAdmin(page);
    await page.locator('#analytics-tab').click();
    await page.locator('button.btn-import').click();
    await page.locator('#import-panel .form-back').click();
    await expect(page.locator('#listings-panel')).toBeVisible();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('THE BUG: showListings() (the post-save return path) restores the listings view', async ({ page }) => {
    await openAdmin(page);
    await page.locator('#analytics-tab').click();
    await page.evaluate(() => { showImportPanel(); });
    await page.evaluate(() => { showListings(); });
    await expect(page.locator('#listings-panel')).toBeVisible();
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });

  test('setAnalyticsView takes an explicit state and is idempotent', async ({ page }) => {
    await openAdmin(page);
    await page.evaluate(() => { setAnalyticsView(true); setAnalyticsView(true); });
    expect(await view(page)).toEqual(ANALYTICS_VIEW);
    await page.evaluate(() => { setAnalyticsView(false); setAnalyticsView(false); });
    expect(await view(page)).toEqual(LISTINGS_VIEW);
  });
});

// Static guard: the two cross-page links the bug report was about. A rename of
// either page, or a link dropped from the nav, fails here instead of leaving
// the admin with no route between the two.
test.describe('Admin <-> Analytics links', () => {
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const analytics = fs.readFileSync(path.join(ROOT, 'analytics.html'), 'utf8');
  const inspector = fs.readFileSync(path.join(ROOT, 'analytics-inspector.html'), 'utf8');

  test('admin.html links to analytics.html from the tab row and from the in-page panel', () => {
    expect((admin.match(/<a [^>]*href="analytics\.html"[^>]*>/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(admin).toMatch(/<a class="tab" href="analytics\.html"[^>]*>[^<]*Full Analytics/);
    expect(fs.existsSync(path.join(ROOT, 'analytics.html'))).toBe(true);
  });

  test('admin.html links to analytics-inspector.html', () => {
    expect(admin).toMatch(/<a [^>]*href="analytics-inspector\.html"/);
    expect(fs.existsSync(path.join(ROOT, 'analytics-inspector.html'))).toBe(true);
  });

  test('analytics.html and analytics-inspector.html link back to admin.html', () => {
    expect(analytics).toMatch(/<a href="admin\.html"[^>]*btn-back[^>]*>/);
    expect(inspector).toMatch(/<a href="admin\.html"[^>]*btn-back[^>]*>/);
    expect(fs.existsSync(path.join(ROOT, 'admin.html'))).toBe(true);
  });

  test('the All Listings tab has an id and an explicit handler (not a bare button)', () => {
    expect(admin).toMatch(/<button class="tab active" id="listings-tab" onclick="setAnalyticsView\(false\)">All Listings<\/button>/);
  });

  test('nothing locates the All Listings tab by position any more', () => {
    expect(admin).not.toMatch(/querySelectorAll\('\.tab'\)\[0\]/);
  });
});

test('the rendered Full Analytics tab resolves to /analytics.html', async ({ page }) => {
  await openAdmin(page);
  // A plain anchor: assert the destination the browser will navigate to without
  // depending on analytics.html booting (it needs a real admin session).
  const href = await page.locator('a.tab[href="analytics.html"]').getAttribute('href');
  expect(new URL(href, page.url()).pathname).toBe('/analytics.html');
});
