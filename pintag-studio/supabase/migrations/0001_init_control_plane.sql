-- Pintag Marketing AI — control-plane schema (Supabase project, separate from
-- the production pintag.io project — see architecture doc Section 1).
--
-- Tables here are the operational "control plane" the Dashboard reads/writes
-- directly. Content bodies/assets themselves live in the git-based Content
-- Vault (pintag-studio/content-vault/); these tables index, score, schedule,
-- and track performance for each Vault item.
--
-- org_id is included on every table from day one (default 'pintag') so a
-- future second tenant is a WHERE clause, not a migration — see architecture
-- doc Section 11 (Future Expansion).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- content_items: the Memory index over the Content Vault. One row per Vault
-- item. embedding powers the dedupe/repurpose check the Content Strategist
-- runs before drafting any new brief (architecture doc Section 5).
-- ---------------------------------------------------------------------------
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  content_type text not null check (content_type in (
    'educational_post', 'neighborhood_guide', 'market_update', 'property_video',
    'carousel_graphic', 'checklist', 'buying_guide', 'selling_guide',
    'investor_guide', 'faq'
  )),
  title text not null,
  summary text,
  language text not null default 'lo' check (language in ('lo', 'en', 'zh')),
  vault_path text not null,
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'revising', 'approved', 'scheduled', 'published', 'superseded'
  )),
  derived_from uuid references content_items(id),
  repurposed_into uuid references content_items(id),
  superseded_by uuid references content_items(id),
  tags text[] default '{}',
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_items_org_idx on content_items (org_id);
create index if not exists content_items_type_idx on content_items (content_type);
create index if not exists content_items_status_idx on content_items (status);
create index if not exists content_items_embedding_idx on content_items
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- content_calendar: scheduling state the Publisher and Dashboard both read.
-- ---------------------------------------------------------------------------
create table if not exists content_calendar (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  content_item_id uuid not null references content_items(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram', 'tiktok', 'youtube')),
  scheduled_at timestamptz not null,
  published_at timestamptz,
  post_id text,
  post_url text,
  publish_status text not null default 'queued' check (publish_status in (
    'queued', 'auto_publish_pending', 'awaiting_approval', 'approved', 'published', 'failed', 'skipped'
  )),
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists content_calendar_org_idx on content_calendar (org_id);
create index if not exists content_calendar_scheduled_idx on content_calendar (scheduled_at);
create index if not exists content_calendar_status_idx on content_calendar (publish_status);

-- ---------------------------------------------------------------------------
-- quality_scores: Brand Guardian's scoring per review pass (architecture doc
-- Section 7 — 8 dimensions, educational_value weighted highest).
-- ---------------------------------------------------------------------------
create table if not exists quality_scores (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  content_item_id uuid not null references content_items(id) on delete cascade,
  review_pass integer not null default 1,
  educational_value numeric(3,2) not null check (educational_value between 0 and 1),
  trustworthiness numeric(3,2) not null check (trustworthiness between 0 and 1),
  brand_voice numeric(3,2) not null check (brand_voice between 0 and 1),
  originality numeric(3,2) not null check (originality between 0 and 1),
  visual_quality numeric(3,2) check (visual_quality between 0 and 1),
  shareability numeric(3,2) not null check (shareability between 0 and 1),
  promotion_level numeric(3,2) not null check (promotion_level between 0 and 1),
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  composite_score numeric(4,3),
  verdict text not null check (verdict in ('pass', 'revise')),
  revision_notes text,
  created_at timestamptz not null default now()
);

create index if not exists quality_scores_item_idx on quality_scores (content_item_id);

-- ---------------------------------------------------------------------------
-- approvals_queue: what the Dashboard's "items awaiting approval" widget
-- reads directly. A row exists only when an item did NOT clear auto-publish.
-- ---------------------------------------------------------------------------
create table if not exists approvals_queue (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  content_item_id uuid not null references content_items(id) on delete cascade,
  reason text not null check (reason in (
    'approval_phase_requires_review', 'low_confidence', 'content_type_always_manual',
    'founder_mode_manual_override', 'new_format', 'max_revisions_exceeded'
  )),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decision text check (decision in ('approved', 'rejected', 'requested_changes')),
  founder_notes text
);

create index if not exists approvals_queue_org_idx on approvals_queue (org_id);
create index if not exists approvals_queue_pending_idx on approvals_queue (decided_at) where decided_at is null;

-- ---------------------------------------------------------------------------
-- performance_metrics: Marketing Analyst's structured outcomes, feeding back
-- into Memory (queryable by Content Strategist and Brand Guardian).
-- ---------------------------------------------------------------------------
create table if not exists performance_metrics (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  content_item_id uuid not null references content_items(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram', 'tiktok', 'youtube')),
  impressions integer default 0,
  reach integer default 0,
  likes integer default 0,
  comments integer default 0,
  shares integer default 0,
  saves integer default 0,
  click_throughs integer default 0,
  collected_at timestamptz not null default now()
);

create index if not exists performance_metrics_item_idx on performance_metrics (content_item_id);

-- ---------------------------------------------------------------------------
-- campaigns: CMO/monthly-strategy state, and the pin target for Founder Mode
-- "campaign" (architecture doc Section 10).
-- ---------------------------------------------------------------------------
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  name text not null,
  theme text,
  goals text,
  start_date date,
  end_date date,
  status text not null default 'planned' check (status in ('planned', 'active', 'completed', 'cancelled')),
  priority_weight numeric(3,1) not null default 1.0,
  created_at timestamptz not null default now()
);

create index if not exists campaigns_org_idx on campaigns (org_id);
create index if not exists campaigns_status_idx on campaigns (status);

-- ---------------------------------------------------------------------------
-- trend_signals: Trend Hunter's output, feeding CMO + Content Strategist.
-- ---------------------------------------------------------------------------
create table if not exists trend_signals (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  source text not null,
  title text not null,
  summary text,
  rationale text,
  relevance_score numeric(3,2) check (relevance_score between 0 and 1),
  status text not null default 'new' check (status in ('new', 'actioned', 'dismissed')),
  linked_content_item_id uuid references content_items(id),
  created_at timestamptz not null default now()
);

create index if not exists trend_signals_org_idx on trend_signals (org_id);
create index if not exists trend_signals_status_idx on trend_signals (status);

-- ---------------------------------------------------------------------------
-- competitor_notes: Competitor Watch's monthly gap-analysis output.
-- ---------------------------------------------------------------------------
create table if not exists competitor_notes (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'pintag',
  competitor_name text not null,
  url text,
  observation text not null,
  gap_identified text,
  created_at timestamptz not null default now()
);

create index if not exists competitor_notes_org_idx on competitor_notes (org_id);

-- ---------------------------------------------------------------------------
-- org_settings: the single row of RUNTIME-MUTABLE state the Dashboard writes
-- directly (Founder Mode switch, current Approval Phase, pinned campaign).
-- Static/structural config (quality-score weights, thresholds, org identity)
-- stays in git at brain/org-config.json since it changes rarely and is
-- reviewed like code; this table exists because Founder Mode needs to change
-- with a single Dashboard click, and a git commit is the wrong latency/UX
-- for that. Pipeline stages read the git file for structure and this table
-- for current state at execution time.
-- ---------------------------------------------------------------------------
create table if not exists org_settings (
  org_id text primary key default 'pintag',
  founder_mode text not null default 'normal' check (founder_mode in (
    'normal', 'busy', 'campaign', 'vacation', 'manual'
  )),
  approval_phase text not null default 'phase_1' check (approval_phase in (
    'phase_1', 'phase_2', 'phase_3'
  )),
  pinned_campaign_id uuid references campaigns(id),
  updated_at timestamptz not null default now()
);

insert into org_settings (org_id) values ('pintag') on conflict (org_id) do nothing;

alter table org_settings enable row level security;
create policy "founder reads settings" on org_settings for select using (auth.role() = 'authenticated');
create policy "founder updates settings" on org_settings for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Row Level Security: single founder principal. The pipeline (headless
-- Claude Code / GitHub Actions) authenticates with the service role and
-- bypasses RLS by design; the Dashboard authenticates as the founder's
-- Supabase Auth user and gets read access everywhere plus write access only
-- to the fields it's meant to change (approval decisions, founder_mode).
-- ---------------------------------------------------------------------------
alter table content_items enable row level security;
alter table content_calendar enable row level security;
alter table quality_scores enable row level security;
alter table approvals_queue enable row level security;
alter table performance_metrics enable row level security;
alter table campaigns enable row level security;
alter table trend_signals enable row level security;
alter table competitor_notes enable row level security;

create policy "founder reads everything" on content_items for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on content_calendar for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on quality_scores for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on approvals_queue for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on performance_metrics for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on campaigns for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on trend_signals for select using (auth.role() = 'authenticated');
create policy "founder reads everything" on competitor_notes for select using (auth.role() = 'authenticated');

-- Founder can only decide on approvals — not rewrite content or scores directly.
create policy "founder decides approvals" on approvals_queue for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
