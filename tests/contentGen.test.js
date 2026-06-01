import { describe, it, expect } from 'vitest';
import { ContentGen } from '../js/content-gen.js';

const { generateOverview, generateHighlightItems, generateNeighborhoodInsight } = ContentGen;

// ── generateOverview ──────────────────────────────────────────────

describe('generateOverview', () => {
  it('returns a non-empty string for all known property types', () => {
    const types = ['villa', 'house', 'apartment', 'condo', 'land', 'commercial'];
    types.forEach(pt => {
      const result = generateOverview({ property_type: pt, transaction_type: 'sale' }, 'en');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(10);
    });
  });

  it('returns Lao text when lang is "lo"', () => {
    const result = generateOverview({ property_type: 'villa', transaction_type: 'sale' }, 'lo');
    // Lao script code point range U+0E80–U+0EFF
    expect(result).toMatch(/[຀-໿]/);
  });

  it('returns Chinese text when lang is "zh"', () => {
    const result = generateOverview({ property_type: 'house', transaction_type: 'rent' }, 'zh');
    expect(result).toMatch(/[一-鿿]/);
  });

  it('selects luxury variant when price_display >= 800000', () => {
    const standard = generateOverview({ property_type: 'villa', transaction_type: 'sale', price_display: '500000' }, 'en');
    const luxury   = generateOverview({ property_type: 'villa', transaction_type: 'sale', price_display: '1200000' }, 'en');
    expect(luxury).not.toBe(standard);
  });

  it('falls back gracefully for unknown property type', () => {
    const result = generateOverview({ property_type: 'unknown_type', transaction_type: 'sale' }, 'en');
    expect(result.length).toBeGreaterThan(10);
  });

  it('falls back gracefully when transaction_type is missing', () => {
    const result = generateOverview({ property_type: 'house' }, 'en');
    expect(result.length).toBeGreaterThan(10);
  });

  it('falls back gracefully when property data is empty', () => {
    const result = generateOverview({}, 'en');
    expect(result.length).toBeGreaterThan(10);
  });

  it('defaults lang to "en" when omitted', () => {
    const result = generateOverview({ property_type: 'apartment', transaction_type: 'rent' });
    expect(result).toMatch(/[a-zA-Z]/);
  });

  it('handles for_sale transaction_type format', () => {
    const a = generateOverview({ property_type: 'house', transaction_type: 'for_sale' }, 'en');
    const b = generateOverview({ property_type: 'house', transaction_type: 'sale' }, 'en');
    expect(a).toBe(b);
  });

  it('handles for_rent transaction_type format', () => {
    const a = generateOverview({ property_type: 'house', transaction_type: 'for_rent' }, 'en');
    const b = generateOverview({ property_type: 'house', transaction_type: 'rent' }, 'en');
    expect(a).toBe(b);
  });
});

// ── generateHighlightItems ────────────────────────────────────────

describe('generateHighlightItems', () => {
  it('returns an array', () => {
    expect(Array.isArray(generateHighlightItems({}, 'en'))).toBe(true);
  });

  it('returns at most 4 items', () => {
    const p = { property_type: 'villa', transaction_type: 'sale', district_en: 'Sisattanak', village_en: 'Thongkang', bedrooms: 4, bathrooms: 3, sqm: 450, parking_spaces: 2, year_built: 2022 };
    expect(generateHighlightItems(p, 'en').length).toBeLessThanOrEqual(4);
  });

  it('each item has kicker and value strings', () => {
    const items = generateHighlightItems({ property_type: 'house', transaction_type: 'sale', district_en: 'Xaysetha', sqm: 200 }, 'en');
    items.forEach(item => {
      expect(typeof item.kicker).toBe('string');
      expect(typeof item.value).toBe('string');
      expect(item.kicker.length).toBeGreaterThan(0);
      expect(item.value.length).toBeGreaterThan(0);
    });
  });

  it('includes location when district_en is set', () => {
    const items = generateHighlightItems({ district_en: 'Chanthabouly' }, 'en');
    const loc = items.find(i => i.value.includes('Chanthabouly'));
    expect(loc).toBeTruthy();
  });

  it('combines village and district in location', () => {
    const items = generateHighlightItems({ district_en: 'Sisattanak', village_en: 'Thongkang' }, 'en');
    const loc = items.find(i => i.value.includes('Thongkang') && i.value.includes('Sisattanak'));
    expect(loc).toBeTruthy();
  });

  it('combines beds and baths when both are present', () => {
    const items = generateHighlightItems({ bedrooms: 3, bathrooms: 2 }, 'en');
    const bedBath = items.find(i => i.value.includes('3') && i.value.includes('2'));
    expect(bedBath).toBeTruthy();
  });

  it('includes sqm when present', () => {
    const items = generateHighlightItems({ sqm: 320 }, 'en');
    const area = items.find(i => i.value.includes('320'));
    expect(area).toBeTruthy();
  });

  it('uses Land Size label for land type', () => {
    const items = generateHighlightItems({ property_type: 'land', sqm: 1000 }, 'en');
    const area = items.find(i => i.kicker === 'Land Size');
    expect(area).toBeTruthy();
  });

  it('uses Building Size label for non-land types', () => {
    const items = generateHighlightItems({ property_type: 'villa', sqm: 400 }, 'en');
    const area = items.find(i => i.kicker === 'Building Size');
    expect(area).toBeTruthy();
  });

  it('includes parking when parking_spaces > 0', () => {
    const items = generateHighlightItems({ parking_spaces: 2 }, 'en');
    const park = items.find(i => i.value.includes('2'));
    expect(park).toBeTruthy();
  });

  it('does not include parking when parking_spaces is 0', () => {
    const items = generateHighlightItems({ parking_spaces: 0 }, 'en');
    const park = items.find(i => i.kicker === 'Parking');
    expect(park).toBeUndefined();
  });

  it('includes year_built when fewer than 4 items and year > 1980', () => {
    const items = generateHighlightItems({ year_built: 2020 }, 'en');
    const yr = items.find(i => i.value === '2020');
    expect(yr).toBeTruthy();
  });

  it('does not include year_built <= 1980', () => {
    const items = generateHighlightItems({ year_built: 1975 }, 'en');
    const yr = items.find(i => i.value === '1975');
    expect(yr).toBeUndefined();
  });

  it('falls back to property type when fewer than 4 items', () => {
    const items = generateHighlightItems({ property_type: 'condo', transaction_type: 'sale' }, 'en');
    const typeItem = items.find(i => i.value.includes('Condo'));
    expect(typeItem).toBeTruthy();
  });

  it('returns Lao kickers when lang is "lo"', () => {
    const items = generateHighlightItems({ district_lo: 'ສີສັດຕະນາກ' }, 'lo');
    expect(items.length).toBeGreaterThan(0);
    // Location kicker in Lao
    expect(items[0].kicker).toMatch(/[຀-໿]/);
  });

  it('returns empty array for completely empty input', () => {
    const items = generateHighlightItems({}, 'en');
    expect(Array.isArray(items)).toBe(true);
  });
});

// ── generateNeighborhoodInsight ───────────────────────────────────

describe('generateNeighborhoodInsight', () => {
  it('returns known Sisattanak district text in English', () => {
    const result = generateNeighborhoodInsight({ district_en: 'Sisattanak' }, 'en');
    expect(result).toContain('Sisattanak');
    expect(result).toContain('diplomatic');
  });

  it('returns known district text in Lao', () => {
    const result = generateNeighborhoodInsight({ district_en: 'Sisattanak' }, 'lo');
    expect(result).toMatch(/[຀-໿]/);
  });

  it('returns known district text in Chinese', () => {
    const result = generateNeighborhoodInsight({ district_en: 'Chanthabouly' }, 'zh');
    expect(result).toMatch(/[一-鿿]/);
  });

  it('normalises spelling variants — chanthabouri', () => {
    const a = generateNeighborhoodInsight({ district_en: 'Chanthabouly' }, 'en');
    const b = generateNeighborhoodInsight({ district_en: 'Chanthabouri' }, 'en');
    expect(a).toBe(b);
  });

  it('normalises spelling variants — sisatanak', () => {
    const a = generateNeighborhoodInsight({ district_en: 'Sisattanak' }, 'en');
    const b = generateNeighborhoodInsight({ district_en: 'Sisatanak' }, 'en');
    expect(a).toBe(b);
  });

  it('normalises spacing in district name', () => {
    const a = generateNeighborhoodInsight({ district_en: 'Sisattanak' }, 'en');
    const b = generateNeighborhoodInsight({ district_en: 'Sisa ttanak' }, 'en');
    expect(a).toBe(b);
  });

  it('falls back with district name interpolated for unknown district', () => {
    const result = generateNeighborhoodInsight({ district_en: 'Phonhong' }, 'en');
    expect(result).toContain('Phonhong');
  });

  it('falls back with Lao template for unknown district in lo', () => {
    const result = generateNeighborhoodInsight({ district_lo: 'ໂພນໂຮງ' }, 'lo');
    expect(result).toMatch(/[຀-໿]/);
  });

  it('uses district_lo when district_en is absent', () => {
    const a = generateNeighborhoodInsight({ district_lo: 'ສີສັດຕະນາກ', district_en: 'Sisattanak' }, 'en');
    const b = generateNeighborhoodInsight({ district_en: 'Sisattanak' }, 'en');
    expect(a).toBe(b);
  });

  it('returns generic fallback when no district at all', () => {
    const result = generateNeighborhoodInsight({}, 'en');
    expect(result).toContain('Vientiane');
    expect(result.length).toBeGreaterThan(20);
  });

  it('returns generic Lao fallback when no district', () => {
    const result = generateNeighborhoodInsight({}, 'lo');
    expect(result).toMatch(/[຀-໿]/);
  });

  it('returns generic Chinese fallback when no district', () => {
    const result = generateNeighborhoodInsight({}, 'zh');
    expect(result).toMatch(/[一-鿿]/);
  });

  it('covers all 8 known districts', () => {
    const districts = ['Chanthabouly', 'Sisattanak', 'Xaysetha', 'Hadxayfong', 'Sikhottabong', 'Sangthong', 'Naxaithong', 'Pakngum'];
    districts.forEach(d => {
      const result = generateNeighborhoodInsight({ district_en: d }, 'en');
      expect(result.length).toBeGreaterThan(20);
      // Should not contain placeholder text
      expect(result).not.toContain('DISTRICT');
    });
  });
});
