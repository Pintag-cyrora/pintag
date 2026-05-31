import { describe, it, expect } from 'vitest';
import { computeStats } from '../js/stats.js';

// ── helpers ────────────────────────────────────────────────────────

const make = (overrides) => ({
  status: 'active',
  transaction_type: 'for_sale',
  ...overrides,
});

// ── computeStats ───────────────────────────────────────────────────

describe('computeStats', () => {
  it('returns all zeros for empty array', () => {
    expect(computeStats([])).toEqual({ total: 0, published: 0, sale: 0, rent: 0 });
  });

  it('counts total regardless of status or type', () => {
    const props = [
      make({ status: 'active' }),
      make({ status: 'inactive' }),
      make({ status: 'sold' }),
    ];
    expect(computeStats(props).total).toBe(3);
  });

  it('counts only status=active as published', () => {
    const props = [
      make({ status: 'active' }),
      make({ status: 'active' }),
      make({ status: 'inactive' }),
      make({ status: 'sold' }),
    ];
    expect(computeStats(props).published).toBe(2);
  });

  it('counts for_sale listings', () => {
    const props = [
      make({ transaction_type: 'for_sale' }),
      make({ transaction_type: 'for_sale' }),
      make({ transaction_type: 'for_rent' }),
    ];
    expect(computeStats(props).sale).toBe(2);
  });

  it('counts for_rent listings', () => {
    const props = [
      make({ transaction_type: 'for_rent' }),
      make({ transaction_type: 'for_sale' }),
    ];
    expect(computeStats(props).rent).toBe(1);
  });

  it('does NOT count legacy "sale" as for_sale (mirrors dashboard.html behaviour)', () => {
    // This is a known limitation documented in stats.js.
    // Legacy entries are excluded until data is migrated.
    const props = [
      make({ transaction_type: 'sale' }),
      make({ transaction_type: 'for_sale' }),
    ];
    expect(computeStats(props).sale).toBe(1);
  });

  it('does NOT count legacy "rent" as for_rent (mirrors dashboard.html behaviour)', () => {
    const props = [
      make({ transaction_type: 'rent' }),
      make({ transaction_type: 'for_rent' }),
    ];
    expect(computeStats(props).rent).toBe(1);
  });

  it('returns correct combined stats', () => {
    const props = [
      make({ status: 'active',   transaction_type: 'for_sale' }),
      make({ status: 'active',   transaction_type: 'for_rent' }),
      make({ status: 'inactive', transaction_type: 'for_sale' }), // inactive, but still a for_sale
      make({ status: 'active',   transaction_type: 'for_rent' }),
    ];
    // sale=2 because computeStats counts all for_sale regardless of status (total, not published)
    expect(computeStats(props)).toEqual({ total: 4, published: 3, sale: 2, rent: 2 });
  });

  it('handles properties with null transaction_type', () => {
    const props = [make({ transaction_type: null })];
    expect(computeStats(props).sale).toBe(0);
    expect(computeStats(props).rent).toBe(0);
    expect(computeStats(props).total).toBe(1);
  });

  it('handles properties with null status', () => {
    const props = [make({ status: null })];
    expect(computeStats(props).published).toBe(0);
    expect(computeStats(props).total).toBe(1);
  });

  it('sale + rent counts are independent (sum can be less than total)', () => {
    const props = [
      make({ transaction_type: 'for_sale' }),
      make({ transaction_type: 'for_rent' }),
      make({ transaction_type: null }),       // not counted in either
    ];
    const stats = computeStats(props);
    expect(stats.sale + stats.rent).toBe(2);
    expect(stats.total).toBe(3);
  });
});
