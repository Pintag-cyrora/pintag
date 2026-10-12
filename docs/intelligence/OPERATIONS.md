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
`resolvePeriod()` in `index.ts` computes "yesterday" via
`date-boundary.js`'s `yesterdayVientiane()`, which reads the **Asia/Vientiane**
calendar date *at invocation time* (see
`20260918000000_intelligence_vientiane_calendar.sql` — Pintag is a
Laos-based business, so the report's calendar is Vientiane, not UTC, even
though this cron itself still runs on a UTC clock and the database's own
`TimeZone` setting stays UTC). The schedule below still fires at 00:05 UTC
(07:05 Vientiane) — unchanged by that migration, and still correct: a UTC
day used to need firing within 5 minutes of UTC midnight to avoid resolving
"yesterday" one day too early (the 23:00 UTC mistake this note originally
warned about). Under the Vientiane boundary the same firing time has *more*
margin, not less — Vientiane midnight (17:00 UTC the previous day) has
already passed a full 7 hours before this cron fires at 00:05 UTC, so
"yesterday" (Vientiane) is unambiguously the complete, already-finalized
previous Vientiane day by the time any of these three jobs run. No cron
schedule change was needed for the calendar fix; only this note's
justification changed.

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

### Reading the run results correctly (pg_net 5-second timeout)

`net.http_post` is asynchronous and, unless `timeout_milliseconds` is passed
(the jobs above do not), pg_net gives up on each request after **5000 ms**.
The Edge Function sends no response until the very end of the run (the
snapshot step, the insight sweep, the Gemini call(s) and the report insert all
happen first), so a daily run takes well over 5 seconds (about 20 seconds when
last observed). Expect this on every run:

- **`cron.job_run_details.status = 'succeeded'` (`return_message = '1 row'`)
  only means the SQL command `SELECT net.http_post(...)` completed.** It
  returns a request id as soon as the request is queued. It says nothing about
  whether the Edge Function ran, failed or finished.
- **A `net._http_response` row with `timed_out = true`, `status_code IS NULL`
  and `error_msg = 'Timeout of 5000 ms reached'` does not mean the Edge
  Function failed.** pg_net stopped waiting; it did not cancel the function.
  Observed in production: the request timed out while the snapshot row had
  already been written about 2 seconds in and the report finished about 20
  seconds in. The snapshot is written by a separate database call
  (`ensure_daily_metrics_snapshot`, `index.ts` `fetchDailyMetrics`) that
  commits on its own, so the timeout cannot roll it back. A 401 or other fast
  error, by contrast, returns inside 5 seconds and is expected to be recorded
  with its `status_code`. `net._http_response` rows may also be pruned after a while.

**Verify that a run actually completed from the tables the function writes,
not from cron or pg_net:**

```sql
-- 1. The report for the target day (status 'generated'; read error_message if 'failed')
SELECT report_type, period_start, period_end, status, generated_at, error_message
FROM intelligence_reports
WHERE report_type = 'daily'
ORDER BY generated_at DESC LIMIT 5;

-- 2. The snapshot row for the target day (finalized_at is when it was written)
SELECT day, finalized_at
FROM daily_metrics_snapshot
ORDER BY day DESC LIMIT 5;
```

(For the weekly and monthly jobs, change `report_type`.) A run is complete
when the expected `intelligence_reports` row has `status = 'generated'` and the
`daily_metrics_snapshot` row for its target day exists.

**Target day versus cron time.** The cron schedule is in UTC; the report
calendar is Asia/Vientiane (UTC+7, no daylight saving). The daily job fires at
00:05 UTC, which is 07:05 the same calendar date in Vientiane. A daily run
targets *yesterday in Vientiane* (`yesterdayVientiane()` in `date-boundary.js`,
and `v_end` in `ensure_daily_metrics_snapshot`), so:

| Cron fires (UTC) | Vientiane time | Target day (row `day` / report `period_end`) |
|---|---|---|
| 2026-10-12 00:05 | 2026-10-12 07:05 | **2026-10-11** |
| 2026-10-13 00:05 | 2026-10-13 07:05 | **2026-10-12** |

The row for a given day cannot exist until Vientiane midnight has passed
(17:00 UTC on that same date), and `finalized_at` is the UTC moment the row
was written, so for the scheduled run it falls on the UTC date *after* the
row's `day`. Do not look for a row dated the same UTC date as the cron run.

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
  first (a `succeeded` status only means the request was queued; confirm
  completion in `intelligence_reports` as described in "Reading the run
  results correctly"). If jobs are firing but every response is a 401, the Vault
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
