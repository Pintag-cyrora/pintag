// Expired availability dates stop being applied.
//   node --test expired-availability-dates.test.js
//
// THE RULE UNDER TEST (unit-availability.js, "AVAILABILITY DATES"): a stored availability date
// (unit_types.next_available_date / properties.available_from) is a Laos calendar day. It is live while it is
// >= today in Asia/Vientiane and a real YYYY-MM-DD date; otherwise it is treated exactly as "no date on file".
// That changes what is SHOWN and which label/sort bucket a closed unit gets -- it never changes availability itself:
// is_available, available_count, total_units and market_status keep deciding that, and an expired date can never
// make anything Available.
//
// Every date case passes an explicit `today` (or pins the instant); nothing here reads the machine clock or timezone,
// except the cross-process TZ test, which sets TZ explicitly on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'property-availability.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const G = globalThis;
const {
  availabilityTodayLao, isValidAvailabilityDate, liveAvailabilityDate, resolveUnitAvailability, formatAvailabilityDisplay,
  formatAvailabilityAdminSummary, formatMoveInDate, formatAvailableFromLine, compareUnitTypesForDisplay,
  resolvePropertyAvailability, ptResolveNextAvailable, ptResolveFomoOverlay,
} = G;

const TODAY = '2026-10-14';
const unit = (o) => Object.assign({ id: 'u', is_available: true, available_count: 0, total_units: null, next_available_date: null, availability_note: null }, o);

// ═══ 1. Strict date validation ════════════════════════════════════════════════════════════════════════════════════
test('isValidAvailabilityDate: real YYYY-MM-DD calendar dates only', () => {
  for (const ok of ['2026-10-14', '2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29', '1900-01-01']) assert.equal(isValidAvailabilityDate(ok), true, ok);
  for (const bad of [
    '2026-02-31', '2026-02-29', '2027-02-29', '2100-02-29',            // impossible dates (2100 is not a leap year)
    '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '2026-04-31',
    '2026-2-3', '2026-02-3', '26-02-03', '2026/02/03', '03/02/2026', '2026-02-03T00:00:00', '2026-02-03T00:00:00Z', ' 2026-02-03', '2026-02-03 ',
    '', 'soon', 'null', null, undefined, 0, 20260203, true, {}, [], ['2026-02-03'], new Date('2026-02-03'),
  ]) assert.equal(isValidAvailabilityDate(bad), false, JSON.stringify(bad));
});

// ═══ 2. Boundaries: yesterday / today / tomorrow / year end ═══════════════════════════════════════════════════════
test('liveAvailabilityDate: before today is expired, today and later are live', () => {
  assert.equal(liveAvailabilityDate('2026-10-13', TODAY), null, 'yesterday');
  assert.equal(liveAvailabilityDate('2026-10-14', TODAY), '2026-10-14', 'today stays valid for the whole day');
  assert.equal(liveAvailabilityDate('2026-10-15', TODAY), '2026-10-15', 'tomorrow');
});
test('liveAvailabilityDate: month, year and leap-day boundaries', () => {
  assert.equal(liveAvailabilityDate('2026-12-31', '2026-12-31'), '2026-12-31');
  assert.equal(liveAvailabilityDate('2026-12-31', '2027-01-01'), null, 'new year: last day of the old year has expired');
  assert.equal(liveAvailabilityDate('2027-01-01', '2026-12-31'), '2027-01-01');
  assert.equal(liveAvailabilityDate('2027-01-01', '2027-01-01'), '2027-01-01');
  assert.equal(liveAvailabilityDate('2028-02-29', '2028-02-29'), '2028-02-29', 'leap day');
  assert.equal(liveAvailabilityDate('2028-02-29', '2028-03-01'), null);
  assert.equal(liveAvailabilityDate('2026-09-30', '2026-10-01'), null, 'month end');
});
test('liveAvailabilityDate: malformed or impossible values are never live, whatever today is', () => {
  for (const bad of ['2026-02-31', '2999-02-31', '2999-13-01', '31/12/2999', 'soon', '', null, undefined, 20991231, {}]) {
    assert.equal(liveAvailabilityDate(bad, TODAY), null, JSON.stringify(bad));
  }
});
test('an invalid explicit `today` falls back to the Lao calendar day, never to "everything is live"', () => {
  const laoNow = availabilityTodayLao();
  assert.equal(liveAvailabilityDate('2000-01-01', 'garbage'), null);
  assert.equal(liveAvailabilityDate('2999-01-01', 'garbage'), '2999-01-01');
  assert.match(laoNow, /^\d{4}-\d{2}-\d{2}$/);
});

// ═══ 3. "Today" is the Lao calendar day ═══════════════════════════════════════════════════════════════════════════
test('availabilityTodayLao: instants around Lao midnight (UTC+7, no DST)', () => {
  const at = (iso) => availabilityTodayLao(new Date(iso));
  assert.equal(at('2026-10-13T16:59:59Z'), '2026-10-13', '23:59:59 in Vientiane');
  assert.equal(at('2026-10-13T17:00:00Z'), '2026-10-14', '00:00:00 in Vientiane');
  assert.equal(at('2026-10-13T17:00:01Z'), '2026-10-14');
  assert.equal(at('2026-10-14T16:59:59Z'), '2026-10-14');
  assert.equal(at('2026-10-14T17:00:00Z'), '2026-10-15');
  assert.equal(at('2026-12-31T16:59:59Z'), '2026-12-31');
  assert.equal(at('2026-12-31T17:00:00Z'), '2027-01-01', 'new year arrives 7 h before UTC');
  assert.equal(at('2028-02-28T17:00:00Z'), '2028-02-29', 'leap day');
  assert.equal(availabilityTodayLao(Date.parse('2026-10-13T17:00:00Z')), '2026-10-14', 'epoch ms accepted');
});
test('a date is live all day in Laos and expires at Lao midnight -- not at UTC or visitor midnight', () => {
  const live = (date, iso) => liveAvailabilityDate(date, availabilityTodayLao(new Date(iso))) === date;
  // 2026-10-14 in Laos runs 2026-10-13T17:00Z .. 2026-10-14T16:59:59Z
  assert.equal(live('2026-10-14', '2026-10-13T17:00:00Z'), true, 'first second of the Lao day (still Oct 13 in UTC and the US)');
  assert.equal(live('2026-10-14', '2026-10-14T16:59:59Z'), true, 'last second of the Lao day (already late Oct 14 in the US)');
  assert.equal(live('2026-10-14', '2026-10-14T17:00:00Z'), false, 'Lao midnight: now expired');
  assert.equal(live('2026-10-13', '2026-10-13T17:00:00Z'), false, 'yesterday in Laos is expired although it is still Oct 13 in UTC');
});
test('the result depends only on the instant: identical under UTC, Lao and US machine timezones', () => {
  const instants = ['2026-10-13T16:59:59Z', '2026-10-13T17:00:00Z', '2026-12-31T16:59:59Z', '2026-12-31T17:00:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:30:00Z'];
  const src = fs.readFileSync(new URL('./unit-availability.js', import.meta.url), 'utf8');
  const prog = src + `;process.stdout.write(JSON.stringify(${JSON.stringify(instants)}.map(function(i){return [availabilityTodayLao(new Date(i)), liveAvailabilityDate('2026-10-14', availabilityTodayLao(new Date(i)))];})));`;
  const expected = instants.map((i) => [availabilityTodayLao(new Date(i)), liveAvailabilityDate('2026-10-14', availabilityTodayLao(new Date(i)))]);
  for (const tz of ['UTC', 'Asia/Vientiane', 'America/New_York', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', prog], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
    assert.deepEqual(out, expected, 'TZ=' + tz);
  }
  assert.deepEqual(expected.map((r) => r[0]), ['2026-10-13', '2026-10-14', '2026-12-31', '2027-01-01', '2026-03-08', '2026-11-01']);
});
test('availabilityTodayLao agrees with laos-date.js (the Analytics / Intelligence definition of a Lao day) on a sweep of instants', () => {
  const { laosDateString } = createRequire(import.meta.url)('./laos-date.js');
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 24 * 400; i += 5) {                                  // every 5 h (+ offsets) over 400 days, incl. both year ends
    const t = start + i * 3600000 + (i % 7) * 1234567;
    assert.equal(availabilityTodayLao(new Date(t)), laosDateString(new Date(t)), new Date(t).toISOString());
  }
  for (const iso of ['2026-12-31T16:59:59Z', '2026-12-31T17:00:00Z', '2027-12-31T17:00:00Z']) {
    assert.equal(availabilityTodayLao(new Date(iso)), laosDateString(new Date(iso)), iso);
  }
});
test('availabilityTodayLao falls back to the fixed UTC+7 offset when Intl cannot answer', () => {
  const RealIntl = G.Intl;
  G.Intl = { DateTimeFormat: function () { throw new Error('no Intl'); } };
  try {
    assert.equal(availabilityTodayLao(new Date('2026-10-13T16:59:59Z')), '2026-10-13');
    assert.equal(availabilityTodayLao(new Date('2026-10-13T17:00:00Z')), '2026-10-14');
  } finally { G.Intl = RealIntl; }
});

// ═══ 4. The per-unit resolver: an expired / malformed date == no date ═════════════════════════════════════════════
test('closed unit with an EXPIRED date: no "Available from", "Currently Unavailable", date dropped but reported to the admin', () => {
  const r = resolveUnitAvailability(unit({ available_count: 0, total_units: 5, next_available_date: '2026-10-13' }), undefined, TODAY);
  assert.equal(r.status, 'temporarily_unavailable');
  assert.equal(r.nextAvailableDate, null);
  assert.equal(r.ignoredNextAvailableDate, '2026-10-13');
  assert.equal(formatAvailabilityDisplay(r, 'en'), 'Currently Unavailable');
  assert.equal(formatMoveInDate(r, 'en'), null);
  assert.equal(formatAvailabilityAdminSummary(r), 'Currently Unavailable (0/5)');
  for (const lang of ['lo', 'zh']) assert.doesNotMatch(formatAvailabilityDisplay(r, lang), /2026/, lang);
});
test('the stale label is never produced: expired date renders exactly like a unit with no date', () => {
  for (const lang of ['en', 'lo', 'zh']) {
    const stale = resolveUnitAvailability(unit({ next_available_date: '2020-01-01' }), undefined, TODAY);
    const none = resolveUnitAvailability(unit({ next_available_date: null }), undefined, TODAY);
    assert.equal(formatAvailabilityDisplay(stale, lang), formatAvailabilityDisplay(none, lang));
    assert.doesNotMatch(formatAvailabilityDisplay(stale, lang), /2020|1 Jan/);
  }
});
test('closed unit with a date TODAY or later keeps the existing "Fully Occupied — Available from" behaviour', () => {
  for (const [d, text] of [['2026-10-14', '14 Oct 2026'], ['2026-10-15', '15 Oct 2026'], ['2027-01-01', '1 Jan 2027']]) {
    const r = resolveUnitAvailability(unit({ next_available_date: d }), undefined, TODAY);
    assert.equal(r.status, 'fully_occupied', d);
    assert.equal(r.nextAvailableDate, d);
    assert.equal(r.ignoredNextAvailableDate, null);
    assert.equal(formatAvailabilityDisplay(r, 'en'), 'Fully Occupied — Available from ' + text);
    assert.equal(formatMoveInDate(r, 'en'), text);
  }
});
test('malformed / impossible dates behave like no date and are never rendered', () => {
  for (const bad of ['2026-02-31', '2999-02-31', '15/10/2026', 'soon', '2026-10-15T00:00:00', 'x'.repeat(50), 20261015, {}, []]) {
    const r = resolveUnitAvailability(unit({ next_available_date: bad }), undefined, TODAY);
    assert.equal(r.status, 'temporarily_unavailable', JSON.stringify(bad));
    assert.equal(r.nextAvailableDate, null, JSON.stringify(bad));
    assert.equal(formatAvailabilityDisplay(r, 'en'), 'Currently Unavailable');
  }
});
test('missing dates (null / undefined / empty string) are simply "no date" -- not reported as ignored', () => {
  for (const none of [null, undefined, '']) {
    const r = resolveUnitAvailability(unit({ next_available_date: none }), undefined, TODAY);
    assert.equal(r.status, 'temporarily_unavailable');
    assert.equal(r.nextAvailableDate, null);
    assert.equal(r.ignoredNextAvailableDate, null);
  }
  const noKey = unit({}); delete noKey.next_available_date;
  assert.equal(resolveUnitAvailability(noKey, undefined, TODAY).status, 'temporarily_unavailable');
});
test('computed date: used when the manual one is absent OR stale; a live manual date still wins; a stale computed date is dropped too', () => {
  const U = (d) => unit({ next_available_date: d });
  assert.equal(resolveUnitAvailability(U(null), '2026-11-01', TODAY).nextAvailableDate, '2026-11-01');
  assert.equal(resolveUnitAvailability(U('2026-09-01'), '2026-11-01', TODAY).nextAvailableDate, '2026-11-01', 'stale manual no longer shadows the computed date');
  assert.equal(resolveUnitAvailability(U('2026-10-20'), '2026-11-01', TODAY).nextAvailableDate, '2026-10-20', 'live manual date wins');
  const both = resolveUnitAvailability(U('2026-09-01'), '2026-09-15', TODAY);
  assert.equal(both.nextAvailableDate, null);
  assert.equal(both.status, 'temporarily_unavailable');
  assert.equal(both.ignoredNextAvailableDate, '2026-09-01');
});

// ═══ 5. Availability itself is never touched ══════════════════════════════════════════════════════════════════════
const EXPIRED = '2000-01-01', FUTURE = '2999-12-31';        // always expired / always live, on any real clock
test('a unit with a positive available count is Available whatever its date says; the expired date is not shown', () => {
  for (const d of [null, EXPIRED, FUTURE, '2026-02-31', 'junk']) {
    const r = resolveUnitAvailability(unit({ available_count: 3, total_units: 10, next_available_date: d }), undefined, TODAY);
    assert.equal(r.status, 'available', String(d));
    assert.equal(formatAvailabilityDisplay(r, 'en'), 'Available Now');
    assert.equal(r.availableCount, 3);
    assert.equal(r.totalUnits, 10);
  }
  const expired = resolveUnitAvailability(unit({ available_count: 3, next_available_date: EXPIRED }), undefined, TODAY);
  assert.equal(expired.nextAvailableDate, null);
});
test('switched-off units keep their canonical status; the expired date neither opens nor relabels them', () => {
  for (const [total, want] of [[null, 'temporarily_unavailable'], [8, 'coming_soon']]) {
    const withDate = resolveUnitAvailability(unit({ is_available: false, available_count: 4, total_units: total, next_available_date: EXPIRED }), undefined, TODAY);
    const noDate = resolveUnitAvailability(unit({ is_available: false, available_count: 4, total_units: total, next_available_date: null }), undefined, TODAY);
    assert.equal(withDate.status, want);
    assert.equal(withDate.status, noDate.status);
    assert.equal(withDate.availableCount, 4, 'manual count preserved');
  }
});
test('the resolver never mutates its input (manual settings preserved)', () => {
  const u = Object.freeze(unit({ available_count: 0, total_units: 6, next_available_date: EXPIRED, availability_note: 'Renovating', is_available: true }));
  const snapshot = JSON.stringify(u);
  const r = resolveUnitAvailability(u, '2026-12-01', TODAY);
  assert.equal(JSON.stringify(u), snapshot);
  assert.equal(r.note, 'Renovating', 'the availability note is kept');
});
test('property level: an expired unit date gives the SAME canonical summary as no date, across every market x unit set', () => {
  const markets = ['available', undefined, 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon'];
  const sets = {
    none: [],
    single_open: [unit({ id: 'a', available_count: 2 })],
    single_closed: [unit({ id: 'a', available_count: 0 })],
    multi_open_closed: [unit({ id: 'a', available_count: 2 }), unit({ id: 'b', available_count: 0 })],
    multi_all_closed: [unit({ id: 'a', available_count: 0 }), unit({ id: 'b', available_count: 0 })],
    multi_all_off: [unit({ id: 'a', is_available: false, total_units: 3 }), unit({ id: 'b', is_available: false, total_units: 2 })],
  };
  for (const m of markets) for (const [name, units] of Object.entries(sets)) {
    const dated = units.map((u) => Object.assign({}, u, { next_available_date: EXPIRED }));
    const plain = units.map((u) => Object.assign({}, u, { next_available_date: null }));
    const a = resolvePropertyAvailability({ market_status: m, unit_types: dated });
    const b = resolvePropertyAvailability({ market_status: m, unit_types: plain });
    assert.deepEqual(
      JSON.parse(JSON.stringify(Object.assign({}, a, { units: a.units.map((u) => u.status) }))),
      JSON.parse(JSON.stringify(Object.assign({}, b, { units: b.units.map((u) => u.status) }))),
      String(m) + ' / ' + name);
  }
});
test('a rented / sold / off-market listing stays unavailable with an expired date, and shows no date', () => {
  for (const market of ['rented', 'sold', 'off_market', 'reserved', 'fully_occupied']) {
    const p = { market_status: market, available_from: '2026-10-13', unit_types: [] };
    assert.equal(resolvePropertyAvailability(p).available, false, market);
    assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null, market + ': stale available_from is not advertised');
    const live = ptResolveNextAvailable(Object.assign({}, p, { available_from: '2026-10-14' }), 'en', TODAY);
    if (market === 'sold' || market === 'off_market') assert.ok(live, 'the existing behaviour for a live date is unchanged'); else assert.equal(live.isoDate, '2026-10-14');
  }
});
test('an AVAILABLE listing gets no date line at all (expired or not)', () => {
  const p = { market_status: 'available', available_from: FUTURE, unit_types: [unit({ available_count: 2, next_available_date: FUTURE })] };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null);
});

// ═══ 6. Multi-unit listings mixing expired, future and missing dates ══════════════════════════════════════════════
test('multi-unit: ptResolveNextAvailable advertises the earliest LIVE date; expired, malformed and missing ones are ignored', () => {
  const p = {
    market_status: 'available',
    available_from: '2026-09-01',                                                                   // stale listing-level date
    unit_types: [
      unit({ id: 'a', next_available_date: '2026-10-01' }),                                         // expired
      unit({ id: 'b', next_available_date: '2026-10-20' }),                                         // live
      unit({ id: 'c', next_available_date: null }),                                                 // missing
      unit({ id: 'd', next_available_date: '2026-10-16' }),                                         // live, earliest
      unit({ id: 'e', next_available_date: '2026-02-31' }),                                         // impossible
    ],
  };
  const na = ptResolveNextAvailable(p, 'en', TODAY);
  assert.equal(na.isoDate, '2026-10-16');
  assert.equal(na.text, 'Available 16 Oct 2026');
  const overlay = ptResolveFomoOverlay(p, 'en', TODAY);
  assert.equal(overlay.dateText, 'Available 16 Oct 2026');
});
test('multi-unit: when every date is expired / missing there is no date line, and the property is still unavailable', () => {
  const p = { market_status: 'available', available_from: '2026-10-13',
    unit_types: [unit({ id: 'a', next_available_date: '2026-10-01' }), unit({ id: 'b', next_available_date: null })] };
  assert.equal(resolvePropertyAvailability(p).available, false);
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null);
  assert.equal(ptResolveFomoOverlay(p, 'en', TODAY).dateText, undefined);
});
test('multi-unit with an open unit and stale dates elsewhere: stays available, no date line', () => {
  const p = { market_status: 'available', unit_types: [unit({ id: 'a', available_count: 2 }), unit({ id: 'b', next_available_date: EXPIRED })] };
  assert.equal(resolvePropertyAvailability(p).available, true);
  assert.deepEqual(resolvePropertyAvailability(p).openUnitIds, ['a']);
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null);
});
test('ptResolveNextAvailable: today is a live date; yesterday is not; the default `today` is the Lao day', () => {
  const base = { market_status: 'rented', unit_types: [] };
  assert.equal(ptResolveNextAvailable(Object.assign({ available_from: '2026-10-14' }, base), 'en', TODAY).isoDate, '2026-10-14');
  assert.equal(ptResolveNextAvailable(Object.assign({ available_from: '2026-10-13' }, base), 'en', TODAY), null);
  // an invalid explicit override must not turn expiry off
  assert.equal(ptResolveNextAvailable(Object.assign({ available_from: EXPIRED }, base), 'en', 'garbage'), null);
  const RealDate = Date;
  class Fixed extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-10-13T18:00:00Z'])); } }   // 01:00 on Oct 14 in Laos, still Oct 13 in UTC/US
  G.Date = Fixed;
  try {
    assert.equal(availabilityTodayLao(), '2026-10-14');
    assert.equal(ptResolveNextAvailable(Object.assign({ available_from: '2026-10-13' }, base), 'en'), null, 'Oct 13 is already yesterday in Laos');
    assert.equal(ptResolveNextAvailable(Object.assign({ available_from: '2026-10-14' }, base), 'en').isoDate, '2026-10-14');
  } finally { G.Date = RealDate; }
});
test('formatAvailableFromLine (listing-level date) applies the same expiry', () => {
  assert.equal(formatAvailableFromLine('2026-10-13', 'en', TODAY), null);
  assert.equal(formatAvailableFromLine('2026-02-31', 'en', TODAY), null);
  assert.equal(formatAvailableFromLine('2026-10-14', 'en', TODAY), 'Available from 14 Oct 2026');
  assert.equal(formatAvailableFromLine('2026-10-15', 'lo', TODAY), 'ວ່າງຕັ້ງແຕ່ 15 ຕ.ລ 2026');
});

// ═══ 7. "Available Soon" sorting ══════════════════════════════════════════════════════════════════════════════════
test('sorting: a unit whose date has expired is Unavailable, not "Available Soon"', () => {
  const pair = (id, o, sort) => ({ id, resolved: resolveUnitAvailability(unit(Object.assign({ id }, o)), undefined, TODAY), sort_order: sort });
  const list = [
    pair('stale', { next_available_date: '2026-10-01' }, 0),            // expired -> Currently Unavailable
    pair('soon_late', { next_available_date: '2026-12-01' }, 1),
    pair('open', { available_count: 2 }, 2),
    pair('soon_early', { next_available_date: '2026-10-20' }, 3),
    pair('none', { next_available_date: null }, 4),
  ];
  const sorted = list.slice().sort(compareUnitTypesForDisplay).map((p) => p.id);
  assert.deepEqual(sorted, ['open', 'soon_early', 'soon_late', 'stale', 'none'],
    'available, then live dates soonest first, then unavailable (staff sort_order as the tiebreak)');
  assert.equal(list[0].resolved.status, 'temporarily_unavailable');
});
