/**
 * Derives a URL-safe slug base from an English title string.
 *
 * Steps applied in order:
 *   1. Lowercase the string
 *   2. Strip every character that is not an ASCII letter, digit, whitespace, or hyphen
 *      (This removes Lao, Chinese, emoji, punctuation, etc.)
 *   3. Collapse whitespace runs to a single hyphen
 *   4. Collapse consecutive hyphens to one
 *   5. Strip leading and trailing hyphens
 *   6. Truncate to 60 characters
 *   7. If the result is empty (e.g. Lao-only or Chinese-only title), return 'property'
 *      BUG FIXED: the original code omitted step 7, so a Lao-only or all-special-char
 *      title would produce slugBase='' and the stored slug would be '-123456', which
 *      is an invalid identifier and breaks look-up by slug.
 *
 * @param {string|null|undefined} titleEn
 * @returns {string}  Slug base, never empty (minimum: 'property')
 */
export function generateSlugBase(titleEn) {
  var base = String(titleEn || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return base || 'property';
}

/**
 * Generates a full listing slug: <base>-<suffix>.
 *
 * @param {string|null|undefined} titleEn  English title used to build the base.
 * @param {string|number}         [suffix] Appended after a hyphen. Defaults to the last
 *                                         6 digits of Date.now() for collision avoidance.
 *                                         Pass an explicit value in tests for determinism.
 * @returns {string}
 */
export function generateSlug(titleEn, suffix) {
  var base = generateSlugBase(titleEn);
  var s = suffix != null ? String(suffix) : Date.now().toString().slice(-6);
  return base + '-' + s;
}
