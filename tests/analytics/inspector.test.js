// analytics-inspector.html — Asia/Vientiane calendar days, whatever the browser's timezone.
//
//   node --test tests/analytics/inspector.test.js
//
// The bug this guards: the Inspector's From/To filter did
// `new Date(input.value).toISOString()`. A <input type="datetime-local"> value
// is a timezone-NAIVE wall-clock string, and `new Date()` reads it in the
// BROWSER's zone — so "2026-10-01T00:00" queried 17:00Z the day before for a
// Laos admin, 07:00Z for one in Los Angeles, and 10:00Z the day before for one
// in Kiritimati, while Full Analytics and the Intelligence report always use
// Asia/Vientiane days. Row times were also rendered in the browser's zone.
//
// These tests lift the REAL functions out of analytics-inspector.html and run
// them in child processes with TZ set to UTC, Asia/Vientiane, America/Los_Angeles
// and Pacific/Kiritimati (UTC+14), requiring identical output in all of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'analytics-inspector.html'), 'utf8');
const LAOS_MODULE = path.join(ROOT, 'laos-date.js');
const TIMEZONES = ['UTC', 'Asia/Vientiane', 'America/Los_Angeles', 'Pacific/Kiritimati'];

// Source of a top-level `function name(...) { ... }` / `async function name` from the page.
function extractFunction(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  assert.ok(m, 'function ' + name + ' not found in analytics-inspector.html');
  let i = HTML.indexOf('{', m.index), depth = 0;
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) return HTML.slice(m.index, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// Run `body` inside a sandbox holding the page's real date helpers, with TZ set.
// `body` is an async function source taking ({ fetchRecentRows, fmtTime, fmtDateTime, calls }).
function inPage(tz, body, now) {
  const script = `
    const vm = require('node:vm');
    const calls = [];
    const sandbox = { PT_LAOS_DATE: require(${JSON.stringify(LAOS_MODULE)}), console, encodeURIComponent, Intl, Date, Error, Promise,
      sbGet: async (p) => { calls.push(p); return []; } };
    vm.createContext(sandbox);
    vm.runInContext(${JSON.stringify(['var LATEST_RECENT_LIMIT = 300;', ...['laosInstant', 'fetchRecentRows', 'fmtTime', 'fmtDateTime'].map(extractFunction)].join('\n'))}, sandbox);
    sandbox.calls = calls;
    (async () => {
      const out = await (${body})(sandbox);
      process.stdout.write(JSON.stringify(out));
    })().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, `child failed under TZ=${tz}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ── static guards ────────────────────────────────────────────────────────
test('the page loads the shared laos-date.js before its inline script', () => {
  const lib = HTML.indexOf('src="laos-date.js');
  assert.ok(lib > 0, 'laos-date.js is not loaded');
  assert.ok(lib < HTML.indexOf('async function fetchRecentRows'), 'laos-date.js must load before the inline script');
});
test('no browser-local Date parsing of the filter inputs remains', () => {
  assert.doesNotMatch(HTML, /new Date\(\s*date(From|To)\s*\)/);
  assert.doesNotMatch(HTML, /new Date\(\s*(from|to)\s*\)/);
  // every locale formatter that renders a row time is pinned to Laos time
  for (const fn of ['fmtTime', 'fmtDateTime']) assert.match(extractFunction(fn), /timeZone:\s*PT_LAOS_DATE\.LAOS_TZ/, fn);
});

// ── date filter -> PostgREST bounds ──────────────────────────────────────
test('From/To filter sends Laos-day instants, identical in every browser timezone', () => {
  // Explicit selected date: all of 2026-10-01 in Laos == [2026-09-30T17:00Z, 2026-10-01T16:59Z].
  for (const tz of TIMEZONES) {
    const got = inPage(tz, `async (p) => {
      await p.fetchRecentRows('ui_events', '2026-10-01T00:00', '2026-10-01T23:59');
      return p.calls.map(decodeURIComponent);
    }`);
    assert.deepEqual(got, [
      'ui_events?select=session_id,created_at&order=created_at.desc&created_at=gte.2026-09-30T17:00:00.000Z&created_at=lte.2026-10-01T16:59:00.000Z&limit=1000'
    ], 'TZ=' + tz);
  }
});
test('Laos "today" boundary: the filter for today\'s Laos date starts at 17:00Z the day before, in every timezone', () => {
  // 2026-09-30T20:00Z is already 2026-10-01 03:00 in Laos, but still 09-30 in UTC/LA
  // and 10-01 10:00 in Kiritimati. "Today" must be the LAOS date, 2026-10-01.
  for (const tz of TIMEZONES) {
    const got = inPage(tz, `async (p) => {
      const L = p.PT_LAOS_DATE;
      const now = new Date('2026-09-30T20:00:00Z');
      const today = L.todayLaos(now);
      await p.fetchRecentRows('ui_events', today + 'T00:00', L.addDays(today, 1) + 'T00:00');
      return { today, from: decodeURIComponent(p.calls[0].match(/created_at=gte\\.([^&]+)/)[1]), to: decodeURIComponent(p.calls[0].match(/created_at=lte\\.([^&]+)/)[1]) };
    }`);
    assert.deepEqual(got, { today: '2026-10-01', from: '2026-09-30T17:00:00.000Z', to: '2026-10-01T17:00:00.000Z' }, 'TZ=' + tz);
  }
  // and 16:59:59Z is still Laos 09-30
  for (const tz of TIMEZONES) {
    const today = inPage(tz, `async (p) => p.PT_LAOS_DATE.todayLaos(new Date('2026-09-30T16:59:59Z'))`);
    assert.equal(today, '2026-09-30', 'TZ=' + tz);
  }
});
test('open-ended ranges and the unfiltered view are unchanged', () => {
  for (const tz of TIMEZONES) {
    const got = inPage(tz, `async (p) => {
      await p.fetchRecentRows('lead_events', '2026-10-01T09:30', null);
      await p.fetchRecentRows('lead_events', null, '2026-10-01T09:30');
      await p.fetchRecentRows('lead_events', null, null);
      return p.calls.map(decodeURIComponent);
    }`);
    assert.deepEqual(got, [
      'lead_events?select=session_id,created_at&order=created_at.desc&created_at=gte.2026-10-01T02:30:00.000Z&limit=1000',
      'lead_events?select=session_id,created_at&order=created_at.desc&created_at=lte.2026-10-01T02:30:00.000Z&limit=1000',
      'lead_events?select=session_id,created_at&order=created_at.desc&limit=300'
    ], 'TZ=' + tz);
  }
});
test('an invalid From/To value fails loudly instead of silently dropping the filter', () => {
  for (const tz of TIMEZONES) {
    const got = inPage(tz, `async (p) => {
      try { await p.fetchRecentRows('ui_events', 'garbage', null); return 'no error'; } catch (e) { return e.message; }
    }`);
    assert.match(got, /Invalid date\/time/, 'TZ=' + tz);
  }
});

// ── display ──────────────────────────────────────────────────────────────
test('row times render as Laos wall clock, not the browser zone', () => {
  // 2026-09-30T20:15:30Z == 2026-10-01 03:15:30 in Laos.
  for (const tz of TIMEZONES) {
    const got = inPage(tz, `async (p) => ({ t: p.fmtTime('2026-09-30T20:15:30Z'), dt: p.fmtDateTime('2026-09-30T20:15:30Z') })`);
    assert.equal(got.t, '03:15:30', 'TZ=' + tz);
    assert.match(got.dt, /Oct\s+1.*03:15|1\s+Oct.*03:15/, 'TZ=' + tz + ' got ' + got.dt);
  }
});
