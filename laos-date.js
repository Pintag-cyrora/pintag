// laos-date.js — Asia/Vientiane calendar-day arithmetic for the Admin Analytics
// page. The ONE place the browser decides what calendar day an instant belongs
// to, and how a date range is expressed.
//
// WHY THIS EXISTS. analytics.js used to build ranges from browser-local `Date`
// objects and send `d.toISOString().slice(0, 10)`. toISOString() is always UTC,
// so in a UTC+7 browser "local midnight" (00:00+07) is the PREVIOUS UTC date:
// "Today" queried yesterday, and the same page's range label read "09-29 → 09-29"
// on 09-30. The result also depended on whichever timezone the admin's laptop
// happened to be set to.
//
// The fix: a range is two plain calendar-date LABELS ('YYYY-MM-DD') — never a
// Date, never an instant. "Today" is resolved through Intl in Asia/Vientiane
// (the same REPORT_TIMEZONE the Intelligence pipeline uses, see
// supabase/functions/generate-intelligence-report/date-boundary.js), and all
// later arithmetic is pure Y-M-D math. The labels are sent to the analytics_*
// RPCs, which convert them to instants server-side with
// `(p_start::timestamp AT TIME ZONE 'Asia/Vientiane')`
// (supabase/migrations/20260921030000_analytics_laos_calendar_days.sql), so the
// browser's timezone can no longer influence any boundary.
//
// The 'Asia/Vientiane' literal here must always match those SQL literals and
// REPORT_TIMEZONE; tests/analytics/laos-date.test.js asserts the JS side agrees
// with date-boundary.js, and the SQL regression greps the SQL side.
//
// Dual-runtime (classic <script> in the browser -> window.PT_LAOS_DATE, and
// require() from node --test), like charts.js's sibling helpers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PT_LAOS_DATE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LAOS_TZ = 'Asia/Vientiane';
  var LABEL_RE = /^\d{4}-\d{2}-\d{2}$/;

  // instant -> the Asia/Vientiane calendar-date label it falls on.
  function laosDateString(date) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: LAOS_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    var get = function (t) { return parts.filter(function (p) { return p.type === t; })[0].value; };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  // instant -> 'YYYY-MM-DD HH:mm' wall-clock time in Laos. Accepts an ISO
  // string exactly as PostgREST returns it (offset included).
  function laosDateTimeString(input) {
    var d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: LAOS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d);
    var get = function (t) { return parts.filter(function (p) { return p.type === t; })[0].value; };
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  }

  // Laos wall-clock -> UTC instant. `wall` is a timezone-NAIVE 'YYYY-MM-DD',
  // 'YYYY-MM-DDTHH:mm' or 'YYYY-MM-DDTHH:mm:ss' (what <input type="datetime-local">
  // holds), interpreted as Asia/Vientiane time. Returns the ISO-8601 UTC string
  // (what PostgREST filters take), or null when `wall` is not a real date/time.
  // Never goes through the runtime timezone: `new Date('2026-05-04T00:00')`
  // would read the string in the BROWSER's zone, so the same selection would
  // mean different instants on different machines.
  var WALL_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  function laosWallClockToInstant(wall) {
    var m = typeof wall === 'string' ? WALL_RE.exec(wall.trim()) : null;
    if (!m || !isLabel(m[1])) return null;
    var h = m[2] === undefined ? 0 : +m[2], mi = m[3] === undefined ? 0 : +m[3], se = m[4] === undefined ? 0 : +m[4];
    if (h > 23 || mi > 59 || se > 59) return null;
    // Treat the wall-clock fields as if they were UTC, then subtract the zone's
    // offset at that point (derived from Intl, not hardcoded; Laos has no DST,
    // so one pass is exact, a second pass keeps it correct for any zone).
    var asUtc = Date.parse(m[1] + 'T00:00:00Z') + ((h * 60 + mi) * 60 + se) * 1000;
    var offset = function (ms) {
      var local = laosDateTimeString(new Date(ms)); // 'YYYY-MM-DD HH:mm'
      var utcMin = Math.floor(ms / 60000) * 60000;
      return Date.parse(local.replace(' ', 'T') + ':00Z') - utcMin;
    };
    var guess = asUtc - offset(asUtc);
    guess = asUtc - offset(guess);
    return new Date(guess).toISOString();
  }

  function isLabel(s) {
    if (typeof s !== 'string' || !LABEL_RE.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-31
  }

  // Pure calendar arithmetic on a label. Parsing as UTC midnight is only a
  // calculation aid and is never converted back through a timezone.
  function addDays(label, delta) {
    var d = new Date(label + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  function diffDays(fromLabel, toLabel) {
    return Math.round((Date.parse(toLabel + 'T00:00:00Z') - Date.parse(fromLabel + 'T00:00:00Z')) / 86400000);
  }
  function todayLaos(now) { return laosDateString(now || new Date()); }

  var PRESET_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

  function rangeLabel(preset, start, endExclusive) {
    var last = addDays(endExclusive, -1);
    var span = diffDays(start, endExclusive);
    var name = preset === 'today' ? 'Today'
      : preset === 'all' ? 'All time'
      : preset === 'custom' ? 'Custom range'
      : 'Last ' + span + ' days';
    return { name: name, text: start === last ? start : start + ' → ' + last, days: span };
  }

  // Presets are anchored on today's LAOS date; endExclusive is tomorrow's
  // label (the RPC contract: p_end is the day AFTER the last included day).
  // `earliest` (from analytics_history_bounds) is only used by 'all'.
  function presetRange(preset, today, earliest) {
    var endExclusive = addDays(today, 1);
    var start;
    if (preset === 'all') {
      start = isLabel(earliest) && earliest <= today ? earliest : today;
    } else {
      var days = PRESET_DAYS[preset] || 7;
      start = addDays(endExclusive, -days);
      preset = PRESET_DAYS[preset] ? preset : '7d';
    }
    var l = rangeLabel(preset, start, endExclusive);
    return { preset: preset, start: start, endExclusive: endExclusive, label: l.name, text: l.text, days: l.days };
  }

  // Custom range from two INCLUSIVE calendar dates (what a date input holds).
  // Returns {error} instead of throwing so the UI can show the reason.
  function customRange(fromLabel, toInclusiveLabel, today) {
    if (!isLabel(fromLabel) || !isLabel(toInclusiveLabel)) return { error: 'invalid', message: 'Enter both dates as YYYY-MM-DD.' };
    if (fromLabel > toInclusiveLabel) return { error: 'inverted', message: 'The start date is after the end date.' };
    if (today && toInclusiveLabel > today) return { error: 'future', message: 'The end date cannot be after today (' + today + ', Laos time).' };
    var endExclusive = addDays(toInclusiveLabel, 1);
    var l = rangeLabel('custom', fromLabel, endExclusive);
    return { preset: 'custom', start: fromLabel, endExclusive: endExclusive, label: l.name, text: l.text, days: l.days };
  }

  // The equal-length span immediately before `range`. null for All time (there
  // is nothing before the first day of data to compare against).
  function compareRange(range, earliest) {
    if (!range || range.preset === 'all') return null;
    var len = diffDays(range.start, range.endExclusive);
    var r = { start: addDays(range.start, -len), endExclusive: range.start };
    r.beforeData = isLabel(earliest) ? r.endExclusive <= earliest : false; // entirely before any data
    return r;
  }

  // Split [start, endExclusive) into contiguous windows of <= maxDays each.
  function chunkRanges(start, endExclusive, maxDays) {
    var out = [];
    if (!(maxDays >= 1)) throw new Error('maxDays must be >= 1');
    var cur = start;
    while (cur < endExclusive) {
      var next = addDays(cur, maxDays);
      if (next > endExclusive) next = endExclusive;
      out.push({ start: cur, endExclusive: next });
      cur = next;
    }
    return out;
  }

  // x-axis labels for a list of day labels: 'MM-DD' inside one calendar year,
  // 'YY-MM-DD' once the series crosses a year boundary (an all-time chart).
  function axisLabels(days) {
    if (!days.length) return [];
    var crossesYear = days[0].slice(0, 4) !== days[days.length - 1].slice(0, 4);
    return days.map(function (d) { return crossesYear ? d.slice(2) : d.slice(5); });
  }

  return {
    LAOS_TZ: LAOS_TZ, PRESET_DAYS: PRESET_DAYS,
    laosDateString: laosDateString, laosDateTimeString: laosDateTimeString,
    laosWallClockToInstant: laosWallClockToInstant,
    isLabel: isLabel, addDays: addDays, diffDays: diffDays, todayLaos: todayLaos,
    presetRange: presetRange, customRange: customRange, compareRange: compareRange,
    chunkRanges: chunkRanges, axisLabels: axisLabels, rangeLabel: rangeLabel
  };
});
