/**
 * Normalises legacy short transaction_type values to canonical form.
 *
 *   'sale' → 'for_sale'   (legacy data; canonical value is 'for_sale')
 *   'rent' → 'for_rent'   (legacy data; canonical value is 'for_rent')
 *   anything else returned unchanged
 *
 * BUG FIXED: the original renderListings() filter compared
 *   p.transaction_type === currentFilter
 * directly, so a property with transaction_type='sale' would never match the
 * filter button value 'for_sale'. getBadgeHtml() and the isSale check in
 * renderListings() already accepted both values — this function makes the
 * filter consistent with that handling.
 *
 * @param {string|null|undefined} txType
 * @returns {string}
 */
export function normalizeTransactionType(txType) {
  if (txType === 'sale') return 'for_sale';
  if (txType === 'rent') return 'for_rent';
  return txType || '';
}

/**
 * Filters a properties array by the active filter value.
 *
 * Filter values used by the listings.html UI:
 *   'all'       → no filtering (returns same array reference)
 *   'for_sale'  → transaction_type 'for_sale' OR legacy 'sale'
 *   'for_rent'  → transaction_type 'for_rent' OR legacy 'rent'
 *   'house'     → property_type 'house'
 *   'villa'     → property_type 'villa'
 *   'apartment' → property_type 'apartment'
 *   'land'      → property_type 'land'
 *
 * @param {object[]} properties  Full properties array
 * @param {string}   filter      Active filter value
 * @returns {object[]}           Filtered array (may be same reference for 'all')
 */
export function filterProperties(properties, filter) {
  if (filter === 'all') return properties;
  return properties.filter(function(p) {
    var txNorm = normalizeTransactionType(p.transaction_type);
    return txNorm === filter || p.property_type === filter;
  });
}
