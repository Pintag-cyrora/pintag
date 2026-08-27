// listing-title.js — the ONE place a listing title is guaranteed to name WHERE
// the property is.
//
// WHY THIS FILE EXISTS
// A title is the only line that survives every surface: a card, a search
// result, a shared link's preview, a Facebook repost. Everywhere else the
// district sits in its own field beside the title; in a share preview it does
// not travel at all. "Modern 3-Bedroom Home with Private Garden" is a good
// title that tells a buyer nothing about where the home IS.
//
// Titles are written by an LLM in three languages, in two different edge
// functions. An instruction in a prompt is a request, not a guarantee -- so the
// prompts ask for the location AND this module enforces it afterwards. Every
// entry point calls the same function, so the rule cannot drift between them.
//
// THE RULES THIS ENCODES
//   1. MOST SPECIFIC FIRST, and never invent. village -> district -> city,
//      using only structured fields already stored on the listing. A missing
//      village is simply skipped; it is never guessed from the district, and a
//      listing with no usable location keeps its title unchanged rather than
//      gaining a made-up one.
//   2. IDEMPOTENT. Appending must be safe to run twice, on a title the AI
//      already located, and on a title an operator wrote by hand -- otherwise
//      the third regeneration reads "Modern Condo in Sisattanak, Vientiane,
//      Sisattanak, Vientiane".
//   3. A DISTRICT IS NOT A VILLAGE. Sisattanak, Saysettha, Chanthabouly and
//      the rest are DISTRICTS of Vientiane Capital. Rendering one in the
//      village slot -- or letting the AI present it as a neighbourhood -- is
//      the specific error this file names and prevents.
//   4. THE CITY LABEL COMES FROM THE REGISTRY. provinces.js owns province
//      metadata (its rule 1); this module asks it for the city label and
//      defines none of its own. That is what keeps 'Vientiane Capital' (the
//      prefecture, city label "Vientiane") from being conflated with
//      'Vientiane Province', which is a different place entirely.
(function (global) {
  'use strict';

  // provinces.js is the source of truth for the city label. In a browser it is
  // a plain global; under node --test it is required. Resolved lazily so load
  // order between the two <script> tags cannot matter.
  function provincesApi() {
    if (global.PintagProvinces) return global.PintagProvinces;
    if (typeof provinceCityLabel === 'function') {
      return { provinceCityLabel: provinceCityLabel, provinceByKey: provinceByKey };
    }
    return null;
  }

  // Small→large everywhere except Chinese, where an address runs large→small
  // (万象·西沙塔纳克), and the connector differs per language. Village names are
  // romanised in every language: properties has village_en only, deliberately
  // -- place names are not translated (the same rule listing.html follows).
  var LANG = {
    en: { connector: ' in ',  separator: ', ',  reverse: false },
    lo: { connector: ' ຢູ່ ',  separator: ', ',  reverse: false },
    zh: { connector: ' 位于', separator: '·',   reverse: true  }
  };

  function langCfg(lang) { return LANG[lang] || LANG.en; }

  function clean(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    // A field holding the literal string a serializer left behind is not data.
    if (!s || s === 'null' || s === 'undefined' || s === 'not specified') return '';
    return s;
  }

  // The three structured components, resolved for one language. Nothing here
  // reads a free-text address or a map URL: only the columns admin.html writes.
  function locationParts(listing, lang) {
    var p = listing || {};
    var L = lang || 'en';

    // village_en is the ONLY village column and is used verbatim in all three
    // languages -- see rule 1's note. Falling back to `village` covers the
    // legacy rows written before the column was renamed.
    var village = clean(p.village_en || p.village);

    var district = clean(p['district_' + L] || p.district_en || p.district);

    // The CITY label, not the province key: 'Vientiane Capital' is a
    // prefecture whose city is Vientiane, and a title reading "in Sisattanak,
    // Vientiane Capital" is not how anyone says it.
    var city = '';
    var api = provincesApi();
    var provinceKey = clean(p.province_en || p.province);
    if (api && api.provinceCityLabel && provinceKey) {
      city = clean(api.provinceCityLabel(provinceKey, L));
    }
    // A row that predates the province column still has a language-specific
    // label stored; use it rather than dropping the city entirely.
    if (!city) city = clean(p['province_' + L]);

    return { village: village, district: district, city: city };
  }

  // "Ban Phonxay, Sisattanak, Vientiane" — or '' when nothing is known.
  // NEVER a partial invention: a listing with only a village and no district
  // still gets the village, because that is real data the listing carries.
  function locationPhrase(listing, lang) {
    var cfg = langCfg(lang);
    var parts = locationParts(listing, lang);
    var ordered = [parts.village, parts.district, parts.city].filter(Boolean);
    if (!ordered.length) return '';
    if (cfg.reverse) ordered = ordered.slice().reverse();
    return ordered.join(cfg.separator);
  }

  // Comparison that survives the ways the same place gets written: casing,
  // punctuation, and the "Ban "/"Ban." prefix Lao villages carry inconsistently.
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’'`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function mentions(title, term) {
    var t = normalize(title);
    var n = normalize(term);
    if (!t || !n) return false;
    if (t.indexOf(n) !== -1) return true;
    // "Ban Phonxay" in the field vs "Phonxay" in the title, and the reverse.
    var stripped = n.replace(/^ban\s+/, '');
    return stripped !== n && stripped.length > 2 && t.indexOf(stripped) !== -1;
  }

  // Does the title already tell a reader where this is?
  //
  // ANY known component counts, not just the most specific one. A title
  // reading "House for Rent in Sisattanak" is already located; appending the
  // full phrase would produce "...in Sisattanak in Ban Phonxay, Sisattanak,
  // Vientiane". The requirement is that the title carries recognisable
  // location -- not that it carries the maximal one.
  function titleHasLocation(title, listing, lang) {
    var parts = locationParts(listing, lang);
    var candidates = [parts.village, parts.district, parts.city].filter(Boolean);
    for (var i = 0; i < candidates.length; i++) {
      if (mentions(title, candidates[i])) return true;
    }
    return false;
  }

  // The enforcement point. Returns the title unchanged when it is already
  // located, or when the listing has no location to add -- inventing one is
  // worse than omitting it.
  function ensureTitleLocation(title, listing, lang) {
    var t = clean(title);
    if (!t) return title;                       // nothing to decorate
    if (titleHasLocation(t, listing, lang)) return t;
    var phrase = locationPhrase(listing, lang);
    if (!phrase) return t;                      // rule 1: never invent
    return t + langCfg(lang).connector + phrase;
  }

  // Convenience for the three-language records both edge functions and the
  // admin form deal in: {title, title_lo, title_zh} or {title_en, ...}.
  // Returns a NEW object; the input is never mutated.
  function ensureAllTitleLocations(record, listing, opts) {
    var out = {};
    for (var k in record) if (Object.prototype.hasOwnProperty.call(record, k)) out[k] = record[k];
    var enKey = (opts && opts.enKey) || (('title_en' in out) ? 'title_en' : 'title');
    var pairs = [[enKey, 'en'], ['title_lo', 'lo'], ['title_zh', 'zh']];
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      if (typeof out[key] === 'string' && out[key]) {
        out[key] = ensureTitleLocation(out[key], listing, pairs[i][1]);
      }
    }
    return out;
  }

  // Is this listing ACTIVE — the set whose titles a customer can actually see?
  //
  // Three independent flags have to agree, and they are not redundant:
  // workflow_status is the authority on draft, `status` collapses to
  // active/draft/archived (the 20260729 sync trigger), and deleted_at is the
  // soft-delete tombstone. Reading only one of them would sweep drafts or
  // removed listings into a bulk title update.
  function isActiveListing(row) {
    if (!row) return false;
    if (row.deleted_at) return false;
    if ((row.workflow_status || 'active') !== 'active') return false;
    var st = String(row.status || '').toLowerCase();
    return st !== 'draft' && st !== 'archived';
  }

  var TITLE_COLUMNS = [['title_en', 'en'], ['title_lo', 'lo'], ['title_zh', 'zh']];

  // The columns that would change to give this row a located title, and why.
  // Returns {} when nothing needs doing — which is the answer for a title that
  // is already located AND for a row with no location to add, so a caller must
  // read `reason` rather than infer success from an empty patch.
  function titleLocationPatch(row) {
    var patch = {}, changes = [], hadTitle = false;
    for (var i = 0; i < TITLE_COLUMNS.length; i++) {
      var col = TITLE_COLUMNS[i][0], lang = TITLE_COLUMNS[i][1];
      var current = row ? row[col] : null;
      // A missing translation stays missing: inventing a Lao title from an
      // English one is not this function's job.
      if (typeof current !== 'string' || !current.trim()) continue;
      hadTitle = true;
      var next = ensureTitleLocation(current, row, lang);
      if (next !== current) { patch[col] = next; changes.push({ column: col, from: current, to: next }); }
    }
    var reason = changes.length ? 'located'
      : !hadTitle ? 'no-title'
      : !locationPhrase(row, 'en') ? 'no-usable-location'
      : 'already-located';
    return { patch: patch, changes: changes, reason: reason };
  }

  var api = {
    isActiveListing: isActiveListing,
    titleLocationPatch: titleLocationPatch,
    locationParts: locationParts,
    locationPhrase: locationPhrase,
    titleHasLocation: titleHasLocation,
    ensureTitleLocation: ensureTitleLocation,
    ensureAllTitleLocations: ensureAllTitleLocations
  };

  global.PintagListingTitle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
