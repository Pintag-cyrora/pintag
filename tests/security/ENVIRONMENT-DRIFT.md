# Security suite — known staging/CI environment drift

The Security Regression workflow (`.github/workflows/security-regression.yml`)
runs `tests/security/run.sh` against the **staging** Supabase project
(`SUPABASE_URL` / `SUPABASE_ANON_KEY` secrets, `APP_ENV=staging`). Some
failures come from the staging project not being a faithful mirror of
production, **not** from a production security gap or a wrong test. Those are
recorded here so they are not "fixed" by weakening production or the tests.

## Anonymous `lead_events` INSERT returns 401 in staging (Group B)

**Symptom (CI, staging):**

- `anon INSERT lead_events (active listing)` → **401** (test expects `201`)
- every downstream Rate-Limiting `lead_events` case → `401` (cannot get a first
  successful insert), and the flood counter reads `0`

**This is NOT how production behaves.** The live single-admin lockdown
(`supabase/migrations/20260804130000_single_admin_cyrora_lockdown.sql`) grants
anon the INSERT it needs and adds the matching policy:

```sql
-- line 125
CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon WITH CHECK (true);
-- line 174
GRANT INSERT ON lead_events, listing_events, search_events, ui_events, page_views TO anon;
```

So in production anon **can** insert `lead_events` (`201`) — which is exactly
how the live site records leads (the admin dashboard's lead counts prove it).

**Root cause of the staging 401:** the staging `lead_events` table is missing
the `GRANT INSERT ... TO anon` above.

- `401` (role lacks the table privilege) rather than `403` (RLS policy denial)
  is the tell that the block is at the **grant** level, not the policy level.
- Proof it is partial drift, not a global anon-key problem: in the **same**
  staging run, `anon INSERT listing_events` **succeeds (201)** — staging has the
  grant for `listing_events` but not for `lead_events`, even though production
  grants both identically on the same line.

**Correct remediation (staging/CI only — do NOT change production or the tests):**

1. Apply the production lockdown grants to the staging project:
   ```sql
   GRANT INSERT ON lead_events, listing_events, search_events, ui_events, page_views TO anon;
   ```
   and confirm the `anon insert *` policies from `20260804130000` exist there, **or**
2. Point the CI `SUPABASE_URL` / `SUPABASE_ANON_KEY` secrets at a project that
   is kept in sync with production migrations.

Until staging is synced, the `lead_events` INSERT and its dependent
Rate-Limiting assertions will remain red **in CI only**. The tests are left
asserting the correct production behavior (`201`) on purpose — accepting `401`
would falsely encode "production rejects lead logging."
