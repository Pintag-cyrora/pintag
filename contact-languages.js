// contact-languages.js — the single source of truth for CONTACT LANGUAGES:
// which languages a phone contact speaks, and how that is labelled and
// resolved for both admin and the public listing page.
//
// Same loading convention as currency.js/terminology.js/rental-terms.js/
// lease-pricing.js: plain global vars, no build step,
// <script src="contact-languages.js"> before any page's own inline <script>.
// Dependency-free — no `document`/`window` in the registry or resolvers — so
// the identical file is includable from a browser <script> tag AND a Deno edge
// function.
//
// ============================================================================
// ARCHITECTURAL RULES — read before touching this file or adding a language
// ============================================================================
//
// 1. CONTACT_LANGUAGES is the single source of truth for language metadata:
//    the stable code stored in the database, the trilingual label, and the
//    display order. No other file may define any of these. A consumer fetches
//    a label from this registry at render time; it never keeps its own copy.
//
// 2. Display order comes from CONTACT_LANGUAGES' array order. Never
//    alphabetize in a consumer, never re-sort per page.
//
// 3. resolveListingContacts() is the ONLY public read API for "which numbers
//    does this listing have". No code outside this file may decide how
//    properties.contacts and properties.property_contacts combine — not
//    admin.html, not listing.html, not an edge function.
//
// 4. Adding a language is ONE entry in CONTACT_LANGUAGES. It must not require
//    a change to any resolver, formatter, admin renderer or public renderer.
//
// 5. SPOKEN LANGUAGE IS NOT UI LANGUAGE. lang.js resolves the three languages
//    the SITE is translated into (lo/en/zh). This registry lists the languages
//    a human ANSWERS THE PHONE in, which is a different and larger set — Thai
//    is the obvious case: plenty of Vientiane agents speak it, and the site
//    will never be translated into it. Never collapse the two lists.
//
// 6. Resolver purity: nothing here mutates `property`, mutates a contact, or
//    writes anything back. Resolution is read-time only.
//
// 7. NEVER INVENT A LANGUAGE. A contact with no languages recorded resolves to
//    an EMPTY list, and the caller renders the number with no language line —
//    not a guessed "Lao", not a default. Most existing rows are in exactly
//    that state and must stay truthful.
//
// 8. An unknown code (a language removed from the registry, or a hand-edited
//    row) is DROPPED from the resolved list rather than rendered raw. The
//    stored value is left alone; this is a display decision only.
// ============================================================================

var CONTACT_LANGUAGES_SCHEMA_VERSION = 1;

// ISO 639-1 codes as the stored value — stable, standard, and short enough to
// read in a raw database row. Order is "most likely in Vientiane first".
var CONTACT_LANGUAGES = [
  { code: 'lo', label: { en: 'Lao',        lo: 'ລາວ',       zh: '老挝语' } },
  { code: 'en', label: { en: 'English',    lo: 'ອັງກິດ',     zh: '英语' } },
  { code: 'th', label: { en: 'Thai',       lo: 'ໄທ',        zh: '泰语' } },
  { code: 'zh', label: { en: 'Chinese',    lo: 'ຈີນ',       zh: '中文' } },
  { code: 'vi', label: { en: 'Vietnamese', lo: 'ຫວຽດນາມ',   zh: '越南语' } },
  { code: 'ko', label: { en: 'Korean',     lo: 'ເກົາຫຼີ',    zh: '韩语' } },
  { code: 'ja', label: { en: 'Japanese',   lo: 'ຍີ່ປຸ່ນ',     zh: '日语' } },
  { code: 'fr', label: { en: 'French',     lo: 'ຝຣັ່ງ',      zh: '法语' } }
];

function contactLanguageByCode(code) {
  for (var i = 0; i < CONTACT_LANGUAGES.length; i++) {
    if (CONTACT_LANGUAGES[i].code === code) return CONTACT_LANGUAGES[i];
  }
  return null;
}

// normalizeContactLanguages(raw) -> array of known codes, in REGISTRY order,
// de-duplicated. Accepts a Postgres text[] as delivered by PostgREST (a real
// JS array), a single string, or null/undefined. Unknown codes are dropped
// (rule 8); nothing is invented (rule 7).
function normalizeContactLanguages(raw) {
  var list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
  var seen = {}, out = [];
  for (var i = 0; i < CONTACT_LANGUAGES.length; i++) {
    var code = CONTACT_LANGUAGES[i].code;
    for (var j = 0; j < list.length; j++) {
      if (typeof list[j] !== 'string') continue;
      if (list[j].trim().toLowerCase() !== code) continue;
      if (seen[code]) break;
      seen[code] = true; out.push(code); break;
    }
  }
  return out;
}

// formatContactLanguages(codes, lang) -> "Lao, English" | null.
// Returns null (not an empty string) when there is nothing to show, so a
// caller can suppress the whole element rather than render an empty node.
function formatContactLanguages(codes, lang) {
  lang = lang || 'en';
  var norm = normalizeContactLanguages(codes);
  if (!norm.length) return null;
  var parts = [];
  for (var i = 0; i < norm.length; i++) {
    var def = contactLanguageByCode(norm[i]);
    if (def) parts.push(def.label[lang] || def.label.en);
  }
  return parts.length ? parts.join(', ') : null;
}

// ---------------------------------------------------------------------------
// resolveListingContacts(property) — the sole public read API (rule 3).
//
// BACKWARD COMPATIBILITY IS THE WHOLE DESIGN HERE.
//
// Before this feature a listing had exactly one contact, reached through
// properties.contact_id -> contacts (PostgREST embeds it as `contacts`, a
// single object). That column still exists, still points at the PRIMARY
// contact, and is still what leads/lead_events reference. Nothing about it
// changed.
//
// Additional numbers live in the property_contacts join table, embedded as
// `property_contacts: [{ sort_order, contacts: {...} }]`. A join table rather
// than a column on contacts because a contacts row is SHARED BY MANY LISTINGS
// (see 20260705000300_backfill_contacts_from_properties.sql, which assigns one
// contact to a whole group of properties) — putting property_id on contacts
// would have forced that sharing to be split apart.
//
// Resolution order:
//   1. property_contacts, by sort_order, when present — the full ordered list,
//      which INCLUDES the primary (the migration backfills it there).
//   2. otherwise the single embedded `contacts` object — every listing that
//      has not been re-saved since the migration, and any page whose query
//      does not embed property_contacts at all.
// Either way the FIRST entry is the primary, so a caller that only wants one
// number takes [0] and behaves exactly as it did before.
//
// Returns [] when a listing genuinely has no contact. Never fabricates one.
// ---------------------------------------------------------------------------
function resolveListingContacts(property) {
  if (!property) return [];
  var out = [];
  var seen = {};

  function push(row, sortOrder, isPrimary) {
    if (!row || !row.id) return;
    if (seen[row.id]) return;
    var phone = (row.phone || '').trim();
    if (!phone) return;                       // a contact with no number is not callable
    seen[row.id] = true;
    out.push({
      id: row.id,
      name: row.name || null,
      role: row.role || null,
      phone: phone,
      // whatsapp falls back to phone — the same convention admin already uses
      // when saving (f-contact-whatsapp defaults to the phone field).
      whatsapp: (row.whatsapp || '').trim() || phone,
      isVerified: !!row.is_verified,
      languages: normalizeContactLanguages(row.languages),
      sortOrder: (typeof sortOrder === 'number') ? sortOrder : 0,
      isPrimary: !!isPrimary
    });
  }

  var joined = Array.isArray(property.property_contacts) ? property.property_contacts.slice() : [];
  if (joined.length) {
    joined.sort(function (a, b) {
      return (a && a.sort_order || 0) - (b && b.sort_order || 0);
    });
    for (var i = 0; i < joined.length; i++) {
      push(joined[i] && joined[i].contacts, joined[i] && joined[i].sort_order,
           joined[i] && joined[i].is_primary);
    }
  }
  // The legacy single embed. Pushed even when property_contacts existed --
  // push() de-duplicates by id, so this is a no-op for an already-listed
  // primary and a genuine repair for a half-backfilled row (join rows written
  // without the primary link). sortOrder -1 puts a repaired primary FIRST, so
  // resolvePrimaryContact() still returns properties.contact_id's contact and
  // no call site changes meaning mid-migration.
  if (property.contacts) push(property.contacts, -1, true);

  // Re-sort after the legacy push: it can carry sortOrder -1 and must not be
  // left wherever append order happened to put it.
  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  return out;
}


// ---------------------------------------------------------------------------
// resolveContactForLanguage(property, uiLang) — THE LANGUAGE-AWARE ROUTER.
//
// The visitor picks a language with Pintag's existing toggle and is routed to
// the number most likely to answer in it. There is no second language
// selector: `uiLang` is whatever lang.js already resolved (?lang= -> stored
// choice -> navigator.language -> 'lo'), passed straight in.
//
// FALLBACK HIERARCHY, in order. The CTA is NEVER hidden or disabled for want
// of a language match -- an older listing with one unlabelled number must keep
// converting exactly as it does today:
//
//   1. A contact whose `languages` include the active language. Ties break on
//      the listing's own order (primary first, then sort_order), so a landlord
//      who lists the general number first keeps it for shared languages.
//   2. The listing's general/primary number (property_contacts.is_primary,
//      which the migration backfills from properties.contact_id).
//   3. Any number at all.
//
// Returns { contact, tier, matchedLanguage } so a caller can tell an explicit
// match from a fallback -- the UI says "speaks English" only for tier 1, and
// never implies a language nobody recorded.
//
// NOTE ON COVERAGE. Pintag's toggle is lo/en/zh (lang.js PINTAG_VALID_LANGS);
// a Thai-only number can therefore never win tier 1 today and is reached via
// the picker or the fallback. That is deliberate rather than a gap: the moment
// 'th' is added to PINTAG_VALID_LANGS this function routes to it with no
// change here, because nothing below names a language.
// ---------------------------------------------------------------------------
function resolveContactForLanguage(property, uiLang) {
  var all = resolveListingContacts(property);
  if (!all.length) return { contact: null, tier: 0, matchedLanguage: null };

  var lang = (typeof uiLang === 'string' && uiLang) ? uiLang.trim().toLowerCase() : null;

  // Tier 1 — an explicit language match. `all` is already in listing order
  // (primary first via sortOrder -1, then sort_order), so the first hit is the
  // right tie-break without re-sorting.
  if (lang) {
    for (var i = 0; i < all.length; i++) {
      if (all[i].languages.indexOf(lang) !== -1) {
        return { contact: all[i], tier: 1, matchedLanguage: lang };
      }
    }
  }

  // Tier 2 — the general number.
  for (var j = 0; j < all.length; j++) {
    if (all[j].isPrimary) return { contact: all[j], tier: 2, matchedLanguage: null };
  }

  // Tier 3 — anything callable. Reached only by a listing whose links predate
  // the is_primary backfill; still better than showing no CTA.
  return { contact: all[0], tier: 3, matchedLanguage: null };
}

// The number a page should use before the buyer has chosen — the primary.
// Exactly what every existing single-contact call site already had.
function resolvePrimaryContact(property) {
  var all = resolveListingContacts(property);
  return all.length ? all[0] : null;
}

// True only when there is a real choice to offer the buyer. Drives whether the
// listing page renders a picker at all -- one number keeps the current UI
// untouched.
function hasMultipleContacts(property) {
  return resolveListingContacts(property).length > 1;
}


// ---------------------------------------------------------------------------
// THE PRIMARY-LINK WRITE PATH — one implementation, four callers.
//
// Every path that writes properties.contact_id must also ensure the matching
// primary property_contacts row. Four of the five live paths did not
// (add-property, edit-listing, and both agent-setup bulk assigns), which is how
// two production listings ended up carrying a contact_id with zero links. The
// public page still showed a number only because listing.html also requests the
// legacy contacts() embed -- language routing, which reads property_contacts,
// silently degraded.
//
// 20260823000000_contact_primary_invariant.sql makes this a DATABASE guarantee,
// and that trigger -- not this helper -- is what makes the invariant unbreakable
// (it also covers recovery scripts and hand-written SQL, which no amount of
// front-end code can reach). This helper exists so the application does not
// depend on the safety net for ordinary correctness, and so the four callers
// share ONE definition of "the primary link" instead of four copies free to
// drift apart the way they did the first time.
//
// The two steps mirror the trigger exactly, in the same order and for the same
// reason: idx_property_contacts_one_primary is a partial UNIQUE on
// (property_id) WHERE is_primary, so a superseded primary must be demoted
// BEFORE the new one is written or a genuine A -> B reassignment raises a
// unique violation.
// ---------------------------------------------------------------------------
var PRIMARY_CONTACT_SORT_ORDER = 0;

// The one agreed shape of a primary link. Returns null for a NULL contact --
// a listing with no contact gets no link, matching the trigger.
function primaryContactLinkRow(propertyId, contactId) {
  if (!propertyId || !contactId) return null;
  return {
    property_id: propertyId,
    contact_id:  contactId,
    sort_order:  PRIMARY_CONTACT_SORT_ORDER,
    is_primary:  true
  };
}

// io is a transport adapter -- see supabaseJsContactLinkIO / restContactLinkIO
// below. Pages talk to Supabase two different ways and neither is worth
// rewriting, so the SHARED part is the logic and the per-page part is only how
// a request is sent.
async function ensurePrimaryContactLink(io, propertyId, contactId) {
  var row = primaryContactLinkRow(propertyId, contactId);
  if (!row) return false;
  await io.demoteOtherPrimaries(propertyId, contactId);
  await io.upsertLink(row);
  return true;
}

// Adapter for the pages that use the supabase-js client
// (add-property.html, edit-listing.html).
function supabaseJsContactLinkIO(client) {
  return {
    demoteOtherPrimaries: async function (propertyId, contactId) {
      var r = await client.from('property_contacts')
        .update({ is_primary: false })
        .eq('property_id', propertyId)
        .eq('is_primary', true)
        .neq('contact_id', contactId);
      if (r && r.error) throw new Error(r.error.message || 'demote failed');
    },
    upsertLink: async function (row) {
      var r = await client.from('property_contacts')
        .upsert(row, { onConflict: 'property_id,contact_id' });
      if (r && r.error) throw new Error(r.error.message || 'link upsert failed');
    }
  };
}

// Adapter for the pages that use the raw REST helper sbApi(method, path, body,
// extraHeaders) (admin.html, agent-setup.html). PostgREST needs both the
// on_conflict target and the merge-duplicates Prefer header to upsert.
function restContactLinkIO(sbApiFn) {
  return {
    demoteOtherPrimaries: async function (propertyId, contactId) {
      await sbApiFn('PATCH',
        'property_contacts?property_id=eq.' + encodeURIComponent(propertyId) +
        '&is_primary=is.true&contact_id=neq.' + encodeURIComponent(contactId),
        { is_primary: false });
    },
    upsertLink: async function (row) {
      await sbApiFn('POST', 'property_contacts?on_conflict=property_id,contact_id',
        row, { Prefer: 'resolution=merge-duplicates' });
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONTACT_LANGUAGES_SCHEMA_VERSION, CONTACT_LANGUAGES, contactLanguageByCode,
    normalizeContactLanguages, formatContactLanguages,
    resolveListingContacts, resolvePrimaryContact, hasMultipleContacts,
    resolveContactForLanguage,
    PRIMARY_CONTACT_SORT_ORDER, primaryContactLinkRow, ensurePrimaryContactLink,
    supabaseJsContactLinkIO, restContactLinkIO
  };
}
