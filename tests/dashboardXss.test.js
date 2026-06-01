import { describe, it, expect, beforeEach } from 'vitest';

// Verbatim copy of escHtml / isSafeUrl / renderListings from dashboard.html.
// Do NOT refactor — tests verify the exact logic used in production.

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  var t = url.trim().toLowerCase();
  return t.indexOf('https://') === 0 || t.indexOf('http://') === 0;
}

function renderListings(properties) {
  const container = document.getElementById('listings');

  if (!properties.length) {
    container.innerHTML = '<div class="empty">No listings yet.</div>';
    return;
  }

  container.innerHTML = properties.map(property => {
    const rawImage =
      property.images && property.images.length ? property.images[0] : null;
    const image = isSafeUrl(rawImage) ? rawImage : 'https://placehold.co/1200x800';
    const safeId = escHtml(String(property.id || ''));

    return `
      <div class="card">
        <div class="card-img"><img src="${escHtml(image)}"></div>
        <div class="card-body">
          <div class="card-location">${escHtml(property.district_en || '')}</div>
          <div class="card-title">${escHtml(property.title_en || property.title_lo || 'Untitled')}</div>
          <div class="card-price">${escHtml(property.price_display || '')}</div>
          <div class="listing-stats">
            <span>👁 ${Number(property.views) || 0}</span>
            <span>💬 ${Number(property.inquiries) || 0}</span>
            <span>❤ ${Number(property.saves) || 0}</span>
          </div>
          <div class="card-actions">
            <button class="card-btn edit-btn" onclick="editListing('${safeId}')">Edit</button>
            <button class="card-btn delete-btn" onclick="deleteListing('${safeId}')">Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── helpers ──────────────────────────────────────────────────────────

function setup() {
  document.body.innerHTML = '<div id="listings"></div>';
}

const makeProperty = (overrides) => ({
  id: 'uuid-1234',
  title_en: 'Nice Villa',
  title_lo: null,
  district_en: 'Sisattanak',
  price_display: '$250,000',
  images: ['https://example.com/photo.jpg'],
  views: 10,
  inquiries: 2,
  saves: 5,
  ...overrides,
});

function getHtml() {
  return document.getElementById('listings').innerHTML;
}

// ── escHtml unit tests ────────────────────────────────────────────────

describe('escHtml', () => {
  it('escapes <script> tag', () => {
    expect(escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('escapes double-quote', () => {
    expect(escHtml('"value"')).toBe('&quot;value&quot;');
  });
  it('escapes single-quote', () => {
    expect(escHtml("it's")).toBe('it&#39;s');
  });
  it('escapes ampersand', () => {
    expect(escHtml('a&b')).toBe('a&amp;b');
  });
  it('returns empty string for null', () => {
    expect(escHtml(null)).toBe('');
  });
  it('returns empty string for undefined', () => {
    expect(escHtml(undefined)).toBe('');
  });
});

// ── isSafeUrl unit tests ──────────────────────────────────────────────

describe('isSafeUrl', () => {
  it('allows https:// URLs', () => {
    expect(isSafeUrl('https://example.com/img.jpg')).toBe(true);
  });
  it('allows http:// URLs', () => {
    expect(isSafeUrl('http://cdn.example.com/img.jpg')).toBe(true);
  });
  it('blocks javascript: scheme', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });
  it('blocks data: URI', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
  it('blocks vbscript: scheme', () => {
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isSafeUrl('')).toBe(false);
  });
  it('returns false for null', () => {
    expect(isSafeUrl(null)).toBe(false);
  });
  it('blocks javascript: with leading whitespace', () => {
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false);
  });
});

// ── renderListings XSS regression tests ──────────────────────────────

describe('renderListings — XSS regression', () => {
  beforeEach(setup);

  it('escapes <script> in title_en', () => {
    renderListings([makeProperty({ title_en: '<script>alert(1)</script>' })]);
    expect(getHtml()).not.toContain('<script>');
    expect(getHtml()).toContain('&lt;script&gt;');
  });

  it('escapes <img onerror> in title_en', () => {
    renderListings([makeProperty({ title_en: '<img src=x onerror=alert(1)>' })]);
    expect(getHtml()).not.toContain('<img src=x');
    expect(getHtml()).toContain('&lt;img');
  });

  it('escapes "><script> injection attempt in title_en', () => {
    renderListings([makeProperty({ title_en: '"><script>alert(1)</script>' })]);
    expect(getHtml()).not.toContain('<script>');
  });

  it('escapes <script> in district_en', () => {
    renderListings([makeProperty({ district_en: '<script>alert(1)</script>' })]);
    expect(getHtml()).not.toContain('<script>');
    expect(getHtml()).toContain('&lt;script&gt;');
  });

  it('escapes <script> in price_display', () => {
    renderListings([makeProperty({ price_display: '<script>alert(1)</script>' })]);
    expect(getHtml()).not.toContain('<script>');
    expect(getHtml()).toContain('&lt;script&gt;');
  });

  it('price_display with double-quote does not create an onmouseover attribute on the card', () => {
    // price_display is in text content, not an attribute — "\" cannot break out of an element.
    // Verify JSDOM did not parse an event-handler attribute out of the escaped value.
    renderListings([makeProperty({ price_display: '" onmouseover="alert(1)' })]);
    const card = document.querySelector('.card');
    expect(card.hasAttribute('onmouseover')).toBe(false);
    expect(card.querySelector('.card-price').textContent).toContain('onmouseover');
  });

  it('escapes single-quote in id so no onmouseover attribute is injected on the button', () => {
    // The id value comes from Supabase as a UUID (safe), but verifying defence-in-depth.
    // JSDOM decodes &#39; → ' when re-serialising, so check the DOM attribute instead.
    renderListings([makeProperty({ id: "' onmouseover='alert(1)" })]);
    const btn = document.querySelector('.edit-btn');
    expect(btn.hasAttribute('onmouseover')).toBe(false);
    expect(btn.getAttribute('onclick')).toContain("editListing");
  });

  it('replaces javascript: image URL with placeholder', () => {
    renderListings([makeProperty({ images: ['javascript:alert(1)'] })]);
    const html = getHtml();
    expect(html).not.toContain('javascript:');
    expect(html).toContain('placehold.co');
  });

  it('replaces data: image URL with placeholder', () => {
    renderListings([makeProperty({ images: ['data:text/html,<h1>xss</h1>'] })]);
    const html = getHtml();
    expect(html).not.toContain('data:text');
    expect(html).toContain('placehold.co');
  });

  it('renders a valid https image URL without modification', () => {
    const url = 'https://storage.example.com/photo.jpg';
    renderListings([makeProperty({ images: [url] })]);
    expect(getHtml()).toContain(url);
  });

  it('falls back to title_lo when title_en is empty, escaping it', () => {
    renderListings([makeProperty({ title_en: '', title_lo: '<b>bold</b>' })]);
    expect(getHtml()).not.toContain('<b>');
    expect(getHtml()).toContain('&lt;b&gt;');
  });

  it('renders numeric stats as plain numbers — not injectable', () => {
    renderListings([makeProperty({ views: 42, inquiries: 3, saves: 7 })]);
    const html = getHtml();
    expect(html).toContain('42');
    expect(html).toContain('3');
    expect(html).toContain('7');
  });

  it('shows empty state for empty array without XSS', () => {
    renderListings([]);
    expect(getHtml()).toContain('No listings yet');
  });
});
