// Admin "Availability Issues" collector (availability-issues.js).
//   node --test availability-issues.test.js
//
// It must REUSE the existing definitions: every mismatch comes from describePropertyAvailabilityConflict(), unit state from
// resolveUnitAvailability(), dates from liveAvailabilityDate() (Lao day). These tests pin that, plus the counting rules
// (one issue per listing per type, distinct listings counted once, only published non-deleted listings) and that nothing is
// mutated. Dates are deterministic: an explicit `today`, or dates that are expired/live on any real clock (2000 / 2999).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'property-availability.js', 'availability-issues.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const G = globalThis;
const { collectAvailabilityIssues, availabilityIssueEditHref, AVAIL_ISSUE_TYPES, describePropertyAvailabilityConflict,
        resolvePropertyAvailability } = G;

const TODAY = '2026-10-14';
const U = (id, o) => Object.assign({ id, name_en: 'Unit ' + id, sort_order: 0, is_available: true, available_count: 2, total_units: null, next_available_date: null }, o || {});
const OPEN = (id, o) => U(id, o);
const FULL = (id, o) => U(id, Object.assign({ available_count: 0 }, o || {}));
const P = (id, market, units, o) => Object.assign({ id, title_en: 'Listing ' + id, slug: 'l-' + id, district_en: 'Sisattanak', workflow_status: 'active', market_status: market, available_from: null, unit_types: units || [] }, o || {});
const run = (rows) => collectAvailabilityIssues(rows, { today: TODAY });
const typesOf = (res) => res.issues.map((i) => i.type);

// ═══ 1. The five mismatch types come from the EXISTING detector, one-for-one ═══════════════════════════════════════
test('the supported types are exactly the five detector codes plus expired_date', () => {
  assert.deepEqual(AVAIL_ISSUE_TYPES.map((t) => t.type), ['available_units_closed', 'single_unit_status_wins', 'multi_unit_status_stale',
    'closed_property_open_units', 'coming_soon_open_units', 'expired_date']);
});
test('each mismatch is reported with the detector\'s own code and message, and agrees with it for every listing', () => {
  const cases = [
    [P('a', 'available', [FULL(1)]), 'available_units_closed'],
    [P('b', 'rented', [OPEN(1)]), 'single_unit_status_wins'],
    [P('c', 'reserved', [OPEN(1), FULL(2)]), 'multi_unit_status_stale'],
    [P('d', 'sold', [OPEN(1)]), 'closed_property_open_units'],
    [P('e', 'off_market', [OPEN(1), OPEN(2)]), 'closed_property_open_units'],
    [P('f', 'coming_soon', [OPEN(1)]), 'coming_soon_open_units'],
  ];
  for (const [row, code] of cases) {
    const res = run([row]);
    assert.equal(res.issueCount, 1, row.id);
    assert.equal(res.issues[0].type, code, row.id);
    const direct = describePropertyAvailabilityConflict(row);
    assert.equal(direct.code, code);
    assert.equal(res.issues[0].message, direct.message, 'the explanation is the detector\'s message, verbatim');
  }
});
test('consistent listings produce no issue (the normal states)', () => {
  const ok = [P('1', 'available', []), P('2', 'available', [OPEN(1)]), P('3', 'available', [OPEN(1), FULL(2)]),
    P('4', 'sold', []), P('5', 'rented', [FULL(1)]), P('6', 'coming_soon', [FULL(1)]), P('7', 'rented', [FULL(1), FULL(2)])];
  const res = run(ok);
  assert.equal(res.issueCount, 0);
  assert.equal(res.listingsAffected, 0);
  assert.equal(res.listingsChecked, 7);
});
test('exhaustive agreement: over every market x unit-set, an issue exists exactly when the detector reports one', () => {
  const markets = ['available', undefined, 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon'];
  const sets = [[], [OPEN(1)], [FULL(1)], [OPEN(1), FULL(2)], [FULL(1), FULL(2)], [U(1, { is_available: false, total_units: 3 })], [OPEN(1), OPEN(2)]];
  for (const m of markets) for (const units of sets) {
    const row = P('x', m, units);
    const d = describePropertyAvailabilityConflict(row);
    const mismatch = collectAvailabilityIssues([row], { today: TODAY }).issues.filter((i) => i.type !== 'expired_date');
    assert.equal(mismatch.length, d ? 1 : 0, String(m) + ' / ' + units.length);
    if (d) assert.equal(mismatch[0].type, d.code);
  }
});

// ═══ 2. Affected units ═════════════════════════════════════════════════════════════════════════════════════════════
test('open-unit mismatches list the OPEN units; "available but all closed" lists every closed unit', () => {
  const multi = run([P('m', 'rented', [OPEN(1, { name_en: 'Studio' }), FULL(2), OPEN(3, { name_en: 'Loft' })])]).issues[0];
  assert.deepEqual(multi.units.map((u) => u.name), ['Studio', 'Loft']);
  assert.ok(multi.units.every((u) => u.status === 'available'));
  const closed = run([P('c', 'available', [FULL(1, { name_en: 'A', sort_order: 1 }), FULL(2, { name_en: 'B', sort_order: 0 })])]).issues[0];
  assert.deepEqual(closed.units.map((u) => u.name), ['B', 'A'], 'in the listing\'s own unit order');
  assert.ok(closed.units.every((u) => u.status === 'temporarily_unavailable'));
});

// ═══ 3. Expired dates ══════════════════════════════════════════════════════════════════════════════════════════════
test('a closed unit with an expired date is flagged; today and future dates are not; boundaries on the Lao day', () => {
  const at = (d) => run([P('e', 'available', [OPEN(1), FULL(2, { next_available_date: d })])]);
  assert.equal(at('2026-10-13').issueCount, 1, 'yesterday: expired');
  assert.equal(at('2026-10-13').issues[0].type, 'expired_date');
  assert.equal(at('2026-10-14').issueCount, 0, 'today is still live all day');
  assert.equal(at('2026-10-15').issueCount, 0, 'tomorrow');
  assert.equal(at('2026-12-31').issueCount, 0);
  // year end, with an explicit today on the other side of it
  const ye = collectAvailabilityIssues([P('y', 'available', [OPEN(1), FULL(2, { next_available_date: '2026-12-31' })])], { today: '2027-01-01' });
  assert.equal(ye.issueCount, 1);
});
test('malformed and impossible dates count as expired; missing dates do not', () => {
  for (const bad of ['2026-02-31', 'soon', '15/10/2026', '2026-10-15T00:00:00']) {
    assert.equal(run([P('b', 'available', [OPEN(1), FULL(2, { next_available_date: bad })])]).issues[0].type, 'expired_date', bad);
  }
  for (const none of [null, undefined, '']) {
    assert.equal(run([P('n', 'available', [OPEN(1), FULL(2, { next_available_date: none })])]).issueCount, 0, String(none));
  }
});
test('a stale date on an OPEN unit, a switched-off unit, or an available listing is NOT flagged (no public effect)', () => {
  assert.equal(run([P('o', 'available', [OPEN(1, { next_available_date: '2000-01-01' })])]).issueCount, 0, 'open unit');
  assert.equal(run([P('s', 'available', [OPEN(1), U(2, { is_available: false, available_count: 0, next_available_date: '2000-01-01' })])]).issueCount, 0, 'switched-off unit');
  assert.equal(run([P('a', 'available', [], { available_from: '2000-01-01' })]).issueCount, 0, 'available listing, stale available_from');
  assert.equal(run([P('c', 'coming_soon', [], { available_from: '2000-01-01' })]).issueCount, 0, 'coming soon: the date is never shown');
});
test('listing-level available_from: flagged only when the listing is unavailable and the date has expired', () => {
  for (const market of ['rented', 'reserved', 'fully_occupied', 'sold', 'off_market']) {
    const res = run([P('r', market, [], { available_from: '2026-10-13' })]);
    assert.equal(res.issueCount, 1, market);
    assert.equal(res.issues[0].type, 'expired_date');
    assert.deepEqual(res.issues[0].listingDate, { value: '2026-10-13' });
  }
  assert.equal(run([P('r', 'rented', [], { available_from: '2026-10-14' })]).issueCount, 0, 'today is live');
  assert.equal(run([P('r', 'rented', [], { available_from: '2026-11-01' })]).issueCount, 0, 'future');
  assert.equal(run([P('r', 'rented', [], { available_from: '2026-02-31' })]).issueCount, 1, 'impossible date');
  assert.equal(run([P('r', 'rented', [], { available_from: null })]).issueCount, 0, 'missing');
});
test('several expired places on one listing are ONE expired_date issue listing each of them', () => {
  const res = run([P('m', 'rented', [FULL(1, { next_available_date: '2026-09-01' }), FULL(2, { next_available_date: '2026-09-02' })], { available_from: '2026-09-03' })]);
  const exp = res.issues.filter((i) => i.type === 'expired_date');
  assert.equal(exp.length, 1);
  assert.equal(exp[0].units.length, 2);
  assert.ok(exp[0].listingDate);
  assert.match(exp[0].message, /Unit 1/); assert.match(exp[0].message, /Unit 2/); assert.match(exp[0].message, /Listing-level Available From/);
});
test('expired-date wording states the date, that the site ignores it, and what to do', () => {
  const m = run([P('w', 'available', [OPEN(1), FULL(2, { name_en: 'Studio', next_available_date: '2026-10-13' })])]).issues[0].message;
  assert.match(m, /Studio: Next Available Date 13 Oct 2026 has passed/);
  assert.match(m, /ignores it/); assert.match(m, /Currently Unavailable/); assert.match(m, /Update the date/);
  assert.match(run([P('w', 'available', [OPEN(1), FULL(2, { next_available_date: '2026-02-31' })])]).issues[0].message, /not a valid date/);
});

// ═══ 4. Counting: no double counting ═══════════════════════════════════════════════════════════════════════════════
test('a listing with a mismatch AND an expired date is one affected listing with two issues, each type counted once', () => {
  const both = P('b', 'available', [FULL(1, { next_available_date: '2026-10-01' })]);       // available but all closed + stale date
  const res = run([both, P('c', 'rented', [OPEN(1)])]);
  assert.equal(res.listingsAffected, 2);
  assert.equal(res.issueCount, 3);
  assert.deepEqual(res.byType, { available_units_closed: 1, single_unit_status_wins: 1, multi_unit_status_stale: 0, closed_property_open_units: 0, coming_soon_open_units: 0, expired_date: 1 });
  assert.deepEqual(Object.values(res.byType).reduce((a, b) => a + b, 0), res.issueCount);
  assert.equal(new Set(res.issues.map((i) => i.key)).size, res.issues.length, 'issue keys are unique');
});
test('many affected units never multiply the count: one issue per listing per type', () => {
  const res = run([P('x', 'rented', [OPEN(1), OPEN(2), OPEN(3), OPEN(4)])]);
  assert.equal(res.issueCount, 1);
  assert.equal(res.listingsAffected, 1);
  assert.equal(res.issues[0].units.length, 4);
});
test('the same row delivered twice (page boundary overlap) is counted once', () => {
  const row = P('d', 'sold', [OPEN(1)]);
  const res = run([row, Object.assign({}, row), row]);
  assert.equal(res.listingsChecked, 1);
  assert.equal(res.issueCount, 1);
});

// ═══ 5. Who is checked ═════════════════════════════════════════════════════════════════════════════════════════════
test('drafts, archived and soft-deleted listings are not checked or counted', () => {
  const bad = (id, o) => P(id, 'sold', [OPEN(1)], o);
  const res = run([bad('pub'), bad('draft', { workflow_status: 'draft' }), bad('arch', { workflow_status: 'archived' }),
    bad('del', { deleted_at: '2026-10-01T00:00:00Z' }), bad('nostatus', { workflow_status: undefined })]);
  assert.deepEqual(res.issues.map((i) => i.propertyId).sort(), ['nostatus', 'pub']);
  assert.equal(res.listingsChecked, 2);
});
test('junk input is tolerated', () => {
  assert.equal(collectAvailabilityIssues(null).issueCount, 0);
  assert.equal(collectAvailabilityIssues([null, undefined, {}, { id: null }]).listingsChecked, 0);
  assert.equal(collectAvailabilityIssues([{ id: 'z', workflow_status: 'active' }]).issueCount, 0);
});

// ═══ 6. Read-only, and no second definition of availability ═══════════════════════════════════════════════════════
test('the input rows are never mutated', () => {
  const deep = (o) => { Object.freeze(o); Object.values(o).forEach((v) => { if (v && typeof v === 'object') deep(v); }); return o; };
  const rows = deep([P('a', 'available', [FULL(1, { next_available_date: '2020-01-01' })], { available_from: '2020-01-01' }), P('b', 'sold', [OPEN(1)])]);
  const before = JSON.stringify(rows);
  const res = run(rows);
  assert.equal(JSON.stringify(rows), before);
  assert.ok(res.issueCount >= 2);
});
test('an expired date can never make a listing available, and the verdict matches the canonical resolver', () => {
  const closed = P('k', 'available', [FULL(1, { next_available_date: '2000-01-01' })]);
  assert.equal(resolvePropertyAvailability(closed).available, false);
  const res = run([closed]);
  assert.ok(typesOf(res).includes('available_units_closed'), 'still a mismatch: the expired date opened nothing');
  assert.ok(typesOf(res).includes('expired_date'));
});
test('the module defines no availability rule of its own (it only calls the existing resolvers)', () => {
  const src = fs.readFileSync(new URL('./availability-issues.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const mustCall of ['describePropertyAvailabilityConflict(', 'resolvePropertyAvailability(', 'resolveUnitAvailability(', 'liveAvailabilityDate(']) {
    assert.ok(src.includes(mustCall), mustCall);
  }
  assert.doesNotMatch(src, /market_status\s*===|available_count\s*>\s*0\s*&&\s*is_available|=== 'rented'|=== 'sold'/, 'no re-implemented market/unit rules');
});

// ═══ 7. Deep link ══════════════════════════════════════════════════════════════════════════════════════════════════
test('availabilityIssueEditHref: existing ?edit=<id> form, optional &unit=, encoded', () => {
  assert.equal(availabilityIssueEditHref('abc'), 'admin.html?edit=abc');
  assert.equal(availabilityIssueEditHref('abc', 'u-1'), 'admin.html?edit=abc&unit=u-1');
  assert.equal(availabilityIssueEditHref('a b&c', 'x/y'), 'admin.html?edit=a%20b%26c&unit=x%2Fy');
  assert.equal(availabilityIssueEditHref('abc', null), 'admin.html?edit=abc');
  assert.equal(availabilityIssueEditHref('abc', ''), 'admin.html?edit=abc');
});
