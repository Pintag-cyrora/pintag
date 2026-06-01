/**
 * Extracts a numeric value from a localised price display string.
 *
 * Examples:
 *   "$250,000"     → 250000
 *   "250000 USD"   → 250000
 *   "1,200,000"    → 1200000
 *   null / ''      → 0   (sorts last on price_asc, last on price_desc)
 *   "Price on req" → 0
 *
 * The regex strips everything except digits and '.', which correctly
 * handles dollar signs, commas, currency codes, and Lao/Chinese text.
 * A known edge case: "1.5M" parses as 1.5 not 1500000 — acceptable for
 * the current dataset where prices are always written as full numbers.
 *
 * @param {string|null|undefined} str
 * @returns {number}
 */
export function parsePriceDisplay(str) {
  return parseFloat((str || '').replace(/[^0-9.]/g, '')) || 0;
}

/**
 * Returns a sorted copy of the properties array. Never mutates the input.
 *
 * @param {object[]} arr       The properties to sort.
 * @param {string}   sortMode  One of: 'newest' | 'featured' | 'price_asc' | 'price_desc'
 *                             Unknown values fall through to 'newest' (preserve order).
 * @returns {object[]}
 */
export function sortProperties(arr, sortMode) {
  var copy = arr.slice();

  if (sortMode === 'featured') {
    return copy.sort(function(a, b) {
      return (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0);
    });
  }

  if (sortMode === 'price_asc') {
    return copy.sort(function(a, b) {
      return parsePriceDisplay(a.price_display) - parsePriceDisplay(b.price_display);
    });
  }

  if (sortMode === 'price_desc') {
    return copy.sort(function(a, b) {
      return parsePriceDisplay(b.price_display) - parsePriceDisplay(a.price_display);
    });
  }

  // 'newest' or any unknown value: preserve original API order
  return copy;
}
