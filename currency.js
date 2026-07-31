// currency.js — the single source of truth for supported currencies and
// how monetary values are formatted. Every monetary value in Pintag reads
// currency metadata from here: rental_terms fields (deposit, cleaning
// deposit, advance rent, additional fees), the structured
// properties.price_amount/rent_price_amount, and budget-bands.js's preset
// ranges. Adding a currency later means one entry here, not N copies
// scattered across files — this consolidates what used to be
// rental-terms.js's own private RENTAL_CURRENCIES registry (nothing else
// in the repo referenced that name, confirmed by a full-repo grep before
// this consolidation, so folding it into one shared file was safe).
//
// Same loading convention as terminology.js/amenities.js/rental-terms.js:
// plain global vars, no build step, <script src="currency.js"> before any
// file that references CURRENCIES/DEFAULT_CURRENCY/formatMoney() —
// including rental-terms.js itself, which now loads this file first.
//
// ============================================================================
// ARCHITECTURAL RULE — read before touching this file
// ============================================================================
// This is the ONLY place currency symbols, codes, or formatting rules are
// defined. No other file may hardcode a currency symbol ('$', '₭', '฿') or
// a currency code list — every consumer (rental-terms.js, the structured
// price fields, budget-bands.js, admin.html/add-property.html/
// edit-listing.html's currency selectors, listings.html/listing.html's
// price rendering) reads CURRENCIES/formatMoney() from here.
// ============================================================================

var CURRENCIES = {
  USD: { symbol: '$', code: 'USD', label: { en: 'US Dollar', lo: 'ໂດລາສະຫະລັດ', zh: '美元' } },
  LAK: { symbol: '₭', code: 'LAK', label: { en: 'Lao Kip',   lo: 'ກີບລາວ',      zh: '老挝基普' } },
  THB: { symbol: '฿', code: 'THB', label: { en: 'Thai Baht', lo: 'ບາດໄທ',       zh: '泰铢' } }
};
var DEFAULT_CURRENCY = 'USD';

// formatMoney(amount, currency) — the one place a raw number becomes a
// displayed price string ("$550,000", "₭2,500,000"). Whole-number
// formatting throughout: real-estate prices in this market are never
// quoted with cents/satang, matching the precedent already set by
// rental-terms.js's own money formatter before this consolidation.
function formatMoney(amount, currency) {
  var cur = CURRENCIES[currency] || CURRENCIES[DEFAULT_CURRENCY];
  var n = Number(amount);
  if (amount == null || isNaN(n)) return null;
  return cur.symbol + Math.round(n).toLocaleString('en-US');
}

// currencySymbol(currency) / currencyCode(currency) — small accessors so
// consumers never destructure CURRENCIES[x] directly and risk a typo'd
// fallback; both default to DEFAULT_CURRENCY when the key is unknown/null.
function currencySymbol(currency) {
  return (CURRENCIES[currency] || CURRENCIES[DEFAULT_CURRENCY]).symbol;
}
function currencyCode(currency) {
  return (CURRENCIES[currency] || CURRENCIES[DEFAULT_CURRENCY]).code;
}

// price_frequency vocabulary shared by every structured-price UI (admin.html/
// add-property.html/edit-listing.html) and every reader that derives legacy
// display text from it. 'one_time' is deliberately excluded from the option
// list -- every consumer only ever shows this list for a rental context
// (a sale's frequency is hardcoded to 'one_time' at save time) so the
// select never needs to offer it.
var PRICE_FREQUENCY_OPTIONS = [
  { value: 'monthly',    label: 'Monthly' },
  { value: 'yearly',     label: 'Yearly' },
  { value: 'weekly',     label: 'Weekly' },
  { value: 'daily',      label: 'Daily' },
  { value: 'negotiable', label: 'Negotiable' }
];
var LEGACY_FREQUENCY_SUFFIX = { monthly: ' / month', yearly: ' / year', weekly: ' / week', daily: ' / day', negotiable: ' (negotiable)' };

// deriveLegacyPriceFields(amount, currency, frequency) -- computes the
// legacy price_display-shaped text ("$550,000", "$1,200 / month") from a
// structured value. The one place every writer (admin.html/add-property.html/
// edit-listing.html) builds the backwards-compatible display text every
// not-yet-migrated reader still depends on, so the format is defined
// exactly once rather than reimplemented per page.
function deriveLegacyPriceFields(amount, currency, frequency) {
  var text = formatMoney(amount, currency);
  if (text == null) return null;
  if (frequency && frequency !== 'one_time') text += (LEGACY_FREQUENCY_SUFFIX[frequency] || '');
  return text;
}
