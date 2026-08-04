# Legacy agent portal — deferred to the future verified-agent phase

**Status:** NOT an active production surface. Retained in the repo for reference;
**excluded from the pintag.io production deployment.**

## What it is

The original agent self-service workflow, from before the single-administrator
model:

| File | Role |
|---|---|
| `agent-login.html` | Agent Portal password login → `dashboard.html` |
| `dashboard.html` | Per-agent dashboard → links to the listing editors |
| `edit-listing.html` | Edit an existing listing |
| `add-property.html` | Create a new listing |

These pages authenticate with a plain `signInWithPassword` (no TOTP) and gate only
on "is there a session" — they predate `admin-auth.js`.

## Why it is disabled in production

The current production model is a **verified-listing platform operated by a single
administrator** (`cyrora.trading@gmail.com`, password + TOTP/AAL2, via
`admin-auth.js`). The administrator manages every listing inside `admin.html`
(its own `saveListing()` upsert, unit-type/contact/owner management); admin.html
does not link to or depend on any of the pages above. The legacy portal is not
part of the current workflow and is not intended for public use yet.

Even while it was reachable, the data layer already contained it: RLS restricts all
writes and all PII reads to `is_pintag_admin()`, so a non-admin agent session could
neither write nor read `owners`/`leads` (verified in P2). Rather than invest in
hardening a surface that isn't in the product, it is removed from the deployment.

## How it is disabled

`.github/workflows/deploy-prod.yml` prunes these four files from the Pages artifact
before upload (`rm -f agent-login.html dashboard.html edit-listing.html
add-property.html`), so they return 404 on pintag.io. The files stay in the repo;
nothing else references them from a deployed page.

## Future

When the verified-agent roadmap begins, the agent authorization model will be
**designed from first principles** under the single-admin/RLS foundation — not
adapted from this portal. Treat these files as historical reference only.
