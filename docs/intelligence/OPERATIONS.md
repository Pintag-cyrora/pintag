# Intelligence Layer — Operational Configuration

> This document exists specifically to close a gap the M1 retrospective
> flagged as a "must fix": the actual production configuration for the
> Intelligence Layer (secrets, scheduling, deployment) previously existed
> nowhere in the repository — only as tribal knowledge. That gap directly
> contributed to a real production incident (a stale Vault secret causing
> silent 401s on every scheduled run, undetected until someone happened to
> check). This document is the fix: everything needed to deploy, schedule,
> and troubleshoot the Intelligence Layer, in one place, kept current.

## Required environment variables / secrets

Set via **Supabase Dashboard → Edge Functions → generate-intelligence-report → Manage secrets**
(or `supabase secrets set` from the CLI). All four are required; the
function fails closed (a clear error, not a silent misbehavior) if any
are missing.

| Variable | Purpose | Where it comes from |
|---|---|---|
| `SUPABASE_URL` | Base URL for REST/RPC/auth calls | Project Settings → API |
| `SUPABASE_ANON_KEY` | Used only to validate a staff JWT via `/auth/v1/user` | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS for all reads/writes the function performs, and is also the credential pg_cron authenticates with (see below) | Project Settings → API — **treat as a secret**, never expose client-side |
| `GEMINI_API_KEY` | Calls Gemini 2.5 Flash for report narration | Google AI Studio |

If `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` is
missing, every request gets `"Server misconfigured"` (401) before any
work happens. If `GEMINI_API_KEY` is missing, the function fails with an
explicit error message pointing back to this location — never a silent
skip.

## Deployment

```sh
supabase functions deploy generate-intelligence-report --project-ref <project-ref>
```

There is no separate build step — `index.ts` and its three sibling `.js`
modules (`insight-engine.js`, `report-composer.js`, `gemini-client.js`,
`metrics-utils.js`) deploy together as one function bundle. Before
deploying, run the unit test suite (`node --test
'supabase/functions/generate-intelligence-report/**/*.test.js'`) — see
`tests/intelligence/README.md` and the `.test.js` files themselves for
what's covered.

## Scheduling (pg_cron + pg_net)

**Why pg_cron, not GitHub Actions' `schedule:` trigger:** GitHub Actions
scheduled workflows auto-disable after 60 days of repository inactivity —
a real risk for something meant to run unattended every morning. pg_cron
lives inside Supabase itself, with no dependency on this repo staying
active.

### One-time setup

1. Enable the `pg_cron` and `pg_net` extensions: **Supabase Dashboard →
   Database → Extensions** (plan-tier dependent; not available on every
   plan).
2. Store the service-role key in Vault, under the exact name
   `intelligence_report_service_key` — every cron job below reads it by
   this name. This is the credential that failed silently in the incident
   this document exists to prevent; if the service-role key is ever
   rotated, **this Vault secret must be updated to match**, or every
   scheduled run starts returning 401 with no visible symptom other than
   reports quietly stopping.

   ```sql
   SELECT vault.create_secret('<service-role-key-value>', 'intelligence_report_service_key');
   ```

   To rotate it later:

   ```sql
   SELECT vault.update_secret(
     (SELECT id FROM vault.secrets WHERE name = 'intelligence_report_service_key'),
     '<new-service-role-key-value>'
   );
   ```

### The three scheduled jobs

**Timing note, stated explicitly because it is easy to get wrong twice:**
`resolvePeriod()` in `index.ts` computes "yesterday" via `yesterdayUTC()`,
which reads the UTC calendar date *at invocation time*. A cron firing at
23:00 UTC would resolve to the wrong (one day too early) period — this
was caught and corrected before it ever shipped. The schedule below fires
just after UTC midnight instead, so "yesterday" always means the day that
actually just ended.

```sql
-- Daily, 00:05 UTC
SELECT cron.schedule(
  'intelligence-report-daily',
  '5 0 * * *',
  $$
  SELECT net.http_post(
    url := '<SUPABASE_URL>/functions/v1/generate-intelligence-report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'intelligence_report_service_key'),
      'apikey', '<SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{"report_type":"daily"}'::jsonb
  );
  $$
);

-- Weekly, Monday 00:10 UTC
SELECT cron.schedule(
  'intelligence-report-weekly',
  '10 0 * * 1',
  $$
  SELECT net.http_post(
    url := '<SUPABASE_URL>/functions/v1/generate-intelligence-report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'intelligence_report_service_key'),
      'apikey', '<SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{"report_type":"weekly"}'::jsonb
  );
  $$
);

-- Monthly, 1st of the month 00:15 UTC
SELECT cron.schedule(
  'intelligence-report-monthly',
  '15 0 1 * *',
  $$
  SELECT net.http_post(
    url := '<SUPABASE_URL>/functions/v1/generate-intelligence-report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'intelligence_report_service_key'),
      'apikey', '<SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{"report_type":"monthly"}'::jsonb
  );
  $$
);
```

Replace `<SUPABASE_URL>` and `<SUPABASE_ANON_KEY>` with the project's real
values (the anon key here is only used to satisfy PostgREST's `apikey`
header requirement — the actual authorization is the service-role bearer
token, checked by `requireStaffOrService()`).

These three `cron.schedule()` calls are **not** captured in a tracked
migration — they were applied directly via the SQL editor, matching how
Vault secrets are also necessarily a manual, per-project setup step (a
migration can't know a project's live service-role key). This document is
the authoritative reference for reproducing them, including on a fresh
project or after disaster recovery.

### Verifying the schedule is live

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'intelligence-report-%';
```

To see recent run outcomes:

```sql
SELECT * FROM cron.job_run_details
WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'intelligence-report-%')
ORDER BY start_time DESC LIMIT 20;
```

## Auth model reference

`requireStaffOrService()` (in `index.ts`) accepts exactly two forms of
Bearer token:

1. **The raw `SUPABASE_SERVICE_ROLE_KEY` value** — this is what pg_cron's
   `net.http_post` calls use (no user session exists inside a cron job).
2. **A staff member's JWT**, validated via `/auth/v1/user`, requiring the
   authenticated email to be exactly `admin@pintag.io`.

**Known limitation, tracked from the M1 retrospective:** this hardcoded
email check is a different (and narrower) staff model than the
`is_pintag_staff(auth.uid())` function RLS policies use elsewhere, which
checks the `parties` table for `type = 'staff'` and supports any number of
staff accounts. Today these agree because there is exactly one staff
account. If a second staff member is ever added to `parties`, they will
have full read access to Intelligence data via RLS but will get 401'd by
this function specifically — a correctness gap to fix before that
happens, not a security hole (it fails closed).

## Troubleshooting

- **Reports silently stop appearing.** Check `cron.job_run_details` above
  first. If jobs are firing but every response is a 401, the Vault
  secret (`intelligence_report_service_key`) most likely no longer
  matches the project's current service-role key — this is exactly what
  happened in the incident this document exists to prevent. Compare the
  Vault secret's value against Project Settings → API → service_role key,
  and update it if they differ (see rotation SQL above).
- **A report shows `status = 'failed'`** — read its `error_message`
  column directly (`SELECT * FROM intelligence_reports WHERE status =
  'failed' ORDER BY generated_at DESC`). Common causes: `GEMINI_API_KEY`
  missing or invalid, a Gemini timeout/rate-limit exhausting all retries
  (`gemini-client.js`'s `RETRY_DELAYS`), or a concurrent sweep already
  holding `intelligence_sweep_lock` past its 10-minute stale-reclaim
  window.
- **Manually triggering a run** (e.g. to backfill a missed period): call
  the function directly with a staff JWT and `force: true` — this is
  exactly what `intelligence.html`'s Generate buttons do. See
  `docs/intelligence/INTELLIGENCE_PAGE_ARCHITECTURE.md` for the page-side
  behavior.
