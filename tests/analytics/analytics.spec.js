// Admin Analytics page, end to end, against stubbed RPCs.
//
//   cd tests/analytics && npm install && npx playwright test
//
// Drives the REAL analytics.html + analytics.js + analytics-core.js +
// laos-date.js + charts.js. Only the network edge is faked: the Supabase
// client CDN script, admin-auth.js (login/2FA) and every /rest/v1/rpc/<fn>
// call. The fake server records every call so the tests can assert the exact
// p_start / p_end / cursor the page sent -- which is the whole point: the
// browser must send Laos calendar-day labels no matter what timezone it is in.
const { test, expect } = require('@playwright/test');
const LAOS = require('../../laos-date.js');
const CORE = require('../../analytics-core.js');

const TIMEZONES = ['UTC', 'Asia/Vientiane', 'Pacific/Kiritimati'];
// 2026-10-01 00:30 in Laos, 2026-09-30 17:30 UTC: the instant the requirement calls out.
const NOW = '2026-09-30T17:30:00Z';

// ── fake lead pool (one row per lead / legacy event / unattributed event) ──
const PID = { A: 'aaaaaaaa-0000-0000-0000-00000000000a', B: 'aaaaaaaa-0000-0000-0000-00000000000b', C: 'aaaaaaaa-0000-0000-0000-00000000000c',
  D: 'aaaaaaaa-0000-0000-0000-00000000000d', E: 'aaaaaaaa-0000-0000-0000-00000000000e', F: 'aaaaaaaa-0000-0000-0000-00000000000f' };
const LISTINGS = {
  [PID.A]: { title: 'Villa Alpha', resolution: 'current', deleted: false },
  [PID.B]: { title: 'Condo Beta', resolution: 'current', deleted: false },
  [PID.C]: { title: 'Gamma Soft', resolution: 'soft_deleted', deleted: true },
  [PID.D]: { title: 'Delta Snap', resolution: 'snapshot', deleted: true },
  [PID.E]: { title: 'Echo Log', resolution: 'removal_log', deleted: true },
  [PID.F]: { title: 'Unknown listing aaaaaaaa', resolution: 'unknown', deleted: true }
};
for (let i = 1; i <= 12; i++) {
  LISTINGS['bbbbbbbb-0000-0000-0000-' + String(i).padStart(12, '0')] = { title: 'Extra Listing ' + i, resolution: 'current', deleted: false };
}

let seq = 0;
function makeRow(day, i, over) {
  const minute = 1439 - i; // strictly decreasing through the day => already newest-first
  const hh = String(Math.floor(minute / 60)).padStart(2, '0'), mm = String(minute % 60).padStart(2, '0');
  const iso = new Date(Date.parse(day + 'T' + hh + ':' + mm + ':00+07:00')).toISOString().replace('.000Z', '.123456+00:00');
  const n = ++seq;
  const base = {
    event_at: iso, laos_day: day, kind: 'lead',
    lead_id: 'l' + String(n).padStart(7, '0') + '-0000-0000-0000-000000000000', lead_event_id: 'e' + String(n).padStart(7, '0') + '-0000-0000-0000-000000000000',
    contact_action: 'whatsapp_click', channel: 'whatsapp', lead_status: 'new',
    property_id: PID.B, unit_type_id: null, unit_type_name: null, agent_party_id: null, agent_name: 'Agent One', contact_id: null, contact_name: null, contact_role: null,
    recipient_type: null, recipient_verified: null, first_touch_source: 'facebook', session_id: 's' + n
  };
  const r = Object.assign(base, over || {});
  const L = r.property_id ? LISTINGS[r.property_id] : null;
  r.listing_title = over && 'listing_title' in over ? over.listing_title : (L ? L.title : null);
  r.listing_slug = null; r.listing_status = L ? 'active' : null;
  r.listing_resolution = L ? L.resolution : null;
  r.is_deleted = L ? L.deleted : false;
  r.row_id = r.lead_id || r.lead_event_id;
  return r;
}
function buildPool() {
  seq = 0;
  const pool = [];
  // 09-18: the mixed day the drill-down tests open
  let i = 0;
  const d18 = '2026-09-18';
  pool.push(makeRow(d18, i++, { property_id: PID.A, unit_type_name: 'Studio', contact_name: 'Contact Person', contact_role: 'agent' }));
  pool.push(makeRow(d18, i++, { property_id: PID.A, contact_action: 'call_click', channel: 'call' }));
  pool.push(makeRow(d18, i++, { property_id: PID.C, contact_action: 'telegram_click', channel: 'telegram' }));
  pool.push(makeRow(d18, i++, { property_id: PID.D, contact_action: 'contact_click', channel: 'contact' }));
  pool.push(makeRow(d18, i++, { property_id: PID.E }));
  pool.push(makeRow(d18, i++, { property_id: PID.F }));
  pool.push(makeRow(d18, i++, { property_id: PID.B }));
  pool.push(makeRow(d18, i++, { property_id: PID.B, contact_action: 'messenger_click', channel: 'messenger' }));
  pool.push(makeRow(d18, i++, { property_id: null, lead_event_id: null, first_touch_source: null, session_id: null }));
  pool.push(makeRow(d18, i++, { kind: 'legacy_event', lead_id: null, lead_status: null, property_id: PID.A }));
  pool.push(makeRow(d18, i++, { kind: 'unattributed_event', lead_id: null, lead_status: null, property_id: null }));
  // 09-17: 130 leads for one listing (Load more)
  for (let k = 0; k < 130; k++) pool.push(makeRow('2026-09-17', k, { property_id: PID.B }));
  // 09-16: 12 different listings, one lead each (makes the by-listing list longer than 10)
  for (let k = 1; k <= 12; k++) pool.push(makeRow('2026-09-16', k, { property_id: 'bbbbbbbb-0000-0000-0000-' + String(k).padStart(12, '0') }));
  // 09-14: 730 leads (two 500-row export pages); one title is a spreadsheet formula
  for (let k = 0; k < 730; k++) pool.push(makeRow('2026-09-14', k, { property_id: PID.B, listing_title: k === 5 ? '=HYPERLINK("http://evil.example","x")' : 'Condo Beta' }));
  return pool;
}

function summarise(rows) {
  const t = { leads: 0, legacy_events: 0, unattributed_events: 0, distinct_listings: 0, deleted_listing_rows: 0 };
  const props = new Set();
  for (const r of rows) {
    if (r.kind === 'lead') t.leads++; else if (r.kind === 'legacy_event') t.legacy_events++; else t.unattributed_events++;
    if (r.property_id) { props.add(r.property_id); if (r.is_deleted) t.deleted_listing_rows++; }
  }
  t.distinct_listings = props.size;
  return t;
}

// ── the fake RPC server ───────────────────────────────────────────────────
function makeFake(opts = {}) {
  const st = Object.assign({
    bounds: {
      tz: 'Asia/Vientiane', today: '2026-10-01', earliest_day: '2026-06-25', latest_day: '2026-09-30',
      sources: {
        page_views: { first_day: '2026-07-28' }, listing_events: { first_day: '2026-07-21' }, lead_events: { first_day: '2026-06-25' },
        leads: { first_day: '2026-08-11' }, search_events: { first_day: '2026-07-17' }, ui_events: { first_day: '2026-07-17' }
      }
    },
    fail: {}, pool: buildPool(), trafficRows: null
  }, opts);
  const calls = [];
  const restRequests = [];
  const zeroFill = (b, fill) => {
    const rows = []; for (let d = b.p_start; d < b.p_end; d = LAOS.addDays(d, 1)) rows.push(fill(d)); return rows;
  };
  const inRange = b => st.pool.filter(r => r.laos_day >= b.p_start && r.laos_day < b.p_end);
  const handlers = {
    analytics_history_bounds: () => st.bounds,
    analytics_realtime_snapshot: () => ({ active_visitors: 3, live_searches: 1, live_listing_views: 2, pages_now: { 'index.html': 2 } }),
    analytics_session_stats: () => ({ sessions: 10, avg_pages_per_session: 2, avg_session_duration_seconds: 30, bounce_rate: 20, page_views: 120, unique_visitors: 8, returning_visitors: 2 }),
    analytics_traffic_by_day: b => st.trafficRows ? st.trafficRows(b) : zeroFill(b, d => ({ day: d, page_views: 5, sessions: 3, unique_visitors: 2, returning_visitors: 1 })),
    analytics_traffic_sources: () => ({ by_source: { direct: 5 }, top_referrers: [], campaigns: [] }),
    analytics_listing_engagement: b => ({
      saves_total: 4, shares_total: 2, views_total: 50, share_rate: 4.0, shared_link_views: 1, views_per_share: 0.5, shared_link_leads: 0, secondary_shares: 0,
      wa_clicks: 17, call_clicks: 5, agent_profile_clicks: 9,
      views_by_day: zeroFill(b, d => ({ day: d, views: 2 })), most_viewed_total: 12, most_viewed: [{ label: 'Villa Alpha', value: 10 }], top_ctr: []
    }),
    analytics_search_breakdown: () => ({ total: 0, zero_result: 0, by_type: [], by_tx: [], by_district: [] }),
    analytics_funnel: () => [{ stage: 'landed', sessions: 1 }],
    analytics_behavior: () => ({ entry: [], exit: [], avg_duration: [], scroll: {}, top_clicks: [] }),
    analytics_location_breakdown: () => ({ device: {}, browser: {}, os: {}, lang: {} }),
    analytics_admin_insights: () => ({ new_listings: 7, by_agent: [], by_district: [], by_type: [], no_views: [], high_view_low_convert: [] }),
    analytics_leads_breakdown: b => {
      const rows = inRange(b);
      const leads = rows.filter(r => r.kind === 'lead');
      const byProp = {};
      leads.forEach(r => { if (r.property_id) byProp[r.property_id] = (byProp[r.property_id] || 0) + 1; });
      const ranked = Object.entries(byProp).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const top = ranked.slice(0, 10);
      return {
        total: leads.length, closed: 2, legacy_events: rows.filter(r => r.kind === 'legacy_event').length,
        unattributed_events: rows.filter(r => r.kind === 'unattributed_event').length,
        by_day: zeroFill(b, d => ({ day: d, value: leads.filter(r => r.laos_day === d).length, legacy: rows.filter(r => r.laos_day === d && r.kind === 'legacy_event').length, unattributed: rows.filter(r => r.laos_day === d && r.kind === 'unattributed_event').length })),
        by_listing: top.map(([id, n]) => ({ property_id: id, label: LISTINGS[id].title, value: n, resolution: LISTINGS[id].resolution, is_deleted: LISTINGS[id].deleted })),
        by_listing_total: ranked.length, by_listing_other: ranked.slice(10).reduce((s, [, n]) => s + n, 0),
        by_listing_unattributed: leads.filter(r => !r.property_id).length, by_listing_deleted: leads.filter(r => r.property_id && r.is_deleted).length,
        by_agent: [{ party_id: 'p1', label: 'Agent One', value: leads.length }], by_agent_total: 1, by_agent_other: 0, by_agent_unassigned: 0,
        by_source: { facebook: leads.length }, recent: []
      };
    },
    analytics_lead_activity: b => {
      let rows = inRange(b).filter(r => !b.p_property_id || r.property_id === b.p_property_id);
      rows.sort((x, y) => (x.event_at < y.event_at ? 1 : x.event_at > y.event_at ? -1 : (x.row_id < y.row_id ? 1 : -1)));
      const totals = summarise(rows);
      let from = 0;
      if (b.p_cursor_id) {
        const idx = rows.findIndex(r => r.row_id === b.p_cursor_id);
        if (idx < 0 || rows[idx].event_at !== b.p_cursor_at) throw Object.assign(new Error('cursor mismatch'), { status: 400 });
        from = idx + 1;
      }
      const limit = Math.min(Math.max(b.p_limit || 200, 1), 500);
      const page = rows.slice(from, from + limit);
      const has_more = from + limit < rows.length;
      const last = page[page.length - 1];
      return { range: { start: b.p_start, end: b.p_end, tz: 'Asia/Vientiane' }, property_id: b.p_property_id || null, totals,
        rows: page.map(r => { const c = Object.assign({}, r); delete c.row_id; return c; }),
        has_more, next_cursor: has_more ? { at: last.event_at, id: last.row_id } : null };
    }
  };

  async function install(page) {
    // Everything that is not this server is blocked so a stray request can never hang the page.
    await page.route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.fulfill({ status: 204, body: '' }));
    await page.route('**/cdn.jsdelivr.net/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.supabase={createClient:function(){return {auth:{onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};'
    }));
    await page.route('**/admin-auth.js*', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.PintagAdminAuth={protect:function(c,cb){setTimeout(cb,0);},token:async function(){return "test-token";},logout:async function(){}};'
    }));
    await page.route(/\/rest\/v1\//, async route => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
      const m = req.url().match(/\/rest\/v1\/rpc\/([a-z_]+)/);
      if (!m) { restRequests.push(req.method() + ' ' + req.url()); return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' }); }
      const fn = m[1];
      const body = req.postDataJSON() || {};
      calls.push({ fn, body });
      const fail = st.fail[fn];
      if (fail && (typeof fail === 'function' ? fail(body) : true)) {
        const f = typeof fail === 'object' ? fail : { status: 500, json: { code: '57014', message: 'canceling statement due to statement timeout' } };
        return route.fulfill({ status: f.status, headers: cors, contentType: 'application/json', body: JSON.stringify(f.json) });
      }
      try {
        const out = handlers[fn] ? handlers[fn](body) : {};
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(out) });
      } catch (e) {
        return route.fulfill({ status: e.status || 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ message: e.message }) });
      }
    });
  }
  const callsFor = fn => calls.filter(c => c.fn === fn).map(c => c.body);
  return { st, calls, restRequests, callsFor, install };
}

async function open(page, fake, now) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await fake.install(page);
  await page.clock.setFixedTime(new Date(now || NOW));
  await page.goto('/analytics.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#range-label')).not.toHaveText('');
  return errors;
}
const lastCall = (fake, fn) => { const c = fake.callsFor(fn); return c[c.length - 1]; };
const rowsText = page => page.locator('#la-table tbody tr');

// ═════════════════════════════════════════════════════════════════════════
// Presets: Laos calendar days, in every browser timezone
// ═════════════════════════════════════════════════════════════════════════
for (const tz of TIMEZONES) {
  test.describe('browser timezone ' + tz, () => {
    test.use({ timezoneId: tz });

    test('Today / 7d / 30d / 90d send Laos calendar-day labels (00:30 Laos time is the NEW day)', async ({ page }) => {
      const fake = makeFake();
      const errors = await open(page, fake);
      // default preset is 7d
      await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-09-25', p_end: '2026-10-02' });
      await expect(page.locator('#range-label')).toHaveText('Last 7 days · 2026-09-25 → 2026-10-01');
      await page.click('.range-preset[data-range="today"]');
      await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-10-01', p_end: '2026-10-02' });
      await expect(page.locator('#range-label')).toHaveText('Today · 2026-10-01');
      await page.click('.range-preset[data-range="30d"]');
      await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-09-02', p_end: '2026-10-02' });
      await page.click('.range-preset[data-range="90d"]');
      await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-07-04', p_end: '2026-10-02' });
      await expect(page.locator('#range-label')).toHaveText('Last 90 days · 2026-07-04 → 2026-10-01');
      expect(errors).toEqual([]);
    });

    test('every RPC on the page receives the same day labels (cards, charts and counts share one calendar)', async ({ page }) => {
      const fake = makeFake();
      await open(page, fake);
      await expect(page.locator('#view-overview .stat-grid')).toBeVisible();
      for (const tab of ['traffic', 'listings', 'search', 'behavior', 'leads', 'location', 'admin']) {
        await page.click('.tab[data-tab="' + tab + '"]');
        await expect(page.locator('#view-' + tab + ' .section-block').first()).toBeVisible();
      }
      const ranged = fake.calls.filter(c => 'p_start' in c.body && c.fn !== 'analytics_lead_activity');
      expect(ranged.length).toBeGreaterThan(8);
      for (const c of ranged) expect([c.fn, c.body.p_start, c.body.p_end]).toEqual([c.fn, '2026-09-25', '2026-10-02']);
    });
  });
}

test.describe('range controls', () => {
  test.use({ timezoneId: 'Asia/Vientiane' });

  test('All time starts at the real first day of data and disables compare', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await expect(page.locator('#compare-toggle')).toBeEnabled();
    await page.click('.range-preset[data-range="all"]');
    await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-06-25', p_end: '2026-10-02' });
    await expect(page.locator('#range-label')).toHaveText('All time · 2026-06-25 → 2026-10-01');
    await expect(page.locator('#compare-toggle')).toBeDisabled();
    await expect(page.locator('#compare-label')).toContainText('not available for All time');
    await expect(page.locator('.range-preset[data-range="all"]')).toHaveClass(/active/);
    await page.click('.range-preset[data-range="7d"]');
    await expect(page.locator('#compare-toggle')).toBeEnabled();
  });

  test('Compare to previous period: previous equal-length span is requested and deltas render', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await expect(page.locator('#view-overview .stat-grid')).toBeVisible();
    await page.check('#compare-toggle');
    // 7 days = 2026-09-25..2026-10-01 -> previous 7 days = 2026-09-18..2026-09-24
    await expect.poll(() => fake.callsFor('analytics_session_stats').some(b => b.p_start === '2026-09-18' && b.p_end === '2026-09-25')).toBe(true);
    await expect(page.locator('#view-overview .stat-delta').first()).toContainText('vs prev');
    // moving to another preset re-derives the previous span from the NEW range (Laos days)
    await page.click('.range-preset[data-range="today"]');
    await expect.poll(() => fake.callsFor('analytics_session_stats').some(b => b.p_start === '2026-09-30' && b.p_end === '2026-10-01')).toBe(true);
  });

  test('Compare is not offered a fabricated baseline when the previous period predates all data', async ({ page }) => {
    const fake = makeFake({ bounds: { tz: 'Asia/Vientiane', today: '2026-10-01', earliest_day: '2026-09-25', latest_day: '2026-09-30', sources: { page_views: { first_day: '2026-09-25' } } } });
    await open(page, fake);
    await expect(page.locator('#view-overview .stat-grid')).toBeVisible();
    const before = fake.callsFor('analytics_session_stats').length;
    await page.check('#compare-toggle');
    await expect(page.locator('#view-overview')).toContainText('no previous period to compare against');
    await expect(page.locator('#view-overview .stat-delta')).toHaveCount(0);
    expect(fake.callsFor('analytics_session_stats').slice(before).some(b => b.p_start === '2026-09-18')).toBe(false);
  });

  test('All time over >900 days: the daily series is fetched in <=900-day chunks and rendered whole', async ({ page }) => {
    const fake = makeFake({
      bounds: { tz: 'Asia/Vientiane', today: '2026-10-01', earliest_day: '2023-03-19', latest_day: '2026-09-30',
        sources: { page_views: { first_day: '2023-03-19' }, listing_events: { first_day: '2023-03-19' }, lead_events: { first_day: '2023-03-19' }, leads: { first_day: '2023-03-19' } } }
    });
    const errors = await open(page, fake);
    await page.click('.range-preset[data-range="all"]');
    await expect(page.locator('#ov-trend-chart svg')).toBeVisible();
    const all = fake.callsFor('analytics_traffic_by_day');
    const big = all.filter(b => LAOS.diffDays(b.p_start, b.p_end) > 30);
    expect(big.length).toBe(2);
    big.sort((a, b) => (a.p_start < b.p_start ? -1 : 1));
    expect(big[0].p_start).toBe('2023-03-19');
    expect(big[1].p_end).toBe('2026-10-02');
    expect(big[0].p_end).toBe(big[1].p_start);
    big.forEach(b => expect(LAOS.diffDays(b.p_start, b.p_end)).toBeLessThanOrEqual(900));
    // year-aware axis labels (YY-MM-DD) once the series spans several years
    const labels = await page.locator('#ov-trend-chart svg text').allTextContents();
    expect(labels.some(t => /^\d\d-\d\d-\d\d$/.test(t))).toBe(true);
    await expect(page.locator('.an-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a traffic answer that reaches the 1000-row API cap is an error, not a silently short chart', async ({ page }) => {
    const fake = makeFake({ trafficRows: () => Array.from({ length: 1000 }, (_, i) => ({ day: '2026-01-01', page_views: 1, sessions: 1, unique_visitors: 1, returning_visitors: 0 })) });
    await open(page, fake);
    await expect(page.locator('#view-overview .an-error')).toContainText('1000-row');
    await expect(page.locator('#view-overview #ov-trend-chart')).toHaveCount(0);
  });

  test('Custom range: inclusive end date becomes an exclusive p_end; invalid input is refused with a reason', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await page.click('.range-preset[data-range="custom"]');
    await expect(page.locator('#range-custom')).toBeVisible();
    await page.fill('#custom-from', '2026-09-10');
    await page.fill('#custom-to', '2026-09-12');
    await page.click('#custom-apply');
    await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-09-10', p_end: '2026-09-13' });
    await expect(page.locator('#range-label')).toHaveText('Custom range · 2026-09-10 → 2026-09-12');
    await expect(page.locator('.range-preset[data-range="custom"]')).toHaveClass(/active/);
    // a single day
    await page.fill('#custom-from', '2026-09-12'); await page.fill('#custom-to', '2026-09-12'); await page.click('#custom-apply');
    await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2026-09-12', p_end: '2026-09-13' });
    await expect(page.locator('#range-label')).toHaveText('Custom range · 2026-09-12');
    // a range far beyond 90 days (no cap)
    await page.fill('#custom-from', '2025-01-01'); await page.fill('#custom-to', '2026-09-30'); await page.click('#custom-apply');
    await expect.poll(() => lastCall(fake, 'analytics_session_stats')).toEqual({ p_start: '2025-01-01', p_end: '2026-10-01' });
    // invalid: no RPC is made and the reason is shown
    const before = fake.callsFor('analytics_session_stats').length;
    await page.fill('#custom-from', '2026-09-20'); await page.fill('#custom-to', '2026-09-10'); await page.click('#custom-apply');
    await expect(page.locator('#custom-msg')).toContainText('after the end date');
    await page.fill('#custom-from', '2026-09-20'); await page.fill('#custom-to', '2026-10-05'); await page.click('#custom-apply');
    await expect(page.locator('#custom-msg')).toContainText('cannot be after today');
    await page.fill('#custom-from', ''); await page.click('#custom-apply');
    await expect(page.locator('#custom-msg')).toContainText('YYYY-MM-DD');
    expect(fake.callsFor('analytics_session_stats').length).toBe(before);
  });

  test('if the first day of data cannot be determined, All time shows an error and keeps the current view', async ({ page }) => {
    // The bounds call is best-effort for the presets (only the "tracking since" notes need it)...
    const fake = makeFake({ fail: { analytics_history_bounds: { status: 500, json: { message: 'boom' } } } });
    await open(page, fake);
    await expect(page.locator('#view-overview .stat-grid')).toBeVisible();
    // ...but All time REQUIRES it, and must never guess a start date.
    const before = fake.callsFor('analytics_session_stats').length;
    await page.click('.range-preset[data-range="all"]');
    await expect(page.locator('#range-error .an-error')).toContainText('The request failed');
    await expect(page.locator('#range-label')).toHaveText(/Last 7 days/);
    expect(fake.callsFor('analytics_session_stats').length).toBe(before);
    // recovers once the bounds call works again
    delete fake.st.fail.analytics_history_bounds;
    await page.click('.range-preset[data-range="all"]');
    await expect(page.locator('#range-label')).toHaveText('All time · 2026-06-25 → 2026-10-01');
    await expect(page.locator('#range-error .an-error')).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Errors are visible, with retry -- never zeros
// ═════════════════════════════════════════════════════════════════════════
test.describe('failure handling', () => {
  test('a timed-out RPC shows an error banner (not zeros) and Retry recovers', async ({ page }) => {
    const fake = makeFake({ fail: { analytics_session_stats: true } });
    await open(page, fake);
    const banner = page.locator('#view-overview .an-error');
    await expect(banner).toContainText('took too long');
    await expect(banner).toContainText('Nothing was hidden or replaced with zeros');
    await expect(page.locator('#view-overview .stat-card')).toHaveCount(0);
    delete fake.st.fail.analytics_session_stats;
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#view-overview .stat-card').first()).toBeVisible();
    await expect(page.locator('#view-overview .stat-value').first()).toHaveText('120');
    await expect(page.locator('#view-overview .an-error')).toHaveCount(0);
  });

  test('every tab reports its own failure instead of rendering zeros', async ({ page }) => {
    const tabs = { traffic: 'analytics_traffic_sources', listings: 'analytics_listing_engagement', search: 'analytics_search_breakdown', behavior: 'analytics_behavior',
      leads: 'analytics_leads_breakdown', location: 'analytics_location_breakdown', admin: 'analytics_admin_insights' };
    const fake = makeFake({ fail: Object.fromEntries(Object.values(tabs).map(f => [f, { status: 500, json: { message: 'db down' } }])) });
    await open(page, fake);
    for (const tab of Object.keys(tabs)) {
      await page.click('.tab[data-tab="' + tab + '"]');
      await expect(page.locator('#view-' + tab + ' .an-error')).toContainText('The request failed');
      await expect(page.locator('#view-' + tab + ' .stat-card')).toHaveCount(0);
    }
  });

  test('an expired session is reported as such', async ({ page }) => {
    const fake = makeFake({ fail: { analytics_session_stats: { status: 401, json: { message: 'JWT expired' } } } });
    await open(page, fake);
    await expect(page.locator('#view-overview .an-error')).toContainText('session may have expired');
  });

  test('a failed drill-down page shows a retryable error and keeps the rows already loaded', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await page.click('.range-preset[data-range="custom"]');
    await page.fill('#custom-from', '2026-09-17'); await page.fill('#custom-to', '2026-09-17'); await page.click('#custom-apply');
    await page.click('.tab[data-tab="leads"]');
    await expect(rowsText(page)).toHaveCount(100);
    fake.st.fail.analytics_lead_activity = { status: 500, json: { code: '57014', message: 'canceling statement due to statement timeout' } };
    await page.click('#la-more');
    await expect(page.locator('#la-error .an-error')).toContainText('took too long');
    await expect(rowsText(page)).toHaveCount(100);
    delete fake.st.fail.analytics_lead_activity;
    await page.locator('#la-error').getByRole('button', { name: 'Retry' }).click();
    await expect(rowsText(page)).toHaveCount(130);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Leads: day / listing drill-down
// ═════════════════════════════════════════════════════════════════════════
async function openLeads(page, fake, from, to) {
  const errors = await open(page, fake);
  await page.click('.range-preset[data-range="custom"]');
  await page.fill('#custom-from', from || '2026-09-16');
  await page.fill('#custom-to', to || '2026-09-18');
  await page.click('#custom-apply');
  await page.click('.tab[data-tab="leads"]');
  await expect(page.locator('#view-leads #la-section')).toBeVisible();
  return errors;
}

test.describe('lead drill-down', () => {
  test.use({ timezoneId: 'Asia/Vientiane' });

  test('summary keeps official leads separate from legacy and unattributed events', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    const cards = page.locator('#view-leads .stat-card');
    await expect(cards.filter({ hasText: 'Total leads' }).locator('.stat-value')).toHaveText('151');
    await expect(cards.filter({ hasText: 'Legacy events' }).locator('.stat-value')).toHaveText('1');
    await expect(page.locator('#view-leads .disclosure').first()).toContainText('1 unattributed event');
    await expect(page.locator('#view-leads .disclosure').first()).toContainText('never added to the lead count');
    // ranked list says how much is hidden
    await expect(page.locator('#view-leads .top-note').filter({ hasText: 'Top 10 of' })).toContainText('Top 10 of 18');
    await expect(page.locator('#view-leads .top-note').filter({ hasText: 'Top 10 of' })).toContainText('on deleted listings');
  });

  test('default panel lists every record in the selected range, newest first, in Laos time', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    await expect(page.locator('#la-scope')).toHaveText('Showing 2026-09-16 → 2026-09-18 (Laos time)');
    await expect(page.locator('#la-summary')).toContainText('151 leads · 1 legacy event · 1 unattributed');
    await expect(rowsText(page)).toHaveCount(100);
    await expect(page.locator('#la-count')).toHaveText('Showing 100 of 153');
    const first = fake.callsFor('analytics_lead_activity')[0];
    expect(first).toMatchObject({ p_start: '2026-09-16', p_end: '2026-09-19', p_property_id: null, p_limit: 100, p_cursor_at: null, p_cursor_id: null });
    // first row is on 09-18 (newest)
    await expect(rowsText(page).first().locator('td').first()).toContainText('2026-09-18 23:');
  });

  test('clicking a day shows that day\'s records: listing per row, legacy / unattributed / deleted / unknown labelled', async ({ page }) => {
    const fake = makeFake();
    const errors = await openLeads(page, fake);
    await page.locator('.day-table [data-day="2026-09-18"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-18', p_end: '2026-09-19', p_cursor_id: null });
    await expect(page.locator('#la-scope')).toHaveText('Showing day 2026-09-18 (Laos time)');
    await expect(rowsText(page)).toHaveCount(11);
    await expect(page.locator('#la-summary')).toHaveText('9 leads · 1 legacy event · 1 unattributed · 6 listings · 4 on deleted listings');
    const table = page.locator('#la-table');
    // which listing generated each one
    await expect(table.locator('tr', { hasText: 'Villa Alpha' })).toHaveCount(3);      // 2 leads + 1 legacy event
    await expect(table.locator('tr', { hasText: 'Condo Beta' })).toHaveCount(2);
    for (const t of ['Gamma Soft', 'Delta Snap', 'Echo Log', 'Unknown listing aaaaaaaa']) await expect(table.locator('tr', { hasText: t })).toHaveCount(1);
    // labels
    await expect(table.locator('.badge-legacy')).toHaveCount(1);
    await expect(table.locator('tr[data-kind="legacy_event"]')).toContainText('Villa Alpha');
    await expect(table.locator('tr[data-kind="legacy_event"]')).toContainText('Legacy event');
    await expect(table.locator('tr[data-kind="unattributed_event"]')).toContainText('Unattributed event');
    await expect(table.locator('tr[data-kind="unattributed_event"]')).toContainText('No listing');
    await expect(table.locator('tr', { hasText: 'Gamma Soft' })).toContainText('Deleted listing');
    await expect(table.locator('tr', { hasText: 'Delta Snap' })).toContainText('Deleted listing · snapshot');
    await expect(table.locator('tr', { hasText: 'Echo Log' })).toContainText('Deleted listing · removal log');
    await expect(table.locator('tr', { hasText: 'Unknown listing aaaaaaaa' }).locator('.badge-unknown')).toHaveCount(1);
    await expect(table.locator('tr', { hasText: 'Unknown listing aaaaaaaa' }).locator('code').first()).toHaveText('aaaaaaaa');
    // details on the enriched lead row
    const alpha = table.locator('tr[data-kind="lead"]', { hasText: 'Villa Alpha' }).first();
    await expect(alpha).toContainText('Studio'); await expect(alpha).toContainText('Contact Person'); await expect(alpha).toContainText('whatsapp_click');
    await expect(alpha.locator('a[href^="listing.html?id="]')).toHaveCount(1);
    await expect(table.locator('tr', { hasText: 'Gamma Soft' }).locator('a[href^="listing.html"]')).toHaveCount(0);
    // every contact action is present, not just WhatsApp
    const text = await table.innerText();
    for (const a of ['call_click', 'telegram_click', 'contact_click', 'messenger_click', 'whatsapp_click']) expect(text).toContain(a);
    // no buyer / contact phone numbers anywhere in the DOM
    expect(await page.locator('#view-leads').innerHTML()).not.toMatch(/customer_|\+856|phone/i);
    expect(errors).toEqual([]);
  });

  test('clicking a point on the Leads Over Time chart opens that day', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    // 3 days in range: 09-16, 09-17, 09-18 -> the last hover rail is 09-18
    await page.locator('#ld-trend-chart rect[data-i="2"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-18', p_end: '2026-09-19' });
    await expect(page.locator('#la-scope')).toHaveText('Showing day 2026-09-18 (Laos time)');
    await page.locator('#ld-trend-chart rect[data-i="0"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-16', p_end: '2026-09-17' });
  });

  test('the day picker opens any day; "Whole selected range" goes back', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    await page.fill('#la-day', '2026-09-17');
    await page.click('#la-day-go');
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-17', p_end: '2026-09-18' });
    await page.click('#la-range-btn');
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-16', p_end: '2026-09-19' });
  });

  test('Load more: keyset cursor is sent back verbatim and rows are never duplicated', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    await page.locator('.day-table [data-day="2026-09-17"]').click();
    await expect(rowsText(page)).toHaveCount(100);
    await expect(page.locator('#la-count')).toHaveText('Showing 100 of 130');
    const first = fake.callsFor('analytics_lead_activity').filter(c => c.p_start === '2026-09-17')[0];
    expect(first.p_cursor_id).toBeNull();
    await page.click('#la-more');
    await expect(rowsText(page)).toHaveCount(130);
    await expect(page.locator('#la-more')).toBeHidden();
    await expect(page.locator('#la-count')).toHaveText('Showing 130 of 130');
    const second = fake.callsFor('analytics_lead_activity').filter(c => c.p_start === '2026-09-17')[1];
    expect(second.p_cursor_at).toMatch(/\.123456\+00:00$/);      // microseconds intact: never round-tripped through a JS Date
    expect(second.p_cursor_id).toMatch(/^l\d{7}-/);
    const ids = await page.locator('#la-table tbody tr code[title^="l"]').evaluateAll(els => els.map(e => e.getAttribute('title')));
    expect(new Set(ids).size).toBe(130);
  });

  test('per-listing filter from a row, from the by-listing chart, and clearing it', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    await page.locator('.day-table [data-day="2026-09-18"]').click();
    await expect(rowsText(page)).toHaveCount(11);
    await rowsText(page).filter({ hasText: 'Villa Alpha' }).first().locator('[data-act="filter-listing"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_start: '2026-09-18', p_end: '2026-09-19', p_property_id: PID.A });
    await expect(page.locator('#la-chip')).toContainText('Listing: Villa Alpha');
    await expect(rowsText(page)).toHaveCount(3);
    await expect(page.locator('#la-summary')).toContainText('2 leads · 1 legacy event · 0 unattributed · 1 listing');
    await page.locator('#la-chip [data-act="clear-filter"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_property_id: null });
    await expect(page.locator('#la-chip')).toHaveText('');
    await expect(rowsText(page)).toHaveCount(11);
    // bar click: first bar is the listing with the most leads (Condo Beta)
    await page.click('#la-range-btn');
    await page.locator('#ld-listing-chart rect[data-i="0"]').click();
    await expect.poll(() => lastCall(fake, 'analytics_lead_activity')).toMatchObject({ p_property_id: PID.B, p_start: '2026-09-16', p_end: '2026-09-19' });
    await expect(page.locator('#la-chip')).toContainText('Condo Beta');
  });

  test('CSV export writes EVERY row of the current view (all pages), with no PII and formula-safe titles', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake, '2026-09-14', '2026-09-14');
    await expect(page.locator('#la-summary')).toContainText('730 leads');
    const dl = page.waitForEvent('download');
    await page.locator('#la-section .section-header .export-btn').click();
    const download = await dl;
    expect(download.suggestedFilename()).toBe('lead-activity_2026-09-14.csv');
    const csv = require('fs').readFileSync(await download.path(), 'utf8');
    const lines = csv.split('\n');
    expect(lines[0]).toBe(CORE.LEAD_CSV_HEADERS.join(','));
    expect(lines.length - 1).toBe(730);
    expect(csv).not.toMatch(/customer|\+856|phone/i);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).toMatch(/2026-09-14 \d\d:\d\d/);
    // paged at the server maximum, in order, no duplicate ids
    const pages = fake.callsFor('analytics_lead_activity').filter(c => c.p_limit === 500);
    expect(pages.length).toBe(2);
    expect(pages[1].p_cursor_id).not.toBeNull();
    const leadIds = lines.slice(1).map(l => l.split(',').slice(-3)[0]);
    expect(new Set(leadIds).size).toBe(730);
  });

  test('the old "Recent Leads (up to 50)" table is gone', async ({ page }) => {
    const fake = makeFake();
    await openLeads(page, fake);
    await expect(page.locator('#view-leads')).not.toContainText('up to 50');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Same calendar everywhere: no browser-side instant filters left
// ═════════════════════════════════════════════════════════════════════════
test.describe('one calendar for cards and counts', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati' });

  test('Listings and Admin tabs read their counts from the RPCs, never from direct REST queries', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await page.click('.tab[data-tab="listings"]');
    const cards = page.locator('#view-listings .stat-card');
    await expect(cards.filter({ hasText: 'WhatsApp clicks' }).locator('.stat-value')).toHaveText('17');
    await expect(cards.filter({ hasText: 'Call clicks' }).locator('.stat-value')).toHaveText('5');
    await expect(cards.filter({ hasText: 'Agent profile clicks' }).locator('.stat-value')).toHaveText('9');
    await expect(page.locator('#view-listings')).toContainText('Top 1 of 12');
    await page.click('.tab[data-tab="admin"]');
    await expect(page.locator('#view-admin .stat-card').filter({ hasText: 'New listings added' }).locator('.stat-value')).toHaveText('7');
    expect(fake.restRequests).toEqual([]);
  });

  test('the listing-views chart is zero-filled: one point per Laos day', async ({ page }) => {
    const fake = makeFake();
    await open(page, fake);
    await page.click('.tab[data-tab="listings"]');
    // 7 days, all present (server zero-fills; the client no longer plots only days that have data)
    await expect(page.locator('#li-trend-chart rect[data-i]')).toHaveCount(7);
  });
});
