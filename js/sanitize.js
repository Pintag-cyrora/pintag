/**
 * Escapes HTML special characters to prevent XSS injection.
 * Mirrors the esc() function already used in listing.html.
 *
 * @param {*} str  Value to escape. Null/undefined returns ''.
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/**
 * Returns true only for http:// or https:// URLs.
 * Rejects javascript:, data:, and all other schemes.
 *
 * @param {*} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  var t = url.trim().toLowerCase();
  return t.indexOf('https://') === 0 || t.indexOf('http://') === 0;
}
