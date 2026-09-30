-- ============================================================================
-- Minimal fixture for the analytics Laos-calendar / lead drill-down regression
-- (supabase/migrations/20260921030000_analytics_laos_calendar_days.sql and
--  20260921040000_analytics_history_and_lead_drilldown.sql).
--
-- Trimmed to the tables/columns the analytics_* functions read. RLS is not
-- modelled (this suite proves calendar bucketing, attribution, paging and
-- function ACLs, not row visibility). Roles anon/authenticated exist so
-- GRANT/REVOKE and SET ROLE behave like Supabase. is_pintag_staff() is a stub
-- keyed off request.jwt.claim.sub.
-- ============================================================================

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Supabase's default privileges: every new function is executable by PUBLIC,
-- which is exactly what the migrations must revoke.
-- Supabase grants EXECUTE on every new public function to anon/authenticated/
-- service_role through default privileges; the migrations must revoke it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION is_pintag_staff(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_uid = '00000000-0000-0000-0000-00000000ad01'::uuid
$$;

CREATE TABLE parties (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en text
);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        text NOT NULL DEFAULT 'agent',
  name        text,
  phone       text NOT NULL DEFAULT '+856000000000',
  whatsapp    text,
  is_verified boolean NOT NULL DEFAULT false
);

CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text,
  title_en        text,
  title_lo        text,
  status          text,
  workflow_status text,
  property_type   text,
  district_en     text,
  view_count      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE properties_row_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  op          text NOT NULL,
  row_data    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_row_snapshots_property ON properties_row_snapshots (property_id, created_at DESC);

CREATE TABLE properties_removal_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL,
  title_en          text,
  title_lo          text,
  status_at_removal text,
  removed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid,
  name_en     text NOT NULL
);

CREATE TABLE lead_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid,
  agent_id     uuid,
  event_type   text NOT NULL CHECK (event_type IN (
                 'whatsapp_click','call_click','messenger_click',
                 'telegram_click','line_click','contact_click')),
  session_id   text,
  contact_id   uuid,
  unit_type_id uuid,
  unit_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lead_events_created_at ON lead_events(created_at DESC);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid,
  party_id           uuid,
  lead_event_id      uuid,
  status             text NOT NULL DEFAULT 'new',
  contact_method     text NOT NULL DEFAULT 'whatsapp',
  contact_id         uuid,
  recipient_type     text,
  recipient_verified boolean,
  unit_type_id       uuid,
  unit_id            uuid,
  customer_name      text,
  customer_phone     text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
-- NOTE: no index on leads.lead_event_id here on purpose -- migration 1 must
-- create idx_leads_lead_event_id, and the regression asserts it exists.

CREATE TABLE page_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      text,
  visitor_id      text,
  is_returning    boolean NOT NULL DEFAULT false,
  page            text,
  referrer        text,
  referrer_source text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  device_type     text,
  browser         text,
  os              text,
  lang            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_page_views_created ON page_views(created_at DESC);
CREATE INDEX idx_page_views_session_created ON page_views(session_id, created_at);

CREATE TABLE listing_events (
  id          bigserial PRIMARY KEY,
  property_id uuid,
  session_id  text,
  event_type  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_listing_events_created ON listing_events(created_at DESC);

CREATE TABLE search_events (
  id               bigserial PRIMARY KEY,
  session_id       text,
  district         text,
  property_type    text,
  transaction_type text,
  result_count     integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_search_events_created ON search_events(created_at DESC);

CREATE TABLE ui_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  element_id text NOT NULL,
  event_type text,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ui_events_created ON ui_events(created_at DESC);
