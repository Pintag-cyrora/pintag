import { describe, it, expect } from 'vitest';
import { sortProperties, parsePriceDisplay } from '../js/sort.js';

// ── helpers ────────────────────────────────────────────────────────

const make = (overrides) => ({
  slug: 'test',
  is_featured: false,
  price_display: null,
  transaction_type: 'for_sale',
  status: 'active',
  ...overrides,
});

// ── parsePriceDisplay ──────────────────────────────────────────────

describe('parsePriceDisplay', () => {
  it('parses a plain number string', () => {
    expect(parsePriceDisplay('250000')).toBe(250000);
  });

  it('parses "$250,000"', () => {
    expect(parsePriceDisplay('$250,000')).toBe(250000);
  });

  it('parses "250000 USD"', () => {
    expect(parsePriceDisplay('250000 USD')).toBe(250000);
  });

  it('parses a million with commas', () => {
    expect(parsePriceDisplay('1,200,000')).toBe(1200000);
  });

  it('parses "$1,200,000 USD"', () => {
    expect(parsePriceDisplay('$1,200,000 USD')).toBe(1200000);
  });

  it('parses a decimal value', () => {
    expect(parsePriceDisplay('1.5')).toBe(1.5);
  });

  it('returns 0 for null', () => {
    expect(parsePriceDisplay(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(parsePriceDisplay(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parsePriceDisplay('')).toBe(0);
  });

  it('returns 0 for "Price on request"', () => {
    expect(parsePriceDisplay('Price on request')).toBe(0);
  });

  it('returns 0 for Lao price text', () => {
    expect(parsePriceDisplay('ສອບຖາມລາຄາ')).toBe(0);
  });

  it('returns 0 for Chinese price text', () => {
    expect(parsePriceDisplay('价格面议')).toBe(0);
  });
});

// ── sortProperties — newest ────────────────────────────────────────

describe('sortProperties — newest', () => {
  it('preserves original order', () => {
    const props = [make({ slug: 'a' }), make({ slug: 'b' }), make({ slug: 'c' })];
    expect(sortProperties(props, 'newest').map(p => p.slug)).toEqual(['a', 'b', 'c']);
  });

  it('preserves order for unknown sort mode', () => {
    const props = [make({ slug: 'x' }), make({ slug: 'y' })];
    expect(sortProperties(props, 'unknown').map(p => p.slug)).toEqual(['x', 'y']);
  });

  it('does not mutate the input array', () => {
    const props = [make({ slug: 'a', price_display: '$200,000' }), make({ slug: 'b', price_display: '$100,000' })];
    const slugsBefore = props.map(p => p.slug);
    sortProperties(props, 'price_asc');
    expect(props.map(p => p.slug)).toEqual(slugsBefore);
  });
});

// ── sortProperties — featured ──────────────────────────────────────

describe('sortProperties — featured', () => {
  it('places featured listing first', () => {
    const props = [
      make({ slug: 'regular', is_featured: false }),
      make({ slug: 'featured', is_featured: true }),
      make({ slug: 'also-regular', is_featured: false }),
    ];
    expect(sortProperties(props, 'featured')[0].slug).toBe('featured');
  });

  it('handles multiple featured listings', () => {
    const props = [
      make({ slug: 'a', is_featured: false }),
      make({ slug: 'b', is_featured: true }),
      make({ slug: 'c', is_featured: true }),
    ];
    const result = sortProperties(props, 'featured');
    expect(result[0].is_featured).toBe(true);
    expect(result[1].is_featured).toBe(true);
    expect(result[2].is_featured).toBe(false);
  });

  it('does not reorder when no featured listings', () => {
    const props = [make({ slug: 'a' }), make({ slug: 'b' })];
    expect(sortProperties(props, 'featured').map(p => p.slug)).toEqual(['a', 'b']);
  });
});

// ── sortProperties — price_asc ────────────────────────────────────

describe('sortProperties — price_asc', () => {
  it('sorts cheapest first', () => {
    const props = [
      make({ slug: 'expensive', price_display: '$500,000' }),
      make({ slug: 'cheap',     price_display: '$100,000' }),
      make({ slug: 'mid',       price_display: '$250,000' }),
    ];
    expect(sortProperties(props, 'price_asc').map(p => p.slug)).toEqual(['cheap', 'mid', 'expensive']);
  });

  it('places null price first (treated as 0)', () => {
    const props = [
      make({ slug: 'has-price', price_display: '$100,000' }),
      make({ slug: 'no-price',  price_display: null }),
    ];
    expect(sortProperties(props, 'price_asc')[0].slug).toBe('no-price');
  });

  it('places undefined price_display first (treated as 0)', () => {
    const props = [
      make({ slug: 'has',     price_display: '$50,000' }),
      make({ slug: 'missing', price_display: undefined }),
    ];
    expect(sortProperties(props, 'price_asc')[0].slug).toBe('missing');
  });

  it('handles plain number strings', () => {
    const props = [
      make({ slug: 'b', price_display: '300000' }),
      make({ slug: 'a', price_display: '100000' }),
    ];
    expect(sortProperties(props, 'price_asc')[0].slug).toBe('a');
  });

  it('handles "250000 USD" format', () => {
    const props = [
      make({ slug: 'b', price_display: '500000 USD' }),
      make({ slug: 'a', price_display: '250000 USD' }),
    ];
    expect(sortProperties(props, 'price_asc')[0].slug).toBe('a');
  });

  it('is deterministic on equal prices', () => {
    const props = [
      make({ slug: 'a', price_display: '$200,000' }),
      make({ slug: 'b', price_display: '$200,000' }),
    ];
    const r1 = sortProperties(props, 'price_asc').map(p => p.slug);
    const r2 = sortProperties(props, 'price_asc').map(p => p.slug);
    expect(r1).toEqual(r2);
  });

  it('handles empty string price as 0', () => {
    const props = [
      make({ slug: 'b', price_display: '$200,000' }),
      make({ slug: 'a', price_display: '' }),
    ];
    expect(sortProperties(props, 'price_asc')[0].slug).toBe('a');
  });
});

// ── sortProperties — price_desc ───────────────────────────────────

describe('sortProperties — price_desc', () => {
  it('sorts most expensive first', () => {
    const props = [
      make({ slug: 'cheap',     price_display: '$100,000' }),
      make({ slug: 'expensive', price_display: '$500,000' }),
      make({ slug: 'mid',       price_display: '$250,000' }),
    ];
    expect(sortProperties(props, 'price_desc').map(p => p.slug)).toEqual(['expensive', 'mid', 'cheap']);
  });

  it('places null price last (treated as 0)', () => {
    const props = [
      make({ slug: 'no-price',  price_display: null }),
      make({ slug: 'has-price', price_display: '$100,000' }),
    ];
    const result = sortProperties(props, 'price_desc');
    expect(result[0].slug).toBe('has-price');
    expect(result[1].slug).toBe('no-price');
  });

  it('handles empty string price as 0 (sorts last)', () => {
    const props = [
      make({ slug: 'a', price_display: '' }),
      make({ slug: 'b', price_display: '$200,000' }),
    ];
    expect(sortProperties(props, 'price_desc')[0].slug).toBe('b');
  });
});

// ── edge cases ─────────────────────────────────────────────────────

describe('sortProperties — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(sortProperties([], 'price_asc')).toEqual([]);
  });

  it('returns single-item array unchanged', () => {
    const props = [make({ slug: 'only' })];
    expect(sortProperties(props, 'featured')[0].slug).toBe('only');
  });

  it('returns a new array, not the original reference', () => {
    const props = [make()];
    expect(sortProperties(props, 'newest')).not.toBe(props);
  });
});
