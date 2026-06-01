import { describe, it, expect } from 'vitest';

// Verbatim copy of escHtml / buildListingRow from admin.html.
// Do NOT refactor — tests verify the exact logic used in production.

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function buildListingRow(p) {
  const safeId        = escHtml(String(p.id || ''));
  const safeTitle     = escHtml(p.title_en || '—');
  const safeSlug      = encodeURIComponent(p.slug || '');
  const safeDist      = escHtml(p.district_en || '—');
  const safePrice     = p.price_display ? escHtml(p.price_display) : '<em style="color:var(--ink-muted)">On request</em>';
  const safeAgent     = escHtml(p.agent_name || '—');
  const safeStatus    = escHtml(p.status || '');
  const safeTitleAttr = escHtml(p.title_en || '');
  const featuredBadge = p.is_featured
    ? ' <span style="font-size:9px;background:rgba(45,140,140,0.1);color:var(--teal);padding:2px 6px;border-radius:2px;letter-spacing:0.1em;text-transform:uppercase;">Featured</span>'
    : '';
  return `<tr>
    <td><strong style="color:var(--ink);font-weight:500;">${safeTitle}</strong>${featuredBadge}</td>
    <td style="color:var(--ink-muted)">${safeDist}</td>
    <td>${safePrice}</td>
    <td>${safeAgent}</td>
    <td><span class="status-badge status-${safeStatus}">${safeStatus}</span></td>
    <td style="display:flex;gap:6px;align-items:center;">
      <button class="action-btn btn-edit" onclick="editListing('${safeId}')">Edit</button>
      <a class="action-btn btn-view" href="listing.html?slug=${safeSlug}" target="_blank">View</a>
      <button class="action-btn btn-delete" onclick="deleteListing('${safeId}','${safeTitleAttr}')">Delete</button>
    </td>
  </tr>`;
}

// ── helpers ──────────────────────────────────────────────────────────

const makeRow = (overrides) => ({
  id: 'abc-123',
  slug: 'nice-villa-abc123',
  title_en: 'Nice Villa',
  district_en: 'Sisattanak',
  price_display: '$250,000',
  agent_name: 'John Doe',
  status: 'active',
  is_featured: false,
  ...overrides,
});

// ── XSS regression tests ──────────────────────────────────────────────

describe('buildListingRow — XSS regression', () => {

  it('escapes <script> in title_en', () => {
    const html = buildListingRow(makeRow({ title_en: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes <img onerror> in title_en', () => {
    const html = buildListingRow(makeRow({ title_en: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('escapes <script> in district_en', () => {
    const html = buildListingRow(makeRow({ district_en: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes <script> in price_display', () => {
    const html = buildListingRow(makeRow({ price_display: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes <script> in agent_name', () => {
    const html = buildListingRow(makeRow({ agent_name: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes <script> in status (text content)', () => {
    const html = buildListingRow(makeRow({ status: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes special chars in status (CSS class name)', () => {
    const html = buildListingRow(makeRow({ status: 'active"><script>x</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes single-quote in id so unescaped quote cannot break out of onclick string', () => {
    const html = buildListingRow(makeRow({ id: "' onmouseover='alert(1)" }));
    // Quotes are encoded as &#39; — the literal adjacent pattern that would break
    // a single-quoted JS string should not be present in the raw HTML.
    expect(html).not.toContain("' onmouseover='");
    expect(html).toContain('&#39;');
  });

  it('escapes double-quote in id preventing onclick attribute break-out', () => {
    const html = buildListingRow(makeRow({ id: '" onmouseover="alert(1)' }));
    expect(html).not.toContain('" onmouseover=');
    expect(html).toContain('&quot;');
  });

  it('URL-encodes special chars in slug for href', () => {
    const html = buildListingRow(makeRow({ slug: '<script>xss</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('%3Cscript%3E');
  });

  it('escapes title_en in delete onclick attribute', () => {
    const html = buildListingRow(makeRow({ title_en: "'); alert(1); //", id: 'safe-id' }));
    expect(html).not.toContain("'); alert(1)");
    expect(html).toContain('&#39;');
  });

  it('shows On request em tag when price_display is empty/null', () => {
    const html = buildListingRow(makeRow({ price_display: null }));
    expect(html).toContain('On request');
    expect(html).toContain('<em');
  });

  it('shows On request em tag when price_display is empty string', () => {
    const html = buildListingRow(makeRow({ price_display: '' }));
    expect(html).toContain('On request');
  });

  it('renders escaped price when price_display is provided', () => {
    const html = buildListingRow(makeRow({ price_display: '$250,000' }));
    expect(html).toContain('$250,000');
    expect(html).not.toContain('<em');
  });

  it('renders featured badge only when is_featured is true', () => {
    const withBadge = buildListingRow(makeRow({ is_featured: true }));
    const withoutBadge = buildListingRow(makeRow({ is_featured: false }));
    expect(withBadge).toContain('Featured');
    expect(withoutBadge).not.toContain('Featured');
  });

  it('escapes ampersand in title_en', () => {
    const html = buildListingRow(makeRow({ title_en: 'House & Garden' }));
    expect(html).toContain('House &amp; Garden');
    expect(html).not.toContain('House & Garden');
  });
});
