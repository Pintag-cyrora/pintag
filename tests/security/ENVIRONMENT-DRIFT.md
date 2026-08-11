# Security suite — CI target and the `lead_events` insert shape

The Security Regression workflow (`.github/workflows/security-regression.yml`)
runs `tests/security/run.sh` against the Supabase project named by the
`SUPABASE_URL` / `SUPABASE_ANON_KEY` secrets (labelled `APP_ENV=staging`, but the
label is cosmetic — see below). This note records two facts that were the source
of a long, misleading investigation, so they are not re-diagnosed as a
production security gap or "fixed" by weakening production.

## 1. CI currently runs against **production**

The `SUPABASE_URL` / `SUPABASE_ANON_KEY` secrets point at the **production**
project (`eoladhcljbpbhnrmmpev`), not a separate staging database. This was
confirmed by the fact that the active listing CI picked up
(`properties?status=eq.active`) only exists in the production project.

Consequences:

- The suite's analytics inserts (`listing_events`, `search_events`, …) persist
  into the live database.
- **`lead_events` is deliberately handled so the suite never materialises leads
  in the production CRM** (a successful `lead_events` insert fires the
  `create_lead_from_event` trigger, which writes a row into `leads`). See §2.

The clean long-term fix is to repoint these secrets at a real staging project
kept in sync with production migrations. Until then, treat any test that would
*write* business-visible rows (leads) as something to assert-without-persisting.

## 2. Anon `lead_events` insert via `return=representation` is *correctly* denied

Earlier this was misdiagnosed as a missing `GRANT INSERT ... TO anon` on
`lead_events` in "staging". That was wrong. The real mechanism:

- The test helper `api_post` sends `Prefer: return=representation`, so PostgREST
  appends `RETURNING *` to the insert.
- `lead_events` intentionally has **no anon `SELECT` policy** — only
  `admin read lead_events` (authenticated + `is_pintag_admin`). Anonymous
  visitors may record a lead but must not be able to read leads back.
- So the `RETURNING` read-back is filtered out by RLS, and the whole statement
  fails with `new row violates row-level security policy for table
  "lead_events"` — **even though the INSERT `WITH CHECK` passed**. Nothing is
  persisted (the failed statement rolls back).

This is not a bug and not a grant problem — the anon `INSERT` grant and the
`anon insert lead_events` policy (active-listing + `check_lead_rate_limit`) are
both present and correct in production. It is purely a consequence of asking
PostgREST to read the row back on a write-only-for-anon table.

**Why `listing_events` behaves differently in the same run:** it *does* have an
anon `SELECT` policy (the dedup-read policy), so its `RETURNING` read-back
succeeds and its insert returns `201`.

**How the live site avoids this entirely:** the app never uses
`return=representation` for these events. `postEvent()` in `listing.html` (and
the shared `ptContactClick()` in `components.js`) always send
`Prefer: return=minimal`, which performs a plain INSERT with no read-back — so
real lead capture works fine.

### What the suite asserts (and why)

Because CI targets production (§1), the suite must not drive a *successful*
anon `lead_events` insert (it would write a fake lead into a real agent's CRM).
So the tests assert the property we *can* verify over the anon HTTP path
without persisting anything:

- `02_rls.sh` / `07_rate_limiting.sh`: an anon `lead_events` insert sent with
  `return=representation` is **denied (401/403)** — proving anon cannot read a
  lead back.
- The per-session dedup / rate-limit behaviour of `check_lead_rate_limit` is
  **skipped** over HTTP (it can only be exercised by a persisting insert) and is
  instead enforced and verified at the database level (migration
  `20260811000000`).

If the CI secrets are ever repointed at a throwaway staging project, these can
be upgraded to exercise the real success + dedup path with `return=minimal`
(the helper is trivial to add back), since writing test leads there is harmless.
