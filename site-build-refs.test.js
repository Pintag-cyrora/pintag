// Regression tests for the reference scanner in scripts/build-site.mjs (refsOf / localRef / build): HTML comment delimiters, encoded and mixed-case
// variants, attempts to inject markup into logs or output, and attempts to slip a reference to an excluded file past the "every reference resolves"
// gate. Origin: a CodeQL "incomplete multi-character sanitization" finding on the first version, which stripped HTML comments with a regex before
// scanning. The scanner now never removes anything from HTML (a commented-out reference counts as a reference: the safe direction), and every
// value it extracts is decoded the way a browser would before it is compared. Run with: node --test site-build-refs.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refsOf, localRef, decodeRef, build, show } from './scripts/build-site.mjs';

const SRC = fs.readFileSync(new URL('./scripts/build-site.mjs', import.meta.url), 'utf8');
const SECRET = 'docs/SECURITY.md';
const has = (html) => refsOf('page.html', html).has(SECRET);

test('the scanner never strips HTML comments: no comment-removal regex or helper exists in build-site.mjs (the flagged pattern)', () => {
  assert.doesNotMatch(SRC, /replace\(\s*\/<!--/);
  assert.doesNotMatch(SRC, /withoutHtmlComments|stripHtmlComments/);
  assert.doesNotMatch(SRC, /<!--[\s\S]{0,12}-->\s*\/g/);
});

test('HTML comment delimiters of every shape: a reference is found whether or not it sits inside something that looks like a comment', () => {
  const variants = [
    `<!-- <img src="${SECRET}"> -->`,                    // properly commented out
    `<!--<img src="${SECRET}">`,                          // unterminated
    `<!-- x --!> <img src="${SECRET}">`,                  // --!> closes a comment in HTML parsing
    `<!<!-- -->--> <img src="${SECRET}">`,                // nested/split delimiters that a one-pass regex would reassemble into "<!--"
    `<!--> <img src="${SECRET}">`,                        // <!--> is an (empty) comment
    `<!---> <img src="${SECRET}">`,
    `<!-- a --> <!-- <img src="${SECRET}"> -->`,
    `<!--[if IE]><img src="${SECRET}"><![endif]-->`,      // conditional comment
    `<!-- -- --><img src="${SECRET}">`,
    `<IMG SRC="${SECRET}">`, `<ImG sRc='${SECRET}'>`, `<img\n  src = "${SECRET}">`,   // mixed case, quotes, whitespace
    `<a HREF="${SECRET}">x</a>`, `<link rel="preload" as="fetch" href="${SECRET}">`, `<form action="${SECRET}">`, `<object data="${SECRET}">`,
    `<img srcset="a.png 1x, ${SECRET} 2x">`, `<meta http-equiv="refresh" content="0; url=${SECRET}">`,
    `<style>.x{background:url(${SECRET})}</style>`, `<style>.x{background:url('${SECRET}')}</style>`,
  ];
  for (const v of variants) assert.ok(has(v), v);
  // quoted file names inside inline scripts are scanned for the file types a page can load
  for (const v of [`<script>var u = 'hidden.js';</script>`, `<script>fetch("hidden.js")</script>`, '<script>x = `hidden.js`</script>', '<!-- <script>x("hidden.js")</script> -->'])
    assert.ok(refsOf('page.html', v).has('hidden.js'), v);
});

test('encoded variants decode to the file a browser would request', () => {
  const variants = [
    'docs%2FSECURITY.md', 'docs%2fSECURITY.md', 'docs&#47;SECURITY.md', 'docs&#x2F;SECURITY.md', '&#100;ocs/SECURITY.md', 'docs&sol;SECURITY.md',
    'docs/SECURITY&period;md', 'docs%252FSECURITY.md', 'docs%25252FSECURITY.md', 'docs&amp;#47;SECURITY.md',          // double / triple encoding
    './docs/SECURITY.md', '/docs/SECURITY.md', 'docs//SECURITY.md', 'docs\\SECURITY.md', 'docs/./SECURITY.md', 'x/../docs/SECURITY.md', '../../docs/SECURITY.md',
    'docs/SECURITY.md?v=1', 'docs/SECURITY.md#top', 'docs/SECURITY.md?a=b#c',
    'https://pintag.io/docs/SECURITY.md', 'HTTPS://WWW.PINTAG.IO/docs/SECURITY.md', 'http://pintag.io/docs/SECURITY.md', '//pintag.io/docs/SECURITY.md', '//WWW.Pintag.io/docs/SECURITY.md',
    'https://pintag-cyrora.github.io/pintag/docs/SECURITY.md', '//pintag-cyrora.github.io/pintag/docs/SECURITY.md',
    '\t docs/SECURITY.md', 'docs/SEC\nURITY.md'.replace('\n', ''), 'docs/SECURITY.md\u0000',
  ];
  for (const v of variants) assert.equal(localRef(v), SECRET, JSON.stringify(v));
  assert.equal(decodeRef('%252e%252e%252fdocs'), '../docs');
  // other origins are never "local"
  for (const v of ['https://example.com/docs/SECURITY.md', '//cdn.example.com/a.js', 'data:text/html,x', 'javascript:alert(1)', 'mailto:a@b.c', '#top', 'tel:123', '${x}', '{{x}}']) assert.equal(localRef(v), null, v);
});

// ── end to end: a published page that still reaches an excluded repository file must FAIL the build ──
function fixture(files, extraManifest = '', { symlink = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  if (symlink) fs.symlinkSync(symlink.target, path.join(root, symlink.name));
  const tracked = [...Object.keys(files), ...(symlink ? [symlink.name] : [])];
  const manifestText = `+ index.html\n- docs/SECURITY.md  # excluded document\n- hidden.js  # excluded script\n- secret.png  # excluded image\n${extraManifest}`;
  return { root, tracked, manifestText, run: () => build({ root, out: path.join(root, '_site'), trackedFiles: tracked, manifestText, version: 'v1' }) };
}
const BASE = { 'docs/SECURITY.md': 'secret', 'hidden.js': 'x', 'secret.png': 'x' };

test('a clean page builds; the same page with any hidden reference to an excluded file fails with a "not published" error', () => {
  assert.equal(fixture({ ...BASE, 'index.html': '<p>hello</p>' }).run().ok, true);
  const attempts = [
    '<!-- <script src="hidden.js"></script> -->', '<!--<script src="hidden.js">', '<SCRIPT SRC="hidden.js"></SCRIPT>', '<script src="hidden%2Ejs"></script>', '<script src="&#104;idden.js"></script>',
    '<script src="./hidden.js"></script>', '<script src="x/../hidden.js"></script>', '<script src="../../hidden.js"></script>', '<script src="//pintag.io/hidden.js"></script>',
    '<script src="HTTPS://WWW.PINTAG.IO/hidden.js"></script>', '<script src="https://pintag-cyrora.github.io/pintag/hidden.js?v=1"></script>',
    '<img srcset="a.png 1x, secret.png 2x">', '<meta http-equiv="refresh" content="0;url=docs/SECURITY.md">', '<a href="docs&#47;SECURITY.md">d</a>', '<a href="docs%2FSECURITY.md">d</a>',
    '<a href="docs\\SECURITY.md">d</a>', '<script>load("hidden.js")</script>', '<script>load(`hidden.js`)</script>', '<style>.a{background:url(secret.png)}</style>',
    '<script src="HIDDEN.JS"></script>', '<a href="Docs/security.md">d</a>',                                // case variants (Pages is case-sensitive; still reported, conservatively)
  ];
  for (const a of attempts) {
    const r = fixture({ ...BASE, 'index.html': a }).run();
    assert.equal(r.ok, false, a);
    assert.ok(r.errors.some((e) => /not published/.test(e)), `${a} -> ${r.errors.join(' | ')}`);
  }
});

test('markup in a reference value cannot reach the output or forge log lines', () => {
  const evil = `<a href="index.html?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!--">a</a><img src="1forge\n::error::x.png"><script src="9a&#10;::set-output name=x::y.js"></script>`;
  const f = fixture({ ...BASE, 'index.html': evil });
  const r = f.run();
  assert.equal(r.ok, false);
  for (const e of r.errors) { assert.doesNotMatch(e, /[\u0000-\u001f\u007f]/); assert.ok(!e.includes('::'), e); assert.ok(e.length <= 300); }
  assert.equal(show('a\n::error::b\r::warning::c'), 'a :​:error:​:b :​:warning:​:c');
  // a page that is only strange (no excluded reference) still builds, and the output is the input byte for byte
  const odd = '<a href="index.html?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!--">a</a><!-- <!-- --> <!--';
  const g = fixture({ ...BASE, 'index.html': odd });
  const rr = g.run();
  assert.equal(rr.ok, true, rr.errors.join(' | '));
  assert.equal(fs.readFileSync(path.join(g.root, '_site', 'index.html'), 'utf8'), odd);
});

test('the version stamp is the only change to published HTML (a hostile page body is copied verbatim)', () => {
  const body = '<script src="a.js?v=__ASSET_VERSION__"></script><!-- <b>"</b> --><img src="x"onerror="1">';
  const g = fixture({ ...BASE, 'index.html': body, 'a.js': '1' }, '+ a.js\n');
  const r = g.run();
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(fs.readFileSync(path.join(g.root, '_site', 'index.html'), 'utf8'), body.replace('__ASSET_VERSION__', 'v1'));
});

test('a symbolic link cannot be published (it would copy a file from outside the repository into _site)', () => {
  const g = fixture({ ...BASE, 'index.html': '<p>x</p>' }, '+ link.js\n', { symlink: { name: 'link.js', target: '/etc/hostname' } });
  const r = g.run();
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not a regular file/.test(e)), r.errors.join(' | '));
  assert.ok(!fs.existsSync(path.join(g.root, '_site', 'link.js')));
});

test('reference values are only ever used as lookup keys: they never reach the filesystem as paths (path traversal in a reference is harmless)', () => {
  const g = fixture({ ...BASE, 'index.html': '<img src="../../../../etc/passwd.png"><script src="/../../etc/hosts.js"></script>' });
  const r = g.run();
  // nothing outside the fixture was read or copied; the result is decided by set membership only
  assert.ok(Array.isArray(r.errors));
  assert.ok(!fs.existsSync(path.join(g.root, '_site', 'etc')));
});
