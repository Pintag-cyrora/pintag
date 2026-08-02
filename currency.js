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
//
// Price RANGES ("$280–300 / month") go through formatMoneyRange() — never
// hand-built by concatenating two formatMoney() calls with a comma or a
// plain string join, and never produced by digit-stripping a range of text
// down to one number (see parseLegacyPriceAmount()'s header for the exact
// corruption that causes — "$280,300" instead of a range).
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

// formatMoneyRange(min, max, currency) — the one place a price RANGE
// becomes a displayed string ("$280–300", "₭3,000,000–3,500,000"). A range
// uses ONE currency symbol (not one per side) and an en dash between the
// two numbers, each with its own thousands separators -- never a plain
// comma joining two full prices, which is indistinguishable from a single
// large number ("$280,300" reads as two hundred eighty thousand three
// hundred, not "$280 to $300"). Falls back to formatMoney() for a single
// value when only one side is present, and collapses to a single value
// when min===max (no range to show).
function formatMoneyRange(min, max, currency) {
  var minN = Number(min), maxN = Number(max);
  var hasMin = min != null && !isNaN(minN);
  var hasMax = max != null && !isNaN(maxN);
  if (!hasMin && !hasMax) return null;
  if (!hasMin) return formatMoney(maxN, currency);
  if (!hasMax || minN === maxN) return formatMoney(minN, currency);
  var cur = CURRENCIES[currency] || CURRENCIES[DEFAULT_CURRENCY];
  return cur.symbol + Math.round(minN).toLocaleString('en-US') + '–' + Math.round(maxN).toLocaleString('en-US');
}

// parseLegacyPriceAmount(text) — extracts a single numeric amount from a
// legacy free-text price string ("$550,000", "$1,200 / month"). Used only
// by the narrow set of callers that still need a plain number out of
// unstructured text: sorting/filtering a row that predates the structured
// pricing migration and was never backfilled, or best-effort parsing
// freshly-imported text before structured fields exist (Smart Import).
//
// A price RANGE ("$280-300", "$1,200 to $1,500") is detected FIRST and
// resolved to its lower bound -- the same "starting from" convention
// admin.html's _utComputeRange() already uses for Unit Type ranges --
// instead of being digit-stripped as a whole. Stripping a range naively
// (removing everything but digits) concatenates the two numbers into one
// bogus value: "280-300" -> "280300" -> later formatted as "$280,300",
// which is exactly the corrupted-range display bug this function exists to
// prevent at the source. Returns null when nothing numeric is found.
function parseLegacyPriceAmount(text) {
  if (!text) return null;
  var str = String(text);
  var rangeMatch = str.match(/([\d,]+(?:\.\d+)?)\s*(?:-|–|—|to)\s*[^\d]*([\d,]+(?:\.\d+)?)/i);
  if (rangeMatch) {
    var lo = parseFloat(rangeMatch[1].replace(/,/g, ''));
    return isNaN(lo) ? null : lo;
  }
  var digits = str.replace(/[^0-9.]/g, '');
  if (digits === '') return null;
  var n = parseFloat(digits);
  return isNaN(n) ? null : n;
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
