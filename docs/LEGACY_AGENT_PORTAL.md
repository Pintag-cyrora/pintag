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

A fifth page is excluded for a different reason, and is listed here because the
deployment treats it identically:

| File | Role |
|---|---|
| `marketing-os.html` | Founder tool. Password-only `signInWithPassword` as `ninee@pintag.io`, outside `admin-auth.js`, against a **separate Supabase project** (`yuboptuclvocadfrqszo`) — not the Pintag production project. It is outside the single-admin auth model and touches no Pintag production data. |

The four portal pages authenticate with a plain `signInWithPassword` (no TOTP) and
gate only on "is there a session" — they predate `admin-auth.js`.

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

`.github/workflows/deploy-prod.yml` prunes these five files from the Pages artifact
before upload (`rm -f agent-login.html dashboard.html edit-listing.html
add-property.html marketing-os.html`), so they return 404 on pintag.io. The files
stay in the repo; nothing else references them from a deployed page.

### This was not actually true until 2026-08-24

The prune step was correct, but GitHub Pages was set to **Deploy from a branch**
(`build_type: legacy`, source `main` at `/`), so pintag.io served the raw
repository tree and the pruned artifact was built, uploaded and then ignored.
All five pages returned 200 in production for as long as that setting stood —
measured 5/5 live on 2026-08-24 — and the same misconfiguration meant
`config.prod.js` never became `config.js` and `__ASSET_VERSION__` was never
substituted.

The exposure was bounded by the data layer rather than by this prune:
`is_pintag_admin()` requires BOTH `admin_accounts` membership AND an
MFA-verified session (`aal2`), so the portal's password-only login yields
`aal1` and fails closed — no writes, no PII reads. `marketing-os.html` points
at a different Supabase project entirely and never had access to Pintag data.

Switching Pages to **GitHub Actions** is what makes the prune (and the generated
config, and asset stamping) take effect. As of 2026-08-24 that switch is still
PENDING: it is a repository setting, and `PUT /repos/:owner/:repo/pages` answers
403 "Resource not accessible by integration" even to a workflow token holding
`pages: write` — that scope authorises deploying Pages, not reconfiguring the
source. It must be changed by a repository admin at
**Settings → Pages → Build and deployment → Source → GitHub Actions**.
Until then, all five pages remain reachable in production.

## Future

When the verified-agent roadmap begins, the agent authorization model will be
**designed from first principles** under the single-admin/RLS foundation — not
adapted from this portal. Treat these files as historical reference only.
