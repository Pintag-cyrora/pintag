// Shared Supabase REST/auth mocking for the intelligence.html Playwright
// suite. Routes by the actual REST path segment (not a loose substring
// match against the whole URL) -- a query's own `select=` clause can
// legitimately embed another table's name (e.g. report_insights's
// `select=role,intelligence_reports(...)`), and substring matching against
// the full URL would misroute a request like that to the wrong handler.
const fs = require('fs');
const path = require('path');

async function installSupabaseMocks(page, { reports, insights, reportInsights, leads }) {
  leads = leads || [];
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
          access_token: 'fake-token', token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
          user: { id: 'user-1', email: 'admin@pintag.io' },
        }),
      });
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.values(insights)) });
    }

    if (table === 'leads') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(leads) });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

module.exports = { installSupabaseMocks };
