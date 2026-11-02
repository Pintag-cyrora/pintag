# Cloudflare Turnstile — setup instructions for the Cloudflare account administrator

**Status: DESIGNED, NOT BUILT.** Turnstile is approved for the planned viewing-request form
(`docs/VIEWING_REQUESTS_DECISIONS.md`). Nothing in the repository uses it yet, no widget exists, and no
public feature flag is enabled. This page is a runbook for the person who owns the Cloudflare account.

> **Never send an account password, API token or Turnstile *secret key* to anyone, into the repository, a
> pull request, an issue, a chat or an email.** The only value that is ever shared outward is the **site key**
> (it is public by design). The secret key goes straight into the Supabase secret store (step 4) and nowhere else.

## What you are creating
One Turnstile **widget** (a pair of keys) that proves a visitor is not a bot before the viewing-request form is
accepted. The browser shows the widget and receives a short-lived token; our server-side function (a Supabase edge
function, built later) sends that token plus the secret key to Cloudflare to validate it. A token that was not
validated server-side is worthless: the form must be refused without a valid validation result.

## Steps (Cloudflare dashboard → Turnstile)
1. **Sign in with your own account, with two-factor authentication enabled.** Use a named person's account, not a
   shared login. Do not give Anthropic/Claude or any contractor your credentials; if help is needed, add them as a
   scoped member for the task and remove them afterwards.
2. **Add widget.** Name: `pintag-viewing-requests`.
3. **Hostnames** (add exactly these; Turnstile refuses tokens from other hostnames):
   `pintag.io`, `www.pintag.io`. Add the development/preview hostname(s) only to a **separate** widget
   (`pintag-viewing-requests-dev`) so a development secret can never validate production traffic.
4. **Widget mode: Managed.** (Cloudflare decides whether a visitor needs an interactive step; most see no puzzle.
   Do not choose a mode that always shows a visual puzzle: see "Accessibility" below.)
5. **Copy two values:**
   * **Site key** — public. Send it to the engineering owner through your normal channel. It will be committed
     to `config.prod.js` in the code change.
   * **Secret key** — private. Do **not** copy it into any message. Set it yourself, or have the operator who holds
     Supabase access set it, as a Supabase **Edge Function secret** named `TURNSTILE_SECRET_KEY` for the
     **production** project (Supabase dashboard → Edge Functions → Secrets, or `supabase secrets set` run by an
     operator on their own machine). Repeat for the dev project with the dev widget's secret.
6. **Confirm** by telling the engineering owner "site key sent, secret set in production and dev", with the date.
   The engineer will never see the secret value.

## Rotation and revocation
* Rotate the secret key (Turnstile widget → Rotate secret key) at least yearly, after any staff change that had
  access to it, and immediately if it may have leaked. After rotating, update the Supabase secret; until then the form
  fails closed (visitors see the WhatsApp fallback).
* If the account or widget is lost, the form falls back to WhatsApp-only; no data is at risk.

## What the code change will do (so you can review it)
* Load the Turnstile script from Cloudflare's challenge domain only on the viewing-request form (CSP will gain that
  one origin for `script-src`, `frame-src` and `connect-src`; `docs/CSP.md` and the CSP tests are updated in the same
  change).
* Send the token to our edge function, which calls Cloudflare's server-side validation endpoint with the secret key
  and the visitor's IP (when available). **Fail closed**: a missing, expired, already-used, or unverifiable token
  means the request is refused with a clear retry message.
* Combine Turnstile with the other abuse limits (per-IP, per-phone, per-property, honeypot) — see
  `docs/VIEWING_REQUESTS_DECISIONS.md`. Shared mobile IPs in Laos mean IP limits alone are never relied on.

## Accessibility and fallback (requirements, not options)
* Prefer Managed / non-interactive operation. The widget must be keyboard-reachable and labelled, with the form's
  own error text announced to screen readers.
* If the widget fails to load, is blocked (privacy tools, corporate networks) or cannot be completed, the form must
  show the existing tracked **WhatsApp "Book a viewing"** button so nobody is prevented from contacting the owner.
* Add the processing to the privacy notice and the consent text (Turnstile processes visitor browser and network
  signals) — wording to be proposed for review, not assumed.

## Interaction with Cloudflare Bot Fight Mode and monitoring
The weekly security check from GitHub Actions is currently blocked from fetching production HTML by Cloudflare
(`cf-mitigated: challenge`, HTTP 403; see `docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md`, O4). That is a separate
setting from Turnstile. If you want those checks to run, create a narrowly scoped WAF skip rule (for example by
a secret header value that only the CI job holds). Do **not** disable Bot Fight Mode globally. This is an optional,
separate decision.

## Testing (before launch, on the dev widget only)
* Use Cloudflare's **published test keys** (listed on Cloudflare's Turnstile "testing" documentation page) in the dev
  project to exercise: always-pass, always-fail, and expired/already-used token paths. They were not copied here
  because they could not be verified from the environment used to write this page; take them from Cloudflare's docs.
* Confirm a refused token produces the visible fallback and no record is created.

## Facts to confirm against Cloudflare's current documentation
Token lifetime and single-use behaviour, the exact validation endpoint and parameters, and the free-plan limits were
not re-verified when this was written (the documentation site was unreachable from the authoring environment).
The engineer implementing the function must check them against the live documentation.
