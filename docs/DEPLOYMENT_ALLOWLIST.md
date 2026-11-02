# Deployment allowlist — what is published to production

**Owner of this responsibility:** `site-manifest.txt` (the list) and `scripts/build-site.mjs` (the builder). This page explains them, records
the audit of every page, and tells an operator how to verify a deployment. The repository is **public**, so nothing here is secret; the purpose of the
allowlist is that internal material is not *also* hosted on the production domain.

## What changed
Before: `deploy-prod.yml` uploaded the **whole repository root** (`path: .`) after deleting five legacy pages. Docs, audit reports, runbooks, SQL migrations,
edge-function source, scripts, the test suite and worker source were therefore web-reachable on the production domain (about 628 files; the site needs about 63).

Now: `node scripts/build-site.mjs` copies **only the files listed with `+` in `site-manifest.txt`** into a clean `_site/` directory, generates `config.js` from
`config.prod.js`, stamps the asset version, verifies the result, and only `_site/` is uploaded. Deny by default.

## Rules enforced by the build (and by `site-allowlist.test.js` in CI)
* The output contains exactly the manifest (plus the generated `config.js`) — no more, no fewer.
* Never publishable, whatever the manifest says: `tests/`, `scripts/`, `supabase/`, `docs/`, `ops/`, `cloudflare-worker/`, `pintag-studio/`, `node_modules/`,
  anything with a dot-component, and file types `.md .sql .sh .py .mjs .ts .toml .yml .map .env .pem .key .age`, `*.test.js`, `config.dev.js`, `config.prod.js`,
  `package.json`, `site-manifest.txt` (the one exception is the font licence `fonts/OFL.txt`).
* Every tracked root web file (`.html .js .css .png .jpg … .woff2 .json .txt`) must be classified: `+` published, or `-` excluded **with a reason**. A new page,
  script or image therefore fails CI until someone decides on purpose.
* Every reference in the published HTML, JS and CSS (script/link/img/source, CSS `url()`, quoted file names in inline scripts and modules, the site's own absolute
  URLs on `pintag.io` and the legacy `pintag-cyrora.github.io/pintag/` host) must resolve inside `_site/`. A reference to a repository file that is not published fails the build.
* No `__ASSET_VERSION__` placeholder may remain; `config.js` must equal `config.prod.js`.

## How to add or restore a file
1. Add `+ path` (or change `-` to `+`) in `site-manifest.txt` in the same pull request.
2. `node scripts/build-site.mjs --check-only` (validates) or without `--check-only` (builds `_site/`); `node --test site-allowlist.test.js`.
3. Review the diff of `site-manifest.txt`: it is the list of what the public can fetch.

## Page audit — every page the old deployment published (and the five it already pruned)
"Required" means: needed by a production flow today. Evidence is from the code, `docs/OVER_ENGINEERING_REGISTER.md`, and the references found by the builder.

| Page | Purpose | Linked from | Auth | Decision | Required in production? |
|---|---|---|---|---|---|
| `index.html` | Public home | many | none | **keep** | Yes |
| `listings.html` | Search results and map | home, cards | none | **keep** | Yes |
| `listing.html` | Listing detail | cards, links, link-preview Worker | none | **keep** | Yes |
| `agents.html` | Agent directory | agent page | none | **keep** | Yes |
| `agent.html` | Agent profile | cards | none | **keep** | Yes |
| `for-agents.html` | Information for agents | home, nav | none | **keep** | Yes |
| `viengkhone-phomthavong.html` | Hard-coded single-agent page with its own OG tags | nothing in the code (only its own canonical/OG tags); reached from external shares or bookmarks | none | **keep** | Probably: URLs may have been shared externally. The register marks it "delete later"; removing it would break those links, so it stays until you decide |
| `reset-password.html` | Landing page for password-reset emails | `admin-auth.js`, Supabase auth redirect | token | **keep** | Yes (auth flow) |
| `admin.html` | The administrator console | — (bookmarked) | `admin-auth.js`: email + password + TOTP | **keep** | Yes — the only listing editor |
| `agent-setup.html` | Agent-profile editor, linked from the console | `admin.html` | `admin-auth.js` | **keep** | Yes (admin-linked). Register: legacy, "delete later" |
| `analytics.html` | Analytics dashboard | `admin.html` | `admin-auth.js` | **keep** | Yes |
| `analytics-inspector.html` | Forensic lead/event inspector | `admin.html` | `admin-auth.js` | **keep** | Yes while recovery is open (register: archive after recovery closes) |
| `intelligence.html` | AI market-intelligence reports | `admin.html` | `admin-auth.js` | **keep** | Yes (admin-linked). Register: "archive" |
| `gallery-recovery.html` | Photo-to-listing recovery tool | **nothing links to it**; bookmarked/typed | `admin-auth.js` | **keep** | Yes while recovery is open (register: keep until recovery closes). Uncertain how the operator reaches it; keeping preserves the URL |
| `watermark-migrate.html` | One-off watermark migration | nothing | `admin-auth.js` | **EXCLUDE (new)** | No: "its migration is done" (register: delete later) |
| `og-preview-gen.html` | Canvas generator for `og-preview.jpg` | nothing | none | **EXCLUDE (new)** | No: the JPG is committed and published; the generator is a design tool (register: archive, remove from the artifact) |
| `og-preview-listings-gen.html` | Same for `og-preview-listings.jpg` | nothing | none | **EXCLUDE (new)** | No (same reasoning) |
| `agent-login.html`, `dashboard.html`, `edit-listing.html`, `add-property.html` | Legacy agent/owner portal | each other | password only | **EXCLUDE (unchanged)** | No — already pruned before this change (`docs/LEGACY_AGENT_PORTAL.md`) |
| `marketing-os.html` | Founder marketing tool, separate Supabase project | — | password only | **EXCLUDE (unchanged)** | No — already pruned before this change |

The three **new** exclusions (`watermark-migrate.html`, `og-preview-gen.html`, `og-preview-listings-gen.html`) are the only pages whose URLs stop working. They are
recorded as `-` lines with reasons; restoring one is a one-line change. Nothing else that was reachable and used is removed.

## Other files
* **Published scripts/styles:** every first-party `.js`/`.css` loaded by a published page (found by the builder, not guessed). **Not published:** `budget-bands.js`
  (no page loads it), `map-location-field.js` (only the legacy owner forms), `config.dev.js`, `config.prod.js`.
* **Images:** all root images are published, including some with no reference in code (`pintag-balcony.png`, `pintag-exterior.png`, four agent photos). They may be
  referenced from database rows (`photo_url`), social posts or the link-preview Worker, which cannot be checked from the repository; images are not sensitive, so they stay.
* **`for-agents.html` and `agent.html` load images from `https://pintag-cyrora.github.io/pintag/…`** (the legacy GitHub Pages address, which redirects to the custom
  domain). Those files (`pintag-interior.png`, `pintag-villa.png`) are therefore published.
* **`config.js`** is generated from `config.prod.js` (as before). **`CNAME`** is published (required for the custom domain).
* **Known pre-existing dangling reference:** `listing.html` declares `favicon.png`, which does not exist in the repository, so it already returns 404 in production. The manifest
  records it (`~`) so the build tolerates it; it is not fixed here.
* **Dev deployment** (`deploy-dev.yml`) still uploads the repository root; it is unchanged by this change.

## Verifying a deployment (read-only; needs a network allowed to reach the site)
`SITE_URL=https://pintag.io bash scripts/verify-site-exclusions.sh` sends GET requests only and checks that every reviewed exclusion and a fixed list of sensitive paths return **404**
and every published page and `config.js` return **200**. A Cloudflare challenge (HTTP 403 with `cf-mitigated`) is reported as UNVERIFIABLE, never as a pass.
Manual spot checks (expect 404): `/SECURITY.md`, `/docs/DOCUMENTATION_MAP.md`, `/supabase/migrations/20260817000000_security_audit_hardening.sql`, `/scripts/restore-production.sh`,
`/tests/security/README.md`, `/RECOVERY_RUNBOOK.md`, `/database-migration.sql`, `/watermark-migrate.html`. Expect 200: `/`, `/listings.html`, `/listing.html`, `/admin.html`, `/config.js`.
Also check in a browser: the home page, a listing page in Lao/English/Chinese, the map view, the administrator console sign-in, and a link preview of a listing.

## What this does not fix
* **The repository is public:** every file remains readable on GitHub, in forks and in caches, and workflow logs are public. This change stops the production domain from also
  hosting them; it does not make them private. Repository visibility is a separate decision (currently: stay public).
* **Cloudflare:** no rule was added. A WAF rule is a separate, optional, production change.
* **Files already fetched or indexed** while the old deployment was live cannot be recalled; search engines may take time to drop them.
* **Live behaviour was not verified** (the site is unreachable from the authoring environment); verification is the script above, run by an authorized operator after deployment.

## Rollback
Revert the `deploy-prod.yml` change (restore `path: .` and the three removed steps) or restore a single page by switching its `-` line to `+`.
