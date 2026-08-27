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

  // Production village_en values carry BOTH scripts in one field —
  // "Phonsinuan ໂພນສີນວນ", "Yapha Village ບ້ານ ຍະພາ". Rendering the whole
  // string puts Lao script inside an English title, and comparing against the
  // whole string fails to notice that the title already says "Phonsinuan" —
  // which is how the first audit produced "...in Phonsinuan ... in Phonsinuan
  // ໂພນສີນວນ, Sisattanak, Vientiane", the exact duplication this must prevent.
  //
  // So a value is split by script and the run matching the target language is
  // used. Falling back to the whole string keeps a single-script value intact.
  var SCRIPT_RUNS = {
    lo: /[\u0E80-\u0EFF][\u0E80-\u0EFF\s]*/g,          // Lao
    zh: /[\u4E00-\u9FFF][\u4E00-\u9FFF\s]*/g,          // CJK
    en: /[A-Za-z][A-Za-z0-9'’.\-\s]*/g                   // Latin
  };

  function scriptRun(value, lang) {
    var v = String(value || '');
    // Chinese has no village column of its own, so a zh title falls back to
    // the Latin spelling rather than borrowing the Lao script.
    var order = lang === 'lo' ? ['lo', 'en'] : lang === 'zh' ? ['zh', 'en'] : ['en'];
    for (var i = 0; i < order.length; i++) {
      var m = v.match(SCRIPT_RUNS[order[i]]);
      if (m && m.length) {
        var best = m.sort(function (a, b) { return b.trim().length - a.trim().length; })[0].trim();
        if (best) return best;
      }
    }
    return v.trim();
  }

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
    var village = clean(scriptRun(p.village_en || p.village, L));

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
  // \p{M} (combining marks) MUST be kept. Lao writes its vowels and tones as
  // combining marks, so stripping them shatters ວຽງຈັນ into "ວຽງຈ" + "ນ" —
  // and a one-character fragment then matches almost any Lao title, which made
  // titleHasLocation() report every Lao title as already located.
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’'`]/g, '')
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
      .trim();
  }

  // Words that describe a place rather than name one; matching on them would
  // call any title with the word "village" in it located.
  var GENERIC = { ban: 1, village: 1, muang: 1, district: 1, city: 1, province: 1, the: 1 };

  function placeTokens(term) {
    return normalize(term).split(' ').filter(function (w) { return w && !GENERIC[w]; });
  }

  function mentions(title, term) {
    var t = normalize(title);
    var n = normalize(term);
    if (!t || !n) return false;
    if (t.indexOf(n) !== -1) return true;

    var titleWords = t.split(' ').filter(Boolean);
    var terms = placeTokens(term);
    for (var i = 0; i < terms.length; i++) {
      var w = terms[i];
      // A one- or two-character fragment is not evidence that a title names a
      // place; it is evidence that something upstream split a word.
      if (w.length < 3) continue;
      if (t.indexOf(w) !== -1) return true;
      // Romanised Lao place names vary in their final vowels between the
      // title and the field — Sungjiang/Sungjieng, Phakhaw/Phakhao. A shared
      // five-character prefix treats those as the same place; five is long
      // enough to keep Phonthan, Phonsinuan and Phonphanao apart.
      //
      // A false positive here means "the title already names this place, so
      // leave it alone" — the safe direction for a bulk edit of live titles.
      if (w.length >= 5) {
        for (var j = 0; j < titleWords.length; j++) {
          if (titleWords[j].length >= 5 && titleWords[j].slice(0, 5) === w.slice(0, 5)) return true;
        }
      }
    }
    return false;
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

    var cfg = langCfg(lang);
    // "Cozy 3-Bedroom House with Carport." + " in ..." keeps the full stop in
    // the middle of the sentence.
    t = t.replace(/[.,;:\s]+$/, '');

    // A title that already reads "... in <somewhere else>" gets the location
    // as a continuation rather than a second "in": "Home in Sikhai in Yapha
    // Village, Sikhottabong" is clumsy where "Home in Sikhai, Yapha Village,
    // Sikhottabong" reads as one address.
    var connector = cfg.connector;
    var already = new RegExp('(^|\\s)' + cfg.connector.trim() + '\\s', 'i');
    if (cfg.connector.trim() && already.test(t)) connector = cfg.separator;

    return t + connector + phrase;
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
