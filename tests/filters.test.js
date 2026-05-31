import { describe, it, expect } from 'vitest';
import { filterProperties, normalizeTransactionType } from '../js/filters.js';

// ── helpers ────────────────────────────────────────────────────────

const make = (overrides) => ({
  slug: 'test-' + Math.random().toString(36).slice(2, 6),
  status: 'active',
  transaction_type: 'for_sale',
  property_type: 'house',
  ...overrides,
});

// ── normalizeTransactionType ───────────────────────────────────────

describe('normalizeTransactionType', () => {
  it('maps legacy "sale" → "for_sale"', () => {
    expect(normalizeTransactionType('sale')).toBe('for_sale');
  });

  it('maps legacy "rent" → "for_rent"', () => {
    expect(normalizeTransactionType('rent')).toBe('for_rent');
  });

  it('passes "for_sale" through unchanged', () => {
    expect(normalizeTransactionType('for_sale')).toBe('for_sale');
  });

  it('passes "for_rent" through unchanged', () => {
    expect(normalizeTransactionType('for_rent')).toBe('for_rent');
  });

  it('returns empty string for null', () => {
    expect(normalizeTransactionType(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeTransactionType(undefined)).toBe('');
  });

  it('passes unknown values through unchanged', () => {
    expect(normalizeTransactionType('other')).toBe('other');
  });
});

// ── filterProperties — all ─────────────────────────────────────────

describe('filterProperties — all', () => {
  it('returns all properties', () => {
    const props = [make(), make({ transaction_type: 'for_rent' })];
    expect(filterProperties(props, 'all')).toHaveLength(2);
  });

  it('returns the exact same array reference for "all"', () => {
    const props = [make()];
    expect(filterProperties(props, 'all')).toBe(props);
  });
});

// ── filterProperties — for_sale ────────────────────────────────────

describe('filterProperties — for_sale', () => {
  it('matches canonical for_sale', () => {
    const props = [
      make({ slug: 'sale', transaction_type: 'for_sale' }),
      make({ slug: 'rent', transaction_type: 'for_rent' }),
    ];
    const result = filterProperties(props, 'for_sale');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('sale');
  });

  // This is the key regression test for the bug:
  // original code: p.transaction_type === 'for_sale' — would MISS legacy 'sale' listings
  // fixed code:    normalizes 'sale' → 'for_sale' first
  it('REGRESSION: matches legacy transaction_type="sale" when filter is for_sale', () => {
    const props = [
      make({ slug: 'legacy-sale', transaction_type: 'sale' }),
      make({ slug: 'rent',        transaction_type: 'for_rent' }),
    ];
    const result = filterProperties(props, 'for_sale');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('legacy-sale');
  });

  it('matches both canonical and legacy sale in the same dataset', () => {
    const props = [
      make({ slug: 'canonical', transaction_type: 'for_sale' }),
      make({ slug: 'legacy',    transaction_type: 'sale' }),
      make({ slug: 'rent',      transaction_type: 'for_rent' }),
    ];
    const result = filterProperties(props, 'for_sale');
    expect(result).toHaveLength(2);
    expect(result.map(p => p.slug).sort()).toEqual(['canonical', 'legacy']);
  });
});

// ── filterProperties — for_rent ────────────────────────────────────

describe('filterProperties — for_rent', () => {
  it('matches canonical for_rent', () => {
    const props = [
      make({ slug: 'rent', transaction_type: 'for_rent' }),
      make({ slug: 'sale', transaction_type: 'for_sale' }),
    ];
    expect(filterProperties(props, 'for_rent')[0].slug).toBe('rent');
  });

  // Same regression as for_sale but for rent
  it('REGRESSION: matches legacy transaction_type="rent" when filter is for_rent', () => {
    const props = [
      make({ slug: 'legacy-rent', transaction_type: 'rent' }),
      make({ slug: 'sale',        transaction_type: 'for_sale' }),
    ];
    const result = filterProperties(props, 'for_rent');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('legacy-rent');
  });

  it('matches both canonical and legacy rent in the same dataset', () => {
    const props = [
      make({ slug: 'canonical', transaction_type: 'for_rent' }),
      make({ slug: 'legacy',    transaction_type: 'rent' }),
      make({ slug: 'sale',      transaction_type: 'for_sale' }),
    ];
    expect(filterProperties(props, 'for_rent')).toHaveLength(2);
  });
});

// ── filterProperties — property types ─────────────────────────────

describe('filterProperties — property types', () => {
  it('filters by house', () => {
    const props = [
      make({ slug: 'house', property_type: 'house' }),
      make({ slug: 'villa', property_type: 'villa' }),
    ];
    const result = filterProperties(props, 'house');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('house');
  });

  it('filters by villa', () => {
    const props = [
      make({ slug: 'villa', property_type: 'villa' }),
      make({ slug: 'house', property_type: 'house' }),
    ];
    expect(filterProperties(props, 'villa')[0].slug).toBe('villa');
  });

  it('filters by apartment', () => {
    const props = [
      make({ slug: 'apt',   property_type: 'apartment' }),
      make({ slug: 'house', property_type: 'house' }),
    ];
    expect(filterProperties(props, 'apartment')[0].slug).toBe('apt');
  });

  it('filters by land', () => {
    const props = [
      make({ slug: 'land',  property_type: 'land',  transaction_type: 'for_sale' }),
      make({ slug: 'house', property_type: 'house', transaction_type: 'for_sale' }),
    ];
    expect(filterProperties(props, 'land')[0].slug).toBe('land');
  });

  it('returns empty array when no property_type matches', () => {
    expect(filterProperties([make({ property_type: 'house' })], 'villa')).toHaveLength(0);
  });
});

// ── filterProperties — edge cases ─────────────────────────────────

describe('filterProperties — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(filterProperties([], 'for_sale')).toEqual([]);
  });

  it('handles properties with null transaction_type', () => {
    const props = [make({ transaction_type: null, property_type: 'house' })];
    expect(filterProperties(props, 'for_sale')).toHaveLength(0);
    expect(filterProperties(props, 'house')).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const props = [make(), make({ transaction_type: 'for_rent' })];
    const len = props.length;
    filterProperties(props, 'for_sale');
    expect(props.length).toBe(len);
  });
});
