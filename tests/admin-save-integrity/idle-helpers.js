// Boots the REAL admin.html with the REAL admin-auth.js (not the harness stub) against a controllable fake Supabase auth
// client, so session events can be fired at will, and instruments every navigation-relevant call.
const { fakeBackend } = require('./fixtures');

const AUTH_STUB = `
window.__authCbs = []; window.__signOuts = 0;
window.supabase = { createClient: function () { return {
  auth: {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'u1' } } } }),
    refreshSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
    getUser: async () => ({ data: { user: { id: 'u1', email: 'cyrora.trading@gmail.com' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' }, error: null }) },
    onAuthStateChange: function (cb) { window.__authCbs.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
    signOut: async () => { window.__signOuts++; return {}; }
  },
  storage: { from: function () { return { upload: async () => ({}), getPublicUrl: function () { return { data: { publicUrl: '' } }; } }; } }
}; } };`;

async function bootRealAuth(page, backend) {
  backend = backend || fakeBackend();
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: AUTH_STUB }));
  await page.route('**/rest/v1/**', backend.handle);
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ title_en: 'Imported Condo', property_type: 'condo', transaction_type: 'for_sale', description_en: 'x', price_amount: 100000, bedrooms: 2, bathrooms: 1 }) }));
  const pageErrors = [];
  const navigations = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  // Count calls to the navigation functions, with who called (stack head), from before any page script runs.
  await page.addInitScript(() => {
    window.__nav = [];
    window.__wrap = (n) => { const f = window[n]; if (typeof f !== 'function' || f.__wrapped) return; const w = function () { window.__nav.push(n + ' @' + Math.round(performance.now())); return f.apply(this, arguments); }; w.__wrapped = true; window[n] = w; };
  });
  await page.goto('/admin.html');
  // Real boot: overlay -> isVerifiedAdminSession -> enterAdmin -> bootAdmin -> admin screen.
  await page.waitForFunction(() => document.getElementById('admin-screen') && document.getElementById('admin-screen').style.display === 'block'
    && !document.getElementById('pintag-admin-auth'), null, { timeout: 15000 });
  await page.evaluate(() => ['showListings', 'revealFormPanel', 'resetListingForm', 'showImportPanel', 'showForm', 'loadListings', 'showAdminScreen', 'bootAdmin'].forEach(window.__wrap));
  return { backend, pageErrors, navigations };
}

const view = (page) => page.evaluate(() => ({
  listings: document.getElementById('listings-panel').style.display,
  import: document.getElementById('import-panel').style.display,
  form: document.getElementById('form-panel').style.display,
  overlay: !!document.getElementById('pintag-admin-auth'),
}));

module.exports = { bootRealAuth, view };
