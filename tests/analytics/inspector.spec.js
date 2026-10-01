// analytics-inspector.html in a real browser, under four browser timezones.
// The page must query and display Asia/Vientiane calendar days regardless of
// the admin's machine. REST/auth/CDN are stubbed; nothing leaves localhost.
const { test, expect } = require('@playwright/test');

const TIMEZONES = ['UTC', 'Asia/Vientiane', 'America/Los_Angeles', 'Pacific/Kiritimati'];
// 2026-09-30T20:00Z == 2026-10-01 03:00 in Laos (still 09-30 in UTC / Los Angeles).
const NOW = '2026-09-30T20:00:00Z';

function fakeRest() {
  const requests = [];
  async function install(page) {
    await page.route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.fulfill({ status: 204, body: '' }));
    await page.route('**/cdn.jsdelivr.net/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.supabase={createClient:function(){return {auth:{onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};'
    }));
    await page.route('**/admin-auth.js*', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.PintagAdminAuth={protect:function(c,cb){setTimeout(cb,0);},token:async function(){return "test-token";},logout:async function(){}};'
    }));
    await page.route(/\/rest\/v1\//, route => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
      const url = new URL(req.url());
      requests.push(decodeURIComponent(url.pathname.split('/rest/v1/')[1] + url.search));
      // One ui_event at 2026-09-30T20:15:30Z (Laos 2026-10-01 03:15:30) for session S1.
      const table = url.pathname.split('/rest/v1/')[1];
      const body = table === 'ui_events' ? [{ session_id: 'S1', created_at: '2026-09-30T20:15:30+00:00' }] : [];
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }
  const tableQueries = table => requests.filter(r => r.startsWith(table + '?'));
  return { install, requests, tableQueries };
}

async function open(page, fake) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await fake.install(page);
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/analytics-inspector.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sessions-list .sessions-table')).toBeVisible();
  return errors;
}

for (const tz of TIMEZONES) {
  test.describe('Inspector, browser timezone ' + tz, () => {
    test.use({ timezoneId: tz });

    test('explicit From/To are Laos wall-clock bounds', async ({ page }) => {
      const fake = fakeRest();
      const errors = await open(page, fake);
      fake.requests.length = 0;
      await page.fill('#f-date-from', '2026-10-01T00:00');
      await page.fill('#f-date-to', '2026-10-01T23:59');
      await page.click('text=Filter Sessions');
      await expect(page.locator('#sessions-view-title')).toContainText('Laos time: 2026-10-01 00:00 → 2026-10-01 23:59');
      await expect.poll(() => fake.tableQueries('ui_events').length).toBeGreaterThan(0);
      for (const t of ['ui_events', 'search_events', 'listing_events', 'lead_events']) {
        const q = fake.tableQueries(t)[0];
        expect(q, t).toContain('created_at=gte.2026-09-30T17:00:00.000Z');
        expect(q, t).toContain('created_at=lte.2026-10-01T16:59:00.000Z');
      }
      expect(errors).toEqual([]);
    });

    test('Laos "today" (from the page clock) is 2026-10-01 and bounds the same instants', async ({ page }) => {
      const fake = fakeRest();
      const errors = await open(page, fake);
      const today = await page.evaluate(() => PT_LAOS_DATE.todayLaos());
      expect(today).toBe('2026-10-01');
      fake.requests.length = 0;
      await page.fill('#f-date-from', today + 'T00:00');
      await page.fill('#f-date-to', PT_LAOS_DATE_NEXT(today) + 'T00:00');
      await page.click('text=Filter Sessions');
      await expect.poll(() => fake.tableQueries('ui_events').length).toBeGreaterThan(0);
      const q = fake.tableQueries('ui_events')[0];
      expect(q).toContain('created_at=gte.2026-09-30T17:00:00.000Z');
      expect(q).toContain('created_at=lte.2026-10-01T17:00:00.000Z');
      expect(errors).toEqual([]);
    });

    test('session start time and timeline render in Laos time', async ({ page }) => {
      const fake = fakeRest();
      await open(page, fake);
      // 20:15Z == 03:15 Laos on Oct 1, whatever this browser's timezone is.
      await expect(page.locator('#sessions-list .sessions-table tbody tr').first()).toContainText(/Oct\s*1.*03:15|1\s*Oct.*03:15/);
    });

    test('labels say Laos time; the unfiltered view still uses the latest-N limit', async ({ page }) => {
      const fake = fakeRest();
      await open(page, fake);
      await expect(page.locator('label', { hasText: 'From (Laos time)' })).toBeVisible();
      await expect(page.locator('label', { hasText: 'To (Laos time)' })).toBeVisible();
      await expect(page.locator('th', { hasText: 'Start Time (Laos)' })).toBeVisible();
      expect(fake.tableQueries('ui_events')[0]).toContain('limit=300');
      expect(fake.tableQueries('ui_events')[0]).not.toContain('created_at=gte');
    });
  });
}
function PT_LAOS_DATE_NEXT(label) {
  const d = new Date(label + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}
