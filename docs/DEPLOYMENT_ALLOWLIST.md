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
* The reference scanner removes nothing from the HTML it reads (a commented-out reference counts as a reference, the conservative direction) and decodes each
  value as a browser would (HTML entities, percent-encoding repeated, backslashes, `.`/`..`, protocol-relative and mixed-case forms of the site's own URLs, `srcset`, meta refresh).
  A value is only ever used as a lookup key; it is never used as a file path, and text from repository files is stripped of control characters and `::` before it is printed in CI logs.
* A symbolic link cannot be listed in the manifest (it would copy a file from outside the repository into `_site`).
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

## Post-deployment verification (an operator task; read-only; never bypasses a challenge)
Nothing in this change has been verified against the live site: the authoring environment cannot reach it, and this procedure is **not** run by CI. It must be performed by an authorized
operator, from a network and identity that the site (and Cloudflare) allow, after the deployment of the allowlist has finished. Do not use a proxy, a mirror or a header trick to get past a
challenge: a challenged request proves nothing and is recorded as UNVERIFIABLE.

**Run:** `OPERATOR="Full Name" SITE_URL=https://pintag.io EXPECTED_SHA=<deployed commit> bash scripts/verify-site-exclusions.sh` (GET requests only; no body, cookies, credentials or Range header).

| Expectation | How it is decided |
|---|---|
| **200** for every published page in the manifest and for `/config.js` | exactly HTTP 200. **Never 206**: a 206 (partial content) or a `Content-Range` header on a 200 is a FAIL. |
| **Complete HTML**, not a truncated or partial body | the body is non-empty, its size equals `Content-Length` when the server sends one, and an HTML page ends with `</html>`. |
| **404** for every reviewed exclusion (`-` line in the manifest) and for a fixed list of sensitive paths (documents, runbooks, audit reports, SQL migrations, scripts, tests, workflows, worker source, config templates, the manifest) | exactly HTTP 404. A 200, 403 or 301 on such a path is a FAIL. |
| **Cloudflare challenge** | a response with `cf-mitigated: challenge`, or a 403/503 whose body is a challenge page, is **UNVERIFIABLE**, never PASS and never FAIL. The run exits 2 and the record says INCOMPLETE. Re-run from an allowed network; do not work around the challenge. |

Exit status: 0 only if every check passed and an operator was named; 1 if anything failed; 2 if nothing failed but something was unverifiable or no operator was given.

**Manual spot checks** (in a browser, as a person): `/SECURITY.md`, `/docs/DOCUMENTATION_MAP.md`, `/supabase/migrations/20260817000000_security_audit_hardening.sql`, `/scripts/restore-production.sh`,
`/tests/security/README.md`, `/RECOVERY_RUNBOOK.md`, `/database-migration.sql`, `/watermark-migrate.html` (all 404); `/`, `/listings.html`, `/listing.html`, `/admin.html`, `/config.js` (200); then the home page,
a listing page in Lao, English and Chinese, the map view, the administrator console sign-in, and a link preview of a listing.

**Record:** the script ends with a RECORD block (operator, UTC date, site, expected commit, result, outstanding failures). Paste it into
`docs/DEPLOYMENT_VERIFICATION_RECORD.md` in a pull request. A record without an operator is invalid. The allowlist deployment is not considered verified until a PASSED record exists; an
INCOMPLETE or FAILED record stays open with its outstanding items listed, and is never reworded as a pass.

## Administrator email address in published code
**Finding.** Before this change the administrator's sign-in address appeared 10 times in code served on the production domain: once as the constant `ADMIN_EMAIL` in `admin-auth.js`, once as a dead
duplicate constant in `admin.html` (nothing read it), and eight times in comments of the administrator pages.

**Why it is there.** `admin-auth.js` compares the signed-in user's address with the constant (three client-side checks) for an early, friendly rejection of any other account, and exports it so
that `admin.html` can label provenance events with the acting administrator. The *authorization* is not the constant: the server decides through `is_pintag_admin()` (allowlist plus an AAL2 session) in
RLS, storage policies, the analytics functions and the administrator Edge Functions.

**What this change does.** It removes the address from the eight comments and deletes the dead duplicate in `admin.html`, with no change in behaviour. One occurrence remains, in `admin-auth.js`
(the constant and its explanatory comment, which does not repeat the address).

**Why the last occurrence is not removed here.** Removing it would change the administrator sign-in flow, which cannot be exercised against the real authentication service from here; and the address
is already public in the repository (about thirty-six tracked files: security documents, migrations, scripts and tests) and in its history, so removing it from the served code would reduce the exposure only
on the production domain. A hashed comparison would keep the behaviour but is obfuscation, not secrecy (anyone who guesses the address can confirm it), and it would still need the sign-in flow retested.
A real fix is server-side: a database function that answers "is this the administrator account" at the password stage, which would let the browser drop the constant entirely; that is database work and is
not part of this change.

**Exact residual exposure.** The administrator's address can be read by anyone who opens `admin-auth.js`, which is served by the production domain and is also in the public repository. It tells an attacker
which account to target for password guessing or phishing. The controls that matter are unchanged: sign-in needs the password **and** a TOTP code, the database refuses any other account, and public
sign-up was reported disabled by the weekly production probe (2026-11-02). **Owner decision (2026-11-04): this residual exposure is TEMPORARILY ACCEPTED by the owner.** This is an accepted exposure, not a passed security control: nothing here is verified or mitigated by the
acceptance. The acceptance is limited strictly to that one address (the single occurrence remaining in `admin-auth.js`). No other personal information, credentials, tokens or secrets are covered, and it
does not cover any further occurrence of that address or of any other identifier. The issue must be revisited when server-side authorization can replace the client-side email check; until then the
acceptance stays open and is not a closure of the finding.

| Item | Decision |
|---|---|
| Residual exposure (one served occurrence plus the public repository) | **TEMPORARILY ACCEPTED by the owner (accepted exposure, not a passed control).** Date: 2026-11-04; decided by: the repository owner. Scope: that one address only. Revisit: when server-side authorization can replace the client-side email check. |

## Related security controls (reconciled with the evidence record in PR #168)
This change does not verify, certify or improve any of the following, and a green CI run for this pull request proves none of them. The statuses below are the ones in
`docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md` (pull request #168); if that record is updated, it is the source of truth.

| Control | Status | What that means |
|---|---|---|
| O3 admin lockdown matrix | **Partially skipped: NOT verified** | The weekly matrix last reported 1 passed, 0 failed, 3 skipped (authenticated non-admin, admin AAL1, admin with MFA), because CI has no admin credentials. AAL1 refusal and MFA enforcement rest on migration code and a catalog check, not on a test that has run. |
| O4 live security headers and XSS proof | **Unknown / blocked** | Cloudflare challenges the CI runner, so 5 HTTP checks and 2 XSS checks are unverifiable. Neither a pass nor a failure. |
| O7 alert delivery | **Unknown** | The alert webhook is not configured in the monitoring job's log; delivery has not been demonstrated. |
| PITR | **Outstanding / unknown** | A dashboard setting that no workflow can observe. |
| Storage-object restore | **Outstanding (skipped)** | The 2026-10-02 restore drill restored the database but reported 0 storage objects and deferred storage to an operator step. |
Also outstanding and unaffected by this change: the failing weekly image-integrity check, Cloudflare WAF/rate limiting (O9), backup decryption (O8), and L1 certification (still PENDING).

## What this does not fix
* **The repository is public:** every file remains readable on GitHub, in forks and in caches, and workflow logs are public. This change stops the production domain from also
  hosting them; it does not make them private. Repository visibility is a separate decision (currently: stay public).
* **Cloudflare:** no rule was added. A WAF rule is a separate, optional, production change.
* **Files already fetched or indexed** while the old deployment was live cannot be recalled; search engines may take time to drop them.
* **Live behaviour was not verified** (the site is unreachable from the authoring environment); verification is the script above, run by an authorized operator after deployment.

## Rollback
Revert the `deploy-prod.yml` change (restore `path: .` and the three removed steps) or restore a single page by switching its `-` line to `+`.
