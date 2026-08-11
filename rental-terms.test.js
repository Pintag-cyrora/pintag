// Unit tests for rental-terms.js -- run with `node --test rental-terms.test.js`.
// rental-terms.js is a plain-global-var browser script (same convention as
// terminology.js/amenities.js, no module exports), so it's loaded into a
// vm sandbox here rather than via `import` -- this also directly exercises
// the "portable, dependency-free" claim in its own header comment, since a
// bare vm context has no `document`/`window` at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// vm.runInThisContext (not vm.createContext, which creates a separate V8
// realm with its own Object/Array prototypes -- that makes assert.deepEqual
// spuriously fail comparing sandbox-created plain objects against this
// file's own literals, even when the data is identical) runs the script
// against the real global context, so `var` declarations land on
// globalThis with the same prototypes as everything in this test file.
const currencySrc = fs.readFileSync(new URL('./currency.js', import.meta.url), 'utf8');
vm.runInThisContext(currencySrc, { filename: 'currency.js' });
const src = fs.readFileSync(new URL('./rental-terms.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'rental-terms.js' });

const {
  resolveRentalTerms, _normalizeRentalTermsBlob, buildRentalTermsPayload,
  formatRentalTermValue, summarizeRentalTermOverrides, RENTAL_TERMS_FIELDS,
  RENTAL_TERMS_SCHEMA_VERSION, RENTAL_LEASE_LENGTH_OPTIONS
} = globalThis;

function property(rental_terms) { return { id: 'p1', rental_terms }; }
function unitType(overrides) { return { id: 'u1', rental_terms_overrides: overrides }; }

// ── Contract shape ──────────────────────────────────────────────────────
test('resolveRentalTerms: frozen contract shape', () => {
  const r = resolveRentalTerms(property({ version: 1, deposit: { type: 'months_of_rent', value: 2 } }), unitType({ version: 1 }));
  assert.deepEqual(Object.keys(r).sort(), ['overriddenKeys', 'values', 'version']);
  assert.equal(r.version, RENTAL_TERMS_SCHEMA_VERSION);
});

test('resolveRentalTerms: version key never leaks into values', () => {
  const r = resolveRentalTerms(property({ version: 1, deposit: 'x' }), unitType({ version: 1 }));
  assert.equal('version' in r.values, false);
});

// ── Property-type coverage (regression: NOT apartment/condo-only) ─────────
// Rental Terms are gated on transaction_type (isRentalTransactionType), never
// property_type -- resolveRentalTerms() doesn't even take property_type as an
// input. These tests pin that guarantee for the property types the extension
// explicitly calls out (townhouse + house + villa), so a future change that
// tries to restrict terms to apartment/condo would fail here. Every rental
// property type must resolve lease_length and security deposit identically.
function typedProperty(propertyType, rental_terms) {
  return { id: 'p1', property_type: propertyType, rental_terms };
}
['townhouse', 'house', 'villa', 'apartment', 'condo'].forEach(function (ptype) {
  test('resolveRentalTerms: full lease_length + deposit for ' + ptype + ' (no property-type gate)', () => {
    const prop = typedProperty(ptype, {
      version: 1,
      lease_length: '12_months',
      deposit: { type: 'months_of_rent', value: 2 }
    });
    const r = resolveRentalTerms(prop, null);
    assert.equal(r.values.lease_length, '12_months');
    assert.deepEqual(r.values.deposit, { type: 'months_of_rent', value: 2 });
    // The resolved facts format identically regardless of property type.
    assert.equal(formatRentalTermValue('lease_length', r.values.lease_length, 'en'), 'Lease Length: 12 Months');
    assert.equal(formatRentalTermValue('deposit', r.values.deposit, 'en'), "Security Deposit: 2 months' rent");
  });
});

// ── Inheritance / merge ─────────────────────────────────────────────────
test('resolveRentalTerms: building-only, no unit type (single-unit property)', () => {
  const r = resolveRentalTerms(property({ version: 1, electricity: { type: 'included' } }), null);
  assert.deepEqual(r.values, { electricity: { type: 'included' } });
  assert.deepEqual(r.overriddenKeys, []);
});

test('resolveRentalTerms: unit override wins per-key, other keys inherit', () => {
  const prop = property({ version: 1, deposit: { type: 'months_of_rent', value: 2 }, laundry: 'included' });
  const ut = unitType({ version: 1, deposit: { type: 'months_of_rent', value: 1 } });
  const r = resolveRentalTerms(prop, ut);
  assert.equal(r.values.deposit.value, 1);   // overridden
  assert.equal(r.values.laundry, 'included'); // inherited
  assert.deepEqual(r.overriddenKeys, ['deposit']);
});

test('resolveRentalTerms: empty overrides means fully inherited', () => {
  const prop = property({ version: 1, laundry: 'included' });
  const r = resolveRentalTerms(prop, unitType({ version: 1 }));
  assert.deepEqual(r.overriddenKeys, []);
  assert.equal(r.values.laundry, 'included');
});

test('resolveRentalTerms: missing rental_terms/overrides entirely (pre-migration-default rows)', () => {
  const r = resolveRentalTerms({ id: 'p1' }, { id: 'u1' });
  assert.deepEqual(r.values, {});
  assert.deepEqual(r.overriddenKeys, []);
});

// ── Purity ───────────────────────────────────────────────────────────────
test('resolveRentalTerms: never mutates its inputs', () => {
  const prop = property({ version: 1, deposit: { type: 'months_of_rent', value: 2 } });
  const ut = unitType({ version: 1, laundry: 'included' });
  const propSnapshot = JSON.stringify(prop);
  const utSnapshot = JSON.stringify(ut);
  resolveRentalTerms(prop, ut);
  assert.equal(JSON.stringify(prop), propSnapshot);
  assert.equal(JSON.stringify(ut), utSnapshot);
});

test('_normalizeRentalTermsBlob: returns a fresh object, does not mutate raw', () => {
  const raw = { version: 1, laundry: 'included' };
  const normalized = _normalizeRentalTermsBlob(raw);
  normalized.laundry = 'changed';
  assert.equal(raw.laundry, 'included'); // original untouched
  assert.equal('version' in normalized, false);
});

// ── Write path ───────────────────────────────────────────────────────────
test('buildRentalTermsPayload: stamps current schema version', () => {
  const payload = buildRentalTermsPayload({ laundry: 'included' });
  assert.equal(payload.version, RENTAL_TERMS_SCHEMA_VERSION);
  assert.equal(payload.laundry, 'included');
});

// ── Registry-driven extensibility proof (rule 4) ────────────────────────
test('formatRentalTermValue: works for a synthetic new field added only to the registry, using an existing kind', () => {
  // Simulates "add a field that fits an existing kind" -- no resolver/
  // formatter code change, just a new registry entry, exactly as the
  // architectural rule promises.
  RENTAL_TERMS_FIELDS.push({
    key: 'test_synthetic_field', kind: 'select', group: 'services',
    label: { en: 'Synthetic Field' },
    options: [{ value: 'yes', label: { en: 'Yes' } }, { value: 'no', label: { en: 'No' } }]
  });
  const line = formatRentalTermValue('test_synthetic_field', 'yes', 'en');
  assert.equal(line, 'Synthetic Field: Yes');
  RENTAL_TERMS_FIELDS.pop(); // clean up
});

// Updated for the money/duration fix: "2 Months" was ambiguous enough to
// read as a lease duration on a monetary field, and a bare "500" carried no
// currency at all. Both now render unambiguously -- see the regression block
// at the end of this file.
test('formatRentalTermValue: money_multiplier formats rent multiplier vs fixed amount', () => {
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 2 }, 'en'), "Security Deposit: 2 months' rent");
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 1 }, 'en'), "Security Deposit: 1 month's rent");
  assert.equal(formatRentalTermValue('deposit', { type: 'fixed_amount', value: 500 }, 'en'), 'Security Deposit: $500');
});

test('formatRentalTermValue: returns null for absent/empty values', () => {
  assert.equal(formatRentalTermValue('deposit', undefined, 'en'), null);
  assert.equal(formatRentalTermValue('included_services', [], 'en'), null);
  assert.equal(formatRentalTermValue('unknown_field', 'x', 'en'), null);
});

// ── Collapsed summary ────────────────────────────────────────────────────
test('summarizeRentalTermOverrides: registry order, not insertion order', () => {
  // additional_fees is declared after deposit in RENTAL_TERMS_FIELDS --
  // pass overrides in the opposite order and confirm output still follows
  // registry order.
  const values = {
    additional_fees: [{ label: 'Sauna', amount: '20', frequency: 'monthly' }],
    deposit: { type: 'months_of_rent', value: 1 }
  };
  const lines = summarizeRentalTermOverrides(['additional_fees', 'deposit'], values, 'en', 5);
  assert.equal(lines[0].startsWith('Security Deposit'), true);
  assert.equal(lines[1].startsWith('Additional Fees'), true);
});

test('summarizeRentalTermOverrides: truncates with "+N more"', () => {
  const overriddenKeys = ['deposit', 'advance_rent', 'electricity', 'water', 'internet'];
  const values = {
    deposit: { type: 'months_of_rent', value: 1 },
    advance_rent: { type: 'months_of_rent', value: 1 },
    electricity: { type: 'included' },
    water: { type: 'metered' },
    internet: { type: 'included' }
  };
  const lines = summarizeRentalTermOverrides(overriddenKeys, values, 'en', 3);
  assert.equal(lines.length, 4); // 3 shown + 1 "+N more"
  assert.equal(lines[3], '+2 more');
});

// ---------------------------------------------------------------------------
// Money vs. rent-multiplier formatting. Regression cover for the production
// bug where a deposit of $100 rendered as "Deposit: 100 Months" -- the old
// money_multiplier formatter special-cased 'fixed_amount' and let every
// other case (including a missing type) fall through to a "N Months"
// branch, so a monetary value rendered as a duration.
// ---------------------------------------------------------------------------

test('deposit: fixed_amount renders a currency symbol, never a duration', () => {
  const out = formatRentalTermValue('deposit', { type: 'fixed_amount', value: 100, currency: 'USD' }, 'en');
  assert.equal(out, 'Security Deposit: $100');
  assert.ok(!/month/i.test(out));
});

test('deposit: honours LAK and THB currencies', () => {
  assert.equal(formatRentalTermValue('deposit', { type: 'fixed_amount', value: 2500000, currency: 'LAK' }, 'en'), 'Security Deposit: ₭2,500,000');
  assert.equal(formatRentalTermValue('deposit', { type: 'fixed_amount', value: 5000, currency: 'THB' }, 'en'), 'Security Deposit: ฿5,000');
});

test('deposit: MISSING type falls back to money, not months (the actual bug)', () => {
  const out = formatRentalTermValue('deposit', { value: 100 }, 'en');
  assert.equal(out, 'Security Deposit: $100');
  assert.ok(!/month/i.test(out), 'a monetary field must never render as a duration');
});

test('deposit: unrecognized type also falls back to money', () => {
  const out = formatRentalTermValue('deposit', { type: 'wat', value: 100 }, 'en');
  assert.ok(!/month/i.test(out));
  assert.equal(out, 'Security Deposit: $100');
});

test('deposit: months_of_rent stays available but reads as a rent multiplier', () => {
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 2 }, 'en'), "Security Deposit: 2 months' rent");
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 1 }, 'en'), "Security Deposit: 1 month's rent");
});

test('deposit: rent multiplier is localized', () => {
  assert.ok(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 2 }, 'lo').includes('ເດືອນຄ່າເຊົ່າ'));
  assert.ok(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 2 }, 'zh').includes('个月租金'));
});

test('advance_rent: same money-first rule as deposit', () => {
  assert.equal(formatRentalTermValue('advance_rent', { value: 300 }, 'en'), 'Advance Rent: $300');
  assert.equal(formatRentalTermValue('advance_rent', { type: 'months_of_rent', value: 1 }, 'en'), "Advance Rent: 1 month's rent");
});

test('additional_fees: single fee shows its amount, not just the label', () => {
  const out = formatRentalTermValue('additional_fees', [{ label: 'Cleaning', amount: '$50', frequency: 'one_time' }], 'en');
  assert.equal(out, 'Additional Fees: Cleaning: $50');
});

test('additional_fees: multi-fee count is localized', () => {
  const fees = [{ label: 'A', amount: '$1' }, { label: 'B', amount: '$2' }];
  assert.equal(formatRentalTermValue('additional_fees', fees, 'en'), 'Additional Fees: 2 fees');
  assert.ok(formatRentalTermValue('additional_fees', fees, 'zh').includes('项费用'));
});

test('duration-style fields still render their own units', () => {
  assert.equal(formatRentalTermValue('lease_length', '12_months', 'en'), 'Lease Length: 12 Months');
});

// ── Lease Length: "3 months" was missing from RENTAL_LEASE_LENGTH_OPTIONS ──
// (root cause: a fixed hop from 1-month-equivalent straight to 6 months,
// with nothing in between). These exercise the full lifecycle the registry
// promises for any select-kind field: selectable (present in the options
// list with a value + all 3 language labels), displayable (formats
// correctly per language via the exact same generic formatter every other
// lease length uses), and saveable/editable (round-trips through the same
// resolve/build functions real listings go through, including inheriting
// correctly alongside pre-existing, differently-valued listings so nothing
// already saved is disturbed by adding a new option).
//
// No admin.html/add-property.html/edit-listing.html DOM test is added
// here: RENTAL_TERM_KIND_RENDERERS.select (rental-terms.js) builds every
// <option> generically from RENTAL_TERMS_FIELDS[...].options -- there is no
// per-field markup anywhere for lease_length to update, so the registry
// change alone is what every form/edit surface needed. Likewise no
// listings.html filter test: today's rental filters (toggleRentalFilter)
// only cover pet_policy/smoking_policy -- lease_length has never had a
// search filter, so there is nothing filter-related to add a test for.
test('RENTAL_LEASE_LENGTH_OPTIONS: 3 months is selectable, with all three language labels', () => {
  const opt = RENTAL_LEASE_LENGTH_OPTIONS.find(o => o.value === '3_months');
  assert.ok(opt, '3_months must exist as a selectable lease length option');
  assert.equal(opt.label.en, '3 Months');
  assert.equal(opt.label.lo, '3 ເດືອນ');
  assert.equal(opt.label.zh, '3个月');
});

test('RENTAL_LEASE_LENGTH_OPTIONS: 1 month is also present (was missing alongside 3 months)', () => {
  const opt = RENTAL_LEASE_LENGTH_OPTIONS.find(o => o.value === '1_month');
  assert.ok(opt);
  assert.equal(opt.label.en, '1 Month');
});

test('RENTAL_LEASE_LENGTH_OPTIONS: ascending duration order (1, 3, 6, 12, 24 months)', () => {
  const order = RENTAL_LEASE_LENGTH_OPTIONS.map(o => o.value);
  assert.deepEqual(
    order.filter(v => ['1_month', '3_months', '6_months', '12_months', '24_months'].includes(v)),
    ['1_month', '3_months', '6_months', '12_months', '24_months']
  );
});

test('formatRentalTermValue: 3 months displays correctly in every language (en/lo/zh)', () => {
  assert.equal(formatRentalTermValue('lease_length', '3_months', 'en'), 'Lease Length: 3 Months');
  assert.equal(formatRentalTermValue('lease_length', '3_months', 'lo'), 'ໄລຍະເວລາເຊົ່າ: 3 ເດືອນ');
  assert.equal(formatRentalTermValue('lease_length', '3_months', 'zh'), '租期: 3个月');
});

test('buildRentalTermsPayload: 3 months round-trips as a plain saved value (save path)', () => {
  const payload = buildRentalTermsPayload({ lease_length: '3_months' });
  assert.equal(payload.lease_length, '3_months');
  assert.equal(payload.version, RENTAL_TERMS_SCHEMA_VERSION);
});

test('resolveRentalTerms: a listing saved with 3 months resolves it back unchanged (save + reopen)', () => {
  const r = resolveRentalTerms(property({ version: 1, lease_length: '3_months' }), null);
  assert.equal(r.values.lease_length, '3_months');
});

test('resolveRentalTerms: a unit type can override lease_length to 3 months while the building keeps a different value (edit path)', () => {
  const prop = property({ version: 1, lease_length: '12_months' });
  const ut = unitType({ version: 1, lease_length: '3_months' });
  const r = resolveRentalTerms(prop, ut);
  assert.equal(r.values.lease_length, '3_months');   // unit override wins
  assert.deepEqual(r.overriddenKeys, ['lease_length']);
});

test('resolveRentalTerms: existing listings on pre-existing lease lengths remain unaffected by adding 1/3 months', () => {
  // Backward compatibility: adding new options must never change how an
  // already-saved listing on an older value (here the pre-existing
  // 'month_to_month', now labeled "Flexible" but with the same stored
  // value) resolves or displays.
  const r = resolveRentalTerms(property({ version: 1, lease_length: 'month_to_month' }), null);
  assert.equal(r.values.lease_length, 'month_to_month');
  assert.equal(formatRentalTermValue('lease_length', 'month_to_month', 'en'), 'Lease Length: Flexible');
});
