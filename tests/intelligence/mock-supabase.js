// Shared Supabase REST/auth mocking for the intelligence.html Playwright
// suite. Routes by the actual REST path segment (not a loose substring
// match against the whole URL) -- a query's own `select=` clause can
// legitimately embed another table's name (e.g. report_insights's
// `select=role,intelligence_reports(...)`), and substring matching against
// the full URL would misroute a request like that to the wrong handler.
const fs = require('fs');
const path = require('path');

// Minimal PostgREST filter-query interpreter -- just enough to make the
// intelligence_insights mock route honest about eq/neq/in/is.null filters,
// since loadAlerts() and loadListingsNeedingAttention() now issue several
// differently-filtered queries against the same table and must not each
// receive the same unfiltered full set (which would double-count rows).
function matchesFilter(fieldValue, filterValue) {
  if (filterValue === 'is.null') return fieldValue === null || fieldValue === undefined;
  if (filterValue === 'not.is.null') return fieldValue !== null && fieldValue !== undefined;
  const eqMatch = filterValue.match(/^eq\.(.*)$/);
  if (eqMatch) return String(fieldValue) === decodeURIComponent(eqMatch[1]);
  const neqMatch = filterValue.match(/^neq\.(.*)$/);
  if (neqMatch) return String(fieldValue) !== decodeURIComponent(neqMatch[1]);
  const inMatch = filterValue.match(/^in\.\((.*)\)$/);
  if (inMatch) return inMatch[1].split(',').map(decodeURIComponent).includes(String(fieldValue));
  return true; // unknown operator -- don't filter, safer default for a test mock
}
function applyPostgrestFilters(rows, url) {
  const params = new URL(url).searchParams;
  let result = rows;
  for (const [key, value] of params.entries()) {
    if (['select', 'order', 'limit', 'or'].includes(key)) continue;
    result = result.filter((row) => matchesFilter(row[key], value));
  }
  return result;
}

// Base64url without padding, for building a JWT the browser-side stub decodes.
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// The single administrator the production auth module (admin-auth.js) admits.
const ADMIN_EMAIL = 'cyrora.trading@gmail.com';
const ADMIN_USER = { id: 'user-1', email: ADMIN_EMAIL, aud: 'authenticated', role: 'authenticated' };

// A real (decodable) access-token JWT whose payload carries aal: "aal2", so the
// unmodified admin-auth.js verification path — getUser() + mfa
// getAuthenticatorAssuranceLevel() — sees a verified AAL2 admin session and
// reaches enterAdmin()/bootIntelligence() on its own. The signature is a
// placeholder: supabase-js decodes (never verifies) the JWT client-side.
function makeAal2AccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: ADMIN_USER.id, email: ADMIN_EMAIL, aud: 'authenticated', role: 'authenticated',
    aal: 'aal2', amr: [{ method: 'password' }, { method: 'totp' }],
    iat: now, exp: now + 3600,
  });
  return header + '.' + payload + '.' + 'test-signature-not-verified';
}

async function installSupabaseMocks(page, { reports, insights, reportInsights, leads }) {
  leads = leads || [];

  // Seed a PERSISTED verified admin session before any page script runs, the
  // way real supabase-js would hydrate one from localStorage. The browser-side
  // stub (fake-supabase-js.js) rehydrates it on createClient(); admin-auth.js
  // then validates it (server-side getUser + AAL2) and reveals #intel-screen
  // naturally. This does not touch or bypass the production auth module.
  const accessToken = makeAal2AccessToken();
  await page.addInitScript(({ key, session }) => {
    try { window.localStorage.setItem(key, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }, {
    key: 'pintag.test.auth.session',
    session: {
      access_token: accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
      user: ADMIN_USER,
    },
  });

  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', async (route) => {
    const body = fs.readFileSync(path.join(__dirname, 'fake-supabase-js.js'), 'utf8');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body });
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));

  await page.route('**/*.supabase.co/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.includes('/auth/v1/token')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          access_token: accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
          user: ADMIN_USER,
        }),
      });
    }
    // Server-side identity check performed by admin-auth.js's getUser(): return
    // the verified administrator so the real verification path passes honestly.
    if (url.includes('/auth/v1/user')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ADMIN_USER) });
    }
    if (url.includes('/auth/v1/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (url.includes('/functions/v1/generate-intelligence-report')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }

    const pathname = new URL(url).pathname;
    const table = pathname.split('/').pop();

    if (table === 'intelligence_reports') {
      if (method === 'DELETE') {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
        const idx = reports.findIndex((r) => r.id === id);
        if (idx !== -1) reports.splice(idx, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      const idMatch = url.match(/id=eq\.([^&]+)/);
      const rows = idMatch ? reports.filter((r) => r.id === decodeURIComponent(idMatch[1])) : reports;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }

    if (table === 'report_insights') {
      const reportIdMatch = url.match(/report_id=eq\.([^&]+)/);
      const insightIdMatch = url.match(/insight_id=eq\.([^&]+)/);
      if (reportIdMatch) {
        const rid = decodeURIComponent(reportIdMatch[1]);
        const rows = reportInsights.filter((l) => l.report_id === rid).map((l) => ({ role: l.role, intelligence_insights: insights[l.insight_id] }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      }
      if (insightIdMatch) {
        const iid = decodeURIComponent(insightIdMatch[1]);
        const rows = reportInsights.filter((l) => l.insight_id === iid).map((l) => ({ role: l.role, intelligence_reports: reports.find((r) => r.id === l.report_id) }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }

    if (table === 'intelligence_insights') {
      const idMatch = url.match(/id=eq\.([^&]+)/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(insights[id] ? [insights[id]] : []) });
      }
      const filtered = applyPostgrestFilters(Object.values(insights), url);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filtered) });
    }

    if (table === 'leads') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(leads) });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

module.exports = { installSupabaseMocks };
