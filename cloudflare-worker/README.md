# Language-aware OG preview Worker

Generates the correct-language WhatsApp/Facebook/Telegram link preview for
`listing.html?slug=...&lang=...` by rewriting just the `<head>` tags of the
real origin response — see the comment block at the top of
`og-listing-preview.js` for the full rationale.

## ⚠️ Before deploying: this replaces an existing, unseen Worker

Production already has *some* Cloudflare-level mechanism generating a
WhatsApp preview for listing URLs today — referenced in a comment inside
`listing.html`, but its source is not in this repository, and there is no
way to view or export it from this development environment (no Cloudflare
account/API access here). This script is a **fresh, complete
implementation** built from the product's full specification (language
explicit in the URL, correct OG title/description/image/alt per language,
canonical + hreflang tags, English/Lao fallback), not a diff against the
current live script.

Before routing this Worker onto `pintag.io/listing.html*`, whoever has
Cloudflare dashboard access should:
1. Open **Workers & Pages** and find the Worker currently handling this
   route (check **Workers Routes** under the `pintag.io` zone for an
   existing route matching `listing.html`).
2. Skim its source for anything not covered here — e.g. a different image
   selection/cropping step, extra tags, analytics pings — and decide
   whether that behavior needs to be ported into `og-listing-preview.js`
   before cutting over.
3. Only then update the route to point at this Worker (or replace the old
   one directly), rather than running both simultaneously on the same route.

## One-time setup

1. Install Wrangler if you don't have it: `npm install -g wrangler`
2. `wrangler login` (opens a browser to authorize against your Cloudflare account)
3. Edit `wrangler.toml`:
   - Set `account_id` (Cloudflare dashboard → Workers & Pages → Overview, right sidebar)
   - Confirm `zone_name = "pintag.io"` matches the zone already proxying the site
4. From this folder: `wrangler deploy`
5. In the Cloudflare dashboard, confirm the route `pintag.io/listing.html*`
   now points at `pintag-og-listing-preview` (Wrangler creates the route
   automatically from `wrangler.toml`, but worth a visual confirm the first
   time, especially if an old Worker held that route already — see the
   warning above).

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

- Does not touch any page other than `/listing.html` (checked by pathname
  before any Supabase call happens).
- Does not change anything for a real visitor with JavaScript enabled —
  `listing.html`'s own `updateOGTags()` performs the equivalent client-side
  update on load and on every language switch; this Worker only matters for
  requests that never execute JS (link-preview crawlers).
- Does not require a `lang` param to function — a request with no `&lang=`
  gets the Lao (site default) preview, matching the page's own
  `<html lang="lo">` default.
- Does not fail visibly if Supabase is unreachable or a slug doesn't
  resolve — it always falls back to returning the unmodified origin
  response rather than serving a broken page.
