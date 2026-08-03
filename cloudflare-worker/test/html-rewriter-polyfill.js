// Minimal, faithful-enough HTMLRewriter polyfill so og-listing-preview.js's
// rewriteListingHead()/rewriteGenericHead() -- which use the REAL
// `HTMLRewriter` global that only exists inside the Cloudflare Workers
// runtime -- can be exercised end-to-end from plain Node, against real
// fixture HTML lifted from listing.html/index.html/listings.html. This is
// what lets og-listing-preview.test.js assert on actual generated HTML
// (the literal <title>/og:title/... text after rewriting) instead of only
// the pure resolveLang()/buildOgFields() return values.
//
// Deliberately narrow: supports exactly the selector shapes
// og-listing-preview.js actually uses (`tag`, `tag[attr="value"]`,
// `tag[attr="value"][attr2="value2"]`, and the special-cased `head`
// append target) and exactly the Element methods it calls
// (setAttribute/setInnerContent/remove/append). It is not a general HTML
// parser and does not need to be -- Cloudflare's real HTMLRewriter is used
// in production; this only needs to reproduce its observable behavior for
// the fixed set of tags this file rewrites.
//
// Only tags that a registered handler actually matches are ever rewritten
// -- every other byte of the fixture (CSS, unrelated tags, self-closing
// slashes, attribute order) passes through completely untouched, same as
// the real HTMLRewriter streaming everything it doesn't match.

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)\/?>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"/g;

function parseAttrs(attrString) {
  const attrs = new Map();
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString))) attrs.set(m[1], m[2]);
  return attrs;
}

function parseSelector(sel) {
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error('html-rewriter-polyfill: unsupported selector "' + sel + '"');
  const tag = m[1].toLowerCase();
  const conds = [...(m[2] || '').matchAll(/\[([a-zA-Z0-9_-]+)="([^"]*)"\]/g)].map((c) => ({ attr: c[1], value: c[2] }));
  return { tag, conds };
}

function attrsMatch(attrs, conds) {
  return conds.every((c) => attrs.get(c.attr) === c.value);
}

function serializeTag(tagName, attrs) {
  let out = '<' + tagName;
  for (const [k, v] of attrs) out += ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
  out += '>';
  return out;
}

class FakeElement {
  constructor(tagName, attrs) {
    this._tagName = tagName;
    this._attrs = attrs;
    this._removed = false;
    this._innerContent = null; // only meaningful for 'title'
    this._appended = '';
  }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  setInnerContent(value) { this._innerContent = value; }
  remove() { this._removed = true; }
  append(html) { this._appended += html; }
}

class FakeResponse {
  constructor(html) { this._html = html; }
  async text() { return this._html; }
}

class FakeHTMLRewriter {
  constructor() {
    this._rules = []; // {tag, conds, handler}
    this._headHandler = null;
  }
  on(selector, handler) {
    if (selector === 'head') {
      this._headHandler = handler;
      return this;
    }
    const { tag, conds } = parseSelector(selector);
    this._rules.push({ tag, conds, handler });
    return this;
  }
  async transform(response) {
    const html = typeof response === 'string' ? response : await response.text();
    const replacements = []; // {start, end, text}

    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(html))) {
      const tagName = m[1].toLowerCase();
      const attrs = parseAttrs(m[2] || '');
      const rule = this._rules.find((r) => r.tag === tagName && attrsMatch(attrs, r.conds));
      if (!rule) continue;

      const el = new FakeElement(tagName, attrs);
      rule.handler.element(el);

      if (el._removed) {
        // Remove the whole element, including its closing tag + content
        // for a non-void element like title -- only 'title' among this
        // file's selectors is non-void, and only the zh hreflang <link>
        // (a void element) ever calls remove() in practice, but handle
        // both correctly.
        const closeTag = '</' + tagName + '>';
        const closeIdx = html.indexOf(closeTag, m.index + m[0].length);
        const end = closeIdx !== -1 ? closeIdx + closeTag.length : m.index + m[0].length;
        replacements.push({ start: m.index, end, text: '' });
        continue;
      }

      let newTagHtml = serializeTag(tagName, el._attrs);
      let end = m.index + m[0].length;

      if (el._innerContent !== null) {
        const closeTag = '</' + tagName + '>';
        const closeIdx = html.indexOf(closeTag, end);
        if (closeIdx !== -1) {
          newTagHtml += el._innerContent + closeTag;
          end = closeIdx + closeTag.length;
        }
      }

      replacements.push({ start: m.index, end, text: newTagHtml });
    }

    if (this._headHandler) {
      const fakeHead = new FakeElement('head', new Map());
      this._headHandler.element(fakeHead);
      if (fakeHead._appended) {
        const closeIdx = html.indexOf('</head>');
        if (closeIdx !== -1) replacements.push({ start: closeIdx, end: closeIdx, text: fakeHead._appended });
      }
    }

    replacements.sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const r of replacements) {
      out += html.slice(cursor, r.start) + r.text;
      cursor = r.end;
    }
    out += html.slice(cursor);
    return new FakeResponse(out);
  }
}

export { FakeHTMLRewriter, FakeResponse };
