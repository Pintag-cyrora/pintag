-- ============================================================================
-- Minimal fixture for the Intelligence Unit-Type Demand regression
-- (supabase/migrations/20260922000000_intelligence_unit_type_demand.sql).
--
-- Trimmed to just the tables/columns intelligence_daily_metrics() and
-- point_in_time_supply_snapshot() actually reference — not a full replica of
-- production's schema, matching the convention already used by
-- schema_intelligence_vientiane_calendar.sql / schema_intelligence_demand_
-- supply_gap.sql in this same directory. unit_type_id on leads/lead_events
-- (with ON DELETE SET NULL) is PR #104's real shape
-- (20260921000000_lead_unit_attribution.sql), reproduced here verbatim since
-- this migration's own "deleted unit type never breaks this" guarantee
-- depends on that exact FK behavior.
--
-- The migration under test fully replaces both
-- intelligence_daily_metrics()/point_in_time_supply_snapshot() bodies with
-- CREATE OR REPLACE FUNCTION, so this fixture creates only the underlying
-- TABLES — the migration itself supplies both functions fresh.
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
  market_status      text,
  workflow_status    text,
  bedrooms           integer,
  price_display      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name_en          text NOT NULL,
  bedrooms         integer,
  price_amount     numeric,
  price_currency   text,
  price_frequency  text,
  is_available     boolean NOT NULL DEFAULT true,
  available_count  integer NOT NULL DEFAULT 1
);

CREATE TABLE properties_removal_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid,
  removed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid,
  unit_type_id uuid REFERENCES unit_types(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'new',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid,
  unit_type_id uuid REFERENCES unit_types(id) ON DELETE SET NULL,
  session_id   text,
  event_type   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
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
