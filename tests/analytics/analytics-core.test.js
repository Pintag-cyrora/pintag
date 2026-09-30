// analytics-core.js — RPC failure classification, the PostgREST 1000-row guard,
// chunked daily-series merging, keyset paging of lead activity, CSV shaping and
// the drill-down table renderer.
//
//   node --test tests/analytics/analytics-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const LAOS = require('../../laos-date.js');
const CORE = require('../../analytics-core.js');

// A stand-in for the zero-filled analytics_traffic_by_day RPC: one row per day of the window.
function fakeDailyRpc(log) {
  return async (fn, params) => {
    log.push({ fn, ...params });
    const n = LAOS.diffDays(params.p_start, params.p_end);
    return Array.from({ length: n }, (_, i) => ({ day: LAOS.addDays(params.p_start, i), page_views: 1, sessions: 1, unique_visitors: 1, returning_visitors: 0 }));
  };
}

// ── failure classification ───────────────────────────────────────────────
test('classifyFailure: timeout / denied / invalid range / generic', () => {
  const t = CORE.classifyFailure('analytics_x', 500, JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }));
  assert.equal(t.kind, 'timeout'); assert.match(t.message, /too long/); assert.match(t.message, /shorter date range/);
  assert.equal(CORE.classifyFailure('f', 401, '{"message":"JWT expired"}').kind, 'denied');
  assert.equal(CORE.classifyFailure('f', 403, '').kind, 'denied');
  assert.equal(CORE.classifyFailure('f', 400, JSON.stringify({ code: '42501', message: 'permission denied' })).kind, 'denied');
  assert.equal(CORE.classifyFailure('f', 400, JSON.stringify({ message: 'Access denied: staff only' })).kind, 'denied');
  assert.equal(CORE.classifyFailure('f', 400, JSON.stringify({ code: '22023', message: 'Invalid date range' })).kind, 'invalid');
  const g = CORE.classifyFailure('f', 500, 'not json at all');
  assert.equal(g.kind, 'http'); assert.equal(g.status, 500);
  assert.ok(g instanceof Error && g.name === 'RpcError');
});

// ── the 1000-row guard ───────────────────────────────────────────────────
test('guardRows: passes below the cap, throws AT the cap, throws on a non-list', () => {
  assert.equal(CORE.guardRows('f', new Array(999).fill({})).length, 999);
  assert.throws(() => CORE.guardRows('f', new Array(1000).fill({})), e => e.kind === 'truncated' && /1000-row/.test(e.message));
  assert.throws(() => CORE.guardRows('f', new Array(1500).fill({})), e => e.kind === 'truncated');
  assert.throws(() => CORE.guardRows('f', { not: 'a list' }), e => e.kind === 'incomplete');
  assert.throws(() => CORE.guardRows('f', null), e => e.kind === 'incomplete');
  assert.equal(CORE.MAX_ROWS, 1000);
  assert.ok(CORE.CHUNK_DAYS <= 900, 'chunks stay comfortably under the API cap');
});

// ── chunk merging ────────────────────────────────────────────────────────
test('mergeDaily: orders chunks by day and refuses overlapping windows', () => {
  const a = [{ day: '2026-01-03', v: 3 }, { day: '2026-01-04', v: 4 }];
  const b = [{ day: '2026-01-01', v: 1 }, { day: '2026-01-02', v: 2 }];
  assert.deepEqual(CORE.mergeDaily([a, b]).map(r => r.day), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.throws(() => CORE.mergeDaily([a, [{ day: '2026-01-04', v: 9 }]]), e => e.kind === 'incomplete' && /duplicate day 2026-01-04/.test(e.message));
  assert.deepEqual(CORE.mergeDaily([]), []);
});

test('fetchDailyChunked: 1,200 days -> 2 requests (<=900 each), merged into 1,200 contiguous rows', async () => {
  const log = [];
  const start = '2023-03-19', end = LAOS.addDays(start, 1200);
  const rows = await CORE.fetchDailyChunked(fakeDailyRpc(log), 'analytics_traffic_by_day', start, end);
  assert.equal(log.length, 2);
  assert.deepEqual(log.map(c => [c.p_start, LAOS.diffDays(c.p_start, c.p_end)]), [['2023-03-19', 900], [LAOS.addDays(start, 900), 300]]);
  assert.equal(log[0].p_end, log[1].p_start, 'windows are contiguous');
  assert.equal(rows.length, 1200);
  assert.equal(rows[0].day, start);
  assert.equal(rows[1199].day, LAOS.addDays(start, 1199));
  rows.forEach((r, i) => assert.equal(r.day, LAOS.addDays(start, i)));
  assert.equal(rows.reduce((s, r) => s + r.page_views, 0), 1200, 'every day counted once');
  assert.ok(rows.length > CORE.MAX_ROWS, 'the merged series legitimately exceeds the per-request cap');
});

test('fetchDailyChunked: window count at the 900-day edges', async () => {
  const count = async n => { const log = []; await CORE.fetchDailyChunked(fakeDailyRpc(log), 'f', '2024-01-01', LAOS.addDays('2024-01-01', n)); return log.length; };
  assert.equal(await count(1), 1);
  assert.equal(await count(900), 1);
  assert.equal(await count(901), 2);
  assert.equal(await count(1800), 2);
  assert.equal(await count(1801), 3);
});

test('fetchDailyChunked: a chunk that hits the 1000-row cap is an ERROR, not a silently short chart', async () => {
  const cap = async () => new Array(1000).fill({ day: '2026-01-01' });
  await assert.rejects(CORE.fetchDailyChunked(cap, 'analytics_traffic_by_day', '2026-01-01', '2026-02-01'), e => e.kind === 'truncated');
});

test('fetchDailyChunked: an incomplete answer (missing days) is an ERROR', async () => {
  const short = async (fn, p) => Array.from({ length: LAOS.diffDays(p.p_start, p.p_end) - 1 }, (_, i) => ({ day: LAOS.addDays(p.p_start, i) }));
  await assert.rejects(CORE.fetchDailyChunked(short, 'f', '2026-01-01', '2026-02-01'), e => e.kind === 'incomplete' && /30 of 31 days/.test(e.message));
});

test('fetchDailyChunked: RPC failures propagate (never swallowed into an empty series)', async () => {
  const boom = async () => { throw CORE.RpcError('f', 'timeout', 500, 'statement timeout'); };
  await assert.rejects(CORE.fetchDailyChunked(boom, 'f', '2026-01-01', '2026-02-01'), e => e.kind === 'timeout');
  const oneBad = async (fn, p) => { if (p.p_start > '2024-01-01') throw CORE.RpcError('f', 'http', 500, ''); return fakeDailyRpc([])(fn, p); };
  await assert.rejects(CORE.fetchDailyChunked(oneBad, 'f', '2023-01-01', '2026-01-01'), e => e.kind === 'http', 'one failed chunk fails the whole series');
});

test('fetchDailyChunked: an empty range makes no requests and returns []', async () => {
  const log = [];
  assert.deepEqual(await CORE.fetchDailyChunked(fakeDailyRpc(log), 'f', '2026-01-01', '2026-01-01'), []);
  assert.equal(log.length, 0);
});

test('trimBeforeCoverage drops only the days before tracking began', () => {
  const rows = [{ day: '2026-06-01' }, { day: '2026-07-28' }, { day: '2026-07-29' }];
  assert.deepEqual(CORE.trimBeforeCoverage(rows, 'day', '2026-07-28').map(r => r.day), ['2026-07-28', '2026-07-29']);
  assert.equal(CORE.trimBeforeCoverage(rows, 'day', null).length, 3);
});

// ── keyset paging ────────────────────────────────────────────────────────
function fakeLeadServer(total, opts) {
  const all = Array.from({ length: total }, (_, i) => ({
    event_at: '2026-09-18T' + String(23 - Math.floor(i / 60)).padStart(2, '0') + ':' + String(59 - (i % 60)).padStart(2, '0') + ':00.123456+00:00',
    kind: 'lead', lead_id: 'lead-' + i, lead_event_id: 'ev-' + i, property_id: null
  }));
  const calls = [];
  const rpc = async (fn, p) => {
    calls.push(p);
    assert.equal(fn, 'analytics_lead_activity');
    let from = 0;
    if (p.p_cursor_id) from = all.findIndex(r => r.lead_id === p.p_cursor_id) + 1;
    const limit = Math.min(p.p_limit, 500);
    const page = all.slice(from, from + limit);
    const has_more = from + limit < all.length;
    const last = page[page.length - 1];
    return { rows: page, totals: { leads: total, legacy_events: 0, unattributed_events: 0 },
      has_more, next_cursor: has_more && !(opts && opts.dropCursor) ? { at: last.event_at, id: last.lead_id } : null };
  };
  return { all, calls, rpc };
}
const VIEW = { start: '2026-09-18', endExclusive: '2026-09-19', propertyId: null };

test('pageAllLeadActivity: walks every page, in order, passing each cursor back verbatim', async () => {
  const s = fakeLeadServer(1234);
  const progress = [];
  const { rows, totals, pages } = await CORE.pageAllLeadActivity(s.rpc, VIEW, { pageSize: 500, onProgress: n => progress.push(n) });
  assert.equal(pages, 3);
  assert.equal(rows.length, 1234);
  assert.deepEqual(rows.map(r => r.lead_id), s.all.map(r => r.lead_id), 'same rows, same order, no gaps, no duplicates');
  assert.deepEqual(progress, [500, 1000, 1234]);
  assert.equal(totals.leads, 1234);
  assert.equal(s.calls[0].p_cursor_at, null); assert.equal(s.calls[0].p_cursor_id, null);
  assert.equal(s.calls[1].p_cursor_at, '2026-09-18T' + s.all[499].event_at.slice(11), 'the microsecond timestamp round-trips as an untouched string');
  assert.equal(s.calls[1].p_cursor_id, 'lead-499');
  assert.ok(s.calls.every(c => c.p_start === '2026-09-18' && c.p_end === '2026-09-19' && c.p_property_id === null && c.p_limit === 500));
});

test('pageAllLeadActivity: passes the listing filter through to every page', async () => {
  const s = fakeLeadServer(30);
  await CORE.pageAllLeadActivity(s.rpc, { ...VIEW, propertyId: 'aaaaaaaa-0000-0000-0000-00000000000a' }, { pageSize: 10 });
  assert.equal(s.calls.length, 3);
  assert.ok(s.calls.every(c => c.p_property_id === 'aaaaaaaa-0000-0000-0000-00000000000a'));
});

test('pageAllLeadActivity: exactly one page when everything fits', async () => {
  const s = fakeLeadServer(5);
  const r = await CORE.pageAllLeadActivity(s.rpc, VIEW, { pageSize: 500 });
  assert.equal(r.pages, 1); assert.equal(r.rows.length, 5); assert.equal(s.calls.length, 1);
});

test('pageAllLeadActivity: has_more without a cursor is an error, not a silently short export', async () => {
  const s = fakeLeadServer(30, { dropCursor: true });
  await assert.rejects(CORE.pageAllLeadActivity(s.rpc, VIEW, { pageSize: 10 }), e => e.kind === 'incomplete' && /cursor/.test(e.message));
});

test('pageAllLeadActivity: a cursor that never advances cannot loop forever', async () => {
  let n = 0;
  const stuck = async () => { n++; return { rows: [{ lead_id: 'x' + n }], totals: {}, has_more: true, next_cursor: { at: 'T', id: 'same' } }; };
  await assert.rejects(CORE.pageAllLeadActivity(stuck, VIEW, { pageSize: 1 }), e => e.kind === 'incomplete' && /did not advance/.test(e.message));
  assert.ok(n <= 3);
});

test('pageAllLeadActivity: a failing page fails the whole export; a malformed page is rejected', async () => {
  const s = fakeLeadServer(30);
  const flaky = async (fn, p) => { if (p.p_cursor_id) throw CORE.RpcError(fn, 'timeout', 500, ''); return s.rpc(fn, p); };
  await assert.rejects(CORE.pageAllLeadActivity(flaky, VIEW, { pageSize: 10 }), e => e.kind === 'timeout');
  await assert.rejects(CORE.pageAllLeadActivity(async () => ({ nope: 1 }), VIEW, {}), e => e.kind === 'incomplete');
});

test('leadActivityParams builds the exact RPC arguments', () => {
  assert.deepEqual(CORE.leadActivityParams({ start: 'a', endExclusive: 'b', propertyId: 'p' }, 100, { at: 't', id: 'i' }),
    { p_start: 'a', p_end: 'b', p_property_id: 'p', p_limit: 100, p_cursor_at: 't', p_cursor_id: 'i' });
  assert.deepEqual(CORE.leadActivityParams({ start: 'a', endExclusive: 'b' }, 200, null),
    { p_start: 'a', p_end: 'b', p_property_id: null, p_limit: 200, p_cursor_at: null, p_cursor_id: null });
});

// ── CSV ──────────────────────────────────────────────────────────────────
const LEAD_ROW = {
  event_at: '2026-09-16T17:00:00+00:00', laos_day: '2026-09-17', kind: 'lead', lead_id: 'L1', lead_event_id: 'E1',
  contact_action: 'whatsapp_click', channel: 'whatsapp', lead_status: 'new', property_id: 'aaaaaaaa-0000-0000-0000-00000000000a',
  listing_title: 'Villa Alpha', listing_slug: 'villa-alpha', listing_status: 'active', listing_resolution: 'current', is_deleted: false,
  unit_type_id: 'U1', unit_type_name: 'Studio', agent_party_id: 'P1', agent_name: 'Agent One', contact_id: 'C1', contact_name: 'Contact Person',
  contact_role: 'agent', recipient_type: 'agent', recipient_verified: true, first_touch_source: 'facebook', session_id: 's1'
};
test('leadRowToCsv: Laos time, deleted flag, ids; keys match the header list exactly', () => {
  const c = CORE.leadRowToCsv(LEAD_ROW);
  assert.deepEqual(Object.keys(c), CORE.LEAD_CSV_HEADERS);
  assert.equal(c.laos_day, '2026-09-17');
  assert.equal(c.laos_time, '2026-09-17 00:00');
  assert.equal(c.record_type, 'lead');
  assert.equal(c.listing_deleted, 'no');
  assert.equal(c.property_id, 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert.equal(c.lead_id, 'L1'); assert.equal(c.lead_event_id, 'E1');
  const del = CORE.leadRowToCsv({ ...LEAD_ROW, is_deleted: true, listing_resolution: 'snapshot' });
  assert.equal(del.listing_deleted, 'yes'); assert.equal(del.listing_resolution, 'snapshot');
  const un = CORE.leadRowToCsv({ ...LEAD_ROW, kind: 'unattributed_event', property_id: null, listing_title: null, lead_id: null });
  assert.equal(un.listing_deleted, ''); assert.equal(un.record_type, 'unattributed_event');
});
test('CSV output never contains buyer or contact PII columns', () => {
  const headers = CORE.LEAD_CSV_HEADERS.join(',');
  assert.ok(!/customer|phone|whatsapp_number|notes|email/i.test(headers), headers);
  const c = CORE.leadRowToCsv({ ...LEAD_ROW, customer_name: 'Secret Buyer', customer_phone: '+85620555', phone: '+85620999' });
  assert.ok(!JSON.stringify(c).includes('Secret Buyer') && !JSON.stringify(c).includes('+85620'));
});
test('csvSafe neutralises spreadsheet formula injection from user-entered titles', () => {
  for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\t=cmd']) assert.equal(CORE.csvSafe(evil)[0], "'", evil);
  assert.equal(CORE.csvSafe('Villa Alpha'), 'Villa Alpha');
  assert.equal(CORE.csvSafe(null), '');
  assert.equal(CORE.leadRowToCsv({ ...LEAD_ROW, listing_title: '=1+1' }).listing_title, "'=1+1");
});

// ── table rendering ──────────────────────────────────────────────────────
const row = over => ({ ...LEAD_ROW, ...over });
test('renderLeadActivityTable: every row names its listing, shows Laos time, and links a live listing', () => {
  const html = CORE.renderLeadActivityTable([row({})]);
  assert.match(html, /Villa Alpha/);
  assert.match(html, /2026-09-17 00:00/);
  assert.match(html, /href="listing\.html\?id=aaaaaaaa-0000-0000-0000-00000000000a"/);
  assert.match(html, /data-act="filter-listing" data-property-id="aaaaaaaa-0000-0000-0000-00000000000a"/);
  assert.match(html, /Studio/); assert.match(html, /Agent One/); assert.match(html, /Contact Person/);
  assert.match(html, /whatsapp_click/); assert.match(html, /facebook/);
  assert.match(html, /lead <code title="L1">L1<\/code>/); assert.match(html, /event <code title="E1">E1<\/code>/);
});
test('renderLeadActivityTable: legacy events are labelled, have no CRM status, and keep their listing', () => {
  const html = CORE.renderLeadActivityTable([row({ kind: 'legacy_event', lead_id: null, lead_status: null })]);
  assert.match(html, /badge-legacy/); assert.match(html, /Legacy event/);
  assert.match(html, /no CRM lead record/i);
  assert.match(html, /Villa Alpha/);
  assert.doesNotMatch(html, /lead <code/, 'no lead id is invented');
  assert.match(html, /title="No CRM record"/);
});
test('renderLeadActivityTable: unattributed events say so and have no listing', () => {
  const html = CORE.renderLeadActivityTable([row({ kind: 'unattributed_event', property_id: null, listing_title: null, lead_id: null, lead_status: null })]);
  assert.match(html, /badge-unattr/); assert.match(html, /Unattributed event/); assert.match(html, /No listing/);
  assert.doesNotMatch(html, /filter-listing/);
});
test('renderLeadActivityTable: deleted listings are badged (by source), unknown ones keep their id, neither is linked', () => {
  const soft = CORE.renderLeadActivityTable([row({ is_deleted: true, listing_resolution: 'soft_deleted' })]);
  assert.match(soft, /Deleted listing/); assert.doesNotMatch(soft, /href="listing\.html/);
  assert.match(CORE.renderLeadActivityTable([row({ is_deleted: true, listing_resolution: 'snapshot' })]), /Deleted listing · snapshot/);
  assert.match(CORE.renderLeadActivityTable([row({ is_deleted: true, listing_resolution: 'removal_log' })]), /Deleted listing · removal log/);
  const unknown = CORE.renderLeadActivityTable([row({ is_deleted: true, listing_resolution: 'unknown', listing_title: 'Unknown listing aaaaaaaa' })]);
  assert.match(unknown, /badge-unknown/); assert.match(unknown, /Unknown listing aaaaaaaa/);
  assert.match(unknown, /<code title="aaaaaaaa-0000-0000-0000-00000000000a">aaaaaaaa<\/code>/, 'the listing id is always shown');
});
test('renderLeadActivityTable: all dynamic text is escaped', () => {
  const html = CORE.renderLeadActivityTable([row({ listing_title: '<img src=x onerror=alert(1)>', agent_name: '"><script>x</script>', unit_type_name: "<b>'", first_touch_source: '<i>' })]);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
test('renderLeadActivityTable: a non-UUID property id is never put in a link', () => {
  const html = CORE.renderLeadActivityTable([row({ property_id: '"><script>' })]);
  assert.doesNotMatch(html, /<script>/); assert.doesNotMatch(html, /href="listing\.html/);
});
test('renderLeadActivityTable: empty state', () => {
  assert.match(CORE.renderLeadActivityTable([]), /No lead activity/);
});
test('renderLeadActivityTable emits no buyer/contact phone fields', () => {
  const html = CORE.renderLeadActivityTable([row({ customer_name: 'Secret Buyer', customer_phone: '+85620555', phone: '+85620999' })]);
  assert.ok(!html.includes('Secret Buyer') && !html.includes('+85620'));
});

// ── notes and banners ────────────────────────────────────────────────────
test('topNote: "Top 10 of N", unattributed and deleted remainders', () => {
  assert.equal(CORE.topNote(10, 34, 57, 'without a listing', 3, 4), 'Top 10 of 34 (+57 more) · 3 without a listing · 4 on deleted listings');
  assert.equal(CORE.topNote(3, 3, 0, 'without a listing', 0, 0), '');
  assert.equal(CORE.topNote(10, 12, 2, 'unassigned', 9, 0), 'Top 10 of 12 (+2 more) · 9 unassigned');
});
test('errorBannerHtml: visible, says nothing was hidden, offers Retry, escapes the message', () => {
  const html = CORE.errorBannerHtml('took <too> long', 'retryTab()');
  assert.match(html, /role="alert"/); assert.match(html, /Nothing was hidden or replaced with zeros/);
  assert.match(html, /onclick="retryTab\(\)"/); assert.match(html, /took &lt;too&gt; long/);
  assert.doesNotMatch(CORE.errorBannerHtml('x', null), /<button/);
});
test('every RpcError kind has a human message that names the RPC', () => {
  for (const kind of ['timeout', 'denied', 'invalid', 'truncated', 'incomplete', 'network', 'http']) {
    const e = CORE.RpcError('analytics_demo', kind, 500, 'detail');
    assert.match(e.message, /analytics_demo/, kind);
  }
});
