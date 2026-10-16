// Boots the REAL admin.html + REAL admin-auth.js + the REAL @supabase/supabase-js bundle (auth-js state machine,
// token refresh, signOut, cross-tab events) against a fake GoTrue + REST server, so session behaviour is the
// library's own, not a stub's. Used to find out what can leave an open New Listing form.
const fs = require('fs');
const { fakeBackend } = require('./fixtures');

const UMD = require.resolve('@supabase/supabase-js/dist/umd/supabase.js');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', email: 'cyrora.trading@gmail.com', aal: 'aal2', role: 'authenticated', session_id: 's1', exp, amr: [{ method: 'totp', timestamp: 1 }] }) + '.sig';
const USER = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'cyrora.trading@gmail.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };

function sessionJson(expiresInSec, refresh) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  return { access_token: jwt(exp), token_type: 'bearer', expires_in: expiresInSec, expires_at: exp, refresh_token: refresh || 'r1', user: USER };
}

// mode: { refresh: 'ok'|'invalid'|'netfail'|'500', logout: 'ok'|'500'|'netfail', user: 'ok'|'500'|'netfail' }
async function bootRealSupabase(page, mode) {
  mode = Object.assign({ refresh: 'ok', logout: 'ok', user: 'ok' }, mode || {});
  const backend = fakeBackend();
  const calls = [];
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(UMD, 'utf8') }));
  await page.route(/fonts\.(googleapis|gstatic)\.com|unpkg\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', backend.handle);
  await page.route('**/functions/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/auth/v1/**', (route) => {
    const u = new URL(route.request().url()); const path = u.pathname.replace(/^.*\/auth\/v1/, ''); const m = route.request().method();
    calls.push(m + ' ' + path + (u.search || ''));
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/user') { if (mode.user === 'netfail') return route.abort('failed'); if (mode.user === '500') return json(500, { message: 'boom' }); return json(200, USER); }
    if (path === '/token') {
      if (mode.refresh === 'netfail') return route.abort('failed');
      if (mode.refresh === '500') return json(500, { message: 'boom' });
      if (mode.refresh === 'invalid') return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found' });
      return json(200, sessionJson(3600, 'r' + (calls.length + 1)));
    }
    if (path === '/logout') { if (mode.logout === 'netfail') return route.abort('failed'); if (mode.logout === '500') return json(500, { message: 'boom' }); return route.fulfill({ status: 204, body: '' }); }
    return json(200, {});
  });
  const pageErrors = []; const navigations = []; const dialogs = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => {
    window.__nav = []; window.__events = [];
    window.__wrap = (n) => { const f = window[n]; if (typeof f !== 'function' || f.__wrapped) return; const w = function () { window.__nav.push(n + ' @' + Math.round(performance.now())); return f.apply(this, arguments); }; w.__wrapped = true; window[n] = w; };
  });
  // First load only to learn the storage key; then seed a live AAL2 session and reload (a normal "already signed in" visit).
  await page.goto('/admin.html');
  const key = await page.evaluate(() => 'sb-' + new URL(window.PINTAG.supabaseUrl).hostname.split('.')[0] + '-auth-token');
  await page.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [key, sessionJson(3600, 'r1')]);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('admin-screen') && document.getElementById('admin-screen').style.display === 'block' && !document.getElementById('pintag-admin-auth'), null, { timeout: 15000 });
  await page.evaluate(() => {
    ['showListings', 'revealFormPanel', 'resetListingForm', 'showImportPanel', 'showForm', 'loadListings'].forEach(window.__wrap);
    // record every auth event the real client emits to admin-auth's/admin.html's listeners
    sbClient.auth.onAuthStateChange((e, s) => { window.__events.push(e + ':' + (s ? 'session' : 'null')); });
  });
  navigations.length = 0;
  return { backend, calls, mode, key, pageErrors, navigations, dialogs };
}

async function openNewListingAndType(page) {
  await page.evaluate(() => { showForm(); });
  await page.evaluate(() => { document.getElementById('f-title-en').value = 'Half-typed listing'; document.getElementById('f-contact-phone').value = '02055512345'; });
}
const state = (page) => page.evaluate(() => ({
  listings: (document.getElementById('listings-panel') || {style:{}}).style.display,
  form: (document.getElementById('form-panel') || {style:{}}).style.display,
  overlay: !!document.getElementById('pintag-admin-auth') && getComputedStyle(document.getElementById('pintag-admin-auth')).display !== 'none',
  title: (document.getElementById('f-title-en') || {}).value,
  events: window.__events, nav: window.__nav,
})).catch((e) => ({ error: String(e).slice(0, 80) }));

module.exports = { bootRealSupabase, openNewListingAndType, state, sessionJson };
