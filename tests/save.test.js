import { describe, it, expect } from 'vitest';
import { getSavedSet, computeToggle, persistSaved } from '../js/save.js';

// ── Mock storage ───────────────────────────────────────────────────

function makeStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem:    (k) => Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null,
    setItem:    (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data:      data,
  };
}

// ── getSavedSet ────────────────────────────────────────────────────

describe('getSavedSet', () => {
  it('returns empty Set for empty storage', () => {
    expect(getSavedSet(makeStorage({})).size).toBe(0);
  });

  it('returns Set containing stored slugs', () => {
    const storage = makeStorage({ pintag_saved: JSON.stringify(['slug-a', 'slug-b']) });
    const saved = getSavedSet(storage);
    expect(saved.has('slug-a')).toBe(true);
    expect(saved.has('slug-b')).toBe(true);
    expect(saved.size).toBe(2);
  });

  it('returns empty Set when storage item is null', () => {
    expect(getSavedSet(makeStorage({ pintag_saved: null })).size).toBe(0);
  });

  it('returns empty Set for invalid JSON — silently recovers', () => {
    const storage = makeStorage({ pintag_saved: 'NOT{{VALID' });
    expect(() => getSavedSet(storage)).not.toThrow();
    expect(getSavedSet(storage).size).toBe(0);
  });

  it('returns empty Set when storage is null (no localStorage available)', () => {
    expect(getSavedSet(null).size).toBe(0);
  });

  it('preserves slug order (Set iteration order = insertion order)', () => {
    const slugs = ['c', 'a', 'b'];
    const storage = makeStorage({ pintag_saved: JSON.stringify(slugs) });
    expect([...getSavedSet(storage)]).toEqual(slugs);
  });
});

// ── computeToggle ──────────────────────────────────────────────────

describe('computeToggle', () => {
  it('adds a slug not yet in the set', () => {
    const result = computeToggle('new-slug', new Set());
    expect(result.has('new-slug')).toBe(true);
  });

  it('removes a slug already in the set', () => {
    const existing = new Set(['slug-a', 'slug-b']);
    const result = computeToggle('slug-a', existing);
    expect(result.has('slug-a')).toBe(false);
    expect(result.has('slug-b')).toBe(true);
  });

  it('does NOT mutate the input Set', () => {
    const original = new Set(['slug-a']);
    computeToggle('slug-a', original);
    expect(original.has('slug-a')).toBe(true);
    expect(original.size).toBe(1);
  });

  it('toggle is reversible: add then remove', () => {
    const empty = new Set();
    const after1 = computeToggle('slug', empty);
    const after2 = computeToggle('slug', after1);
    expect(after1.has('slug')).toBe(true);
    expect(after2.has('slug')).toBe(false);
  });

  it('adding the same slug twice results in removal (idempotency)', () => {
    const s1 = computeToggle('slug', new Set());
    const s2 = computeToggle('slug', s1);
    expect(s2.size).toBe(0);
  });

  it('handles slugs with hyphens and digits', () => {
    const result = computeToggle('villa-3bed-sisattanak-123456', new Set());
    expect(result.has('villa-3bed-sisattanak-123456')).toBe(true);
  });

  it('handles URL-encoded slugs (apostrophe encoded as %27)', () => {
    const slug = "villa-it%27s-nice-123456";
    const result = computeToggle(slug, new Set());
    expect(result.has(slug)).toBe(true);
  });
});

// ── persistSaved ──────────────────────────────────────────────────

describe('persistSaved', () => {
  it('writes slugs as a JSON array', () => {
    const storage = makeStorage({});
    persistSaved(new Set(['a', 'b']), storage);
    const stored = JSON.parse(storage.getItem('pintag_saved'));
    expect(stored).toContain('a');
    expect(stored).toContain('b');
    expect(stored).toHaveLength(2);
  });

  it('writes an empty JSON array for an empty Set', () => {
    const storage = makeStorage({});
    persistSaved(new Set(), storage);
    expect(JSON.parse(storage.getItem('pintag_saved'))).toEqual([]);
  });

  it('does nothing if storage is null — does not throw', () => {
    expect(() => persistSaved(new Set(['a']), null)).not.toThrow();
  });

  it('round-trips correctly through getSavedSet', () => {
    const storage = makeStorage({});
    const original = new Set(['x', 'y', 'z']);
    persistSaved(original, storage);
    const restored = getSavedSet(storage);
    expect([...restored].sort()).toEqual([...original].sort());
  });

  it('overwrites previous value on subsequent calls', () => {
    const storage = makeStorage({});
    persistSaved(new Set(['a']), storage);
    persistSaved(new Set(['b', 'c']), storage);
    const result = JSON.parse(storage.getItem('pintag_saved'));
    expect(result).not.toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
  });
});
