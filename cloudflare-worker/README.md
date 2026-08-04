# Language-aware OG preview Worker

Generates the correct-language WhatsApp/Facebook/Telegram link preview for
`listing.html?slug=...&lang=...`, `listings.html?lang=...`, and
`index.html`/`/?lang=...` by rewriting just the `<head>` tags of the real
origin response — see the comment block at the top of
`og-listing-preview.js` for the full rationale. All three paths read the
same `?lang=` precedence tier via the shared `resolveLang()` — see that
function's comment for why the other tiers of `lang.js`'s client-side
precedence (persisted preference, browser language) can't be reproduced
server-side.

## ⚠️ Before enabling automatic deployment: this may replace an existing, unseen Worker

Production already has *some* Cloudflare-level mechanism generating a
WhatsApp preview for listing URLs today — referenced in a comment inside
`listing.html`, but its source is not in this repository, and there is no
way to view or export it from this development environment (no Cloudflare
account/API access here). This script is a **fresh, complete
implementation** built from the product's full specification (language
explicit in the URL, correct OG title/description/image/alt per language,
canonical + hreflang tags, English/Lao fallback), not a diff against the
current live script. **This has never been resolved or confirmed from any
development session working on this repo** — it is not safe to assume it's
already been handled.

This matters more once CI deployment (below) is wired up, not less:
Cloudflare routes can only be owned by one Worker at a time, and `wrangler
deploy` reassigns a route to whichever Worker it's deploying, with no
confirmation prompt and no error if something else currently owns it. A
one-off manual `wrangler deploy` at least puts a human in front of the
Cloudflare dashboard at the moment of cutover; **automatic deployment on
every push removes that checkpoint entirely** — so this manual check must
happen once, *before* the CI job is ever allowed to run for the first time
(see "Automatic deployment (CI)" below for exactly what gates that).

Before routing this Worker onto `pintag.io/listing.html*` — manually or via
CI — whoever has Cloudflare dashboard access should:
1. Open **Workers & Pages** and find the Worker currently handling this
   route (check **Workers Routes** under the `pintag.io` zone for an
   existing route matching `listing.html`).
2. Skim its source for anything not covered here — e.g. a different image
   selection/cropping step, extra tags, analytics pings — and decide
   whether that behavior needs to be ported into `og-listing-preview.js`
   before cutting over.
3. Only then update the route to point at this Worker (or replace the old
   one directly), rather than running both simultaneously on the same route.

Note the route this Worker needs now covers `pintag.io/listing.html*`,
`pintag.io/listings.html*`, and `pintag.io/` + `pintag.io/index.html*` — the
old Worker being replaced may only have been routed to the first of these;
confirm the new route pattern in `wrangler.toml` before deploying, not just
the script contents.

## One-time setup (manual, local — do this first)

1. Install Wrangler if you don't have it: `npm install -g wrangler`
2. `wrangler login` (opens a browser to authorize against your Cloudflare account)
3. Edit `wrangler.toml`:
   - Set `account_id` (Cloudflare dashboard → Workers & Pages → Overview, right sidebar)
   - Confirm `zone_name = "pintag.io"` matches the zone already proxying the site
4. Complete the route-ownership check above, then: `wrangler deploy` from this folder
5. In the Cloudflare dashboard, confirm the route `pintag.io/listing.html*`
   now points at `pintag-og-listing-preview` (Wrangler creates the route
   automatically from `wrangler.toml`, but worth a visual confirm the first
   time, especially if an old Worker held that route already — see the
   warning above).

Do this manual deploy **before** wiring up automatic deployment below —
it's the same route-reassignment operation either way, but doing it by hand
first means a human directly observes the Cloudflare dashboard result,
rather than discovering it only via a CI log after the fact.

## Automatic deployment (CI)

Every push to `main` deploys this Worker automatically, via the
`deploy-worker` job in `.github/workflows/deploy-prod.yml` (using
[`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action)).
It runs `wrangler deploy` from this folder using the exact same commit that
was just deployed to production Pages in the same workflow run — see the
comment at the top of that workflow file. There is no separate manual
`wrangler deploy` step required after this is set up; a failed Worker
deploy fails the GitHub Actions run (shows red in the Actions tab), it is
never silently swallowed.

### Required GitHub Secrets

Add both in the repo's **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → **My Profile → API Tokens → Create Token**. Use the **"Edit Cloudflare Workers"** template, scoped to the specific account/zone (`pintag.io`) rather than an account-wide token — this token only needs permission to deploy this one Worker and manage its routes. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → **Workers & Pages → Overview**, right sidebar. `wrangler.toml` intentionally leaves `account_id` **unset** so this secret (in CI) or your `wrangler login` session (local) supplies it. An explicit `account_id` in the file would take precedence over this secret and break CI with Cloudflare API error 7003. |

Neither value is hardcoded anywhere in this repo; both are read from GitHub
Secrets by the workflow at deploy time.

### One-time setup steps (do in order)

1. Complete the "Before enabling automatic deployment" route-ownership
   check above, and the manual `wrangler deploy` in "One-time setup" above —
   **before** adding the secrets below. Once both secrets exist, the very
   next push to `main` deploys automatically with no further confirmation
   step, so this is the last point at which a human reviews the route
   cutover directly.
2. Create the scoped API token (table above) and copy it.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.
4. Push any commit to `main` (or re-run the workflow manually via **Actions
   → Deploy Production (Pages + Worker) → Run workflow**, which this
   workflow also supports via `workflow_dispatch`) and confirm the
   `deploy-worker` job succeeds.
5. Verify the routes are still exactly the 4 declared in `wrangler.toml`
   (Cloudflare dashboard → `pintag.io` zone → **Workers Routes**):
   `pintag.io/listing.html*`, `pintag.io/listings.html*`, `pintag.io/`,
   `pintag.io/index.html*`. `wrangler deploy` re-syncs routes from
   `wrangler.toml` on every deploy, so this list should never drift from
   what's committed — if it ever does, that's a sign something deployed
   outside of CI (or `wrangler.toml` changed without a matching commit
   being deployed).
6. To confirm which commit is actually live at any point, run
   `wrangler deployments list` (from this folder, authenticated locally, or
   via the Cloudflare dashboard's Worker → Deployments tab) — because CI
   deploys from a real `actions/checkout`, Wrangler picks up the commit SHA
   and message from git automatically and shows them per deployment.

## Testing after deploy

```bash
# Should return Lao OG tags (default, no &lang=)
curl -s "https://pintag.io/listing.html?slug=<a-real-slug>" | grep -E 'og:title|og:description|hreflang'

# Should return English OG tags
curl -s "https://pintag.io/listing.html?slug=<a-real-slug>&lang=en" | grep -E 'og:title|og:description'

# Should return Chinese OG tags only if that listing has title_zh; otherwise
# falls back to English per field, and the zh hreflang tag is simply absent
curl -s "https://pintag.io/listing.html?slug=<a-real-slug>&lang=zh" | grep -E 'og:title|hreflang="zh"'
```

Or use Meta's [Sharing Debugger](https://developers.facebook.com/tools/debug/)
/ WhatsApp's own "forward to yourself" test with each of the three
`&lang=` variants of a real listing URL.

## What it does NOT do

- Does not touch any page other than `/listing.html`, `/listings.html`,
  `/index.html`, and `/` (checked by pathname before any Supabase call
  happens) — every other path/asset passes straight through unmodified.
- Only `/listing.html` performs a Supabase lookup (for that property's
  title/description/image); `/listings.html` and `/index.html`/`/` rewrite
  to static trilingual copy with no network call, mirroring their own
  client-side `LISTINGS_META_I18N`/`HOME_META_I18N`.
- Does not change anything for a real visitor with JavaScript enabled — each
  page's own client-side code (`updateOGTags()`, `updateListingsMetaForFilters()`,
  `updateHeadMeta()`) performs the equivalent update on load and on every
  language switch; this Worker only matters for requests that never execute
  JS (link-preview crawlers).
- Does not require a `lang` param to function — a request with no `&lang=`
  gets the Lao (site default) preview on any of the three routes, matching
  each page's own `<html lang="lo">` default.
- Does not read `Accept-Language` or any other header as a language signal
  on any route — see `resolveLang()`'s comment in `og-listing-preview.js`
  for why.
- Does not fail visibly if Supabase is unreachable or a slug doesn't
  resolve — it always falls back to returning the unmodified origin
  response rather than serving a broken page.
