-- Observation Sources (M2.2) — credential storage only. Observations
-- themselves (what an Observation Source reports each run) are Operational
-- Memory: computed fresh every `npm run daily-briefing` run and fed
-- straight into the prompt, never persisted here or anywhere else (see
-- pipeline/lib/observations.ts). This table exists purely because OAuth
-- access tokens are rotating state a scheduled pipeline run needs to read
-- and refresh — the one thing this milestone genuinely needs Supabase for,
-- same operational-control-plane role org_settings/agent_health already
-- play, not a new kind of store.

create table if not exists observation_source_tokens (
  org_id text not null default 'pintag',
  -- 'tiktok' today; 'facebook' / 'instagram' / etc. reuse this same table
  -- later — one row per (org_id, source), not a new table per source.
  source text not null,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, source)
);

alter table observation_source_tokens enable row level security;

-- No founder-facing read/write policy: this table is never displayed
-- (tokens aren't something the Dashboard should render) and only ever
-- written by the pipeline's service-role connection, which bypasses RLS
-- by design (see 0001_init_control_plane.sql's RLS note). RLS is still
-- enabled so a future anon/authenticated key can never read it by accident.
