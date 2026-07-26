-- The run ledger (autonomy roadmap step 1 — see EXECUTION_ARCHITECTURE.md
-- §8.1). Every department execution gets a row here, whether the founder
-- triggered it from their phone or a schedule started it at 3am.
--
-- WHY THIS EXISTS. Execution state currently lives in module-scoped Maps
-- (founder-server.ts's `morningJob`, `activeCampaigns`), which means it dies
-- with the process. That is acceptable for a local tool the founder watches
-- and unacceptable for an organization that works unattended: there is no
-- history, no way to answer "what happened overnight," no way for a second
-- device to see the same state, and — most importantly — nothing for the
-- Morning Brief to REPORT OVER once it stops orchestrating work and starts
-- reporting completed work (§7).
--
-- This table is deliberately useful on its own, before any scheduling
-- exists: run history, progress that survives a restart, and a spend audit
-- trail ("who spent this, and on what").
--
-- IDEMPOTENCY. `idempotency_key` is what makes a retrying scheduler safe. A
-- nightly cycle that fires twice, or a worker that restarts mid-run, must not
-- produce two campaigns for one opportunity. Callers pass a natural key —
-- conventionally `<org>:<department>:<cycle-date>` — and the unique index
-- turns a duplicate start into a detectable conflict rather than duplicate
-- work and duplicate LLM spend. It is nullable because founder-triggered ad
-- hoc runs legitimately have no natural key: pressing Generate twice on
-- purpose is a real thing a founder may want to do.
--
-- COST. `cost_usd` is nullable and only ever written from a real measured
-- value. A run whose provider didn't report cost stores null, not an
-- estimate — same evidence discipline as everything else here (a fabricated
-- number in a spend audit is worse than a missing one).

create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',

  -- Which department ran. Free text rather than an enum so adding a
  -- department is a code change, not a migration — matches how AgentName
  -- (pipeline/lib/health.ts) is already a TypeScript union, not a DB type.
  department text not null,

  -- 'running' | 'complete' | 'failed' | 'interrupted'
  -- 'interrupted' is for runs orphaned by a process restart: they were
  -- 'running' in a process that no longer exists. Distinguishing that from a
  -- genuine failure matters — one is a crash, the other is a bug in an agent.
  status text not null default 'running',

  -- Who asked for this: 'founder' | 'schedule' | 'department'. The last one
  -- is for the department-to-department queueing in §10 — Research finishing
  -- enqueues Strategy. Recorded so the brief can distinguish "you asked for
  -- this" from "the organization decided to do this."
  trigger text not null default 'founder',

  started_at timestamptz not null default now(),
  finished_at timestamptz,

  -- Real measured spend only. Null means unknown, never zero-as-a-guess.
  cost_usd numeric(10, 4),

  -- Populated on failure, so the phone can show what actually broke rather
  -- than a generic error.
  error text,

  -- What the run produced, by reference not by value: campaign ids, the
  -- generatedAt of a brief, counts. Deliberately loose (jsonb) because each
  -- department's output shape differs and this table should not need a
  -- migration every time one of them changes.
  output jsonb not null default '{}'::jsonb,

  -- Free-form progress for a running job (current step, per-step state), so
  -- a client polling mid-run sees real detail instead of just "running".
  progress jsonb not null default '{}'::jsonb,

  idempotency_key text,

  updated_at timestamptz not null default now()
);

-- One run per natural key. Partial (`where idempotency_key is not null`) so
-- ad hoc founder runs, which have no key, are never constrained.
create unique index if not exists pipeline_runs_idempotency_key_uniq
  on pipeline_runs (idempotency_key)
  where idempotency_key is not null;

-- The Morning Brief's own query shape: "everything since the last brief,
-- newest first" (§7). Also serves the workspace's run-history view.
create index if not exists pipeline_runs_org_started_idx
  on pipeline_runs (org_id, started_at desc);

-- Circuit-breaker query (§11): "the last N runs for this department."
create index if not exists pipeline_runs_org_department_started_idx
  on pipeline_runs (org_id, department, started_at desc);

alter table pipeline_runs enable row level security;

-- Read-only for the founder — written only by the pipeline's service-role
-- connection (bypasses RLS by design, same as morning_briefs and
-- observation_source_tokens). A run record is an audit trail: the founder
-- reads it, nobody edits it by hand.
create policy "founder reads pipeline runs" on pipeline_runs for select using (auth.role() = 'authenticated');
