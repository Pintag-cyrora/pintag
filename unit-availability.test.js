// Unit tests for unit-availability.js -- run with `node --test unit-availability.test.js`.
// Loaded into a vm sandbox, same rationale as rental-terms.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./unit-availability.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'unit-availability.js' });

const {
  resolveUnitAvailability, formatAvailabilityDisplay, formatAvailableUnitCount,
  getAvailabilityNoteLine, compareUnitTypesForDisplay, formatAvailabilityAdminSummary,
  formatMoveInDate
} = globalThis;

function unitType(overrides) {
  return Object.assign({ is_available: true, available_count: 0, total_units: null, next_available_date: null, availability_note: null }, overrides);
}

// ── Status derivation ────────────────────────────────────────────────────
test('status: available when count > 0', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 3 }));
  assert.equal(r.status, 'available');
});

test('status: fully_occupied when count = 0 and a date is known', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' }));
  assert.equal(r.status, 'fully_occupied');
});

test('status: temporarily_unavailable when count = 0 and no date', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 0 }));
  assert.equal(r.status, 'temporarily_unavailable');
});

test('status: coming_soon when is_available=false and total_units is set', () => {
  const r = resolveUnitAvailability(unitType({ is_available: false, available_count: 0, total_units: 8 }));
  assert.equal(r.status, 'coming_soon');
});

test('status: is_available=false with no total_units falls back to temporarily_unavailable', () => {
  const r = resolveUnitAvailability(unitType({ is_available: false, available_count: 0 }));
  assert.equal(r.status, 'temporarily_unavailable');
});

// ── Manual date overrides computed date (Phase 2 compatibility) ─────────
test('manual next_available_date wins over a computed date when both present', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' }), '2026-09-01');
  assert.equal(r.nextAvailableDate, '2026-08-15');
});

test('computed date is used as fallback when manual date is absent', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 0 }), '2026-09-01');
  assert.equal(r.nextAvailableDate, '2026-09-01');
  assert.equal(r.status, 'fully_occupied');
});

test('neither manual nor computed date present -> null, temporarily_unavailable', () => {
  const r = resolveUnitAvailability(unitType({ available_count: 0 }));
  assert.equal(r.nextAvailableDate, null);
  assert.equal(r.status, 'temporarily_unavailable');
});

// ── Purity ───────────────────────────────────────────────────────────────
test('resolveUnitAvailability: never mutates its input', () => {
  const ut = unitType({ available_count: 2, next_available_date: '2026-08-15' });
  const snapshot = JSON.stringify(ut);
  resolveUnitAvailability(ut, '2026-09-01');
  assert.equal(JSON.stringify(ut), snapshot);
});

// ── Public formatter: frozen 3-message contract ──────────────────────────
test('formatAvailabilityDisplay: available -> "Available Now"', () => {
  assert.equal(formatAvailabilityDisplay(resolveUnitAvailability(unitType({ available_count: 2 })), 'en'), 'Available Now');
});

test('formatAvailabilityDisplay: fully_occupied -> "Fully Occupied — Available from {date}"', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' }));
  assert.equal(formatAvailabilityDisplay(resolved, 'en'), 'Fully Occupied — Available from 15 Aug 2026');
});

test('formatAvailabilityDisplay: temporarily_unavailable -> "Currently Unavailable"', () => {
  assert.equal(formatAvailabilityDisplay(resolveUnitAvailability(unitType({ available_count: 0 })), 'en'), 'Currently Unavailable');
});

test('formatAvailabilityDisplay: coming_soon collapses into "Currently Unavailable" today', () => {
  const resolved = resolveUnitAvailability(unitType({ is_available: false, available_count: 0, total_units: 8 }));
  assert.equal(formatAvailabilityDisplay(resolved, 'en'), 'Currently Unavailable');
});

test('formatAvailableUnitCount: only plural, per the frozen contract', () => {
  assert.equal(formatAvailableUnitCount(resolveUnitAvailability(unitType({ available_count: 1 }))), null);
  assert.equal(formatAvailableUnitCount(resolveUnitAvailability(unitType({ available_count: 3 }))), 3);
  assert.equal(formatAvailableUnitCount(resolveUnitAvailability(unitType({ available_count: 0 }))), null);
});

// ── Note is always supplementary ─────────────────────────────────────────
test('note never appears inside formatAvailabilityDisplay output, only via getAvailabilityNoteLine', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15', availability_note: 'Renovation finishing next week.' }));
  assert.equal(formatAvailabilityDisplay(resolved, 'en').includes('Renovation'), false);
  assert.equal(getAvailabilityNoteLine(resolved), 'Renovation finishing next week.');
});

test('getAvailabilityNoteLine: null when no note set', () => {
  assert.equal(getAvailabilityNoteLine(resolveUnitAvailability(unitType({ available_count: 1 }))), null);
});

// ── formatMoveInDate: the standalone date, separate from the composed message ──
test('formatMoveInDate: returns the formatted date when one is resolved', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' }));
  assert.equal(formatMoveInDate(resolved, 'en'), '15 Aug 2026');
});

test('formatMoveInDate: null when no date is resolved', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 1 }));
  assert.equal(formatMoveInDate(resolved, 'en'), null);
});

// ── Admin summary includes total_units fraction; public formatter never does ──
test('formatAvailabilityAdminSummary: appends (available/total) when total_units is set', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 3, total_units: 12 }));
  assert.equal(formatAvailabilityAdminSummary(resolved), 'Available Now (3/12)');
});

test('formatAvailabilityAdminSummary: no fraction when total_units is unset', () => {
  const resolved = resolveUnitAvailability(unitType({ available_count: 3 }));
  assert.equal(formatAvailabilityAdminSummary(resolved), 'Available Now');
});

// ── Public listing ordering ──────────────────────────────────────────────
test('compareUnitTypesForDisplay: Available Now before Fully Occupied before Unavailable', () => {
  const items = [
    { resolved: resolveUnitAvailability(unitType({ available_count: 0 })), sort_order: 0 },              // unavailable
    { resolved: resolveUnitAvailability(unitType({ available_count: 2 })), sort_order: 1 },               // available
    { resolved: resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' })), sort_order: 2 } // occupied w/ date
  ];
  const sorted = items.slice().sort(compareUnitTypesForDisplay);
  assert.deepEqual(sorted.map(i => i.resolved.status), ['available', 'fully_occupied', 'temporarily_unavailable']);
});

test('compareUnitTypesForDisplay: within fully_occupied bucket, soonest date first', () => {
  const items = [
    { resolved: resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-12-01' })), sort_order: 0 },
    { resolved: resolveUnitAvailability(unitType({ available_count: 0, next_available_date: '2026-08-15' })), sort_order: 1 }
  ];
  const sorted = items.slice().sort(compareUnitTypesForDisplay);
  assert.equal(sorted[0].resolved.nextAvailableDate, '2026-08-15');
});

test('compareUnitTypesForDisplay: sort_order is the tiebreak within the same bucket/date', () => {
  const items = [
    { resolved: resolveUnitAvailability(unitType({ available_count: 3 })), sort_order: 5 },
    { resolved: resolveUnitAvailability(unitType({ available_count: 1 })), sort_order: 2 }
  ];
  const sorted = items.slice().sort(compareUnitTypesForDisplay);
  assert.equal(sorted[0].sort_order, 2);
});

test('compareUnitTypesForDisplay: unavailable unit types are still included, never dropped', () => {
  const items = [{ resolved: resolveUnitAvailability(unitType({ available_count: 0 })), sort_order: 0 }];
  const sorted = items.slice().sort(compareUnitTypesForDisplay);
  assert.equal(sorted.length, 1);
});
