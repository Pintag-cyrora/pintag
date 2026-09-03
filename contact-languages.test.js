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
    assert.match(src, /property_contacts\(sort_order,is_primary,contacts\(/, f + ' must embed property_contacts');
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
  // ...through the ONE phone normaliser (components.js), so a locally-stored
  // number ("020…") still yields a valid wa.me link.
  assert.match(src, /_currentContactPhone=ptNormalizePhoneDigits\(c\.whatsapp\|\|c\.phone\|\|''\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// LANGUAGE-AWARE ROUTING — the toggle picks the number
// ═══════════════════════════════════════════════════════════════════════════
// The visitor chooses a language with Pintag's EXISTING toggle and is routed
// to the number most likely to answer in it. `uiLang` is whatever lang.js
// already resolved; there is no second language selector anywhere.

const { resolveContactForLanguage } = await import('./contact-languages.js');

const routed = (rows) => ({ property_contacts: rows.map((r, i) => ({
  sort_order: i, is_primary: !!r.primary,
  contacts: c({ id: r.id, phone: r.phone, languages: r.langs || null })
})) });

const THREE = routed([
  { id: 'a', phone: '+856 20 111 111', langs: ['lo', 'en'], primary: true },
  { id: 'b', phone: '+856 20 222 222', langs: ['th'] },
  { id: 'c', phone: '+856 20 333 333', langs: ['zh'] }
]);

test('ROUTING: each language reaches its assigned number', () => {
  assert.equal(resolveContactForLanguage(THREE, 'lo').contact.id, 'a');
  assert.equal(resolveContactForLanguage(THREE, 'en').contact.id, 'a');
  assert.equal(resolveContactForLanguage(THREE, 'th').contact.id, 'b');
  assert.equal(resolveContactForLanguage(THREE, 'zh').contact.id, 'c');
});

test('ROUTING: one number serving TWO languages is reached by both', () => {
  const lo = resolveContactForLanguage(THREE, 'lo');
  const en = resolveContactForLanguage(THREE, 'en');
  assert.equal(lo.contact.id, en.contact.id, 'the Lao+English number serves both');
  assert.equal(lo.tier, 1); assert.equal(en.tier, 1);
});

test('ROUTING: an explicit match reports tier 1 and the language it matched', () => {
  const r = resolveContactForLanguage(THREE, 'zh');
  assert.equal(r.tier, 1);
  assert.equal(r.matchedLanguage, 'zh');
});

// ── The fallback hierarchy ────────────────────────────────────────────────
test('FALLBACK 2: no number speaks the language -> the PRIMARY, never nothing', () => {
  const noZh = routed([
    { id: 'a', phone: '020111', langs: ['lo'], primary: true },
    { id: 'b', phone: '020222', langs: ['th'] }
  ]);
  const r = resolveContactForLanguage(noZh, 'zh');
  assert.equal(r.contact.id, 'a', 'must fall through to the general number');
  assert.equal(r.tier, 2);
  assert.equal(r.matchedLanguage, null, 'must NOT claim a language match');
});

test('FALLBACK 3: no language match and no primary -> any number', () => {
  const none = routed([
    { id: 'a', phone: '020111', langs: ['th'] },
    { id: 'b', phone: '020222', langs: ['th'] }
  ]);
  const r = resolveContactForLanguage(none, 'en');
  assert.equal(r.tier, 3);
  assert.ok(r.contact, 'the CTA must never be left without a number');
});

test('FALLBACK: an OLD single-number listing keeps converting untouched', () => {
  // The whole point of the hierarchy: no manual editing required.
  const legacy = { contacts: c({ id: 'solo', phone: '02055555555' }) };
  for (const l of ['lo', 'en', 'zh', 'th', null, undefined]) {
    const r = resolveContactForLanguage(legacy, l);
    assert.equal(r.contact.phone, '02055555555', 'lang=' + l);
    assert.ok(r.tier >= 2, 'a fallback, never a claimed match');
  }
});

test('the CTA is never hidden — only a listing with NO contact resolves empty', () => {
  const empty = resolveContactForLanguage({}, 'en');
  assert.equal(empty.contact, null);
  assert.equal(empty.tier, 0, 'tier 0 is the only "nothing to call" state');
});

test('ROUTING: unlabelled numbers never win tier 1', () => {
  const mixed = routed([
    { id: 'a', phone: '020111', primary: true },          // no languages recorded
    { id: 'b', phone: '020222', langs: ['en'] }
  ]);
  assert.equal(resolveContactForLanguage(mixed, 'en').contact.id, 'b');
  assert.equal(resolveContactForLanguage(mixed, 'en').tier, 1);
  assert.equal(resolveContactForLanguage(mixed, 'zh').contact.id, 'a', 'zh falls back to primary');
});

test('ROUTING: ties break on listing order, so the general number wins a shared language', () => {
  const tie = routed([
    { id: 'general', phone: '020111', langs: ['lo', 'en'], primary: true },
    { id: 'other',   phone: '020222', langs: ['en'] }
  ]);
  assert.equal(resolveContactForLanguage(tie, 'en').contact.id, 'general');
});

test('ROUTING is case/whitespace tolerant on the incoming UI language', () => {
  assert.equal(resolveContactForLanguage(THREE, 'ZH').contact.id, 'c');
  assert.equal(resolveContactForLanguage(THREE, ' th ').contact.id, 'b');
});

test('COVERAGE: the toggle is lo/en/zh, so a Thai-only number is fallback-reachable today', () => {
  // lang.js PINTAG_VALID_LANGS = ['en','lo','zh'] — 'th' cannot be selected in
  // the toggle yet. This pins that the ROUTER is already correct for it, so
  // adding 'th' to the toggle needs no change here.
  const langJs = fs.readFileSync(new URL('./lang.js', import.meta.url), 'utf8');
  assert.match(langJs, /PINTAG_VALID_LANGS\s*=\s*\['en',\s*'lo',\s*'zh'\]/,
    'if the toggle gains a language, revisit this test, not the router');
  assert.equal(resolveContactForLanguage(THREE, 'th').contact.id, 'b',
    'the router already routes Thai correctly');
});

test('WIRING: the listing page routes through the EXISTING toggle, not a new one', () => {
  const src = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  assert.match(src, /resolveContactForLanguage\(data,\s*lang\)/,
    'must pass the language lang.js already resolved');
  // setLang() re-runs buildMockupLayout(), which is what makes a toggle click
  // re-resolve the CTAs. If that call ever goes away, routing silently freezes.
  const setLang = src.slice(src.indexOf('function setLang('));
  assert.match(setLang.slice(0, setLang.indexOf('\n}')), /buildMockupLayout\(\)/,
    'the language toggle must still re-render the contact block');
  // No parallel language state.
  assert.ok(!/contactLang|_contactLanguageSelector|selectContactLanguage/.test(src),
    'must not introduce a second language selector');
});

test('WIRING: both queries select is_primary, else the fallback tier is lost', () => {
  for (const f of ['listing.html', 'admin.html']) {
    const src = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    assert.match(src, /property_contacts\(sort_order,is_primary,contacts\(/, f);
  }
});

test('MIGRATION: is_primary is backfilled from the existing single contact', () => {
  const sql = fs.readFileSync(new URL('./supabase/migrations/20260820000000_multi_phone_contacts.sql', import.meta.url), 'utf8');
  assert.match(sql, /INSERT INTO property_contacts \(property_id, contact_id, sort_order, is_primary\)[\s\S]*?true/,
    'the existing number must become the primary automatically');
  assert.match(sql, /idx_property_contacts_one_primary[\s\S]*WHERE is_primary/,
    'at most one primary per listing');
  assert.match(sql, /UPDATE property_contacts pc SET is_primary = true/, 'safety net for link rows with no primary');
});

// ---------------------------------------------------------------------------
// REGRESSION: every known properties.contact_id write path maintains the
// primary property_contacts link.
//
// Two production listings were found carrying a contact_id with zero links.
// The root cause was that four of the five live write paths could only do half
// the job. These tests pin the shape of the shared helper and assert -- by
// reading the actual page sources -- that each of those paths now calls it.
// A future edit that reintroduces a bare contact_id write fails here.
// ---------------------------------------------------------------------------
{
  const {
    primaryContactLinkRow, ensurePrimaryContactLink,
    supabaseJsContactLinkIO, restContactLinkIO, PRIMARY_CONTACT_SORT_ORDER
  } = await import('./contact-languages.js');

  test('primaryContactLinkRow builds the one agreed link shape', () => {
    assert.deepStrictEqual(
      primaryContactLinkRow('p1', 'c1'),
      { property_id: 'p1', contact_id: 'c1', sort_order: 0, is_primary: true });
    assert.strictEqual(PRIMARY_CONTACT_SORT_ORDER, 0);
  });

  test('a NULL contact gets no link — matching the trigger', () => {
    assert.strictEqual(primaryContactLinkRow('p1', null), null);
    assert.strictEqual(primaryContactLinkRow('p1', undefined), null);
    assert.strictEqual(primaryContactLinkRow(null, 'c1'), null);
  });

  test('ensurePrimaryContactLink demotes BEFORE it upserts', async () => {
    // Order matters: idx_property_contacts_one_primary is a partial UNIQUE on
    // (property_id) WHERE is_primary, so upserting first would raise a unique
    // violation on every genuine A -> B reassignment.
    const calls = [];
    const io = {
      demoteOtherPrimaries: async (pid, cid) => { calls.push(['demote', pid, cid]); },
      upsertLink:           async (row)      => { calls.push(['upsert', row.contact_id]); }
    };
    const did = await ensurePrimaryContactLink(io, 'prop-1', 'contact-B');
    assert.strictEqual(did, true);
    assert.deepStrictEqual(calls, [['demote', 'prop-1', 'contact-B'], ['upsert', 'contact-B']]);
  });

  test('ensurePrimaryContactLink is a no-op for a NULL contact', async () => {
    let touched = false;
    const io = {
      demoteOtherPrimaries: async () => { touched = true; },
      upsertLink:           async () => { touched = true; }
    };
    assert.strictEqual(await ensurePrimaryContactLink(io, 'prop-1', null), false);
    assert.strictEqual(touched, false, 'a NULL contact must not write anything');
  });

  test('the REST adapter demotes only OTHER primaries and upserts on the right constraint', async () => {
    const seen = [];
    const io = restContactLinkIO(async (m, path, body, headers) => {
      seen.push({ m, path, body, headers });
    });
    await io.demoteOtherPrimaries('P', 'C');
    await io.upsertLink(primaryContactLinkRow('P', 'C'));

    assert.match(seen[0].path, /property_id=eq\.P/);
    assert.match(seen[0].path, /is_primary=is\.true/);
    assert.match(seen[0].path, /contact_id=neq\.C/,
      'must never demote the contact it is about to promote');
    assert.deepStrictEqual(seen[0].body, { is_primary: false });

    assert.match(seen[1].path, /on_conflict=property_id,contact_id/,
      'PostgREST needs the on_conflict target to upsert');
    assert.strictEqual(seen[1].headers.Prefer, 'resolution=merge-duplicates',
      'without merge-duplicates the POST is a plain insert and 409s');
  });

  test('the supabase-js adapter surfaces errors instead of silently continuing', async () => {
    const client = { from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ neq: async () => ({ error: { message: 'nope' } }) }) }) }),
      upsert: async () => ({ error: null })
    }) };
    await assert.rejects(
      () => supabaseJsContactLinkIO(client).demoteOtherPrimaries('P', 'C'), /nope/);
  });

  // ── the four previously-broken pages now call the shared helper ──────────
  for (const [file, expected] of [
    ['add-property.html', 1],
    ['edit-listing.html', 1],
    ['agent-setup.html',  2],   // both bulk-assignment loops
  ]) {
    test(`${file} maintains the primary link after writing contact_id`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.match(src, /contact-languages\.js/,
        `${file} must load the shared contact module`);
      const calls = (src.match(/await ensurePrimaryContactLink\(/g) || []).length;
      assert.strictEqual(calls, expected,
        `${file} should call ensurePrimaryContactLink ${expected}x`);
    });
  }

  test('admin.html saveExtraContacts never deletes before the replacements land', () => {
    const src = fs.readFileSync('admin.html', 'utf8');
    const fn = src.slice(src.indexOf('async function saveExtraContacts'),
                         src.indexOf('// ── SAVE ─'));
    const wipeAll = /DELETE',\s*`property_contacts\?property_id=eq\.\$\{propertyId\}`/;
    assert.ok(!wipeAll.test(fn),
      'the unconditional "delete every link for this listing" must be gone — it is what left two listings with zero numbers');
    const upsertAt = fn.indexOf('on_conflict=property_id,contact_id');
    const deleteAt = fn.indexOf("contact_id=not.in.");
    assert.ok(upsertAt > -1, 'links must be upserted');
    assert.ok(deleteAt > -1, 'removals must be scoped to contacts the user took away');
    assert.ok(upsertAt < deleteAt,
      'the upsert must come BEFORE the delete so a failure can never leave zero rows');
  });

  test('no page writes properties.contact_id without the module loaded', () => {
    // Catches a NEW page repeating the original mistake.
    for (const f of ['add-property.html', 'edit-listing.html', 'agent-setup.html', 'admin.html']) {
      const src = fs.readFileSync(f, 'utf8');
      if (/contact_id\s*:/.test(src)) {
        assert.match(src, /contact-languages\.js/,
          `${f} writes contact_id but does not load contact-languages.js`);
      }
    }
  });

  test('the invariant migration exists and is shaped correctly', () => {
    const sql = fs.readFileSync(
      'supabase/migrations/20260823000000_contact_primary_invariant.sql', 'utf8');
    assert.match(sql, /AFTER INSERT OR UPDATE OF contact_id ON properties/,
      'must fire on INSERT and on UPDATE of contact_id');
    assert.match(sql, /IF NEW\.contact_id IS NULL THEN\s*\n\s*RETURN NULL/,
      'a NULL contact must produce no link');
    assert.match(sql, /SET is_primary = false[\s\S]*?contact_id <> NEW\.contact_id/,
      'must demote a superseded primary');
    assert.match(sql, /ON CONFLICT ON CONSTRAINT property_contacts_unique/,
      'must upsert on the real unique constraint so a secondary is promoted, not duplicated');
    assert.match(sql, /SECURITY DEFINER/,
      'the safety net must hold for writers who lack RLS access to property_contacts');
    assert.ok(!/INSERT INTO property_contacts[\s\S]*FROM properties p\s+WHERE p\.contact_id IS NOT NULL/.test(sql),
      'the migration must NOT backfill — repairing existing rows is a separate authorized step');
  });
}
