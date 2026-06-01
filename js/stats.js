/**
 * Computes dashboard listing counts from a flat properties array.
 *
 * Mirrors the filter logic in dashboard.html renderStats().
 *
 * NOTE: Legacy transaction_type values 'sale' and 'rent' are intentionally
 * not counted here — this preserves parity with the existing dashboard.html
 * behaviour. If future data migration normalises all legacy values, this
 * function will automatically become accurate. To count legacy values too,
 * import normalizeTransactionType from filters.js.
 *
 * @param {object[]} properties  Array of property rows from Supabase
 * @returns {{ total: number, published: number, sale: number, rent: number }}
 */
export function computeStats(properties) {
  return {
    total:     properties.length,
    published: properties.filter(function(p) { return p.status === 'active'; }).length,
    sale:      properties.filter(function(p) { return p.transaction_type === 'for_sale'; }).length,
    rent:      properties.filter(function(p) { return p.transaction_type === 'for_rent'; }).length,
  };
}
