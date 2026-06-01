import { describe, it, expect } from 'vitest';
import { generateSlugBase, generateSlug } from '../js/slug.js';

// ── generateSlugBase — English titles ─────────────────────────────

describe('generateSlugBase — English titles', () => {
  it('lowercases and hyphenates words', () => {
    expect(generateSlugBase('Beautiful Villa Vientiane')).toBe('beautiful-villa-vientiane');
  });

  it('strips trailing punctuation', () => {
    expect(generateSlugBase('3-Bed House!')).toBe('3-bed-house');
  });

  it('strips ampersand', () => {
    expect(generateSlugBase('House & Garden')).toBe('house-garden');
  });

  it('strips parentheses', () => {
    expect(generateSlugBase('Villa (Near Embassy)')).toBe('villa-near-embassy');
  });

  it('strips forward slashes', () => {
    expect(generateSlugBase('For Sale / Lease')).toBe('for-sale-lease');
  });

  it('collapses multiple spaces to single hyphen', () => {
    expect(generateSlugBase('hello   world')).toBe('hello-world');
  });

  it('collapses consecutive hyphens', () => {
    expect(generateSlugBase('hello--world')).toBe('hello-world');
  });

  it('strips leading hyphen', () => {
    expect(generateSlugBase('-hello')).toBe('hello');
  });

  it('strips trailing hyphen', () => {
    expect(generateSlugBase('hello-')).toBe('hello');
  });

  it('handles mixed alphanumeric', () => {
    expect(generateSlugBase('4-Bedroom Modern Home 2024')).toBe('4-bedroom-modern-home-2024');
  });

  it('handles title that is already a valid slug', () => {
    expect(generateSlugBase('my-villa')).toBe('my-villa');
  });
});

// ── generateSlugBase — non-Latin titles ───────────────────────────

describe('generateSlugBase — non-Latin titles', () => {
  it('strips Lao characters, returns digits when present', () => {
    // 'ເຮືອນ 3 ຫ້ອງນອນ' → Lao stripped, digits kept → '3'
    expect(generateSlugBase('ເຮືອນ 3 ຫ້ອງນອນ')).toBe('3');
  });

  it('returns fallback "property" for Lao-only title (no digits/Latin)', () => {
    expect(generateSlugBase('ເຮືອນໃນວຽງຈັນ')).toBe('property');
  });

  it('returns fallback "property" for Chinese-only title', () => {
    expect(generateSlugBase('万象公寓')).toBe('property');
  });

  it('keeps Latin/digit parts alongside stripped non-Latin', () => {
    expect(generateSlugBase('3 Bed ເຮືອນ')).toBe('3-bed');
  });

  it('returns fallback when title_en is empty because property has only Lao name', () => {
    // Production scenario: admin enters Lao title but leaves English blank
    expect(generateSlugBase('')).toBe('property');
  });
});

// ── generateSlugBase — emoji and special characters ───────────────

describe('generateSlugBase — emoji and special characters', () => {
  it('strips emoji and collapses surrounding spaces', () => {
    expect(generateSlugBase('Beautiful 🏠 House')).toBe('beautiful-house');
  });

  it('strips @ symbol', () => {
    // @ is stripped; no space separator so words concatenate directly
    expect(generateSlugBase('Sisattanak@Vientiane')).toBe('sisattanakvientiane');
  });

  it('handles title with ONLY special characters — returns fallback', () => {
    expect(generateSlugBase('!!!! ####')).toBe('property');
  });

  it('handles all-whitespace title — returns fallback', () => {
    expect(generateSlugBase('   ')).toBe('property');
  });

  it('strips quotes', () => {
    expect(generateSlugBase('"Premium" Villa')).toBe('premium-villa');
  });
});

// ── generateSlugBase — length limits ──────────────────────────────

describe('generateSlugBase — length limits', () => {
  it('truncates output to at most 60 characters', () => {
    const longTitle = 'a '.repeat(40).trim(); // 79 chars before processing
    expect(generateSlugBase(longTitle).length).toBeLessThanOrEqual(60);
  });

  it('preserves a 60-char ASCII title exactly', () => {
    const sixtyChars = 'a'.repeat(60);
    expect(generateSlugBase(sixtyChars)).toBe(sixtyChars);
  });

  it('does not produce output longer than 60 chars regardless of input', () => {
    const veryLong = 'word '.repeat(100);
    expect(generateSlugBase(veryLong).length).toBeLessThanOrEqual(60);
  });
});

// ── generateSlugBase — edge cases ─────────────────────────────────

describe('generateSlugBase — edge cases', () => {
  it('returns "property" for empty string', () => {
    expect(generateSlugBase('')).toBe('property');
  });

  it('returns "property" for null', () => {
    expect(generateSlugBase(null)).toBe('property');
  });

  it('returns "property" for undefined', () => {
    expect(generateSlugBase(undefined)).toBe('property');
  });

  it('handles numeric input coerced to string', () => {
    expect(generateSlugBase(123)).toBe('123');
  });
});

// ── generateSlug ───────────────────────────────────────────────────

describe('generateSlug', () => {
  it('appends explicit suffix to slug base', () => {
    expect(generateSlug('Beautiful Villa', '123456')).toBe('beautiful-villa-123456');
  });

  it('uses fallback base for non-Latin-only title', () => {
    expect(generateSlug('万象公寓', '999999')).toBe('property-999999');
  });

  it('uses fallback for empty title', () => {
    expect(generateSlug('', '000001')).toBe('property-000001');
  });

  it('uses last 6 digits of Date.now() when no suffix provided', () => {
    const result = generateSlug('Test Property');
    expect(result).toMatch(/^test-property-\d{6}$/);
  });

  it('suffix of 0 is preserved (not falsy-coalesced)', () => {
    // suffix=0 should produce 'property-0', not 'property-<timestamp>'
    expect(generateSlug('Test', 0)).toBe('test-0');
  });
});
