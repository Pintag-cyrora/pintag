// Unit tests for dashboard.html's lead-unit-attribution breadcrumb
// (resolveLeadUnitSummary / buildLeadUnitBreadcrumbHtml) -- the admin/agent
// display side of the WhatsApp unit-attribution fix. Run with:
//   node --test dashboard-lead-unit-breadcrumb.test.js
//
// Same "extract the real function from the shipped file" technique as
// xss-inline-handlers.test.js / image-cdn.test.js -- these are the actual
// functions dashboard.html runs, not a reimplementation that could silently
// drift from them. formatMoney/_ptFrequencySuffix/esc are stubbed with
// simple, deterministic equivalents (currency.js/components.js are large,
// DOM-adjacent files this test has no need to load in full) -- this test's
// job is the FALLBACK LOGIC in resolveLeadUnitSummary/
// buildLeadUnitBreadcrumbHtml itself, not currency formatting fidelity.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function extractFn(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const ctx = vm.createContext({});
vm.runInContext(
  'function esc(s){ return s == null ? "" : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }\n' +
  'function formatMoney(amount, currency){ return amount == null ? null : "$" + amount; }\n' +
  'function _ptFrequencySuffix(freq){ return freq ? "/" + freq : ""; }\n' +
  extractFn('dashboard.html', 'resolveLeadUnitSummary') + '\n' +
  extractFn('dashboard.html', 'buildLeadUnitBreadcrumbHtml'),
  ctx
);
const { resolveLeadUnitSummary, buildLeadUnitBreadcrumbHtml } = ctx;

function property(overrides) {
  return Object.assign({
    id: 'prop-1', title_en: 'River Apartment', bedrooms: 3, price_amount: 500000, price_currency: 'USD',
    unit_types: [
      { id: 'ut-a', name_en: 'Room Type A', bedrooms: 2, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly' },
      { id: 'ut-b', name_en: 'Room Type B', bedrooms: 1, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly' },
    ],
  }, overrides || {});
}
function lead(overrides) {
  return Object.assign({ id: 'lead-1', property_id: 'prop-1', unit_type_id: 'ut-a', unit_id: null }, overrides || {});
}

// ── resolveLeadUnitSummary ───────────────────────────────────────────────
test('resolveLeadUnitSummary: null when the lead has no unit_type_id at all (a general, building-level lead)', () => {
  assert.equal(resolveLeadUnitSummary(property(), null), null);
  assert.equal(resolveLeadUnitSummary(property(), undefined), null);
});

// REQUIRED 9: missing/deleted unit type does not crash the admin display.
test('REQUIRED 9: resolveLeadUnitSummary returns null (not a throw) when unit_type_id points to a unit type no longer in the property\'s unit_types (deleted)', () => {
  assert.doesNotThrow(() => resolveLeadUnitSummary(property(), 'deleted-unit-id'));
  assert.equal(resolveLeadUnitSummary(property(), 'deleted-unit-id'), null);
});
test('resolveLeadUnitSummary returns null when the property itself could not be resolved (deleted property, propMap lookup misses)', () => {
  assert.doesNotThrow(() => resolveLeadUnitSummary(undefined, 'ut-a'));
  assert.equal(resolveLeadUnitSummary(undefined, 'ut-a'), null);
});

// REQUIRED 8: the admin/agent display correctly identifies the unit type.
test('REQUIRED 8: resolveLeadUnitSummary resolves name/bedrooms/price from the unit type itself', () => {
  const summary = resolveLeadUnitSummary(property(), 'ut-a');
  assert.equal(summary.name, 'Room Type A');
  assert.equal(summary.bedrooms, 2);
  assert.equal(summary.priceText, '$400 /monthly'); // real _ptFrequencySuffix() returns "/ month"-style text with its own leading space
});

// REQUIRED 10: multiple unit types on the same property remain distinguishable.
test('REQUIRED 10: two different unit_type_id values on the same property resolve to their OWN distinct summaries', () => {
  const p = property();
  const a = resolveLeadUnitSummary(p, 'ut-a');
  const b = resolveLeadUnitSummary(p, 'ut-b');
  assert.equal(a.name, 'Room Type A');
  assert.equal(b.name, 'Room Type B');
  assert.notEqual(a.bedrooms, b.bedrooms);
});

test('resolveLeadUnitSummary falls back to the property\'s own bedrooms when the unit type\'s own bedrooms is null (inherits, never fabricates)', () => {
  const p = property({ unit_types: [{ id: 'ut-a', name_en: 'Room Type A', bedrooms: null }] });
  const summary = resolveLeadUnitSummary(p, 'ut-a');
  assert.equal(summary.bedrooms, 3); // property.bedrooms
});

// REQUIRED 6: changing the unit type's displayed name never requires
// changing the attribution -- unit_type_id is the only key ever looked up,
// never a stored name. Proven by construction: resolveLeadUnitSummary takes
// the CURRENT unit_types row and reads its CURRENT name_en live -- renaming
// it in admin.html changes what this resolves to immediately, with zero
// change to any stored lead/lead_event row.
test('REQUIRED 6: the resolved name always reflects the unit type\'s CURRENT name_en, proving the lookup is by id, never a stored/cached name', () => {
  const renamed = property({ unit_types: [{ id: 'ut-a', name_en: 'Deluxe Suite (renamed)', bedrooms: 2 }] });
  const summary = resolveLeadUnitSummary(renamed, 'ut-a');
  assert.equal(summary.name, 'Deluxe Suite (renamed)');
});

// ── buildLeadUnitBreadcrumbHtml ──────────────────────────────────────────
test('buildLeadUnitBreadcrumbHtml: empty string for a general, building-level lead (no unit_type_id)', () => {
  assert.equal(buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: null }), property()), '');
});
test('REQUIRED 8: buildLeadUnitBreadcrumbHtml renders "→ name / → N bedrooms / → price" for a unit-type lead', () => {
  const html = buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: 'ut-a' }), property());
  assert.match(html, /→ Room Type A/);
  assert.match(html, /→ 2 bedrooms/);
  assert.match(html, /→ \$400 \/monthly/);
  assert.ok(!html.includes('Unit '), 'no unit_id set -- must not render a "Unit ..." line');
});
test('buildLeadUnitBreadcrumbHtml includes a "Unit <id>" line when unit_id is present (forward-compatible with a future physical-units table)', () => {
  const html = buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: 'ut-a', unit_id: '203' }), property());
  assert.match(html, /→ Unit 203/);
});
test('REQUIRED 9: buildLeadUnitBreadcrumbHtml never throws for a deleted unit type, and simply omits the breadcrumb', () => {
  assert.doesNotThrow(() => buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: 'gone' }), property()));
  assert.equal(buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: 'gone' }), property()), '');
});
test('buildLeadUnitBreadcrumbHtml HTML-escapes the unit type name (defense in depth against a malicious/AI-generated unit name)', () => {
  const p = property({ unit_types: [{ id: 'ut-x', name_en: '<img src=x onerror=alert(1)>', bedrooms: 1 }] });
  const html = buildLeadUnitBreadcrumbHtml(lead({ unit_type_id: 'ut-x' }), p);
  assert.ok(!html.includes('<img'), 'a raw <img> tag must never appear unescaped in the rendered breadcrumb');
  assert.match(html, /&lt;img/);
});
