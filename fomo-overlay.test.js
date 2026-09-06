// FOMO photo overlay (Agoda-style scarcity treatment) — ptResolveFomoOverlay()
// (components.js) and getOverlayStatusWord() (listing-status.js).
//   node --test fomo-overlay.test.js
//
// This is a PRESENTATION layer only: which of two treatments (a full dark
// scrim + bold status word, or a scarcity ribbon) sits directly on a
// listing's photo, and what it says. Every decision is delegated to the
// existing resolvers (_ptIsUnavailableNow, ptResolveListingFomo) — this file
// pins that no new status logic was introduced and that nothing here can
// ever fabricate scarcity or suppress a price (price is a separate concern,
// covered by listing-card-price-availability.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { ptResolveFomoOverlay, getOverlayStatusWord, formatPropertyPrice, _ptIsUnavailableNow } = globalThis;

const property = (o) => Object.assign({
  transaction_type: 'for_rent', market_status: 'available', workflow_status: 'active',
  price_amount: 850, price_currency: 'USD', price_frequency: 'monthly',
  unit_types: [],
}, o);
const unit = (o) => Object.assign(
  { id: 'u1', name_en: 'Unit', is_available: true, available_count: 1, total_units: null }, o);

// ═══ The required scenarios ═════════════════════════════════════════════

test('available (plain listing, no unit types) → no overlay at all', () => {
  const p = property({ market_status: 'available' });
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

test('rented → JUST RENTED overlay, tone "unavailable"', () => {
  const p = property({ market_status: 'rented' });
  const overlay = ptResolveFomoOverlay(p, 'en');
  assert.deepEqual(overlay, { tone: 'unavailable', text: 'Just Rented' });
});

test('fully_occupied (market_status set directly, no unit types) → FULLY BOOKED overlay', () => {
  const p = property({ market_status: 'fully_occupied' });
  const overlay = ptResolveFomoOverlay(p, 'en');
  assert.deepEqual(overlay, { tone: 'unavailable', text: 'Fully Booked' });
});

test('sold → SOLD overlay', () => {
  const p = property({ market_status: 'sold' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Sold' });
});

test('reserved → RESERVED overlay', () => {
  const p = property({ market_status: 'reserved' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Reserved' });
});

test('off_market → OFF MARKET overlay (not one of the headline examples, but still a real unavailable status)', () => {
  const p = property({ market_status: 'off_market' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Off Market' });
});

test('multi-unit building, every unit type occupied (market_status untouched) → still FULLY BOOKED, via unit rows outranking market_status', () => {
  // Mirrors _ptIsUnavailableNow()'s own documented production shape: staff
  // toggle each unit's Available checkbox and never touch the separate
  // Market Status dropdown, which is left reading 'available'.
  const p = property({
    market_status: 'available',
    unit_types: [
      unit({ id: 'a', is_available: false, available_count: 0 }),
      unit({ id: 'b', is_available: false, available_count: 0 }),
    ],
  });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Fully Booked' });
});

test('PARTIAL multi-unit availability → NOT fully booked (2 of 10 open is real availability, not scarcity or unavailability)', () => {
  const units = [unit({ id: 'open1', is_available: true, available_count: 2, total_units: 10 })];
  for (let i = 0; i < 8; i++) units.push(unit({ id: 'occ' + i, is_available: false, available_count: 0 }));
  const p = property({ market_status: 'available', unit_types: units });
  const overlay = ptResolveFomoOverlay(p, 'en');
  // 2 of 10 is <= 25% -> a real, data-backed scarcity ribbon is legitimate
  // here (requirement #5), but it must never be the "unavailable" tone/word.
  assert.equal(overlay.tone, 'scarce');
  assert.notEqual(overlay.text, 'Fully Booked');
});

test('ONLY 1 UNIT LEFT → scarce-tone ribbon, backed by a real available_count, NOT the dark "unavailable" scrim', () => {
  const p = property({
    market_status: 'available',
    unit_types: [
      unit({ id: 'a', is_available: true, available_count: 1 }),
      unit({ id: 'b', is_available: false, available_count: 0 }),
    ],
  });
  const overlay = ptResolveFomoOverlay(p, 'en');
  assert.equal(overlay.tone, 'scarce');
  assert.match(overlay.text, /only 1 left/i);
});

test('NO FAKE SCARCITY: healthy availability (well above the 25% scarcity threshold) → no overlay at all', () => {
  const p = property({
    market_status: 'available',
    unit_types: [unit({ id: 'a', is_available: true, available_count: 8, total_units: 10 })],
  });
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

test('price remains visible for every unavailable overlay scenario (overlay never touches price)', () => {
  for (const status of ['reserved', 'rented', 'sold', 'fully_occupied', 'off_market']) {
    const p = property({ market_status: status });
    const overlay = ptResolveFomoOverlay(p, 'en');
    assert.equal(overlay.tone, 'unavailable', status);
    const price = formatPropertyPrice(p, 'en');
    assert.equal(price.isPriceOnRequest, false, status + ': price must still resolve');
    assert.equal(price.singleText, '$850', status);
  }
});

test('localization: Lao and Chinese overlay words exist and are not silently English (getOverlayStatusWord)', () => {
  assert.equal(getOverlayStatusWord('rented', 'lo'), 'ຫາກໍ່ຖືກເຊົ່າ');
  assert.equal(getOverlayStatusWord('sold', 'lo'), 'ຂາຍແລ້ວ');
  assert.equal(getOverlayStatusWord('reserved', 'lo'), 'ຖືກຈອງແລ້ວ');
  assert.equal(getOverlayStatusWord('fully_occupied', 'lo'), 'ເຕັມແລ້ວ');
  assert.equal(getOverlayStatusWord('rented', 'zh'), '刚被租出');
  // An unknown language code falls back to English, never throws/blank.
  assert.equal(getOverlayStatusWord('sold', 'xx'), 'Sold');
});

test('getOverlayStatusWord returns null for a status with no overlay word (e.g. "available") — callers must not fabricate one', () => {
  assert.equal(getOverlayStatusWord('available', 'en'), null);
  assert.equal(getOverlayStatusWord('coming_soon', 'en'), null);
});

test('an available listing with no unit inventory data at all gets no overlay (the honest default)', () => {
  const p = property({ market_status: 'available', unit_types: [] });
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

// ═══ REGRESSION: stale market_status must not survive a genuine unit-level ═══
// ═══ availability change (production bug — a reopened unit stayed dark) ═════
//
// admin.html's per-unit Available checkbox (saveUnitTypes()) writes ONLY the
// unit_types table; nothing anywhere keeps properties.market_status in sync
// with it. _ptIsUnavailableNow() must therefore treat unit rows as
// authoritative for occupancy-shaped statuses in BOTH directions — reopening
// a unit must clear a stale 'fully_occupied'/'rented'/'reserved', and closing
// every unit must produce 'fully_occupied' even while market_status still
// says 'available' (the pre-existing, already-correct direction).

test('REOPEN: market_status stuck on fully_occupied + the unit is closed → still unavailable (starting state)', () => {
  const p = property({
    market_status: 'fully_occupied',
    unit_types: [unit({ id: 'u1', is_available: false, available_count: 0 })],
  });
  // Both signals agree it's closed -- market_status's own reason is kept,
  // not downgraded to a generic unit-derived one (nothing to override yet).
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: true, market: 'fully_occupied', source: 'market_status' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Fully Booked' });
});

test('REOPEN: the SAME listing, only the unit flipped to available (market_status left untouched) → FOMO disappears, listing resolves available', () => {
  const p = property({
    market_status: 'fully_occupied',   // ← never touched by the unit save, exactly like production
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 2 })],
  });
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: false, market: 'fully_occupied', source: 'unit_types' });
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

test('CLOSE: market_status available + units available → no FOMO (starting state)', () => {
  const p = property({
    market_status: 'available',
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 3 })],
  });
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: false, market: 'available', source: 'unit_types' });
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

test('CLOSE: the SAME listing, the unit flipped to closed (market_status left untouched) → resolves fully_occupied, FOMO appears', () => {
  const p = property({
    market_status: 'available',   // ← never touched by the unit save
    unit_types: [unit({ id: 'u1', is_available: false, available_count: 0 })],
  });
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: true, market: 'fully_occupied', source: 'unit_types' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Fully Booked' });
});

test('a stale RESERVED market_status does not hide a listing that has a genuinely available unit', () => {
  const p = property({
    market_status: 'reserved',
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 1 })],
  });
  assert.equal(_ptIsUnavailableNow(p).unavailable, false);
  // Still a real scarcity signal (1 left), just never the dark "unavailable" scrim.
  const overlay = ptResolveFomoOverlay(p, 'en');
  assert.notEqual(overlay && overlay.tone, 'unavailable');
});

test('a stale RENTED market_status does not hide a listing that has a genuinely available unit', () => {
  const p = property({
    market_status: 'rented',
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 4 })],
  });
  assert.equal(_ptIsUnavailableNow(p).unavailable, false);
  assert.equal(ptResolveFomoOverlay(p, 'en'), null);
});

test('SOLD still overrides an available unit — a property-wide fact, never a per-unit one', () => {
  const p = property({
    market_status: 'sold',
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 4 })],
  });
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: true, market: 'sold', source: 'market_status' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Sold' });
});

test('OFF_MARKET still overrides an available unit — a property-wide fact, never a per-unit one', () => {
  const p = property({
    market_status: 'off_market',
    unit_types: [unit({ id: 'u1', is_available: true, available_count: 4 })],
  });
  assert.deepEqual(_ptIsUnavailableNow(p), { unavailable: true, market: 'off_market', source: 'market_status' });
  assert.deepEqual(ptResolveFomoOverlay(p, 'en'), { tone: 'unavailable', text: 'Off Market' });
});

test('a property with NO unit rows still respects market_status exactly as before (no unit data to consult)', () => {
  const rented = property({ market_status: 'rented', unit_types: [] });
  assert.deepEqual(_ptIsUnavailableNow(rented), { unavailable: true, market: 'rented', source: 'market_status' });

  const available = property({ market_status: 'available', unit_types: [] });
  assert.deepEqual(_ptIsUnavailableNow(available), { unavailable: false, market: 'available', source: null });
});
