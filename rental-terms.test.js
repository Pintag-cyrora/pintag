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
const src = fs.readFileSync(new URL('./rental-terms.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'rental-terms.js' });

const {
  resolveRentalTerms, _normalizeRentalTermsBlob, buildRentalTermsPayload,
  formatRentalTermValue, summarizeRentalTermOverrides, RENTAL_TERMS_FIELDS,
  RENTAL_TERMS_SCHEMA_VERSION
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

test('formatRentalTermValue: money_multiplier formats months vs fixed amount', () => {
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 2 }, 'en'), 'Deposit: 2 Months');
  assert.equal(formatRentalTermValue('deposit', { type: 'months_of_rent', value: 1 }, 'en'), 'Deposit: 1 Month');
  assert.equal(formatRentalTermValue('deposit', { type: 'fixed_amount', value: 500 }, 'en'), 'Deposit: 500');
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
  assert.equal(lines[0].startsWith('Deposit'), true);
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
