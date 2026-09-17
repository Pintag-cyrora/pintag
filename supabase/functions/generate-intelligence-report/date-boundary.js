// date-boundary.js — the ONE place the Intelligence pipeline decides what
// calendar day an instant belongs to for reporting purposes.
//
// Pintag is a Laos-based business; "today"/"yesterday" in a Daily
// Intelligence Report should mean the Asia/Vientiane calendar day, not the
// UTC calendar day. Before this module existed, index.ts derived every
// boundary via toISOString() (always UTC) -- confirmed against production
// to shift a material fraction of each day's ui_events into the adjacent
// UTC day relative to Vientiane's own clock (e.g. 2026-09-16: 517 rows
// landed on the same calendar day under both conventions, 146 did not).
//
// REPORT_TIMEZONE is the single source of truth for that calendar --
// matched, deliberately and literally, by the `AT TIME ZONE 'Asia/Vientiane'`
// conversions added to intelligence_daily_metrics()/
// ensure_daily_metrics_snapshot() in
// 20260918000000_intelligence_vientiane_calendar.sql. The two must never
// drift independently; if this identifier ever changes, that migration's
// literal needs to change with it.
//
// No hardcoded numeric offset anywhere: Intl.DateTimeFormat resolves the
// real IANA rule for the zone (Laos has no DST, but this stays correct
// even if that were ever untrue, and stays self-documenting either way).
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js/metrics-utils.js/trend-calculator.js in this directory.

export const REPORT_TIMEZONE = 'Asia/Vientiane';

// instant -> the REPORT_TIMEZONE calendar-date label ('YYYY-MM-DD') it
// falls on. The only function in this module that converts a real instant
// into a calendar date; everything below operates on already-resolved
// date-only labels.
export function vientianeDateString(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Adds/subtracts whole calendar days to/from an already-resolved date-only
// label. This is pure Y-M-D arithmetic, not an instant conversion -- once a
// label exists, shifting it by N days needs no timezone at all, so parsing
// it as UTC midnight purely as a calculation aid (never converted back
// through a timezone) is safe and matches the technique already used
// elsewhere in this codebase for date-label math.
export function addDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function yesterdayVientiane() {
  return addDays(vientianeDateString(new Date()), -1);
}

// Day 0 of month `month1based` (1-12) rolls back to the last day of the
// PREVIOUS month -- a standard, timezone-agnostic idiom for "how many days
// does this month have". Only ever used as a pure calendar calculator here;
// the Date it returns is never read back as an instant.
function lastDayOfMonth(year, month1based) {
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

export function resolvePeriod(reportType, periodEndOverride) {
  if (reportType === 'daily') {
    const end = periodEndOverride || yesterdayVientiane();
    return { start: end, end };
  }
  if (reportType === 'weekly') {
    const end = periodEndOverride || yesterdayVientiane();
    return { start: addDays(end, -6), end };
  }
  // monthly: the full Vientiane calendar month containing the reference
  // date (defaults to yesterday, so a run on the 1st reports the month
  // that just ended). Computed entirely from the reference label's own
  // year/month -- no re-parsing of the label as an instant, so no second
  // timezone conversion is needed here.
  const ref = periodEndOverride || yesterdayVientiane();
  const [y, m] = ref.split('-').map(Number); // m is 1-12
  const mm = String(m).padStart(2, '0');
  const start = `${y}-${mm}-01`;
  const end = `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`;
  return { start, end };
}
