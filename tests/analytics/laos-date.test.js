// laos-date.js — Asia/Vientiane calendar-day arithmetic for Admin Analytics.
//
//   node --test tests/analytics/laos-date.test.js
//
// The bug this guards: analytics.js used to send `d.toISOString().slice(0, 10)`
// of a browser-LOCAL midnight. In a UTC+7 browser, local midnight is 17:00Z of
// the previous UTC date, so "Today" queried yesterday and the label read
// "09-29 → 09-29" on 09-30; the answer also depended on the laptop's timezone.
// These tests run the REAL module in child processes with TZ set to UTC,
// Asia/Vientiane, America/Los_Angeles and Pacific/Kiritimati (UTC+14) and
// require identical results in all of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LAOS = require('../../laos-date.js');
const MODULE = path.join(__dirname, '..', '..', 'laos-date.js');
const TIMEZONES = ['UTC', 'Asia/Vientiane', 'America/Los_Angeles', 'Pacific/Kiritimati'];

// Run `body` (which may use L = the laos-date module and prints JSON) with TZ set.
function inTimezone(tz, body) {
  const script = `const L = require(${JSON.stringify(MODULE)}); const out = (${body})(L); process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, `child failed under TZ=${tz}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ── instants around Laos midnight ────────────────────────────────────────
test('laosDateString: 16:59:59Z is still the same Laos day, 17:00:00Z is the next', () => {
  assert.equal(LAOS.laosDateString(new Date('2026-09-16T16:59:59Z')), '2026-09-16');
  assert.equal(LAOS.laosDateString(new Date('2026-09-16T17:00:00Z')), '2026-09-17');
  assert.equal(LAOS.laosDateString(new Date('2026-09-16T23:59:59Z')), '2026-09-17');
  assert.equal(LAOS.laosDateString(new Date('2026-09-17T00:05:00Z')), '2026-09-17');
});
test('laosDateString: month, year and leap-day boundaries', () => {
  assert.equal(LAOS.laosDateString(new Date('2026-09-30T17:00:00Z')), '2026-10-01');
  assert.equal(LAOS.laosDateString(new Date('2026-12-31T17:00:00Z')), '2027-01-01');
  assert.equal(LAOS.laosDateString(new Date('2028-02-28T17:00:00Z')), '2028-02-29');
  assert.equal(LAOS.laosDateString(new Date('2028-02-29T17:00:00Z')), '2028-03-01');
});
test('laosDateTimeString formats the Laos wall clock (used for row timestamps)', () => {
  assert.equal(LAOS.laosDateTimeString('2026-09-16T16:59:59Z'), '2026-09-16 23:59');
  assert.equal(LAOS.laosDateTimeString('2026-09-16T17:00:00Z'), '2026-09-17 00:00');
  assert.equal(LAOS.laosDateTimeString('2026-09-17T16:59:59.999999+00:00'), '2026-09-17 23:59');
  assert.equal(LAOS.laosDateTimeString('not a date'), '');
});

// ── label arithmetic ─────────────────────────────────────────────────────
test('addDays / diffDays are pure calendar math across month, year and leap boundaries', () => {
  assert.equal(LAOS.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(LAOS.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(LAOS.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(LAOS.addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(LAOS.diffDays('2026-09-24', '2026-10-01'), 7);
  assert.equal(LAOS.diffDays('2023-03-19', '2026-06-30'), 1199);
});
test('isLabel rejects malformed and impossible dates', () => {
  assert.equal(LAOS.isLabel('2026-09-30'), true);
  for (const bad of ['2026-9-30', '2026-02-31', '2026-13-01', '', null, undefined, '2026-09-30T00:00:00Z', 20260930]) {
    assert.equal(LAOS.isLabel(bad), false, String(bad));
  }
});

// ── presets ──────────────────────────────────────────────────────────────
test('presets are anchored on the Laos "today"; end is exclusive (tomorrow)', () => {
  const t = '2026-09-30';
  const r = (p, e) => LAOS.presetRange(p, t, e);
  assert.deepEqual([r('today').start, r('today').endExclusive], ['2026-09-30', '2026-10-01']);
  assert.deepEqual([r('7d').start, r('7d').endExclusive], ['2026-09-24', '2026-10-01']);
  assert.deepEqual([r('30d').start, r('30d').endExclusive], ['2026-09-01', '2026-10-01']);
  assert.deepEqual([r('90d').start, r('90d').endExclusive], ['2026-07-03', '2026-10-01']);
  assert.equal(r('90d').days, 90);
  assert.equal(r('today').label, 'Today');
  assert.equal(r('7d').label, 'Last 7 days');
  assert.equal(r('today').text, '2026-09-30');
  assert.equal(r('7d').text, '2026-09-24 → 2026-09-30');
  assert.equal(r('bogus').preset, '7d', 'an unknown preset falls back to 7d');
});
test('the 90-day preset is kept alongside All time and Custom', () => {
  assert.equal(LAOS.PRESET_DAYS['90d'], 90);
  assert.ok(LAOS.presetRange('90d', '2026-09-30').days === 90);
});
test('All time starts at the earliest day of real data, never an invented epoch', () => {
  const r = LAOS.presetRange('all', '2026-09-30', '2026-06-25');
  assert.deepEqual([r.preset, r.start, r.endExclusive, r.label], ['all', '2026-06-25', '2026-10-01', 'All time']);
  assert.equal(r.days, 98);
  assert.equal(LAOS.presetRange('all', '2026-09-30', null).start, '2026-09-30', 'no data -> just today, not a guess');
  assert.equal(LAOS.presetRange('all', '2026-09-30', '2027-01-01').start, '2026-09-30', 'an earliest day in the future is ignored');
  assert.equal(LAOS.presetRange('all', '2026-09-30', 'garbage').start, '2026-09-30');
});
test('custom range: inclusive end input becomes an exclusive end; bad input returns a reason', () => {
  const r = LAOS.customRange('2026-09-10', '2026-09-12', '2026-09-30');
  assert.deepEqual([r.preset, r.start, r.endExclusive, r.days], ['custom', '2026-09-10', '2026-09-13', 3]);
  assert.equal(LAOS.customRange('2026-09-10', '2026-09-10', '2026-09-30').endExclusive, '2026-09-11', 'a single day');
  assert.equal(LAOS.customRange('2026-09-10', '2026-09-10', '2026-09-30').text, '2026-09-10');
  assert.equal(LAOS.customRange('2026-09-12', '2026-09-10', '2026-09-30').error, 'inverted');
  assert.equal(LAOS.customRange('2026-09-10', '2026-10-02', '2026-09-30').error, 'future');
  assert.equal(LAOS.customRange('2026-09-10', '2026-09-30', '2026-09-30').error, undefined, 'ending today is allowed');
  assert.equal(LAOS.customRange('', '2026-09-30', '2026-09-30').error, 'invalid');
  assert.equal(LAOS.customRange('2026-02-30', '2026-03-01', '2026-09-30').error, 'invalid');
  assert.ok(LAOS.customRange('2026-09-12', '2026-09-10', '2026-09-30').message.length > 5);
  const wide = LAOS.customRange('2023-01-01', '2026-09-30', '2026-09-30');
  assert.equal(wide.error, undefined, 'no maximum span: history is not capped');
});
test('compare range: equal-length previous span; none for All time; flags a span before any data', () => {
  const r = LAOS.presetRange('7d', '2026-09-30');
  const c = LAOS.compareRange(r, '2026-06-25');
  assert.deepEqual([c.start, c.endExclusive, c.beforeData], ['2026-09-17', '2026-09-24', false]);
  assert.equal(LAOS.compareRange(LAOS.presetRange('all', '2026-09-30', '2026-06-25'), '2026-06-25'), null);
  const early = LAOS.compareRange(LAOS.presetRange('90d', '2026-09-30'), '2026-06-01');
  assert.equal(early.beforeData, false, 'partly overlapping data still compares');
  const none = LAOS.compareRange(LAOS.presetRange('90d', '2026-09-30'), '2026-07-03');
  assert.equal(none.beforeData, true, 'the previous 90 days end before the first day of data');
  assert.equal(LAOS.compareRange(LAOS.customRange('2026-09-10', '2026-09-12', '2026-09-30'), null).start, '2026-09-07');
});

// ── chunking (PostgREST 1000-row cap) ────────────────────────────────────
test('chunkRanges: contiguous, each <= max, covers the whole span exactly', () => {
  const check = (start, end, max) => {
    const chunks = LAOS.chunkRanges(start, end, max);
    assert.equal(chunks[0].start, start);
    assert.equal(chunks[chunks.length - 1].endExclusive, end);
    let total = 0;
    chunks.forEach((c, i) => {
      assert.ok(LAOS.diffDays(c.start, c.endExclusive) <= max, 'chunk too big');
      assert.ok(LAOS.diffDays(c.start, c.endExclusive) >= 1, 'empty chunk');
      if (i) assert.equal(c.start, chunks[i - 1].endExclusive, 'gap or overlap');
      total += LAOS.diffDays(c.start, c.endExclusive);
    });
    assert.equal(total, LAOS.diffDays(start, end));
    return chunks.length;
  };
  assert.equal(check('2026-01-01', LAOS.addDays('2026-01-01', 900), 900), 1);
  assert.equal(check('2026-01-01', LAOS.addDays('2026-01-01', 901), 900), 2);
  assert.equal(check('2026-01-01', LAOS.addDays('2026-01-01', 1800), 900), 2);
  assert.equal(check('2026-01-01', LAOS.addDays('2026-01-01', 1801), 900), 3);
  assert.equal(check('2023-03-19', '2026-10-01', 900), 2);
  assert.equal(check('2026-09-01', '2026-09-02', 900), 1);
  assert.deepEqual(LAOS.chunkRanges('2026-09-01', '2026-09-01', 900), [], 'empty range -> no chunks');
  assert.throws(() => LAOS.chunkRanges('2026-01-01', '2026-02-01', 0));
});

// ── axis labels ──────────────────────────────────────────────────────────
test('axisLabels: MM-DD inside a year, YY-MM-DD once the series crosses a year', () => {
  assert.deepEqual(LAOS.axisLabels(['2026-09-29', '2026-09-30']), ['09-29', '09-30']);
  assert.deepEqual(LAOS.axisLabels(['2025-12-31', '2026-01-01']), ['25-12-31', '26-01-01']);
  assert.deepEqual(LAOS.axisLabels([]), []);
});

// ── the regression: results are identical in every browser timezone ───────
const PROBES = [
  '2026-09-30T02:30:00Z',   // 09:30 Laos
  '2026-09-30T16:59:59Z',   // 23:59:59 Laos on 09-30
  '2026-09-30T17:00:00Z',   // 00:00:00 Laos on 10-01  (the crossover)
  '2026-09-30T17:30:00Z',   // 00:30 Laos on 10-01  (the example in the requirement)
  '2026-12-31T17:00:00Z'    // Laos new year
];
test('presets and custom ranges are identical under every browser timezone', () => {
  const body = `function (L) {
    const probes = ${JSON.stringify(PROBES)};
    return probes.map(function (iso) {
      const today = L.todayLaos(new Date(iso));
      return { iso: iso, today: today,
               presets: ['today', '7d', '30d', '90d'].map(function (p) { const r = L.presetRange(p, today); return [r.start, r.endExclusive, r.text]; }),
               all: L.presetRange('all', today, '2026-06-25').start,
               custom: L.customRange('2026-09-10', today, today) };
    });
  }`;
  const baseline = inTimezone('UTC', body);
  for (const tz of TIMEZONES) {
    assert.deepEqual(inTimezone(tz, body), baseline, `TZ=${tz} must give the same ranges as UTC`);
  }
  // spot-check the expected values so "identical" cannot mean "identically wrong"
  const byIso = Object.fromEntries(baseline.map(x => [x.iso, x]));
  assert.equal(byIso['2026-09-30T02:30:00Z'].today, '2026-09-30');
  assert.equal(byIso['2026-09-30T16:59:59Z'].today, '2026-09-30');
  assert.equal(byIso['2026-09-30T17:00:00Z'].today, '2026-10-01');
  assert.deepEqual(byIso['2026-09-30T17:30:00Z'].presets[0], ['2026-10-01', '2026-10-02', '2026-10-01'], '"Today" at 00:30 Laos time is the NEW Laos day');
  assert.deepEqual(byIso['2026-09-30T17:30:00Z'].presets[1], ['2026-09-25', '2026-10-02', '2026-09-25 → 2026-10-01']);
  assert.deepEqual(byIso['2026-12-31T17:00:00Z'].presets[0], ['2027-01-01', '2027-01-02', '2027-01-01']);
});

test('regression witness: the OLD toISOString() approach DID depend on the browser timezone', () => {
  const body = `function () {
    // verbatim shape of the removed computeRange()/fmtIso() code, "now" = 2026-09-30 02:30Z (09:30 Laos)
    const RealDate = Date; const fixed = new RealDate('2026-09-30T02:30:00Z').getTime();
    function D(a) { return a === undefined ? new RealDate(fixed) : new RealDate(a); }
    const end = D(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
    const start = new RealDate(end); start.setDate(start.getDate() - 1);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  }`;
  const laosBrowser = inTimezone('Asia/Vientiane', body);
  const utcBrowser = inTimezone('UTC', body);
  assert.notDeepEqual(laosBrowser, utcBrowser, 'the old code gave different ranges in different timezones');
  assert.deepEqual(laosBrowser, ['2026-09-29', '2026-09-30'], 'in a Laos browser, old "Today" was YESTERDAY (09-29)');
  assert.deepEqual(utcBrowser, ['2026-09-30', '2026-10-01']);
  // the new code, by contrast, is timezone-proof
  for (const tz of TIMEZONES) {
    const r = inTimezone(tz, `function (L) { const t = L.todayLaos(new Date('2026-09-30T02:30:00Z')); const r = L.presetRange('today', t); return [r.start, r.endExclusive]; }`);
    assert.deepEqual(r, ['2026-09-30', '2026-10-01'], `TZ=${tz}`);
  }
});

// ── SQL <-> JS agreement on the timezone identifier ───────────────────────
test('agrees with the Intelligence pipeline (date-boundary.js) and the SQL migrations on the timezone literal', async () => {
  const fs = require('node:fs');
  const dateBoundary = await import(pathToFileURL(path.join(__dirname, '..', '..', 'supabase', 'functions', 'generate-intelligence-report', 'date-boundary.js')).href);
  assert.equal(LAOS.LAOS_TZ, dateBoundary.REPORT_TIMEZONE);
  for (const iso of PROBES.concat(['2026-02-28T17:00:00Z', '2028-02-28T17:00:00Z', '2026-06-15T05:00:00Z'])) {
    assert.equal(LAOS.laosDateString(new Date(iso)), dateBoundary.vientianeDateString(new Date(iso)), iso);
  }
  for (const [a, n] of [['2026-09-30', 1], ['2026-03-01', -1], ['2028-02-28', 1]]) {
    assert.equal(LAOS.addDays(a, n), dateBoundary.addDays(a, n));
  }
  for (const f of ['20260921030000_analytics_laos_calendar_days.sql', '20260921040000_analytics_history_and_lead_drilldown.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8').replace(/--.*$/gm, '');
    const zones = [...sql.matchAll(/AT TIME ZONE '([^']+)'/g)].map(m => m[1]);
    assert.ok(zones.length > 10, f + ' converts with AT TIME ZONE');
    assert.deepEqual([...new Set(zones)], [LAOS.LAOS_TZ], f + ' uses only ' + LAOS.LAOS_TZ);
    assert.ok(!/created_at::date|updated_at::date/.test(sql), f + ' has no bare ::date bucketing');
  }
});

test('the browser page and its helpers contain no toISOString()-based day maths', () => {
  const fs = require('node:fs');
  for (const f of ['analytics.js', 'analytics-core.js', 'laos-date.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // laos-date.js itself uses toISOString() only on a Date built as UTC midnight of a label
    // (pure calendar arithmetic); the page and core must never derive a day from an instant that way.
    if (f !== 'laos-date.js') assert.ok(!/\.toISOString\(\)\s*\.slice\(/.test(code), f + ' must not derive a day from toISOString().slice()');
    assert.ok(!/created_at=(gte|lt)\./.test(code), f + ' must not build client-side created_at instant filters');
    assert.ok(!/setHours\(0,\s*0,\s*0,\s*0\)/.test(code), f + ' must not compute local-midnight boundaries');
  }
});

// ── Laos wall-clock -> instant (Analytics Inspector's From/To filter) ─────
// <input type="datetime-local"> holds a timezone-naive 'YYYY-MM-DDTHH:mm'. It
// must mean Laos time on every machine; `new Date(value)` reads it in the
// BROWSER's zone, which is the Inspector bug this helper replaces.
test('laosWallClockToInstant: Laos midnight and end-of-day are the same instants in every runtime timezone', () => {
  const expected = {
    startOfDay: '2026-09-30T17:00:00.000Z',   // 2026-10-01T00:00 Laos
    lastMinute: '2026-10-01T16:59:00.000Z',   // 2026-10-01T23:59 Laos
    dateOnly: '2026-09-30T17:00:00.000Z',     // bare label == midnight
    withSeconds: '2026-10-01T16:59:59.000Z',
    boundaryBefore: '2026-09-30T16:59:00.000Z' // 2026-09-30T23:59 Laos
  };
  for (const tz of TIMEZONES) {
    const got = inTimezone(tz, `L => ({
      startOfDay: L.laosWallClockToInstant('2026-10-01T00:00'),
      lastMinute: L.laosWallClockToInstant('2026-10-01T23:59'),
      dateOnly: L.laosWallClockToInstant('2026-10-01'),
      withSeconds: L.laosWallClockToInstant('2026-10-01T23:59:59'),
      boundaryBefore: L.laosWallClockToInstant('2026-09-30T23:59')
    })`);
    assert.deepEqual(got, expected, 'TZ=' + tz);
  }
});
test('laosWallClockToInstant: round-trips through laosDateTimeString and crosses month/year/leap boundaries', () => {
  for (const tz of TIMEZONES) {
    const got = inTimezone(tz, `L => ['2026-12-31T23:59','2027-01-01T00:00','2028-02-29T12:30','2026-03-01T00:00'].map(w => {
      const iso = L.laosWallClockToInstant(w);
      return [w, iso, L.laosDateTimeString(iso)];
    })`);
    assert.deepEqual(got, [
      ['2026-12-31T23:59', '2026-12-31T16:59:00.000Z', '2026-12-31 23:59'],
      ['2027-01-01T00:00', '2026-12-31T17:00:00.000Z', '2027-01-01 00:00'],
      ['2028-02-29T12:30', '2028-02-29T05:30:00.000Z', '2028-02-29 12:30'],
      ['2026-03-01T00:00', '2026-02-28T17:00:00.000Z', '2026-03-01 00:00']
    ], 'TZ=' + tz);
  }
});
test('laosWallClockToInstant: rejects anything that is not a real wall-clock time (null, never a guess)', () => {
  for (const bad of ['', '   ', 'tomorrow', '2026-02-31', '2026-13-01', '2026-10-01T24:00', '2026-10-01T12:60', '2026-10-01T12:00Z', '2026-10-01T12:00+07:00', null, undefined, 20261001]) {
    assert.equal(LAOS.laosWallClockToInstant(bad), null, String(bad));
  }
});
