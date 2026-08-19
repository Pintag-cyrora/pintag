// lease-pricing.js — the single source of truth for RENTAL TERM pricing:
// the Daily rate and the 3-/6-/12-month lease tiers, at both the building
// level and the unit-type level.
//
// Same loading convention as currency.js/terminology.js/rental-terms.js:
// plain global vars, no build step, <script src="lease-pricing.js"> after
// currency.js (the only file this one depends on) and before any page's own
// inline <script>. Written dependency-free — no `document`/`window` in the
// registry, resolver or formatters — so the identical file is includable from
// a browser <script> tag AND a Deno edge function, which is required because
// AI-generated copy must read the SAME resolved rates a visitor sees rather
// than re-deriving them in a second runtime and drifting.
//
// ============================================================================
// ARCHITECTURAL RULES — read before touching this file or adding a term
// ============================================================================
//
// 1. LEASE_TERMS is the single source of truth for lease-term metadata:
//    the column each term reads, its labels (en/lo/zh), its display order,
//    and how its amount is quoted. No other file may define any of these.
//
// 2. Display order comes from LEASE_TERMS' array order (shortest commitment
//    first: daily → monthly → 3 → 6 → 12). Never re-sort in a consumer.
//
// 3. resolveLeasePricing() is the ONLY public read API. No code outside this
//    file may read properties/unit_types.rent_price_daily/_3mo/_6mo/_12mo or
//    lease_price_basis directly — not admin.html, not listing.html, not an
//    edge function. A future helper must call resolveLeasePricing() and read
//    its `.terms`, never re-open the columns as a shortcut.
//
// 4. Adding a term (a 24-month tier, a weekly rate) is ONE entry in
//    LEASE_TERMS plus its column in a migration. It must NOT require a change
//    to resolveLeasePricing(), formatLeaseTermAmount(), buildLeasePricingLines()
//    or any consumer. If it does, the registry design has broken down for that
//    term — fix the registry, don't special-case it in a consumer.
//
// 5. Resolver purity: resolveLeasePricing() never mutates `property`, never
//    mutates `unitType`, and never writes anything back. Resolution is
//    read-time only.
//
// 6. The return shape is a frozen contract: { version, basis, currency,
//    source, baseAmount, terms, hasTiers }. `terms` only ever contains terms
//    that have a real amount — a consumer renders what it is handed and never
//    invents a rate for a missing duration.
//
// 7. NO ARITHMETIC. This module never computes a total from a monthly rate,
//    never computes a monthly rate from a total, never interpolates a missing
//    tier, and never derives a daily rate from a monthly one. Every figure
//    shown is a figure a human typed. This is the whole reason the `basis`
//    flag is carried through to display instead of being normalized away:
//    normalizing would require exactly the arithmetic that turns a quoted
//    price into an invented one.
//
// 8. Tiers DO NOT INHERIT PER COLUMN. This is the one deliberate departure
//    from the null-means-inherit-the-building contract every other unit_types
//    column follows (resolveUnitType(), terminology.js), and it is a
//    correctness rule, not a style choice: a tier is a discount quoted
//    against a SPECIFIC base rent. Pairing the building's "3 months:
//    $420/month" (quoted against its $450 base) with the 2BR's own $700 base
//    would publish a combination no landlord ever agreed to. A unit type
//    therefore shows its OWN tiers or none at all. Only `basis` — a quoting
//    convention, not a price — falls back to the building's.
//
// 9. Daily is per-day, always. `basis` governs the 3/6/12-month tiers only.
//    There is no coherent reading of "a daily rate quoted as a whole-lease
//    total", and letting basis reach it would make $45 mean either $45/day or
//    $45 for an unspecified stay. LEASE_TERMS marks this with `perDay:true`;
//    formatLeaseTermAmount() honours it unconditionally.
//
// 10. This is PRICING (operational data) and stays in flat relational columns,
//     like every other price in this schema. It is deliberately NOT in the
//     rental_terms JSONB — see rental-terms.js rule 9 for that boundary. The
//     two modules must stay independent: neither may reference the other.
// ============================================================================

var LEASE_PRICING_SCHEMA_VERSION = 1;

// The two ways the 3/6/12-month amounts can be quoted. 'monthly' is the
// default and the common case ("3 months = $420/month"); 'total' exists
// because some landlords quote the whole-lease figure instead, and guessing
// which one a number meant is exactly the ambiguity this flag removes.
var LEASE_BASIS_OPTIONS = [
  { value: 'monthly', label: { en: 'Monthly (per month)',  lo: 'ຕໍ່ເດືອນ',           zh: '每月' } },
  { value: 'total',   label: { en: 'Total for the lease',  lo: 'ລວມທັງສັນຍາ',        zh: '整个租期总额' } }
];
var LEASE_DEFAULT_BASIS = 'monthly';

// LEASE_TERMS — the registry (rule 1). Array order = display order (rule 2).
//
//   key      stable identifier, safe to persist/reference
//   column   the numeric column on properties AND unit_types. null for
//            'monthly', whose amount is the row's existing BASE rent
//            (price_amount / rent_price_amount) — deliberately no new column,
//            so a single-price listing is untouched by this feature.
//   perDay   true only for 'daily'; forces a per-day suffix regardless of
//            basis (rule 9).
//   basisApplies  whether `basis` decides how the amount reads. False for
//            daily (per-day) and for monthly (the base rent is always a
//            per-month figure).
var LEASE_TERMS = [
  { key: 'daily',   column: 'rent_price_daily', months: null, perDay: true,  basisApplies: false,
    label: { en: 'Daily',    lo: 'ຕໍ່ມື້',    zh: '每日' } },
  { key: 'monthly', column: null,               months: 1,    perDay: false, basisApplies: false,
    label: { en: '1 month',  lo: '1 ເດືອນ',  zh: '1个月' } },
  { key: '3mo',     column: 'rent_price_3mo',   months: 3,    perDay: false, basisApplies: true,
    label: { en: '3 months', lo: '3 ເດືອນ',  zh: '3个月' } },
  { key: '6mo',     column: 'rent_price_6mo',   months: 6,    perDay: false, basisApplies: true,
    label: { en: '6 months', lo: '6 ເດືອນ',  zh: '6个月' } },
  { key: '12mo',    column: 'rent_price_12mo',  months: 12,   perDay: false, basisApplies: true,
    label: { en: '1 year',   lo: '1 ປີ',     zh: '1年' } }
];

// The tier columns only — every LEASE_TERMS entry that has a column of its
// own. Save/load paths iterate this instead of hardcoding three column names,
// so rule 4 holds for them too.
var LEASE_TIER_COLUMNS = LEASE_TERMS
  .filter(function (t) { return t.column; })
  .map(function (t) { return t.column; });

function leaseTermByKey(key) {
  for (var i = 0; i < LEASE_TERMS.length; i++) {
    if (LEASE_TERMS[i].key === key) return LEASE_TERMS[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Suffix vocabulary. Deliberately its OWN table rather than a reach into
// components.js's PT_FREQUENCY_SUFFIX: components.js is browser-only page
// furniture, and this file has to stay importable from a Deno edge function
// (see the header). The two tables agree on wording by review, and the
// lease-pricing.test.js suite pins that agreement so they cannot drift.
// ---------------------------------------------------------------------------
var LEASE_SUFFIX_PER_DAY   = { en: '/ day',   lo: '/ ມື້',    zh: '/ 天' };
var LEASE_SUFFIX_PER_MONTH = { en: '/ month', lo: '/ ເດືອນ',  zh: '/ 月' };
var LEASE_SUFFIX_TOTAL     = { en: 'total',   lo: 'ລວມ',      zh: '总计' };

function _lpText(table, lang) { return table[lang] || table.en; }

// A number is a real amount only when it is a finite number. '' , null,
// undefined and NaN all mean "this duration is not offered" and must resolve
// to nothing at all rather than to 0 — a $0 lease rate would read as free.
function _lpAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  var n = Number(raw);
  return isFinite(n) ? n : null;
}

function _lpBasis(raw) {
  return raw === 'total' ? 'total' : LEASE_DEFAULT_BASIS;
}

// Lease pricing only exists for a RENTAL. On a for_sale row price_amount is a
// sale price, so without this gate a sale listing would resolve to
// "1 month — $250,000 / month", and a stale tier column left behind by a
// listing that switched from rent to sale would publish a rental rate on a
// sale listing.
//
// This duplicates the two-value check isRentalTransactionType() owns in
// rental-terms.js, deliberately: rule 10 forbids these two modules from
// referencing each other, and a one-line predicate is a smaller price than a
// cross-module dependency. lease-pricing.test.js pins that the two agree on
// every transaction type, so the duplication cannot drift silently.
function _lpIsRental(transactionType) {
  return transactionType === 'for_rent' || transactionType === 'sale_or_rent';
}

// The base per-month rent for a row, following the exact convention
// 20260731000000_structured_pricing established and 20260808000000 reused:
// price_amount is the rent for a pure for_rent row, and the SALE leg for a
// sale_or_rent row (whose rent lives in rent_price_amount).
function _lpBaseRent(row, transactionType) {
  if (!row) return { amount: null, currency: null };
  if (transactionType === 'sale_or_rent') {
    return { amount: _lpAmount(row.rent_price_amount), currency: row.rent_price_currency || null };
  }
  return { amount: _lpAmount(row.price_amount), currency: row.price_currency || null };
}

// ---------------------------------------------------------------------------
// resolveLeasePricing(property, unitType) — the sole public read API (rule 3).
// Pure (rule 5). Frozen contract (rule 6). No arithmetic (rule 7).
//
// unitType null/omitted  → the BUILDING's own lease pricing.
// unitType given         → THAT unit type's lease pricing, per rule 8: its own
//                          tier amounts (never the building's), its own base
//                          rent where it has one, and the building's `basis`
//                          only when the unit has not chosen one itself.
//
// Returns terms in registry order, containing ONLY durations that actually
// have an amount. A row with no daily rate and no tiers resolves to just its
// base monthly rent (hasTiers:false) — which is what every listing in the
// database looks like today, and is why this feature is invisible until
// someone fills a field in.
// ---------------------------------------------------------------------------
function resolveLeasePricing(property, unitType) {
  var prop = property || {};
  var transactionType = prop.transaction_type;
  var source = unitType ? 'unit_type' : 'property';
  var row = unitType || prop;

  // Base (1-month) rent. A unit type with no price of its own inherits the
  // building's — that is the ordinary null-means-inherit contract, and it is
  // safe here because the base rent is a standalone price, not a discount
  // quoted against another number (contrast rule 8).
  var base = _lpBaseRent(row, transactionType);
  if (unitType && base.amount === null) base = _lpBaseRent(prop, transactionType);

  // Basis: the unit's own when it set one, else the building's. A convention,
  // never a price (rule 8).
  var basis = _lpBasis(row.lease_price_basis || (unitType ? prop.lease_price_basis : null));

  var currency = base.currency
    || row.price_currency || row.rent_price_currency
    || prop.price_currency || prop.rent_price_currency
    || (typeof DEFAULT_CURRENCY !== 'undefined' ? DEFAULT_CURRENCY : 'USD');

  var terms = [];
  var hasTiers = false;
  var isRental = _lpIsRental(transactionType);
  for (var i = 0; isRental && i < LEASE_TERMS.length; i++) {
    var def = LEASE_TERMS[i];
    var amount = def.column ? _lpAmount(row[def.column]) : base.amount;
    if (amount === null) continue;
    if (def.column) hasTiers = true;
    terms.push({
      key: def.key,
      label: def.label,
      months: def.months,
      amount: amount,
      // Pre-resolved per term so a consumer never re-implements rule 9's
      // "basis does not reach daily" carve-out.
      isPerDay: !!def.perDay,
      isTotal: !!(def.basisApplies && basis === 'total')
    });
  }

  return {
    version: LEASE_PRICING_SCHEMA_VERSION,
    basis: basis,
    currency: currency,
    source: source,
    baseAmount: isRental ? base.amount : null,
    terms: terms,
    hasTiers: hasTiers
  };
}

// ---------------------------------------------------------------------------
// Formatting. Generic over term (rule 4) — nothing below names a duration.
// ---------------------------------------------------------------------------

// formatLeaseTermAmount(term, currency, lang) -> "$420 / month" | "$45 / day"
// | "$2,400 total". The money itself goes through currency.js's formatMoney(),
// the one place a number becomes a price string.
function formatLeaseTermAmount(term, currency, lang) {
  lang = lang || 'en';
  if (!term || term.amount == null) return null;
  var money = (typeof formatMoney === 'function')
    ? formatMoney(term.amount, currency)
    : String(term.amount);
  if (money == null) return null;
  var suffix = term.isPerDay ? LEASE_SUFFIX_PER_DAY
             : term.isTotal  ? LEASE_SUFFIX_TOTAL
             : LEASE_SUFFIX_PER_MONTH;
  return money + ' ' + _lpText(suffix, lang);
}

// formatLeaseTermLine(term, currency, lang) -> "3 months — $420 / month".
// The em dash separator is fixed here so every surface (admin preview, the
// public listing page, the AI prompt) reads identically.
function formatLeaseTermLine(term, currency, lang) {
  lang = lang || 'en';
  var amountText = formatLeaseTermAmount(term, currency, lang);
  if (!amountText) return null;
  return _lpText(term.label, lang) + ' — ' + amountText;
}

// buildLeasePricingLines(resolved, lang) -> ["1 month — $450 / month", ...].
// The one function every display surface calls. Returns [] when there is
// nothing to show, so callers self-suppress the whole block rather than
// rendering an empty heading.
function buildLeasePricingLines(resolved, lang) {
  lang = lang || 'en';
  if (!resolved || !resolved.terms || !resolved.terms.length) return [];
  var out = [];
  for (var i = 0; i < resolved.terms.length; i++) {
    var line = formatLeaseTermLine(resolved.terms[i], resolved.currency, lang);
    if (line) out.push(line);
  }
  return out;
}

// hasLeaseTermPricing(property, unitType) — "is there more than a single flat
// rent here?", the question every consumer actually asks before deciding to
// render a lease-pricing block. A row with only its base monthly rent answers
// false, so nothing new appears on the ~all listings that have no tiers.
function hasLeaseTermPricing(property, unitType) {
  return resolveLeasePricing(property, unitType).hasTiers;
}

// buildLeasePricingPayload(values, basis) — the ONLY write path (rule 3),
// mirroring rental-terms.js's buildRentalTermsPayload(). `values` is a plain
// {termKey: amount} map straight off a form; the returned object is the exact
// set of columns to PATCH, with every unfilled tier explicitly null so
// clearing a field in the UI genuinely clears it in the database instead of
// silently leaving the old number behind.
//
// basis is stored ONLY when at least one basis-governed tier has an amount:
// no tiers ⇒ every column null ⇒ byte-for-byte today's single-price row.
function buildLeasePricingPayload(values, basis) {
  var vals = values || {};
  var out = {};
  var anyBasisGoverned = false;
  for (var i = 0; i < LEASE_TERMS.length; i++) {
    var def = LEASE_TERMS[i];
    if (!def.column) continue;               // 'monthly' has no column of its own
    var amount = _lpAmount(vals[def.key]);
    out[def.column] = amount;
    if (amount !== null && def.basisApplies) anyBasisGoverned = true;
  }
  out.lease_price_basis = anyBasisGoverned ? _lpBasis(basis) : null;
  return out;
}
