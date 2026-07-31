// budget-bands.js — the single place preset Budget-filter ranges are
// defined, so tuning them for the Lao market later never means touching
// listings.html's search UI or filtering logic. Same loading convention as
// terminology.js/amenities.js/currency.js: plain global vars, no build
// step, <script src="currency.js"> then <script src="budget-bands.js">
// (band labels are formatted through currency.js's formatMoney(), so it
// must load first).
//
// ============================================================================
// ARCHITECTURAL RULES
// ============================================================================
// 1. BUDGET_BANDS is the single source of truth for preset ranges. No
//    consumer (listings.html today; any future page) may hardcode a
//    budget number or invent its own range list.
// 2. Bands are keyed by (kind, currency) where kind is 'rent' or 'sale' --
//    NOT by raw transaction_type, so the mapping from a listing's
//    transaction_type/currentTxFilter value to a band set lives in exactly
//    one function, getBudgetBands(), rather than being re-derived by every
//    caller. 'sale_or_rent' and the "All" filter both use the 'sale' set
//    (the wider of the two ranges) -- see getBudgetBands()'s own comment.
// 3. "Any Budget" is NOT a band in this file. It's the universal
//    no-filter-applied default every preset-filter UI in this app already
//    has (mirrors "All Types"/"All Listings" elsewhere in listings.html),
//    so it's a UI-layer concept, not a numeric range -- callers prepend it
//    themselves. BUDGET_ANY_ID is exported as the one shared sentinel
//    value so every caller uses the same id instead of each inventing
//    'any'/'all'/null independently.
// 4. Ranges here are v1 estimates for the Vientiane market, not sourced
//    from live listing data -- expected to be tuned in place as real usage
//    data comes in, without touching anything outside this file.
// 5. This file defines ranges only. Matching a specific listing's price
//    against a band (bandContains) and formatting a band's label
//    (formatBudgetLabel) are pure functions here too, so listings.html's
//    filter predicate and its UI rendering both stay one line each.
// ============================================================================

var BUDGET_ANY_ID = 'any';

var BUDGET_BANDS = {
  rent: {
    // Monthly rent, in each currency's own typical unit.
    USD: [
      { id: 'under_300',   min: null, max: 300  },
      { id: '300_600',     min: 300,  max: 600  },
      { id: '600_1000',    min: 600,  max: 1000 },
      { id: '1000_2000',   min: 1000, max: 2000 },
      { id: '2000_plus',   min: 2000, max: null }
    ],
    LAK: [
      { id: 'under_3m',    min: null,     max: 3000000  },
      { id: '3m_6m',       min: 3000000,  max: 6000000  },
      { id: '6m_12m',      min: 6000000,  max: 12000000 },
      { id: '12m_20m',     min: 12000000, max: 20000000 },
      { id: '20m_plus',    min: 20000000, max: null }
    ],
    THB: [
      { id: 'under_10k',   min: null,   max: 10000 },
      { id: '10k_20k',     min: 10000,  max: 20000 },
      { id: '20k_35k',     min: 20000,  max: 35000 },
      { id: '35k_70k',     min: 35000,  max: 70000 },
      { id: '70k_plus',    min: 70000,  max: null }
    ]
  },
  sale: {
    USD: [
      { id: 'under_50k',   min: null,   max: 50000  },
      { id: '50k_150k',    min: 50000,  max: 150000 },
      { id: '150k_300k',   min: 150000, max: 300000 },
      { id: '300k_600k',   min: 300000, max: 600000 },
      { id: '600k_plus',   min: 600000, max: null }
    ],
    LAK: [
      { id: 'under_500m',  min: null,      max: 500000000   },
      { id: '500m_1.5b',   min: 500000000, max: 1500000000  },
      { id: '1.5b_3b',     min: 1500000000,max: 3000000000  },
      { id: '3b_6b',       min: 3000000000,max: 6000000000  },
      { id: '6b_plus',     min: 6000000000,max: null }
    ],
    THB: [
      { id: 'under_1.5m',  min: null,     max: 1500000  },
      { id: '1.5m_4.5m',   min: 1500000,  max: 4500000  },
      { id: '4.5m_9m',     min: 4500000,  max: 9000000  },
      { id: '9m_18m',      min: 9000000,  max: 18000000 },
      { id: '18m_plus',    min: 18000000, max: null }
    ]
  }
};

// getBudgetBands(transactionType, currency) — the one place a listing's
// transaction_type (or the search page's currentTxFilter) maps to a band
// set. 'for_rent' -> rent bands; everything else ('for_sale',
// 'sale_or_rent', 'all', undefined) -> sale bands. Falls back to USD if an
// unsupported currency is passed.
function getBudgetBands(transactionType, currency) {
  var kind = transactionType === 'for_rent' ? 'rent' : 'sale';
  var byCurrency = BUDGET_BANDS[kind];
  return byCurrency[currency] || byCurrency[DEFAULT_CURRENCY];
}

// bandContains(band, amount) — true when a numeric amount falls inside a
// band's [min, max) range. min===null means "no floor" (the "Under X"
// band); max===null means "no ceiling" (the "X+" band). amount must
// already be in the band's own currency -- this function does no
// currency conversion (Pintag has no live FX rate source; see the
// pricing-architecture design notes).
function bandContains(band, amount) {
  if (amount == null || isNaN(Number(amount))) return false;
  var n = Number(amount);
  if (band.min != null && n < band.min) return false;
  if (band.max != null && n >= band.max) return false;
  return true;
}

// formatBudgetLabel(band, currency, lang) — "Under $300" / "$300 – $600" /
// "₭20,000,000+", trilingual. The only place this phrasing is defined.
var _BUDGET_LABEL_TEMPLATES = {
  under: { en: 'Under {x}',   lo: 'ຕ່ຳກວ່າ {x}',  zh: '低于 {x}' },
  range: { en: '{x} – {y}',   lo: '{x} – {y}',    zh: '{x} – {y}' },
  plus:  { en: '{x}+',        lo: '{x}+',         zh: '{x}+' }
};
function formatBudgetLabel(band, currency, lang) {
  lang = lang || 'en';
  var x = formatMoney(band.min, currency);
  var y = formatMoney(band.max, currency);
  var t;
  if (band.min == null) { t = _BUDGET_LABEL_TEMPLATES.under; return (t[lang] || t.en).replace('{x}', y); }
  if (band.max == null) { t = _BUDGET_LABEL_TEMPLATES.plus;  return (t[lang] || t.en).replace('{x}', x); }
  t = _BUDGET_LABEL_TEMPLATES.range;
  return (t[lang] || t.en).replace('{x}', x).replace('{y}', y);
}

// "Any Budget" label -- exported alongside BUDGET_ANY_ID so callers never
// hardcode this phrase either.
var BUDGET_ANY_LABEL = { en: 'Any Budget', lo: 'ງົບປະມານໃດກໍ່ໄດ້', zh: '任意预算' };
