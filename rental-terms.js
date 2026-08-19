// rental-terms.js — Rental Terms v2: building-level defaults + per-unit-type
// overrides for deposit, utilities, service frequency, policies, and fees.
// Same loading convention as terminology.js/amenities.js: plain global vars,
// no build step, <script src="rental-terms.js"> before each page's own
// inline <script>. Written as plain, dependency-free JS (no `document`/
// `window` references in the resolver/formatter/normalizer functions) so
// the same file is includable from a browser <script> tag AND a Deno edge
// function without a rewrite — required because AI-generated copy (Smart
// Import, future description generation) must consume resolveRentalTerms()
// rather than re-deriving this logic in a different runtime.
//
// ============================================================================
// ARCHITECTURAL RULES — read before touching this file or adding a field
// ============================================================================
//
// 1. RENTAL_TERMS_FIELDS is the single source of truth for Rental Terms
//    metadata: labels (en/lo/zh), option lists, field kind, display order,
//    and grouping. No other file may define any of these. A consumer that
//    needs a label fetches it from this registry at render time — it never
//    keeps its own copy.
//
// 2. Display order comes directly from RENTAL_TERMS_FIELDS' array order.
//    Never alphabetize; never let an individual consumer re-sort fields.
//
// 3. resolveRentalTerms() is the ONLY public read API. No code outside this
//    file may read properties.rental_terms or unit_types.rental_terms_overrides
//    directly — not admin.html, not listing.html, not an edge function, not
//    a future helper. Any future helper (e.g. a hypothetical
//    getEffectiveDeposit()) must itself call resolveRentalTerms() internally
//    and read from its `.values` — it may never re-open the raw columns as
//    a shortcut.
//
// 4. Adding a Rental Term that fits an EXISTING `kind` requires only: one
//    entry in RENTAL_TERMS_FIELDS, plus its option list if applicable. It
//    must NOT require changes to resolveRentalTerms(), _normalizeRentalTermsBlob(),
//    the admin renderer (RENTAL_TERM_KIND_RENDERERS), the public listing
//    renderer, save/load logic, or the collapsed-summary formatter
//    (formatRentalTermValue()). A new `kind` (a new renderer function) is
//    only justified when a field needs a genuinely new interaction model —
//    check whether it fits money_multiplier / utility / select /
//    checkbox_ref / fee_list first; most new fields will. If implementing a
//    field ever requires touching more than the registry, that's a signal
//    the kind-dispatch architecture has broken down for that field — fix
//    the architecture, don't hand-roll a special case in a consumer.
//
// 5. Resolver purity: resolveRentalTerms() and _normalizeRentalTermsBlob()
//    never mutate the `property` object, never mutate the `unitType`
//    object, never mutate the stored JSON, and never write normalized or
//    resolved values back to the database as a side effect of being
//    called. Normalization is an in-memory, read-time-only concern.
//
// 6. The resolver's return shape is a frozen contract:
//      { version, values, overriddenKeys }
//    This must remain stable across future schema versions. A future v2
//    schema changes what _normalizeRentalTermsBlob() does internally — it
//    must never change what resolveRentalTerms() returns to callers.
//
// 7. "version" inside a stored blob is a serialization/schema-version
//    marker ONLY. It must never be read as, or repurposed for, a business
//    version, a pricing revision, a policy revision, or any other domain
//    concept. `_normalizeRentalTermsBlob()` stays intentionally minimal
//    (strip `version`, return a shallow copy) until a real Version 2 shape
//    actually exists — no speculative migration logic is written ahead of
//    a real need.
//
// 8. This module and unit-availability.js must remain completely
//    independent — see unit-availability.js's own header for the mirrored
//    rule. Neither file may import or reference the other.
//
// 9. JSONB scope boundary: this pattern is for configuration/policy data —
//    small, human-edited, evolves by adding optional keys. It is NOT a
//    precedent for operational/transactional data (bookings, pricing
//    history, calendars, analytics) — those stay flat and relational,
//    matching every other table in this schema (search_events,
//    listing_events, leads, intelligence_insights, unit_types itself).
// ============================================================================

var RENTAL_TERMS_SCHEMA_VERSION = 1;

// Shared option lists.
var RENTAL_MONTHS_OPTIONS = [
  {value:'months_of_rent', label:{en:'Months of rent', lo:'ຈຳນວນເດືອນຄ່າເຊົ່າ', zh:'按月租计算'}},
  {value:'fixed_amount',   label:{en:'Fixed amount',   lo:'ຈຳນວນຄົງທີ່',        zh:'固定金额'}}
];
// Currency for monetary rental terms (deposit, advance rent) is read from
// the shared currency.js registry (CURRENCIES/DEFAULT_CURRENCY/
// formatMoney()) -- see that file's header. This used to be a private
// RENTAL_CURRENCIES/RENTAL_DEFAULT_CURRENCY copy defined here; consolidated
// once properties.price_amount/price_currency needed the exact same
// currency list, so there is now exactly one currency registry in the app.
// currency.js must be loaded before this file (<script src="currency.js">
// then <script src="rental-terms.js">).

var RENTAL_FREQUENCY_OPTIONS = [
  {value:'daily',        label:{en:'Daily',            lo:'ທຸກມື້',          zh:'每天'}},
  {value:'twice_weekly',  label:{en:'Twice a Week',     lo:'ອາທິດລະ 2 ຄັ້ງ',  zh:'每周两次'}},
  {value:'weekly',        label:{en:'Weekly',           lo:'ອາທິດລະຄັ້ງ',    zh:'每周一次'}},
  {value:'biweekly',      label:{en:'Biweekly',         lo:'ສອງອາທິດຄັ້ງ',   zh:'每两周一次'}},
  {value:'monthly',       label:{en:'Monthly',          lo:'ເດືອນລະຄັ້ງ',    zh:'每月一次'}},
  {value:'not_included',  label:{en:'Not Included',     lo:'ບໍ່ລວມ',         zh:'不包含'}}
];
var RENTAL_LAUNDRY_OPTIONS = [
  {value:'included',     label:{en:'Included',      lo:'ລວມຢູ່ແລ້ວ',     zh:'包含'}},
  {value:'self_service', label:{en:'Self-Service',  lo:'ບໍລິການດ້ວຍຕົນເອງ', zh:'自助服务'}},
  {value:'paid_service', label:{en:'Paid Service',  lo:'ບໍລິການເສຍຄ່າ',  zh:'付费服务'}},
  {value:'not_available',label:{en:'Not Available', lo:'ບໍ່ມີບໍລິການ',   zh:'不提供'}}
];
// Values are the only thing ever persisted (properties.rental_terms /
// unit_types.rental_terms_overrides) -- labels are free to change without
// touching a single saved listing. 'month_to_month' keeps its original
// value for exactly that reason even though its label now reads "Flexible"
// (a month-to-month lease IS the flexible/no-fixed-term option); only
// '1_month' and '3_months' are new values, inserted between the existing
// ones in ascending duration order. 'negotiable' is kept as-is (not part of
// the requested list, but nothing asked for its removal, and removing a
// live option would break any listing already using it).
var RENTAL_LEASE_LENGTH_OPTIONS = [
  {value:'month_to_month', label:{en:'Flexible',   lo:'ຢືດຢຸ່ນ',        zh:'灵活'}},
  {value:'1_month',        label:{en:'1 Month',    lo:'1 ເດືອນ',        zh:'1个月'}},
  {value:'3_months',       label:{en:'3 Months',   lo:'3 ເດືອນ',        zh:'3个月'}},
  {value:'6_months',       label:{en:'6 Months',   lo:'6 ເດືອນ',        zh:'6个月'}},
  {value:'12_months',      label:{en:'12 Months',  lo:'12 ເດືອນ',       zh:'12个月'}},
  {value:'24_months',      label:{en:'24 Months',  lo:'24 ເດືອນ',       zh:'24个月'}},
  {value:'negotiable',     label:{en:'Negotiable', lo:'ສາມາດເຈລະຈາໄດ້', zh:'可协商'}}
];
var RENTAL_PET_POLICY_OPTIONS = [
  {value:'allowed',      label:{en:'Pets Allowed',       lo:'ລ້ຽງສັດໄດ້',        zh:'允许宠物'}},
  {value:'not_allowed',  label:{en:'No Pets',            lo:'ບໍ່ອະນຸຍາດລ້ຽງສັດ', zh:'不允许宠物'}},
  {value:'case_by_case', label:{en:'Case-by-Case',       lo:'ພິຈາລະນາເປັນກໍລະນີ', zh:'具体情况具体讨论'}}
];
var RENTAL_PARKING_OPTIONS = [
  {value:'included',    label:{en:'Included',           lo:'ລວມຢູ່ແລ້ວ',       zh:'包含'}},
  {value:'extra_fee',   label:{en:'Available (Extra Fee)', lo:'ມີໃຫ້ (ເສຍຄ່າເພີ່ມ)', zh:'可提供(需额外付费)'}},
  {value:'not_available', label:{en:'Not Available',    lo:'ບໍ່ມີ',            zh:'不提供'}}
];
// Included-or-Amount: the shape of a recurring service charge that a landlord
// either bundles into the rent or bills separately. Two options only, on
// purpose -- "Included" and "Amount" are the only answers that carry
// information; a third "Not included / ask us" option would store the absence
// of an answer as if it were one, and an unset field already says that.
//
// The stored VALUE is what matters and never changes when a label does:
//   { type: 'included' }
//   { type: 'amount', value: 15, currency: 'USD' }
// -- a real number in a real currency, not free text, so a filter or a report
// can compare it without re-parsing prose (contrast the `utility` kind's
// free-text `rate`, which is display-only by design).
var RENTAL_INCLUDED_OR_AMOUNT_OPTIONS = [
  {value:'included', label:{en:'Included', lo:'ລວມຢູ່ແລ້ວ', zh:'包含'}},
  {value:'amount',   label:{en:'Amount',   lo:'ຈຳນວນເງິນ',   zh:'金额'}}
];
var RENTAL_SMOKING_POLICY_OPTIONS = [
  {value:'allowed',        label:{en:'Smoking Allowed',    lo:'ສູບຢາໄດ້',           zh:'允许吸烟'}},
  {value:'not_allowed',    label:{en:'No Smoking',         lo:'ຫ້າມສູບຢາ',          zh:'禁止吸烟'}},
  {value:'designated_areas',label:{en:'Designated Areas Only', lo:'ສະເພາະບ່ອນທີ່ກຳນົດ', zh:'仅限指定区域'}}
];

// Included Services — a filtered, rental-specific registry, same shape as
// AMENITIES ({key: {en,lo,zh,icon}}) but deliberately its own set: this is
// "what's bundled into the rent," a different question from AMENITIES'
// general marketing feature list, even where a term (wifi) overlaps in
// English. Intentionally a conservative v1 set — see terminology.js-style
// future-proofing note: breakfast/gym access/airport transfer are the
// documented FUTURE additions (design doc §8), added later as new entries
// here with zero resolver/renderer changes, not built speculatively now.
var RENTAL_SERVICES = {
  wifi:        {en:'Wi-Fi',        lo:'ອິນເຕີເນັດໄວໄຟ', zh:'无线网络',   icon:'📶'},
  housekeeping:{en:'Housekeeping', lo:'ບໍລິການທຳຄວາມສະອາດ', zh:'客房清洁', icon:'🧹'},
  security:    {en:'Security',     lo:'ຄວາມປອດໄພ',      zh:'安保',       icon:'🔐'}
};

// RENTAL_TERMS_FIELDS — the registry. Array order = display order (rule 2
// above). `group` is optional metadata (financial/utilities/services) for
// a future grouped admin/public UI — not consumed by any renderer yet.
var RENTAL_TERMS_FIELDS = [
  { key:'deposit', kind:'money_multiplier', group:'financial',
    label:{en:'Security Deposit', lo:'ເງິນມັດຈຳ', zh:'押金'}, typeOptions:RENTAL_MONTHS_OPTIONS },
  { key:'cleaning_deposit', kind:'money_multiplier', group:'financial',
    label:{en:'Cleaning Deposit', lo:'ເງິນມັດຈຳທຳຄວາມສະອາດ', zh:'清洁押金'}, typeOptions:RENTAL_MONTHS_OPTIONS },
  { key:'advance_rent', kind:'money_multiplier', group:'financial',
    label:{en:'Advance Rent', lo:'ຄ່າເຊົ່າລ່ວງໜ້າ', zh:'预付租金'}, typeOptions:RENTAL_MONTHS_OPTIONS },
  { key:'electricity', kind:'utility', group:'utilities',
    label:{en:'Electricity', lo:'ໄຟຟ້າ', zh:'电费'}, typeOptions:[
      {value:'included',  label:{en:'Included',        lo:'ລວມຢູ່ແລ້ວ', zh:'包含'}},
      {value:'metered',   label:{en:'Metered',         lo:'ຕິດຕັ້ງມິເຕີ', zh:'按表计费'}},
      {value:'flat_rate', label:{en:'Flat Rate',       lo:'ອັດຕາຄົງທີ່', zh:'固定费率'}}
    ] },
  { key:'water', kind:'utility', group:'utilities',
    label:{en:'Water', lo:'ນ້ຳປະປາ', zh:'水费'}, typeOptions:[
      {value:'included', label:{en:'Included',  lo:'ລວມຢູ່ແລ້ວ', zh:'包含'}},
      {value:'metered',  label:{en:'Metered',   lo:'ຕິດຕັ້ງມິເຕີ', zh:'按表计费'}},
      {value:'flat_fee', label:{en:'Flat Fee',  lo:'ຄ່າທຳນຽມຄົງທີ່', zh:'固定费用'}}
    ] },
  { key:'internet', kind:'utility', group:'utilities',
    label:{en:'Internet', lo:'ອິນເຕີເນັດ', zh:'网络'}, typeOptions:[
      {value:'included',       label:{en:'Included',        lo:'ລວມຢູ່ແລ້ວ',   zh:'包含'}},
      {value:'not_included',   label:{en:'Not Included',    lo:'ບໍ່ລວມ',       zh:'不包含'}},
      {value:'available_extra',label:{en:'Available (Extra Fee)', lo:'ມີໃຫ້ (ເສຍຄ່າເພີ່ມ)', zh:'可提供(需额外付费)'}}
    ] },
  // Trash Fee -- a recurring monthly service charge, so it sits with the other
  // utilities rather than in `additional_fees` (which is a free-text list for
  // one-off/ad-hoc charges and is deliberately not machine-readable).
  // `amountPeriod` is what makes the amount self-describing: the formatter
  // renders "$15 / month" from it, so the "monthly" in the label is not the
  // only thing telling a reader what the number means. Nullable by
  // construction -- an absent key resolves to nothing at all, so every listing
  // that predates this field is unaffected.
  { key:'trash_fee', kind:'included_or_amount', group:'utilities', amountPeriod:'monthly',
    label:{en:'Trash Fee', lo:'ຄ່າຂີ້ເຫຍື້ອ', zh:'垃圾费'}, typeOptions:RENTAL_INCLUDED_OR_AMOUNT_OPTIONS },
  { key:'cleaning_frequency', kind:'select', group:'services',
    label:{en:'Cleaning Frequency', lo:'ຄວາມຖີ່ການທຳຄວາມສະອາດ', zh:'清洁频率'}, options:RENTAL_FREQUENCY_OPTIONS },
  { key:'sheet_changing_frequency', kind:'select', group:'services',
    label:{en:'Sheet Changing Frequency', lo:'ຄວາມຖີ່ການປ່ຽນຜ້າປູ', zh:'换床单频率'}, options:RENTAL_FREQUENCY_OPTIONS },
  { key:'laundry', kind:'select', group:'services',
    label:{en:'Laundry', lo:'ບໍລິການຊັກຜ້າ', zh:'洗衣服务'}, options:RENTAL_LAUNDRY_OPTIONS },
  { key:'included_services', kind:'checkbox_ref', group:'services',
    label:{en:'Included Services', lo:'ບໍລິການທີ່ລວມຢູ່', zh:'包含的服务'}, registry:'RENTAL_SERVICES' },
  { key:'additional_fees', kind:'fee_list', group:'financial',
    label:{en:'Additional Fees', lo:'ຄ່າທຳນຽມເພີ່ມເຕີມ', zh:'其他费用'} },
  { key:'lease_length', kind:'select', group:'financial',
    label:{en:'Lease Length', lo:'ໄລຍະເວລາເຊົ່າ', zh:'租期'}, options:RENTAL_LEASE_LENGTH_OPTIONS },
  { key:'pet_policy', kind:'select', group:'services',
    label:{en:'Pet Policy', lo:'ນະໂຍບາຍລ້ຽງສັດ', zh:'宠物政策'}, options:RENTAL_PET_POLICY_OPTIONS },
  { key:'smoking_policy', kind:'select', group:'services',
    label:{en:'Smoking Policy', lo:'ນະໂຍບາຍສູບຢາ', zh:'吸烟政策'}, options:RENTAL_SMOKING_POLICY_OPTIONS },
  { key:'parking', kind:'select', group:'services',
    label:{en:'Parking', lo:'ບ່ອນຈອດລົດ', zh:'停车位'}, options:RENTAL_PARKING_OPTIONS }
];

// isRentalTransactionType(tx) -- the single source of truth for "does this
// listing_type mean rental terms are relevant" (Rental Terms refactor:
// base gating on listing_type === rent, not property_type). A property_type
// of any kind (apartment/condo/house/villa/townhouse/shophouse/office/
// warehouse/land/etc.) is irrelevant here on purpose -- rental contract
// terms are a function of HOW a property is being transacted, never WHAT
// kind of property it is. Every consumer that needs to decide whether to
// show/require Rental Terms (admin.html, add-property.html,
// edit-listing.html, listings.html's search filters) calls this instead of
// re-deriving the for_rent/sale_or_rent check inline.
function isRentalTransactionType(transactionType) {
  return transactionType === 'for_rent' || transactionType === 'sale_or_rent';
}

// ---------------------------------------------------------------------------
// Resolver — the sole public read API (rule 3). Pure (rule 5). Frozen
// contract (rule 6).
// ---------------------------------------------------------------------------

function _normalizeRentalTermsBlob(raw) {
  // Intentionally minimal (rule 7) -- v1 is a no-op beyond stripping the
  // version marker and returning a fresh copy. A version-aware upgrade
  // branch is added here only once a real v2 shape exists.
  var blob = raw || {};
  var copy = {};
  for (var k in blob) {
    if (Object.prototype.hasOwnProperty.call(blob, k) && k !== 'version') {
      copy[k] = blob[k];
    }
  }
  return copy;
}

function resolveRentalTerms(property, unitType) {
  var defaults  = _normalizeRentalTermsBlob(property && property.rental_terms);
  var overrides = _normalizeRentalTermsBlob(unitType && unitType.rental_terms_overrides);
  var values = {};
  var k;
  for (k in defaults)  { if (Object.prototype.hasOwnProperty.call(defaults, k))  values[k] = defaults[k]; }
  for (k in overrides) { if (Object.prototype.hasOwnProperty.call(overrides, k)) values[k] = overrides[k]; }
  return {
    version: RENTAL_TERMS_SCHEMA_VERSION,
    values: values,
    overriddenKeys: Object.keys(overrides)
  };
}

// buildRentalTermsPayload()/getRentalTermsOverridesFromDom() are the only
// write paths (rule 3) -- admin.html calls these, it never constructs a
// raw {version, ...} object itself.
function buildRentalTermsPayload(fieldValues) {
  var payload = { version: RENTAL_TERMS_SCHEMA_VERSION };
  for (var k in fieldValues) {
    if (Object.prototype.hasOwnProperty.call(fieldValues, k)) payload[k] = fieldValues[k];
  }
  return payload;
}

// getRentalTermAmount(property, unitType, fieldKey) -- the machine-readable
// read API for `included_or_amount` fields (Trash Fee today, any future
// bundled-or-billed charge tomorrow). Rule 3 compliant: it calls
// resolveRentalTerms() internally and reads its `.values`; it never opens
// properties.rental_terms or unit_types.rental_terms_overrides itself.
//
// This exists because formatRentalTermValue() returns DISPLAY TEXT ("$15 /
// month"), which is the right thing for a listing page and the wrong thing
// for anything that has to compare, sum, sort or filter. A listing card, a
// search filter, a report, or an AI prompt that needs the number gets it
// here, in one shape, instead of each re-parsing the rendered string.
//
// Generic over fieldKey by design (rule 4) -- there is deliberately no
// getTrashFee(). Returns null when the field is unset, is not an
// included_or_amount field, or holds an incomplete value:
//
//   { key, included: true,  amount: null, currency: null, period: 'monthly' }
//   { key, included: false, amount: 15,   currency: 'USD', period: 'monthly' }
//
// `included: true` with a null amount is a real, meaningful answer ("bundled
// into the rent, costs nothing extra") and must not be confused with null
// ("nobody said").
function getRentalTermAmount(property, unitType, fieldKey) {
  var fieldDef = null;
  for (var i = 0; i < RENTAL_TERMS_FIELDS.length; i++) {
    if (RENTAL_TERMS_FIELDS[i].key === fieldKey) { fieldDef = RENTAL_TERMS_FIELDS[i]; break; }
  }
  if (!fieldDef || fieldDef.kind !== 'included_or_amount') return null;

  var raw = resolveRentalTerms(property, unitType).values[fieldKey];
  if (!raw || !raw.type) return null;

  if (raw.type !== 'amount') {
    return { key: fieldKey, included: true, amount: null, currency: null, period: fieldDef.amountPeriod || null };
  }
  var n = Number(raw.value);
  if (raw.value == null || raw.value === '' || isNaN(n)) return null;
  return {
    key: fieldKey,
    included: false,
    amount: n,
    currency: raw.currency || DEFAULT_CURRENCY,
    period: fieldDef.amountPeriod || null
  };
}

// ---------------------------------------------------------------------------
// Formatting -- per-`kind` dispatch, generic over field key (rule 4).
// ---------------------------------------------------------------------------

function _rtOptionLabel(options, value, lang) {
  for (var i = 0; i < options.length; i++) {
    if (options[i].value === value) return options[i].label[lang] || options[i].label.en;
  }
  return value;
}

// Money vs. rent-multiplier rendering for the money_multiplier kind.
//
// Every field using this kind (deposit, advance_rent) is MONETARY by
// definition. "N months of rent" is a legitimate, widely-used way to quote a
// deposit in this market, so it stays -- but it is a rent MULTIPLIER, never a
// duration, and it only ever applies when explicitly chosen. See the
// formatter below for why the default direction matters.
function _rtFormatMoney(value, currency) {
  var n = Number(value);
  if (isNaN(n)) return currencySymbol(currency) + String(value);
  return formatMoney(n, currency);
}
function _rtFormatRentMultiplier(value, lang) {
  var T = {
    en: function(v) { return v + (Number(v) === 1 ? " month's rent" : " months' rent"); },
    lo: function(v) { return v + ' ເດືອນຄ່າເຊົ່າ'; },
    zh: function(v) { return v + '个月租金'; }
  };
  return (T[lang] || T.en)(value);
}

// Period suffixes for the included_or_amount kind, keyed by a field's
// `amountPeriod`. A table rather than a hardcoded "/ month" so a future
// per-week or per-quarter charge is still a registry-only addition (rule 4).
var _RT_AMOUNT_PERIOD_SUFFIX = {
  monthly: { en: '/ month', lo: '/ ເດືອນ', zh: '/ 月' }
};

var RENTAL_TERM_KIND_FORMATTERS = {
  money_multiplier: function(fieldDef, raw, lang) {
    if (!raw || raw.value == null) return null;
    // Rent-multiplier ONLY when explicitly chosen. Everything else --
    // 'fixed_amount', a missing type, or an unrecognized one -- renders as
    // money, because this kind is only ever used for monetary fields.
    //
    // The old code had this backwards: it special-cased 'fixed_amount' and
    // let EVERY other case (including a missing type) fall through to a
    // "N Months" branch. That is what produced "Deposit: 100 Months" on a
    // listing whose owner meant $100 -- a monetary value silently rendered
    // as a duration. Defaulting to money is the safe direction for a field
    // that is monetary by definition.
    if (raw.type === 'months_of_rent') return _rtFormatRentMultiplier(raw.value, lang);
    return _rtFormatMoney(raw.value, raw.currency);
  },
  // included_or_amount -- "the landlord bundles this into the rent" vs "the
  // landlord bills N per period". Renders the option label for 'included' and
  // real money for 'amount', with the period spelled out ("$15 / month") so
  // the figure can never be mistaken for a one-off charge. Missing/zero-less
  // amounts self-suppress like every other kind: a half-filled field shows
  // nothing rather than a bare currency symbol.
  included_or_amount: function(fieldDef, raw, lang) {
    if (!raw || !raw.type) return null;
    if (raw.type !== 'amount') return _rtOptionLabel(fieldDef.typeOptions, raw.type, lang);
    if (raw.value == null || raw.value === '') return null;
    var money = _rtFormatMoney(raw.value, raw.currency);
    if (money == null) return null;
    var period = _RT_AMOUNT_PERIOD_SUFFIX[fieldDef.amountPeriod];
    return period ? (money + ' ' + (period[lang] || period.en)) : money;
  },
  utility: function(fieldDef, raw, lang) {
    if (!raw || !raw.type) return null;
    var label = _rtOptionLabel(fieldDef.typeOptions, raw.type, lang);
    return raw.rate ? (label + ' (' + raw.rate + ')') : label;
  },
  select: function(fieldDef, raw, lang) {
    if (!raw) return null;
    return _rtOptionLabel(fieldDef.options, raw, lang);
  },
  checkbox_ref: function(fieldDef, raw, lang) {
    if (!Array.isArray(raw) || !raw.length) return null;
    var registry = (fieldDef.registry === 'RENTAL_SERVICES') ? RENTAL_SERVICES : {};
    return raw.map(function(key) {
      var entry = registry[key];
      return entry ? (entry[lang] || entry.en) : key;
    }).join(', ');
  },
  fee_list: function(fieldDef, raw, lang) {
    if (!Array.isArray(raw) || !raw.length) return null;
    // A fee's `amount` is free text entered by staff ("$50", "200,000 LAK")
    // -- it carries its own currency inline, the same convention
    // properties.price_display already uses, so it is never re-formatted
    // through _rtFormatMoney() here. Previously the amount was dropped
    // entirely (label only), and the multi-fee count was hardcoded English.
    if (raw.length === 1) {
      var f = raw[0];
      return f.amount ? (f.label + ': ' + f.amount) : f.label;
    }
    var more = { en: ' fees', lo: ' ລາຍການຄ່າທຳນຽມ', zh: ' 项费用' };
    return raw.length + (more[lang] || more.en);
  }
};

// formatRentalTermValue() -- used by admin.html's collapsed Unit Type card
// summary to show resolved VALUES (not just field names) for overridden
// fields, in registry order, e.g. "Deposit: 1 Month".
function formatRentalTermValue(fieldKey, rawValue, lang) {
  lang = lang || 'en';
  var fieldDef = null;
  for (var i = 0; i < RENTAL_TERMS_FIELDS.length; i++) {
    if (RENTAL_TERMS_FIELDS[i].key === fieldKey) { fieldDef = RENTAL_TERMS_FIELDS[i]; break; }
  }
  if (!fieldDef) return null;
  var formatter = RENTAL_TERM_KIND_FORMATTERS[fieldDef.kind];
  var formatted = formatter ? formatter(fieldDef, rawValue, lang) : null;
  if (formatted == null) return null;
  return (fieldDef.label[lang] || fieldDef.label.en) + ': ' + formatted;
}

// Collapsed-card summary: top N overridden fields by registry order, with
// intelligent truncation ("+N more"). Pure, portable, no DOM.
function summarizeRentalTermOverrides(overriddenKeys, values, lang, maxShown) {
  lang = lang || 'en';
  maxShown = maxShown || 3;
  var orderedKeys = RENTAL_TERMS_FIELDS
    .map(function(f) { return f.key; })
    .filter(function(k) { return overriddenKeys.indexOf(k) !== -1; });
  var lines = [];
  for (var i = 0; i < orderedKeys.length && lines.length < maxShown; i++) {
    var line = formatRentalTermValue(orderedKeys[i], values[orderedKeys[i]], lang);
    if (line) lines.push(line);
  }
  var remaining = orderedKeys.length - lines.length;
  if (remaining > 0) lines.push('+' + remaining + ' more');
  return lines;
}

// ---------------------------------------------------------------------------
// Admin rendering -- DOM-touching, browser-only (unlike the resolver/
// formatter functions above, which stay portable per this file's header).
// Kept generic over `kind`, never over field key (rule 4).
//
// Every renderer below takes `lang` as its final argument, defaulting to
// 'en' when omitted -- admin.html (the original, only caller before this)
// never passes it, so its output is byte-for-byte unchanged. add-property.
// html/edit-listing.html pass 'lo' so the self-service portal can reuse
// this exact renderer instead of hand-rolling a second, partial one (which
// is how those two pages ended up exposing only Deposit in the first
// place -- see the Rental Terms listing_type refactor).
// ---------------------------------------------------------------------------

// Renderer-chrome strings (placeholders, static option labels) that aren't
// part of RENTAL_TERMS_FIELDS itself -- kept here, not duplicated per
// caller, so add-property.html/edit-listing.html get the same trilingual
// treatment as every registry-driven label without a second copy of this
// text living in either HTML file.
var _RT_CHROME = {
  selectPlaceholder: { en: '— select —', lo: '— ເລືອກ —', zh: '— 请选择 —' },
  blank:             { en: '—', lo: '—', zh: '—' },
  rateOptional:      { en: 'Rate (optional)', lo: 'ອັດຕາ (ຖ້າມີ)', zh: '费率（可选）' },
  feeName:           { en: 'Fee name', lo: 'ຊື່ຄ່າທຳນຽມ', zh: '费用名称' },
  amount:            { en: 'Amount', lo: 'ຈຳນວນ', zh: '金额' },
  oneTime:           { en: 'One-Time', lo: 'ເທື່ອດຽວ', zh: '一次性' },
  monthly:           { en: 'Monthly', lo: 'ລາຍເດືອນ', zh: '每月' },
  addFee:            { en: '+ Add Fee', lo: '+ ເພີ່ມຄ່າທຳນຽມ', zh: '+ 添加费用' },
  monthlyAmountHint: { en: 'per month', lo: 'ຕໍ່ເດືອນ', zh: '每月' }
};
function _rtChrome(key, lang) { return (_RT_CHROME[key][lang] || _RT_CHROME[key].en); }

var RENTAL_TERM_KIND_RENDERERS = {
  money_multiplier: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var row = document.createElement('div');
    row.className = 'rt-field rt-field-money';
    var typeSel = document.createElement('select');
    typeSel.className = 'form-input rt-input';
    // Explicit placeholder FIRST. Without it the select silently sits on
    // whichever option happens to be first ('Months of rent'), so a staff
    // member who types a plain amount and never opens the dropdown saves a
    // rent multiplier. That is the data-entry half of the "Deposit: 100
    // Months" bug -- the formatter change alone would not have prevented it.
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = _rtChrome('selectPlaceholder', lang);
    typeSel.appendChild(ph);
    fieldDef.typeOptions.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label[lang] || opt.label.en;
      if (value && value.type === opt.value) o.selected = true;
      typeSel.appendChild(o);
    });
    if (!value || !value.type) ph.selected = true;

    var numInput = document.createElement('input');
    numInput.type = 'number'; numInput.min = '0'; numInput.className = 'form-input rt-input';
    numInput.value = (value && value.value != null) ? value.value : '';

    var curSel = document.createElement('select');
    curSel.className = 'form-input rt-input';
    Object.keys(CURRENCIES).forEach(function(code) {
      var o = document.createElement('option');
      o.value = code; o.textContent = CURRENCIES[code].symbol + ' ' + code;
      curSel.appendChild(o);
    });
    curSel.value = (value && value.currency) || DEFAULT_CURRENCY;

    // Currency is meaningless for a rent multiplier -- "2 months' rent"
    // inherits whatever currency the rent itself is quoted in.
    function syncCurrency() { curSel.style.display = (typeSel.value === 'months_of_rent') ? 'none' : ''; }
    function emit() {
      syncCurrency();
      var v = numInput.value === '' ? null : parseFloat(numInput.value);
      if (v == null) { onChange(fieldDef.key, null); return; }
      // An amount typed with no type chosen is money, not a duration --
      // same safe-direction rule the formatter uses.
      var out = { type: typeSel.value || 'fixed_amount', value: v };
      if (out.type !== 'months_of_rent') out.currency = curSel.value;
      onChange(fieldDef.key, out);
    }
    typeSel.onchange = emit; numInput.oninput = emit; curSel.onchange = emit;
    syncCurrency();
    row.appendChild(typeSel); row.appendChild(numInput); row.appendChild(curSel);
    return row;
  },
  // The one kind with a CONDITIONAL control: the amount inputs exist in the
  // DOM only conceptually -- they are hidden until 'Amount' is chosen, so
  // 'Included' never presents an empty money box to fill in. This reveal is
  // the genuinely new interaction model that justifies a new kind rather than
  // bending `utility` (whose free-text `rate` is always visible and is not
  // machine-readable) or `money_multiplier` (which has no "no amount at all"
  // state). Everything else -- currency list, class names, onChange contract
  // -- matches the existing renderers exactly.
  included_or_amount: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var row = document.createElement('div');
    row.className = 'rt-field rt-field-included-amount';

    var typeSel = document.createElement('select');
    typeSel.className = 'form-input rt-input';
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = _rtChrome('selectPlaceholder', lang);
    typeSel.appendChild(ph);
    fieldDef.typeOptions.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label[lang] || opt.label.en;
      if (value && value.type === opt.value) o.selected = true;
      typeSel.appendChild(o);
    });
    if (!value || !value.type) ph.selected = true;

    var numInput = document.createElement('input');
    numInput.type = 'number'; numInput.min = '0'; numInput.className = 'form-input rt-input';
    numInput.value = (value && value.value != null) ? value.value : '';
    // The label a data-entry person reads while typing. Without it "15" in a
    // box next to a currency is ambiguous between a monthly charge and a
    // one-off one -- the same class of ambiguity that produced
    // "Deposit: 100 Months" before the money_multiplier fix.
    var periodHint = document.createElement('span');
    periodHint.className = 'rt-period-hint';
    periodHint.textContent = _rtChrome('monthlyAmountHint', lang);

    var curSel = document.createElement('select');
    curSel.className = 'form-input rt-input';
    Object.keys(CURRENCIES).forEach(function(code) {
      var o = document.createElement('option');
      o.value = code; o.textContent = CURRENCIES[code].symbol + ' ' + code;
      curSel.appendChild(o);
    });
    curSel.value = (value && value.currency) || DEFAULT_CURRENCY;

    function syncAmountVisibility() {
      var show = typeSel.value === 'amount';
      numInput.style.display = show ? '' : 'none';
      curSel.style.display   = show ? '' : 'none';
      periodHint.style.display = show ? '' : 'none';
    }
    function emit() {
      syncAmountVisibility();
      if (!typeSel.value) { onChange(fieldDef.key, null); return; }
      if (typeSel.value !== 'amount') { onChange(fieldDef.key, { type: typeSel.value }); return; }
      // 'Amount' chosen but nothing typed yet is an INCOMPLETE answer, not a
      // free service -- store nothing rather than a 0 that would publish
      // "Trash Fee: $0 / month".
      var v = numInput.value === '' ? null : parseFloat(numInput.value);
      if (v == null || isNaN(v)) { onChange(fieldDef.key, null); return; }
      onChange(fieldDef.key, { type: 'amount', value: v, currency: curSel.value });
    }
    typeSel.onchange = emit; numInput.oninput = emit; curSel.onchange = emit;
    syncAmountVisibility();
    row.appendChild(typeSel); row.appendChild(numInput); row.appendChild(curSel); row.appendChild(periodHint);
    return row;
  },
  utility: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var row = document.createElement('div');
    row.className = 'rt-field rt-field-utility';
    var typeSel = document.createElement('select');
    typeSel.className = 'form-input rt-input';
    fieldDef.typeOptions.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label[lang] || opt.label.en;
      if (value && value.type === opt.value) o.selected = true;
      typeSel.appendChild(o);
    });
    var rateInput = document.createElement('input');
    rateInput.type = 'text'; rateInput.placeholder = _rtChrome('rateOptional', lang); rateInput.className = 'form-input rt-input';
    rateInput.value = (value && value.rate) ? value.rate : '';
    function emit() {
      onChange(fieldDef.key, typeSel.value ? { type: typeSel.value, rate: rateInput.value.trim() || null } : null);
    }
    typeSel.onchange = emit; rateInput.oninput = emit;
    row.appendChild(typeSel); row.appendChild(rateInput);
    return row;
  },
  select: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var sel = document.createElement('select');
    sel.className = 'form-input rt-input rt-field';
    var blank = document.createElement('option'); blank.value = ''; blank.textContent = _rtChrome('blank', lang);
    sel.appendChild(blank);
    fieldDef.options.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label[lang] || opt.label.en;
      if (value === opt.value) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function() { onChange(fieldDef.key, sel.value || null); };
    return sel;
  },
  checkbox_ref: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var wrap = document.createElement('div');
    wrap.className = 'rt-field rt-field-checkboxes';
    var registry = (fieldDef.registry === 'RENTAL_SERVICES') ? RENTAL_SERVICES : {};
    var current = Array.isArray(value) ? value.slice() : [];
    Object.keys(registry).forEach(function(key) {
      var label = document.createElement('label');
      label.className = 'rt-checkbox-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = current.indexOf(key) !== -1;
      cb.onchange = function() {
        current = cb.checked ? current.concat([key]) : current.filter(function(k) { return k !== key; });
        onChange(fieldDef.key, current.length ? current : null);
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + registry[key].icon + ' ' + (registry[key][lang] || registry[key].en)));
      wrap.appendChild(label);
    });
    return wrap;
  },
  fee_list: function(fieldDef, value, onChange, lang) {
    lang = lang || 'en';
    var wrap = document.createElement('div');
    wrap.className = 'rt-field rt-field-fees';
    var rows = Array.isArray(value) ? value.slice() : [];
    function redraw() {
      wrap.innerHTML = '';
      rows.forEach(function(fee, i) {
        var row = document.createElement('div');
        row.className = 'rt-fee-row';
        var labelInput = document.createElement('input');
        labelInput.type = 'text'; labelInput.placeholder = _rtChrome('feeName', lang); labelInput.className = 'form-input rt-input';
        labelInput.value = fee.label || '';
        var amountInput = document.createElement('input');
        amountInput.type = 'text'; amountInput.placeholder = _rtChrome('amount', lang); amountInput.className = 'form-input rt-input';
        amountInput.value = fee.amount || '';
        var freqSel = document.createElement('select');
        freqSel.className = 'form-input rt-input';
        ['one_time', 'monthly'].forEach(function(f) {
          var o = document.createElement('option'); o.value = f; o.textContent = f === 'one_time' ? _rtChrome('oneTime', lang) : _rtChrome('monthly', lang);
          if (fee.frequency === f) o.selected = true;
          freqSel.appendChild(o);
        });
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button'; removeBtn.textContent = '✕'; removeBtn.className = 'rt-fee-remove';
        function emit() {
          rows[i] = { label: labelInput.value.trim(), amount: amountInput.value.trim(), frequency: freqSel.value };
          onChange(fieldDef.key, rows.length ? rows : null);
        }
        labelInput.oninput = emit; amountInput.oninput = emit; freqSel.onchange = emit;
        removeBtn.onclick = function() { rows.splice(i, 1); onChange(fieldDef.key, rows.length ? rows : null); redraw(); };
        row.appendChild(labelInput); row.appendChild(amountInput); row.appendChild(freqSel); row.appendChild(removeBtn);
        wrap.appendChild(row);
      });
      var addBtn = document.createElement('button');
      addBtn.type = 'button'; addBtn.textContent = _rtChrome('addFee', lang); addBtn.className = 'rt-fee-add';
      addBtn.onclick = function() { rows.push({label:'', amount:'', frequency:'one_time'}); redraw(); };
      wrap.appendChild(addBtn);
    }
    redraw();
    return wrap;
  }
};

// renderRentalTermsFields(container, values, onChange, fieldKeys, lang) --
// the generic renderer every admin/self-service surface calls. Adding a
// field that fits an existing `kind` requires zero changes here (rule 4).
//
// fieldKeys (optional): renders only the given keys, in registry order,
// instead of every field in RENTAL_TERMS_FIELDS -- e.g. a page that only
// wants to expose Deposit passes ['deposit']. Omitting it (every existing
// caller) renders every field, unchanged from before this parameter
// existed -- this is filtering an already-generic renderer, not a new
// single-field special case (rule 4's actual concern), and every filtered
// caller still goes through the exact same per-`kind` renderer map as the
// full panel.
//
// lang (optional, default 'en'): admin.html never passes it, so its output
// is unchanged. add-property.html/edit-listing.html pass 'lo' -- this is
// what lets the self-service portal show the full field set (not just
// Deposit) without hand-rolling a second, English-hardcoded renderer.
function renderRentalTermsFields(container, values, onChange, fieldKeys, lang) {
  lang = lang || 'en';
  container.innerHTML = '';
  var fields = fieldKeys
    ? RENTAL_TERMS_FIELDS.filter(function(f) { return fieldKeys.indexOf(f.key) !== -1; })
    : RENTAL_TERMS_FIELDS;
  fields.forEach(function(fieldDef) {
    var row = document.createElement('div');
    row.className = 'form-field rt-row';
    var label = document.createElement('label');
    label.className = 'form-label';
    label.textContent = fieldDef.label[lang] || fieldDef.label.en;
    row.appendChild(label);
    var control = RENTAL_TERM_KIND_RENDERERS[fieldDef.kind](fieldDef, values[fieldDef.key], onChange, lang);
    row.appendChild(control);
    container.appendChild(row);
  });
}

// getRentalTermsFromDom(container) -- reads a container previously built by
// renderRentalTermsFields() back into a plain {key: value} object, by
// re-reading the same onChange-tracked state. In practice the admin page
// keeps a local `fieldValues` object updated live via onChange and passes
// it straight to buildRentalTermsPayload() -- this helper exists for
// completeness/symmetry and for any consumer that only has the DOM.
function getRentalTermsFromDom(fieldValues) {
  return buildRentalTermsPayload(fieldValues || {});
}
