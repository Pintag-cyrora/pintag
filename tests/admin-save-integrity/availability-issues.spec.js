// Admin "Availability Issues": the tab + count, the banner, the filterable list, the deep links. The REAL admin.html against
// the in-memory REST fake plus a spec-local feed for the paged properties query (limit/offset + Content-Range, with a
// configurable server row cap), so the pagination/completeness behaviour is exercised for real.
//
// Fixed clock: 2026-10-13T18:00:00Z == 01:00 on 14 Oct in Vientiane (still 13 Oct in UTC / the US):
// '2026-10-13' is EXPIRED, '2026-10-14' is TODAY (live).
const { test, expect } = require('@playwright/test');
const { fakeBackend, boot } = require('./fixtures');

const NOW = '2026-10-13T18:00:00Z';
const UT = (id, o) => Object.assign({ id, name_en: 'Unit ' + id, name_lo: null, name_zh: null, bedrooms: 1, bathrooms: 1, sqm: 30, price_amount: 300,
  price_currency: 'USD', price_frequency: 'monthly', sort_order: 0, is_available: true, available_count: 2, total_units: null, next_available_date: null }, o || {});
const OPEN = (id, o) => UT(id, o);
const FULL = (id, o) => UT(id, Object.assign({ available_count: 0 }, o || {}));
const P = (id, title, market, units, o) => Object.assign({ id, slug: 's-' + id, title_en: title, district_en: 'Sisattanak', workflow_status: 'active', status: 'active',
  market_status: market, property_type: 'house', transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
  available_from: null, deleted_at: null, images: [], contact_id: null, unit_types: units }, o || {});

const DATASET = () => [
  P('p-1', 'Sold With Open Unit', 'sold', [OPEN('p1-a', { name_en: 'Studio A' })]),
  P('p-2', 'Rented Single', 'rented', [OPEN('p2-a', { name_en: 'Only Unit' })]),
  P('p-3', 'Stale Multi', 'reserved', [OPEN('p3-a', { name_en: 'Loft' }), FULL('p3-b', { name_en: 'Suite' })]),
  P('p-4', 'Coming Soon Open', 'coming_soon', [OPEN('p4-a', { name_en: 'Penthouse' })]),
  P('p-5', 'All Closed Both Problems', 'available', [FULL('p5-a', { name_en: 'Room A', next_available_date: '2026-10-13', sort_order: 0 }),
                                                     FULL('p5-b', { name_en: 'Room B', next_available_date: '2026-10-14', sort_order: 1 })]),
  P('p-6', 'Expired Only', 'available', [OPEN('p6-a', { name_en: 'Open One' }), FULL('p6-b', { name_en: 'Closed One', next_available_date: '2026-10-01', sort_order: 1 })]),
  P('p-7', 'Listing Level Date', 'rented', [], { available_from: '2026-10-13' }),
  P('p-8', 'Consistent', 'available', [OPEN('p8-a')]),
  P('p-9', 'Live Date Fine', 'available', [OPEN('p9-a'), FULL('p9-b', { next_available_date: '2026-10-20', sort_order: 1 })]),
  // never checked:
  P('d-1', 'Draft Sold Open', 'sold', [OPEN('d1-a')], { workflow_status: 'draft', status: 'draft' }),
  P('a-1', 'Archived Sold Open', 'sold', [OPEN('a1-a')], { workflow_status: 'archived', status: 'archived' }),
  P('x-1', 'Deleted Sold Open', 'sold', [OPEN('x1-a')], { deleted_at: '2026-10-01T00:00:00Z' }),
];
// expected for DATASET: 7 listings affected, 8 issues; expired_date 3 (p-5, p-6, p-7), the five mismatch types 1 each.

// Spec-local feed for the properties queries (the shared fake answers [] for list queries).
async function feed(page, rows, opts) {
  opts = opts || {};
  const log = { issuePages: [], editFetches: [], listFetches: 0 };
  await page.route('**/rest/v1/properties?*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() !== 'GET') return route.fallback();
    const sp = u.searchParams;
    const json = (status, body, headers) => route.fulfill({ status, contentType: 'application/json', headers: headers || {}, body: JSON.stringify(body) });
    const idEq = (sp.get('id') || '').replace(/^eq\./, '');
    if (idEq) {                                              // editListing(): the opened listing, with ALL its unit rows
      log.editFetches.push(idEq);
      const row = rows.find((r) => r.id === idEq);
      return json(200, row ? [Object.assign({}, row, { contacts: null, property_contacts: [] })] : []);
    }
    const sel = sp.get('select') || '';
    if (sp.has('limit') && sel.includes('available_from')) {  // the Availability Issues paged fetch
      if (opts.fail) return json(500, { message: 'boom' });
      if (opts.beforePage) opts.beforePage(log.issuePages.length + 1, rows);     // lets a test change the data between pages
      let pool = rows.filter((r) => (sp.get('workflow_status') || '') === 'eq.active' ? r.workflow_status === 'active' : true);
      if ((sp.get('deleted_at') || '') === 'is.null') pool = pool.filter((r) => !r.deleted_at);
      pool = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const total = pool.length, offset = Number(sp.get('offset') || 0);
      const limit = Math.min(Number(sp.get('limit')), opts.cap || 1000);
      let page_ = pool.slice(offset, offset + limit);
      if (opts.stopAt != null && offset >= opts.stopAt) page_ = [];       // server stops returning rows
      log.issuePages.push({ offset, n: page_.length });
      const range = page_.length ? `${offset}-${offset + page_.length - 1}/${total}` : `*/${total}`;
      const headers = opts.noCount ? {} : { 'content-range': range, 'access-control-expose-headers': 'Content-Range' };
      return json(200, page_.map((r) => ({ id: r.id, slug: r.slug, title_en: r.title_en, district_en: r.district_en, workflow_status: r.workflow_status,
        market_status: r.market_status, available_from: r.available_from, unit_types: r.unit_types })), headers);
    }
    if (sel.includes('view_count')) {                        // the listings table (loadListings)
      log.listFetches++;
      return json(200, rows.filter((r) => !r.deleted_at).map((r) => Object.assign({ view_count: 0, is_featured: false, contacts: null, owners: null, owner_id: null,
        managed_by_party_id: null, village_en: null }, r)));
    }
    return route.fallback();
  });
  return log;
}
async function open(page, rows, opts, viewport) {
  await page.clock.setFixedTime(NOW);
  const backend = fakeBackend();
  await boot(page, backend);
  const log = await feed(page, rows, opts);
  await page.evaluate(() => showListings());
  return { backend, log };
}
const tabCount = (page) => page.locator('#availability-tab-count');
const banner = (page) => page.locator('#availability-banner');
const nonGet = (backend) => backend.state.requests.filter((r) => r.method !== 'GET');

test.describe('summary, tab and banner', () => {
  test('tab count and banner show DISTINCT listings; the issue total is shown separately', async ({ page }) => {
    await open(page, DATASET());
    await expect(tabCount(page)).toHaveText('7');
    await expect(tabCount(page)).toHaveClass(/has-issues/);
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('7 published listings have availability issues');
    await expect(banner(page)).toContainText('8 issues in total');
  });
  test('panel: listings affected vs issues, an overlap note, the scope note, and per-type chip counts', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    await expect(page.locator('#ai-summary')).toContainText('7 listings affected');
    await expect(page.locator('#ai-summary')).toContainText('8 issues in total');
    await expect(page.locator('#ai-notes')).toContainText('Checked 9 published listings');
    await expect(page.locator('#ai-notes')).toContainText('drafts, archived and deleted listings are not checked');
    await expect(page.locator('#ai-notes')).toContainText('can have more than one issue');
    await expect(page.locator('#ai-notes')).toContainText('read-only');
    const chip = (t) => page.locator(`.ai-chip[data-filter="${t}"]`);
    await expect(chip('all')).toHaveText('All (8)');
    await expect(chip('available_units_closed')).toContainText('(1)');
    await expect(chip('single_unit_status_wins')).toContainText('(1)');
    await expect(chip('multi_unit_status_stale')).toContainText('(1)');
    await expect(chip('closed_property_open_units')).toContainText('(1)');
    await expect(chip('coming_soon_open_units')).toContainText('(1)');
    await expect(chip('expired_date')).toContainText('(3)');
    await expect(page.locator('.ai-card')).toHaveCount(8);
  });
  test('one listing with two issues appears as two cards but counts once in the headline', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    const p5 = page.locator('.ai-card[data-property-id="p-5"]');
    await expect(p5).toHaveCount(2);
    expect(await p5.evaluateAll((els) => els.map((e) => e.dataset.issueType).sort())).toEqual(['available_units_closed', 'expired_date']);
  });
  test('zero issues: tab shows 0, no banner, a clear empty state', async ({ page }) => {
    await open(page, [P('p-8', 'Consistent', 'available', [OPEN('p8-a')]), P('d-1', 'Draft', 'sold', [OPEN('d1-a')], { workflow_status: 'draft' })]);
    await expect(tabCount(page)).toHaveText('0');
    await expect(tabCount(page)).not.toHaveClass(/has-issues/);
    await expect(banner(page)).toBeHidden();
    await page.click('#availability-tab');
    await expect(page.locator('#ai-list')).toContainText('No availability issues found');
    await expect(page.locator('#ai-summary')).toContainText('0 listings affected');
  });
});

test.describe('cards: property, mismatch, units, explanation', () => {
  test('a mismatch card shows the listing, the type, the detector\'s own explanation, and the open unit', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    const c = page.locator('.ai-card[data-property-id="p-3"]');
    await expect(c).toContainText('Stale Multi');
    await expect(c).toContainText('Sisattanak');
    await expect(c.locator('.status-badge')).toHaveText('reserved');
    await expect(c.locator('.ai-type')).toHaveText('Stale status on a multi-unit listing');
    await expect(c.locator('.ai-why')).toContainText('Market Status is Reserved, but 1 of 2 unit types are available');
    await expect(c.locator('.ai-units li')).toHaveCount(1);
    await expect(c.locator('.ai-units li')).toContainText('Loft');
    await expect(c.locator('.ai-units li')).toContainText('Available');
    await expect(c.locator('.ai-units li')).toContainText('2 available');
  });
  test('"available but all closed" lists every closed unit; the expired card says which date and that it is ignored', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    const closed = page.locator('.ai-card[data-property-id="p-5"][data-issue-type="available_units_closed"]');
    await expect(closed.locator('.ai-units li')).toHaveCount(2);
    const exp = page.locator('.ai-card[data-property-id="p-5"][data-issue-type="expired_date"]');
    await expect(exp.locator('.ai-units li')).toHaveCount(1);                       // only Room A: Room B's date is today = live
    await expect(exp.locator('.ai-units li')).toContainText('Room A');
    await expect(exp.locator('.ai-units li')).toContainText('13 Oct 2026 has passed');
    await expect(exp.locator('.ai-why')).toContainText('ignores it');
    await expect(exp).not.toContainText('Room B');
    const lst = page.locator('.ai-card[data-property-id="p-7"]');
    await expect(lst).toContainText('Listing-level Available From: 13 Oct 2026');
    await expect(lst.locator('.ai-units')).toHaveCount(0);
  });
  test('drafts, archived and deleted listings never appear; consistent and live-date listings never appear', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    const ids = await page.locator('.ai-card').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.propertyId))].sort());
    expect(ids).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']);
  });
  test('agrees with the existing listings-table badge for the same published listings', async ({ page }) => {
    await open(page, DATASET());
    await page.waitForSelector('.listings-table');
    const badged = await page.locator('.listings-table tr[data-property-id]').evaluateAll((trs) =>
      trs.filter((t) => t.querySelector('.status-conflict')).map((t) => t.dataset.propertyId).sort());
    // the badge skips drafts only (existing behaviour); the archived row is the one place the two intentionally differ
    expect(badged.filter((id) => !['a-1', 'x-1'].includes(id))).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
    await page.click('#availability-tab');
    const mismatchIds = await page.locator('.ai-card:not([data-issue-type="expired_date"])').evaluateAll((els) => els.map((e) => e.dataset.propertyId).sort());
    expect(mismatchIds).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
  });
});

test.describe('filter and search', () => {
  test('type chips filter the list; aria-pressed follows; All restores', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    await page.click('.ai-chip[data-filter="expired_date"]');
    await expect(page.locator('.ai-card')).toHaveCount(3);
    await expect(page.locator('.ai-chip[data-filter="expired_date"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ai-chip[data-filter="all"]')).toHaveAttribute('aria-pressed', 'false');
    await page.click('.ai-chip[data-filter="closed_property_open_units"]');
    await expect(page.locator('.ai-card')).toHaveCount(1);
    await page.click('.ai-chip[data-filter="all"]');
    await expect(page.locator('.ai-card')).toHaveCount(8);
  });
  test('search narrows by listing title and composes with the chip filter', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    await page.fill('#ai-search', 'stale');
    await expect(page.locator('.ai-card')).toHaveCount(1);
    await page.fill('#ai-search', 'zzz');
    await expect(page.locator('#ai-list')).toContainText('No issues match this filter');
    await page.fill('#ai-search', 'closed');
    await page.click('.ai-chip[data-filter="expired_date"]');
    await expect(page.locator('.ai-card')).toHaveCount(1);                          // only p-5's title contains "closed", and its expired card passes the chip
    await expect(page.locator('.ai-card')).toHaveAttribute('data-issue-type', 'expired_date');
  });
});

test.describe('completeness: the data cap', () => {
  const many = (n, extra) => {
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(P('r-' + String(i).padStart(5, '0'), 'Bulk ' + i, 'available', [OPEN('u' + i)]));
    return rows.concat(extra || []);
  };
  const ISSUE_LATE = () => [P('z-late-1', 'Late Sold Open', 'sold', [OPEN('zl1')]), P('z-late-2', 'Late Rented Open', 'rented', [OPEN('zl2')])];   // sort after the bulk rows

  test('more than 1000 listings: pages continue past the PostgREST row cap and late rows are checked', async ({ page }) => {
    const rows = many(1203, ISSUE_LATE());
    const { log } = await open(page, rows, { cap: 1000 });
    await expect(tabCount(page)).toHaveText('2');
    expect(log.issuePages.map((p) => p.n)).toEqual([500, 500, 205]);
    await page.click('#availability-tab');
    await expect(page.locator('#ai-notes')).toContainText('Checked 1205 published listings');
    await expect(page.locator('#ai-warning')).toBeHidden();
    await expect(page.locator('.ai-card')).toHaveCount(2);
  });
  test('a server cap SMALLER than the page size: continues from what was really returned', async ({ page }) => {
    const rows = many(450, ISSUE_LATE());
    const { log } = await open(page, rows, { cap: 100 });
    await expect(tabCount(page)).toHaveText('2');
    expect(log.issuePages.reduce((a, p) => a + p.n, 0)).toBe(452);
    expect(log.issuePages.length).toBe(5);
    await page.click('#availability-tab');
    await expect(page.locator('#ai-warning')).toBeHidden();
  });
  test('the server stops returning rows early: a visible partial-check warning, a "+" on the count', async ({ page }) => {
    const rows = many(1203, ISSUE_LATE());
    await open(page, rows, { cap: 1000, stopAt: 1000 });
    await expect(tabCount(page)).toHaveText('0+');
    await page.click('#availability-tab');
    await expect(page.locator('#ai-warning')).toBeVisible();
    await expect(page.locator('#ai-warning')).toContainText('Partial check: read 1000 of 1205');
  });
  test('no Content-Range (total unknown): never presented as a complete check', async ({ page }) => {
    await open(page, DATASET(), { noCount: true });
    await expect(tabCount(page)).toHaveText('7+');
    await expect(banner(page)).toContainText('partial check');
    await page.click('#availability-tab');
    await expect(page.locator('#ai-warning')).toContainText('Partial check');
  });
  test('the check fails: "!" on the tab, a clear message with Refresh, no banner, the listings table still loads', async ({ page }) => {
    await open(page, DATASET(), { fail: true });
    await expect(tabCount(page)).toHaveText('!');
    await expect(banner(page)).toBeHidden();
    await page.waitForSelector('.listings-table');
    await page.click('#availability-tab');
    await expect(page.locator('#ai-warning')).toContainText('The check failed');
    await expect(page.locator('#ai-warning')).toContainText('Nothing was changed');
  });
});

test.describe('consistency: the total moving during a scan', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => 'r-' + String(i).padStart(4, '0'));
  // 1000 published listings, 500 per page; the ONLY issue sits exactly on the page boundary (index 500).
  const boundary = () => ids(1000).map((id, i) => i === 500 ? P(id, 'Boundary Sold Open', 'sold', [OPEN('bu')]) : P(id, 'Fine ' + i, 'available', [OPEN('u' + i)]));
  const st = (page) => page.evaluate(() => ({ complete: _aiState.complete, changed: _aiState.changed, fetched: _aiState.fetched, total: _aiState.total, status: _aiState.status }));

  test('REGRESSION (confirmed case): a row deleted between page 1 and 2 -> fewer rows read, total drops by one -> NOT a complete scan', async ({ page }) => {
    const rows = boundary();
    let done = false;
    const { log } = await open(page, rows, { cap: 500, beforePage: (n, r) => { if (n === 2 && !done) { done = true; r.splice(10, 1); } } });
    await expect(tabCount(page)).toHaveText('0+');                  // the boundary row was skipped, and the "+" says so
    expect(log.issuePages.map((p) => p.n)).toEqual([500, 499]);      // page 2 started one row late: that row was never read
    expect(await st(page)).toEqual({ complete: false, changed: true, fetched: 999, total: 999, status: 'ok' });   // 999 rows == the NEW total, yet not complete
    await expect(banner(page)).toBeHidden();                         // no issues were found, and nothing claims a clean bill of health
    await page.click('#availability-tab');
    const w = page.locator('#ai-warning');
    await expect(w).toBeVisible();
    await expect(w).toContainText('listings changed while they were being read');
    await expect(w).toContainText('Refresh');
    await expect(page.locator('#ai-warning')).not.toContainText('Checked 1000');
  });
  test('Refresh after an inconsistent scan retries and, with a stable total, finds the skipped issue and clears the warning', async ({ page }) => {
    const rows = boundary();
    let done = false;
    const { log } = await open(page, rows, { cap: 500, beforePage: (n, r) => { if (n === 2 && !done) { done = true; r.splice(10, 1); } } });
    await expect(tabCount(page)).toHaveText('0+');
    await page.click('#availability-tab');
    await page.click('button:has-text("Refresh")');
    await expect(tabCount(page)).toHaveText('1');                    // no "+": consistent and complete
    await expect(page.locator('#ai-warning')).toBeHidden();
    await expect(page.locator('.ai-card')).toHaveCount(1);
    await expect(page.locator('.ai-card')).toContainText('Boundary Sold Open');
    expect(await st(page)).toEqual({ complete: true, changed: false, fetched: 999, total: 999, status: 'ok' });
  });
  test('a row INSERTED between pages (total rises) is also not a verified complete scan', async ({ page }) => {
    const rows = ids(1000).map((id, i) => P(id, 'Fine ' + i, 'available', [OPEN('u' + i)]));
    let done = false;
    await open(page, rows, { cap: 500, beforePage: (n, r) => { if (n === 2 && !done) { done = true; r.splice(10, 0, P('r-0009a', 'Inserted', 'sold', [OPEN('iu')])); } } });
    await expect(tabCount(page)).toHaveText(/\+$/);
    expect(await st(page)).toMatchObject({ complete: false, changed: true });
  });
  test('a STABLE total across pages is still a complete, verified scan (no warning, no "+")', async ({ page }) => {
    const { log } = await open(page, boundary(), { cap: 500 });
    await expect(tabCount(page)).toHaveText('1');
    expect(log.issuePages.map((p) => p.n)).toEqual([500, 500]);
    expect(await st(page)).toEqual({ complete: true, changed: false, fetched: 1000, total: 1000, status: 'ok' });
    await page.click('#availability-tab');
    await expect(page.locator('#ai-warning')).toBeHidden();
    await expect(page.locator('#ai-notes')).toContainText('Checked 1000 published listings');
    await expect(banner(page)).toContainText('1 published listing has availability issues');
    await expect(banner(page)).not.toContainText('partial');
  });
  test('an inconsistent scan is flagged on the banner too, and a later FAILED refresh leaves no stale results shown as current', async ({ page }) => {
    const rows = ids(1000).map((id, i) => i === 3 ? P(id, 'Early Sold Open', 'sold', [OPEN('eu')]) : P(id, 'Fine ' + i, 'available', [OPEN('u' + i)]));
    let phase = 'change';
    await open(page, rows, { cap: 500, beforePage: (n, r) => { if (phase === 'change' && n === 2) { phase = 'stable'; r.splice(700, 1); } } });
    await expect(tabCount(page)).toHaveText('1+');                   // the issue on page 1 is shown, but flagged as partial
    await expect(banner(page)).toContainText('partial check');
    await page.click('#availability-tab');
    await expect(page.locator('.ai-card')).toHaveCount(1);
    await expect(page.locator('#ai-warning')).toContainText('listings changed while they were being read');
    // next refresh fails: nothing from the previous (inconsistent) scan may remain on screen
    await page.unroute('**/rest/v1/properties?*');
    await page.route('**/rest/v1/properties?*', (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.has('limit') && (u.searchParams.get('select') || '').includes('available_from')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.click('button:has-text("Refresh")');
    await expect(tabCount(page)).toHaveText('!');
    await expect(page.locator('.ai-card')).toHaveCount(0);
    await expect(page.locator('#ai-warning')).toContainText('The check failed');
    await expect(page.locator('#ai-warning')).not.toContainText('changed while');
    await expect(banner(page)).toBeHidden();
  });
  test('the first page already complete (single page): unaffected by the new check', async ({ page }) => {
    await open(page, DATASET(), {});
    await expect(tabCount(page)).toHaveText('7');
    expect(await st(page)).toMatchObject({ complete: true, changed: false });
  });
});

test.describe('read-only', () => {
  test('using the whole feature writes nothing (zero non-GET requests, stored data untouched)', async ({ page }) => {
    const rows = DATASET();
    const before = JSON.stringify(rows);
    const { backend } = await open(page, rows);
    await page.click('#availability-tab');
    await page.click('.ai-chip[data-filter="expired_date"]');
    await page.fill('#ai-search', 'a');
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(400);
    await page.click('#listings-tab');
    expect(nonGet(backend)).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

test.describe('view switching', () => {
  test('All Listings <-> Availability Issues <-> Analytics: exactly one view at a time; the banner is for the listings view only', async ({ page }) => {
    await open(page, DATASET());
    await page.waitForSelector('.listings-table');
    await expect(page.locator('#listings-container')).toBeVisible();
    await expect(banner(page)).toBeVisible();
    await page.click('#availability-tab');
    await expect(page.locator('#availability-panel')).toBeVisible();
    await expect(page.locator('#listings-container')).toBeHidden();
    await expect(banner(page)).toBeHidden();
    await expect(page.locator('#availability-tab')).toHaveClass(/active/);
    await expect(page.locator('#listings-tab')).not.toHaveClass(/active/);
    await page.click('#analytics-tab');
    await expect(page.locator('#availability-panel')).toBeHidden();
    await expect(page.locator('#analytics-panel')).toBeVisible();
    await expect(banner(page)).toBeHidden();
    await page.click('#listings-tab');
    await expect(page.locator('#availability-panel')).toBeHidden();
    await expect(page.locator('#listings-container')).toBeVisible();
    await expect(banner(page)).toBeVisible();
    await page.click('#availability-tab');
    await page.click('#analytics-tab');
    await page.click('#availability-tab');
    await expect(page.locator('#analytics-panel')).toBeHidden();
    await expect(page.locator('#availability-panel')).toBeVisible();
  });
  test('the banner button opens the panel', async ({ page }) => {
    await open(page, DATASET());
    await banner(page).locator('button').click();
    await expect(page.locator('#availability-panel')).toBeVisible();
  });
});

test.describe('links and deep links', () => {
  test('hrefs: Edit listing = ?edit=<id>, Edit unit = ?edit=<id>&unit=<unit id>, View public page by slug', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    const c = page.locator('.ai-card[data-property-id="p-3"]');
    await expect(c.locator('a:has-text("Edit listing")')).toHaveAttribute('href', 'admin.html?edit=p-3');
    await expect(c.locator('a:has-text("Edit unit")')).toHaveAttribute('href', 'admin.html?edit=p-3&unit=p3-a');
    await expect(c.locator('a:has-text("View public page")')).toHaveAttribute('href', 'listing.html?slug=s-p-3');
    await expect(c.locator('a:has-text("View public page")')).toHaveAttribute('target', '_blank');
  });
  test('clicking "Edit unit" opens that listing and expands exactly that unit card', async ({ page }) => {
    const { log } = await open(page, DATASET());
    await page.click('#availability-tab');
    await page.locator('.ai-card[data-property-id="p-3"] a:has-text("Edit unit")').click();
    await expect(page.locator('#form-panel')).toBeVisible();
    await expect(page.locator('#edit-id')).toHaveValue('p-3');
    const cards = page.locator('#unit-types-list .ut-card');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('#unit-types-list .ut-card[data-id="p3-a"]')).toHaveClass(/expanded/);
    await expect(page.locator('#unit-types-list .ut-card[data-id="p3-b"]')).not.toHaveClass(/expanded/);
    expect(log.editFetches).toEqual(['p-3']);
  });
  test('clicking "Edit listing" opens the listing without expanding any unit', async ({ page }) => {
    await open(page, DATASET());
    await page.click('#availability-tab');
    await page.locator('.ai-card[data-property-id="p-3"] a:has-text("Edit listing")').click();
    await expect(page.locator('#edit-id')).toHaveValue('p-3');
    await expect(page.locator('#unit-types-list .ut-card')).toHaveCount(2);
    await expect(page.locator('#unit-types-list .ut-card.expanded')).toHaveCount(0);
  });
  test('Back from the editor returns to the listings view (and re-checks, so a fixed listing drops out)', async ({ page }) => {
    const rows = DATASET();
    await open(page, rows);
    await page.click('#availability-tab');
    await page.locator('.ai-card[data-property-id="p-1"] a:has-text("Edit listing")').click();
    await expect(page.locator('#form-panel')).toBeVisible();
    rows[0].market_status = 'available';                      // as if staff fixed and saved it
    await page.evaluate(() => showListings());
    await expect(tabCount(page)).toHaveText('6');
  });

  async function direct(page, query) {
    const rows = DATASET();
    await open(page, rows);
    await page.goto('/admin.html' + query);
    await expect.poll(() => page.evaluate(() => typeof saveListing === 'function')).toBe(true);
    return rows;
  }
  test('direct URL ?edit=<id>&unit=<its unit>: opens the listing and expands that unit', async ({ page }) => {
    await direct(page, '?edit=p-3&unit=p3-b');
    await expect(page.locator('#edit-id')).toHaveValue('p-3');
    await expect(page.locator('#unit-types-list .ut-card[data-id="p3-b"]')).toHaveClass(/expanded/);
    await expect(page.locator('#unit-types-list .ut-card[data-id="p3-a"]')).not.toHaveClass(/expanded/);
  });
  test('EXISTING ?edit=<id> links still work exactly as before (no unit param)', async ({ page }) => {
    await direct(page, '?edit=p-3');
    await expect(page.locator('#edit-id')).toHaveValue('p-3');
    await expect(page.locator('#f-title-en')).toHaveValue('Stale Multi');
    await expect(page.locator('#unit-types-list .ut-card.expanded')).toHaveCount(0);
  });
  test('SAFETY: a unit id that belongs to ANOTHER listing is ignored (nothing expanded, editor stays on the selected listing)', async ({ page }) => {
    await direct(page, '?edit=p-3&unit=p1-a');
    await expect(page.locator('#edit-id')).toHaveValue('p-3');
    await expect(page.locator('#f-title-en')).toHaveValue('Stale Multi');
    await expect(page.locator('#unit-types-list .ut-card')).toHaveCount(2);
    await expect(page.locator('#unit-types-list .ut-card.expanded')).toHaveCount(0);
    await expect(page.locator('#unit-types-list .ut-card.ai-focus')).toHaveCount(0);
  });
  test('SAFETY: hostile or garbage unit values do nothing (no selector injection, no script, no errors)', async ({ page }) => {
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    for (const bad of ['*', '"]%20.ut-card[x="', encodeURIComponent('"><img src=x onerror=window.__xss=1>'), '__proto__', '%00', 'p3-a%27', '']) {
      await direct(page, '?edit=p-3&unit=' + bad);
      await expect(page.locator('#edit-id')).toHaveValue('p-3');
      await expect(page.locator('#unit-types-list .ut-card.expanded')).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(errors).toEqual([]);
  });
  test('a unit parameter without ?edit does nothing', async ({ page }) => {
    await direct(page, '?unit=p3-a');
    await expect(page.locator('#form-panel')).toBeHidden();
    await expect(page.locator('#listings-panel')).toBeVisible();
  });
  test('focusUnitCardForListing refuses when the editor is open on a different listing', async ({ page }) => {
    await open(page, DATASET());
    await page.evaluate(() => editListing('p-3'));
    await expect(page.locator('#unit-types-list .ut-card')).toHaveCount(2);
    expect(await page.evaluate(() => focusUnitCardForListing('p-2', 'p3-a'))).toBe(false);
    expect(await page.evaluate(() => focusUnitCardForListing('p-3', 'p3-a'))).toBe(true);
    expect(await page.evaluate(() => focusUnitCardForListing('p-3', 'nope'))).toBe(false);
  });
});

test.describe('mobile (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('tab, banner, chips and cards fit the screen: no horizontal overflow, actions reachable', async ({ page }) => {
    await open(page, DATASET());
    await expect(tabCount(page)).toHaveText('7');
    await expect(banner(page)).toBeVisible();
    await page.locator('#availability-tab').tap();
    await expect(page.locator('.ai-card').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const box = await page.locator('.ai-card').first().boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    const btn = page.locator('.ai-card').first().locator('a:has-text("Edit listing")');
    await expect(btn).toBeVisible();
    const bb = await btn.boundingBox();
    expect(bb.x + bb.width).toBeLessThanOrEqual(391);
    await btn.tap();
    await expect(page.locator('#form-panel')).toBeVisible();
  });
});
