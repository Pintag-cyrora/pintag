# Contact Tracking Tests

Automated protection against the 2026-08 contact-tracking regression: an
audit found real WhatsApp/Call contact buttons that completed a genuine
contact (opened WhatsApp, dialed a number) while posting zero analytics
rows anywhere — `listing.html`'s mobile sticky CTA bar, and `agents.html`'s
WhatsApp button (the whole page never loaded the tracking scripts at all).

This suite has two parts:

- **`contact-cta-audit.spec.js`** — a static source scan (no server, no
  Supabase mocks) that finds every `wa.me`/`tel:` URL construction site
  across the site's pages and fails if it isn't wired to
  `components.js`'s `ptContactClick()` or a `data-track` attribute. This
  is what makes the guard durable: it catches a *future* untracked
  contact button the moment it's added, without needing a fixture/mock
  written for whatever new page it lands on.
- **`contact-tracking-live.spec.js`** — real browser clicks against a
  mocked Supabase backend, confirming the previously-broken paths now
  post exactly the right `ui_events`/`lead_events` rows (and that the
  Rented-Listings waitlist CTAs correctly stay `lead_events`-free by
  design, via `recordLead:false`).

Fully mocked — no real Supabase project, credentials, or network access
required. Isolated from the app itself (which has no build step and no
`package.json` of its own) — this directory's `package.json` exists only
so the test tooling has somewhere to declare its one dependency.

## Running locally

```sh
cd tests/contact-tracking
npm install
npx playwright install --with-deps chromium   # first time only
npm test
```

If you're in an environment with a pre-provisioned Chromium binary:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm test
```

## Adding a new contact CTA

Use `components.js`'s `ptContactClick()` — see its header comment for the
full interface and rationale. Do **not** hand-roll a `trackLead()`-style
call or a bare `data-track` on a WhatsApp/Call `<a>`; the static audit
test will fail the build if it finds one that isn't wired through either
mechanism. If a genuinely new exemption is needed (e.g. another
staff-only internal tool), add it to the `ALLOWLIST` in
`contact-cta-audit.spec.js` with a clear, specific reason — see the two
existing entries for the expected level of detail.
