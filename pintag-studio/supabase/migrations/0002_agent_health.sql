-- AI Department Health — lets the Dashboard answer "is the department itself
-- functioning?" separately from "what's happening today?" (architecture doc,
-- Dashboard section). One row per employee; upserted by that employee's
-- pipeline stage every time it runs, via pipeline/lib/health.ts.

create table if not exists agent_health (
  org_id text not null default 'pintag',
  agent_name text not null check (agent_name in (
    'cmo', 'content_strategist', 'researcher', 'writer', 'graphic_designer',
    'video_producer', 'brand_guardian', 'trend_hunter', 'competitor_watch',
    'publisher', 'marketing_analyst'
  )),
  -- 'idle' = seeded default, has never actually run yet — distinct from
  -- 'healthy' so the Dashboard never implies an agent is fine when it
  -- simply hasn't been exercised.
  status text not null default 'idle' check (status in ('healthy', 'degraded', 'down', 'idle')),
  message text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_name)
);

insert into agent_health (org_id, agent_name)
select 'pintag', a
from unnest(array[
  'cmo', 'content_strategist', 'researcher', 'writer', 'graphic_designer',
  'video_producer', 'brand_guardian', 'trend_hunter', 'competitor_watch',
  'publisher', 'marketing_analyst'
]) as a
on conflict (org_id, agent_name) do nothing;

alter table agent_health enable row level security;

-- Read-only for the founder — health is reported by the pipeline (service
-- role, bypasses RLS), never edited by hand from the Dashboard.
create policy "founder reads department health" on agent_health for select using (auth.role() = 'authenticated');
