import { describe, it, expect } from 'vitest';
import { getBadgeHtml } from '../js/badges.js';

// ── helpers ────────────────────────────────────────────────────────

const make = (overrides) => ({
  status: 'active',
  transaction_type: 'for_sale',
  property_type: 'house',
  ...overrides,
});

// ── Featured card ──────────────────────────────────────────────────

describe('getBadgeHtml — featured card', () => {
  it('returns badge-curated in English', () => {
    const html = getBadgeHtml(make(), 'en', true);
    expect(html).toContain('badge-curated');
    expect(html).toContain('Curated');
  });

  it('returns badge-curated in Lao', () => {
    const html = getBadgeHtml(make(), 'lo', true);
    expect(html).toContain('badge-curated');
    expect(html).toContain('ຄັດເລືອກ');
  });

  it('returns badge-curated in Chinese', () => {
    const html = getBadgeHtml(make(), 'zh', true);
    expect(html).toContain('badge-curated');
    expect(html).toContain('精选');
  });

  it('overrides status=sold when isFeaturedCard is true', () => {
    const html = getBadgeHtml(make({ status: 'sold' }), 'en', true);
    expect(html).toContain('badge-curated');
    expect(html).not.toContain('badge-sold');
  });
});

// ── Sold ──────────────────────────────────────────────────────────

describe('getBadgeHtml — sold', () => {
  it('returns badge-sold (en)', () => {
    const html = getBadgeHtml(make({ status: 'sold' }), 'en', false);
    expect(html).toContain('badge-sold');
    expect(html).toContain('Sold');
  });

  it('returns badge-sold (lo)', () => {
    const html = getBadgeHtml(make({ status: 'sold' }), 'lo', false);
    expect(html).toContain('badge-sold');
    expect(html).toContain('ຂາຍແລ້ວ');
  });

  it('returns badge-sold (zh)', () => {
    const html = getBadgeHtml(make({ status: 'sold' }), 'zh', false);
    expect(html).toContain('badge-sold');
    expect(html).toContain('已售');
  });
});

// ── Rented ────────────────────────────────────────────────────────

describe('getBadgeHtml — rented', () => {
  it('returns badge-rented (en)', () => {
    const html = getBadgeHtml(make({ status: 'rented' }), 'en', false);
    expect(html).toContain('badge-rented');
    expect(html).toContain('Rented');
  });

  it('returns badge-rented (lo)', () => {
    expect(getBadgeHtml(make({ status: 'rented' }), 'lo', false)).toContain('ເຊົ່າແລ້ວ');
  });

  it('returns badge-rented (zh)', () => {
    expect(getBadgeHtml(make({ status: 'rented' }), 'zh', false)).toContain('已租');
  });
});

// ── Under Offer ───────────────────────────────────────────────────

describe('getBadgeHtml — under_offer', () => {
  it('returns badge-offer (en)', () => {
    const html = getBadgeHtml(make({ status: 'under_offer' }), 'en', false);
    expect(html).toContain('badge-offer');
    expect(html).toContain('Under Offer');
  });

  it('returns badge-offer (lo)', () => {
    expect(getBadgeHtml(make({ status: 'under_offer' }), 'lo', false)).toContain('ກຳລັງດຳເນີນ');
  });

  it('returns badge-offer (zh)', () => {
    expect(getBadgeHtml(make({ status: 'under_offer' }), 'zh', false)).toContain('洽谈中');
  });
});

// ── Land ──────────────────────────────────────────────────────────

describe('getBadgeHtml — land property_type', () => {
  it('returns badge-land (en)', () => {
    const html = getBadgeHtml(make({ property_type: 'land', transaction_type: 'for_sale' }), 'en', false);
    expect(html).toContain('badge-land');
    expect(html).toContain('Land');
  });

  it('returns badge-land (lo)', () => {
    expect(getBadgeHtml(make({ property_type: 'land' }), 'lo', false)).toContain('ທີ່ດິນ');
  });

  it('returns badge-land (zh)', () => {
    expect(getBadgeHtml(make({ property_type: 'land' }), 'zh', false)).toContain('土地');
  });

  it('returns badge-land even when transaction_type is for_rent', () => {
    const html = getBadgeHtml(make({ property_type: 'land', transaction_type: 'for_rent' }), 'en', false);
    expect(html).toContain('badge-land');
    expect(html).not.toContain('badge-rent');
  });
});

// ── Rent ──────────────────────────────────────────────────────────

describe('getBadgeHtml — rent', () => {
  it('returns badge-rent for for_rent (en)', () => {
    const html = getBadgeHtml(make({ transaction_type: 'for_rent' }), 'en', false);
    expect(html).toContain('badge-rent');
    expect(html).toContain('For Rent');
  });

  it('returns badge-rent for legacy "rent" value', () => {
    // Ensures backward compatibility with legacy transaction_type='rent'
    const html = getBadgeHtml(make({ transaction_type: 'rent' }), 'en', false);
    expect(html).toContain('badge-rent');
  });

  it('returns badge-rent for for_rent (lo)', () => {
    expect(getBadgeHtml(make({ transaction_type: 'for_rent' }), 'lo', false)).toContain('ເຊົ່າ');
  });

  it('returns badge-rent for for_rent (zh)', () => {
    expect(getBadgeHtml(make({ transaction_type: 'for_rent' }), 'zh', false)).toContain('租房');
  });
});

// ── Sale (default) ────────────────────────────────────────────────

describe('getBadgeHtml — sale (default)', () => {
  it('returns badge-sale for for_sale (en)', () => {
    const html = getBadgeHtml(make({ transaction_type: 'for_sale' }), 'en', false);
    expect(html).toContain('badge-sale');
    expect(html).toContain('For Sale');
  });

  it('returns badge-sale (lo)', () => {
    expect(getBadgeHtml(make({ transaction_type: 'for_sale' }), 'lo', false)).toContain('ຂາຍ');
  });

  it('returns badge-sale (zh)', () => {
    expect(getBadgeHtml(make({ transaction_type: 'for_sale' }), 'zh', false)).toContain('出售');
  });

  it('falls back to badge-sale when no condition matches (active house for_sale)', () => {
    expect(getBadgeHtml(make(), 'en', false)).toContain('badge-sale');
  });
});

// ── Priority chain ────────────────────────────────────────────────

describe('getBadgeHtml — priority chain', () => {
  it('sold (priority 2) beats land (priority 5)', () => {
    const html = getBadgeHtml(make({ status: 'sold', property_type: 'land' }), 'en', false);
    expect(html).toContain('badge-sold');
    expect(html).not.toContain('badge-land');
  });

  it('rented (priority 3) beats land (priority 5)', () => {
    const html = getBadgeHtml(make({ status: 'rented', property_type: 'land' }), 'en', false);
    expect(html).toContain('badge-rented');
    expect(html).not.toContain('badge-land');
  });

  it('under_offer (priority 4) beats land (priority 5)', () => {
    const html = getBadgeHtml(make({ status: 'under_offer', property_type: 'land' }), 'en', false);
    expect(html).toContain('badge-offer');
    expect(html).not.toContain('badge-land');
  });

  it('land (priority 5) beats for_rent (priority 6)', () => {
    const html = getBadgeHtml(make({ property_type: 'land', transaction_type: 'for_rent' }), 'en', false);
    expect(html).toContain('badge-land');
    expect(html).not.toContain('badge-rent');
  });

  it('for_rent (priority 6) beats for_sale default (priority 7)', () => {
    const html = getBadgeHtml(make({ transaction_type: 'for_rent' }), 'en', false);
    expect(html).toContain('badge-rent');
    expect(html).not.toContain('badge-sale');
  });
});
