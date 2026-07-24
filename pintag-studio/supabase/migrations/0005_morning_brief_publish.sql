-- Morning Brief publish target (M2.10 — reading the Morning Brief on a
-- phone, read-only, without a second cloud runtime; see ARCHITECTURE.md
-- §0's generation-vs-publication distinction). One row per org, upserted
-- by pipeline/daily-briefing.ts (via publishMorningBriefToSupabase(),
-- pipeline/services/morning/publish.ts) immediately after each local,
-- Claude-Code-CLI generation — never from CI, there is none for this.
--
-- `brief` (jsonb) is the permanent, canonical artifact — the same
-- MorningBrief shape generateMorningBrief() has always produced
-- (pipeline/services/morning/types.ts). Any future renderer (a redesign,
-- marketingos.ai's own UI, a mobile app) reads THIS column and can ignore
-- `rendered_html` entirely.
--
-- `rendered_html` is a v1-only convenience: the current renderer
-- (pipeline/renderers/web/render.ts) is already pure and Node-free, so
-- rendering once at publish time and storing the finished string avoids
-- hand-porting that renderer into the browser (which would create a
-- second copy to keep in sync). It is a cache of `brief`, not a second
-- source of truth — never written without `brief` alongside it, and safe
-- to drop or leave stale if a future consumer renders `brief` itself
-- instead.

create table if not exists morning_briefs (
  org_id text primary key default 'pintag',
  brief jsonb not null,
  rendered_html text not null,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table morning_briefs enable row level security;

-- Read-only for the founder — written only by the pipeline's service-role
-- connection (bypasses RLS by design, same as observation_source_tokens),
-- never edited by hand.
create policy "founder reads morning brief" on morning_briefs for select using (auth.role() = 'authenticated');
