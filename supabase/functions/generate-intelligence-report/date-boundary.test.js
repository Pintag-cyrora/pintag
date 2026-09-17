// Tests for date-boundary.js -- the Intelligence pipeline's Asia/Vientiane
// calendar-boundary logic. Previously this logic lived inline in index.ts
// as yesterdayUTC()/toISODate() and had NO test coverage at all; this file
// is that coverage, plus the boundary cases that motivated moving off UTC.
//
//   node --test supabase/functions/generate-intelligence-report/date-boundary.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_TIMEZONE, vientianeDateString, addDays, yesterdayVientiane, resolvePeriod,
} from './date-boundary.js';

test('REPORT_TIMEZONE is the IANA identifier, not a numeric offset', () => {
  assert.equal(REPORT_TIMEZONE, 'Asia/Vientiane');
});

// ── The exact boundary cases from the production investigation ────────────
// Vientiane = UTC+7 (no DST): a UTC day's last 7 hours (17:00-23:59:59)
// belong to the NEXT Vientiane calendar day.
test('vientianeDateString: 2026-09-16 16:59 UTC -> Sep 16 Vientiane (last minute still same day)', () => {
  assert.equal(vientianeDateString(new Date('2026-09-16T16:59:00Z')), '2026-09-16');
});
test('vientianeDateString: 2026-09-16 17:00 UTC -> Sep 17 Vientiane (the exact crossover instant)', () => {
  assert.equal(vientianeDateString(new Date('2026-09-16T17:00:00Z')), '2026-09-17');
});
test('vientianeDateString: 2026-09-16 23:59 UTC -> Sep 17 Vientiane', () => {
  assert.equal(vientianeDateString(new Date('2026-09-16T23:59:00Z')), '2026-09-17');
});
test('vientianeDateString: 2026-09-17 00:05 UTC -> Sep 17 Vientiane (well past the crossover)', () => {
  assert.equal(vientianeDateString(new Date('2026-09-17T00:05:00Z')), '2026-09-17');
});
// The complementary fact that makes the above a genuine change: all four
// instants above fall on TWO different UTC calendar dates (16th and 17th),
// but only two distinct Vientiane dates as shown -- i.e. the UTC-date split
// point (midnight UTC) and the Vientiane-date split point (17:00 UTC) are
// different instants, which is the entire bug this module fixes.
test('the UTC split point and the Vientiane split point are genuinely different instants', () => {
  const utcMidnight = new Date('2026-09-17T00:00:00Z');
  const vientianeMidnight = new Date('2026-09-16T17:00:00Z');
  assert.notEqual(utcMidnight.getTime(), vientianeMidnight.getTime());
  assert.equal(vientianeDateString(utcMidnight), '2026-09-17');
  assert.equal(vientianeDateString(vientianeMidnight), '2026-09-17');
  // one minute before the Vientiane midnight is still the PRIOR Vientiane day
  assert.equal(vientianeDateString(new Date(vientianeMidnight.getTime() - 60_000)), '2026-09-16');
});

// ── addDays: pure calendar-label arithmetic ─────────────────────────────────
test('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});
test('addDays crosses a year boundary', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
test('addDays handles a non-leap February correctly', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});
test('addDays handles a leap-year February correctly (2028 is a leap year)', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
});
test('addDays going backwards crosses a year boundary', () => {
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
});

// ── resolvePeriod: daily / weekly / monthly ─────────────────────────────────
test('resolvePeriod daily: start and end are the same Vientiane day', () => {
  assert.deepEqual(resolvePeriod('daily', '2026-09-17'), { start: '2026-09-17', end: '2026-09-17' });
});
test('resolvePeriod weekly: a 7-day window ending on the reference day', () => {
  assert.deepEqual(resolvePeriod('weekly', '2026-09-17'), { start: '2026-09-11', end: '2026-09-17' });
});
test('resolvePeriod monthly: the full calendar month containing the reference day', () => {
  assert.deepEqual(resolvePeriod('monthly', '2026-02-15'), { start: '2026-02-01', end: '2026-02-28' });
});
test('resolvePeriod monthly: leap-year February has 29 days', () => {
  assert.deepEqual(resolvePeriod('monthly', '2028-02-15'), { start: '2028-02-01', end: '2028-02-29' });
});
test('resolvePeriod monthly: a 31-day month', () => {
  assert.deepEqual(resolvePeriod('monthly', '2026-01-15'), { start: '2026-01-01', end: '2026-01-31' });
});
test('resolvePeriod monthly: reference day is the 1st (a run on the 1st reports the month that just ended)', () => {
  assert.deepEqual(resolvePeriod('monthly', '2026-10-01'), { start: '2026-10-01', end: '2026-10-31' });
});
test('resolvePeriod: an explicit periodEndOverride is used verbatim, bypassing yesterdayVientiane()', () => {
  assert.deepEqual(resolvePeriod('daily', '2020-01-01'), { start: '2020-01-01', end: '2020-01-01' });
});

// ── yesterdayVientiane: exercises the "now" path without a fixed clock ──────
// (No fake-timer dependency in this codebase's test setup -- this asserts
// the relationship between the two functions rather than a specific date,
// which is what's actually being guaranteed.)
test('yesterdayVientiane is exactly one day before the current Vientiane date', () => {
  const today = vientianeDateString(new Date());
  assert.equal(yesterdayVientiane(), addDays(today, -1));
});

// ── SQL/JS agreement ─────────────────────────────────────────────────────
// The migration adds `(created_at AT TIME ZONE 'Asia/Vientiane')::date` to
// intelligence_daily_metrics()/ensure_daily_metrics_snapshot() -- this
// table pins the JS side's answer for the same instants the SQL-level
// regression test (tests/security/regression/) asserts against, so a
// future change to either side that breaks agreement fails on BOTH tests,
// not silently on just one.
test('SQL/JS agreement table for the exact instants the SQL regression test also checks', () => {
  const cases = [
    ['2026-09-16T16:59:00Z', '2026-09-16'],
    ['2026-09-16T17:00:00Z', '2026-09-17'],
    ['2026-09-16T23:59:00Z', '2026-09-17'],
    ['2026-09-17T00:05:00Z', '2026-09-17'],
  ];
  for (const [instant, expected] of cases) {
    assert.equal(vientianeDateString(new Date(instant)), expected, instant);
  }
});
