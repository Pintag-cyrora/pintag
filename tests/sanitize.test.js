import { describe, it, expect } from 'vitest';
import { escapeHtml, isSafeUrl } from '../js/sanitize.js';

// ── escapeHtml ─────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes <', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('escapes >', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes &', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('blocks <script>alert(1)</script>', () => {
    const output = escapeHtml('<script>alert(1)</script>');
    expect(output).not.toContain('<script>');
    expect(output).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('blocks <img src=x onerror=alert(1)>', () => {
    const output = escapeHtml('<img src=x onerror=alert(1)>');
    expect(output).not.toContain('<img');
    expect(output).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('blocks attribute-breaking ">alert(1)', () => {
    const output = escapeHtml('">alert(1)');
    expect(output).toBe('&quot;&gt;alert(1)');
  });

  it('blocks single-quote attribute break \'><svg/onload=alert(1)>', () => {
    const output = escapeHtml("'><svg/onload=alert(1)>");
    expect(output).not.toContain("'>");
    expect(output).toBe('&#39;&gt;&lt;svg/onload=alert(1)&gt;');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces numbers to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('does not alter safe plain text', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });

  it('handles Lao text without corruption', () => {
    const lao = 'ວຽງຈັນ';
    expect(escapeHtml(lao)).toBe(lao);
  });

  it('handles Chinese text without corruption', () => {
    const zh = '万象公寓';
    expect(escapeHtml(zh)).toBe(zh);
  });

  it('escapes all five special chars in one string', () => {
    expect(escapeHtml('<"\'>&')).toBe('&lt;&quot;&#39;&gt;&amp;');
  });
});

// ── isSafeUrl ──────────────────────────────────────────────────────

describe('isSafeUrl', () => {
  it('allows https://', () => {
    expect(isSafeUrl('https://example.com/image.jpg')).toBe(true);
  });

  it('allows http://', () => {
    expect(isSafeUrl('http://example.com/photo.jpg')).toBe(true);
  });

  it('blocks javascript: scheme', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('blocks javascript: with mixed case', () => {
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
  });

  it('blocks data: URIs', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('blocks vbscript:', () => {
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSafeUrl('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isSafeUrl(null)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isSafeUrl(42)).toBe(false);
  });

  it('returns false for a relative path', () => {
    expect(isSafeUrl('/images/photo.jpg')).toBe(false);
  });
});
