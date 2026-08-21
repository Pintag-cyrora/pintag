// Multiple phone numbers per listing, each advertising its own languages.
//   node --test contact-languages.test.js
//
// THE MODEL. `contacts` already owned a phone (phone/whatsapp/name/role/
// party_id/is_verified), so languages are a column there, not a new JSON blob
// and not phone_1/phone_2/phone_3. The many-side is the property_contacts JOIN
// TABLE because a contacts row is SHARED BY MANY LISTINGS
// (20260705000300 assigns one contact to a whole group of properties) --
// putting property_id on contacts would have forced that sharing apart.
//
// BACKWARD COMPATIBILITY is the property most of these tests defend:
// properties.contact_id still points at the primary, leads/lead_events still
// reference contacts, and a listing that has never been re-saved resolves
// exactly as it did before.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  CONTACT_LANGUAGES, contactLanguageByCode, normalizeContactLanguages,
  formatContactLanguages, resolveListingContacts, resolvePrimaryContact,
  hasMultipleContacts
} = await import('./contact-languages.js');

const c = (o) => Object.assign({ id: 'c1', role: 'agent', phone: '02011111111' }, o);
const joined = (rows) => rows.map((r, i) => ({ sort_order: i, contacts: r }));

// ── Registry ──────────────────────────────────────────────────────────────
test('the registry carries the languages the example needs', () => {
  const codes = CONTACT_LANGUAGES.map(l => l.code);
  for (const need of ['lo', 'en', 'th', 'zh']) assert.ok(codes.includes(need), need);
  assert.equal(new Set(codes).size, codes.length, 'codes must be unique');
  for (const l of CONTACT_LANGUAGES) {
    for (const k of ['en', 'lo', 'zh']) assert.ok(l.label[k], l.code + ' missing ' + k);
  }
});

test('spoken languages are NOT the site UI languages — Thai is present', () => {
  // lang.js resolves lo/en/zh for the SITE. A contact answering in Thai is
  // ordinary in Vientiane and must be expressible.
  assert.ok(CONTACT_LANGUAGES.some(l => l.code === 'th'));
  assert.ok(CONTACT_LANGUAGES.length > 3);
});

// ── Normalization ─────────────────────────────────────────────────────────
test('normalization: registry order, de-duplicated, unknown codes dropped', () => {
  assert.deepEqual(normalizeContactLanguages(['en', 'lo']), ['lo', 'en'], 'registry order, not input order');
  assert.deepEqual(normalizeContactLanguages(['lo', 'lo', 'en']), ['lo', 'en']);
  assert.deepEqual(normalizeContactLanguages(['en', 'klingon', 'xx']), ['en']);
  assert.deepEqual(normalizeContactLanguages(['EN', ' lo ']), ['lo', 'en'], 'case/whitespace tolerant');
});

test('normalization never invents: null/undefined/[]/garbage all resolve empty', () => {
  for (const v of [null, undefined, [], '', 0, {}, [null, 42]]) {
    assert.deepEqual(normalizeContactLanguages(v), [], JSON.stringify(v));
  }
});

test('formatting returns null (not "") when nothing is recorded', () => {
  assert.equal(formatContactLanguages([], 'en'), null);
  assert.equal(formatContactLanguages(null, 'en'), null);
  assert.equal(formatContactLanguages(['nope'], 'en'), null);
});

test('formatting matches the requested display, and localizes', () => {
  assert.equal(formatContactLanguages(['lo', 'en'], 'en'), 'Lao, English');
  assert.equal(formatContactLanguages(['th'], 'en'), 'Thai');
  assert.equal(formatContactLanguages(['zh', 'en'], 'en'), 'English, Chinese');
  assert.equal(formatContactLanguages(['lo', 'en'], 'lo'), 'ລາວ, ອັງກິດ');
  assert.equal(formatContactLanguages(['lo', 'en'], 'zh'), '老挝语, 英语');
});

// ── Backward compatibility ────────────────────────────────────────────────
test('LEGACY: a listing with only the single `contacts` embed still resolves', () => {
  const p = { contacts: c({ name: 'Somchai', whatsapp: '02099999999' }) };
  const all = resolveListingContacts(p);
  assert.equal(all.length, 1);
  assert.equal(all[0].phone, '02011111111');
  assert.equal(all[0].whatsapp, '02099999999');
  assert.equal(all[0].name, 'Somchai');
  assert.deepEqual(all[0].languages, [], 'no languages recorded -> empty, never guessed');
  assert.equal(hasMultipleContacts(p), false, 'one number -> no picker');
});

test('LEGACY: whatsapp falls back to phone, matching what admin already saves', () => {
  const [only] = resolveListingContacts({ contacts: c({ whatsapp: null }) });
  assert.equal(only.whatsapp, '02011111111');
});

test('LEGACY: the primary is byte-identical with and without the join rows', () => {
  const legacy = { contacts: c({ name: 'A' }) };
  const migrated = { contacts: c({ name: 'A' }), property_contacts: joined([c({ name: 'A' })]) };
  assert.deepEqual(resolvePrimaryContact(legacy).phone, resolvePrimaryContact(migrated).phone);
  assert.deepEqual(resolvePrimaryContact(legacy).id, resolvePrimaryContact(migrated).id);
});

test('a listing with no contact at all resolves to [] — nothing fabricated', () => {
  assert.deepEqual(resolveListingContacts({}), []);
  assert.deepEqual(resolveListingContacts(null), []);
  assert.equal(resolvePrimaryContact({}), null);
  assert.deepEqual(resolveListingContacts({ contacts: c({ phone: '' }) }), [],
    'a contact with no number is not callable');
});

// ── Multi-number ──────────────────────────────────────────────────────────
const threeNumbers = {
  contacts: c({ id: 'a', phone: '+856 20 111 1111', languages: ['lo', 'en'] }),
  property_contacts: [
    { sort_order: 2, contacts: c({ id: 'cc', phone: '+856 20 333 3333', languages: ['zh', 'en'] }) },
    { sort_order: 0, contacts: c({ id: 'a',  phone: '+856 20 111 1111', languages: ['lo', 'en'] }) },
    { sort_order: 1, contacts: c({ id: 'bb', phone: '+856 20 222 2222', languages: ['th'] }) }
  ]
};

test('THE GOAL: one listing -> three numbers -> each with its own languages', () => {
  const all = resolveListingContacts(threeNumbers);
  assert.equal(all.length, 3);
  const shown = all.map(x => x.phone + ' → ' + (formatContactLanguages(x.languages, 'en') || ''));
  assert.deepEqual(shown, [
    '+856 20 111 1111 → Lao, English',
    '+856 20 222 2222 → Thai',
    '+856 20 333 3333 → English, Chinese'
  ]);
});

test('rows come back in staff sort_order, not payload order', () => {
  assert.deepEqual(resolveListingContacts(threeNumbers).map(x => x.id), ['a', 'bb', 'cc']);
});

test('the primary (sort_order 0) is index 0, so single-number call sites are untouched', () => {
  assert.equal(resolvePrimaryContact(threeNumbers).id, 'a');
  assert.equal(hasMultipleContacts(threeNumbers), true);
});

test('the primary is not duplicated when it appears in BOTH embeds', () => {
  const ids = resolveListingContacts(threeNumbers).map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a half-backfilled row is repaired: join rows missing the primary still include it', () => {
  // property_contacts exists but the primary link was never written.
  const p = {
    contacts: c({ id: 'primary', phone: '020111' }),
    property_contacts: [{ sort_order: 1, contacts: c({ id: 'extra', phone: '020222' }) }]
  };
  const all = resolveListingContacts(p);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'primary', 'the primary sorts first via sortOrder -1');
});

test('one unit\'s languages never leak to another number', () => {
  const all = resolveListingContacts(threeNumbers);
  assert.deepEqual(all[1].languages, ['th']);
  assert.deepEqual(all[2].languages, ['en', 'zh']);
  assert.notDeepEqual(all[0].languages, all[1].languages);
});

test('a number with no languages renders bare, alongside ones that have them', () => {
  const p = { property_contacts: joined([
    c({ id: 'x', phone: '020111', languages: ['lo'] }),
    c({ id: 'y', phone: '020222' })
  ]) };
  const all = resolveListingContacts(p);
  assert.equal(formatContactLanguages(all[0].languages, 'en'), 'Lao');
  assert.equal(formatContactLanguages(all[1].languages, 'en'), null, 'no guess for the second');
});

// ── Wiring guards ─────────────────────────────────────────────────────────
test('the migration backfills, widens the anon policy, and adds no fixed phone columns', () => {
  const sql = fs.readFileSync(new URL('./supabase/migrations/20260820000000_multi_phone_contacts.sql', import.meta.url), 'utf8');
  assert.match(sql, /INSERT INTO property_contacts[\s\S]*FROM properties p\s+WHERE p\.contact_id IS NOT NULL/,
    'existing listings must keep their number');
  assert.match(sql, /ON CONFLICT \(property_id, contact_id\) DO NOTHING/, 'backfill must be idempotent');
  // The anon policy MUST consider property_contacts, or extra numbers are invisible.
  const policy = sql.slice(sql.indexOf('Public read contacts of active properties'));
  assert.match(policy, /property_contacts/, 'without this the second number is filtered out for anon');
  // No FIXED phone columns. Matches a column DEFINITION, not the words -- the
  // migration's own prose says "not phone_1/phone_2/phone_3", which is correct
  // documentation and must not trip this.
  assert.ok(!/ADD COLUMN[^;]*\bphone_\d/i.test(sql), 'no fixed phone columns');
  assert.ok(!/^\s*phone_\d\s+(text|varchar)/im.test(sql), 'no fixed phone columns in a CREATE TABLE');
  // Additive only.
  assert.ok(!/DROP COLUMN|ALTER COLUMN .* TYPE|DELETE FROM (properties|contacts)\b/.test(sql), 'must be additive');
});

test('both public queries embed the join rows, else the feature is inert', () => {
  for (const f of ['listing.html', 'admin.html']) {
    const src = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    assert.match(src, /property_contacts\(sort_order,contacts\(/, f + ' must embed property_contacts');
    assert.match(src, /languages/, f + ' must select the languages column');
  }
});

test('the listing page routes CTAs through the SELECTED contact', () => {
  const src = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  assert.match(src, /function ptSelectContact\(index\)/);
  // Both CTAs must read the live attribute rather than a baked-in id, so the
  // dialled number and the tracked contact can never disagree.
  assert.match(src, /id="pt-wa-primary"/);
  assert.match(src, /id="pt-call-primary"/);
  // The quotes are backslash-escaped inside the generated JS string literal.
  assert.ok((src.match(/contactId:this\.getAttribute\(\\?'data-contact-id\\?'\)/g) || []).length >= 2,
    'WhatsApp and Call must both attribute to the selected contact');
  // The mobile sticky bar reads this global, so selection must update it.
  assert.match(src, /_currentContactPhone=String\(c\.whatsapp\|\|c\.phone\|\|''\)/);
});
