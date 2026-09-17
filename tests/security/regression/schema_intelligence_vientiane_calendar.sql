-- ============================================================================
-- Minimal fixture for the Intelligence Vientiane-calendar regression
-- (supabase/migrations/20260918000000_intelligence_vientiane_calendar.sql).
--
-- Trimmed to just the tables/columns intelligence_daily_metrics() and
-- ensure_daily_metrics_snapshot() actually reference -- not a full replica
-- of production's properties/leads/etc. schemas. RLS is intentionally not
-- modelled (this suite proves calendar-bucketing behavior, not the
-- visibility model), matching the convention already used by
-- schema_ops_alert_and_image_sync.sql in this same directory.
--
-- point_in_time_supply_snapshot() is stubbed to a fixed, harmless jsonb --
-- this migration does not touch it (it has no date/calendar logic of its
-- own; see the investigation), so faithfully reproducing its real
-- multi-table computation here would test something this fix doesn't
-- change. data_confidence_from_sample_size() IS included verbatim (real,
-- unchanged, and simple) since ensure_daily_metrics_snapshot() calls it
-- directly.
-- ============================================================================

CREATE TABLE properties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_en           text,
  title_lo           text,
  property_type      text,
  transaction_type   text,
  district_en        text,
  status             text,
  status_changed_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties_removal_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid,
  removed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid,
  status      text NOT NULL DEFAULT 'new',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid,
  session_id  text,
  event_type  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listing_events (
  id          bigserial PRIMARY KEY,
  property_id uuid,
  session_id  text,
  event_type  text NOT NULL CHECK (event_type IN ('view','contact','save','share','impression','click')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE search_events (
  id                bigserial PRIMARY KEY,
  session_id        text,
  district          text,
  property_type     text,
  transaction_type  text,
  price_min         numeric,
  price_max         numeric,
  bedrooms          integer,
  result_count      integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ui_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text,
  element_id   text NOT NULL,
  element_type text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── daily_metrics_snapshot — VERBATIM shape from 20260724000000 ────────────
CREATE TABLE daily_metrics_snapshot (
  day             date PRIMARY KEY,
  metrics         jsonb NOT NULL,
  sample_size     integer,
  data_confidence text
);

-- ── data_confidence_from_sample_size — VERBATIM from 20260724000000 ────────
CREATE OR REPLACE FUNCTION data_confidence_from_sample_size(p_sample_size integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_sample_size < 10  THEN 'low'
    WHEN p_sample_size < 30  THEN 'moderate'
    WHEN p_sample_size < 100 THEN 'high'
    ELSE 'very_high'
  END;
$$;

-- ── point_in_time_supply_snapshot — STUB, deliberately not the real body ───
-- (see header comment: untouched by this fix, so it isn't exercised here).
CREATE OR REPLACE FUNCTION point_in_time_supply_snapshot()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT '{"active_inventory": null, "asking_price": null}'::jsonb;
$$;
