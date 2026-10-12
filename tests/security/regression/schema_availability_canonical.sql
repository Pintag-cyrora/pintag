-- ============================================================================
-- Minimal fixture for the canonical-availability supply regression
-- (supabase/migrations/20261012000000_intelligence_canonical_availability.sql).
--
-- Only the columns point_in_time_supply_snapshot() reads. unit_types carries the columns of the real table that the
-- canonical rules need (is_available / available_count NOT NULL, total_units, next_available_date).
--
-- A placeholder point_in_time_supply_snapshot() is created and locked down first, reproducing production's ACL
-- (20260921010000_revoke_public_execute_analytics_and_ownership_rpcs.sql revoked it from PUBLIC/anon/authenticated),
-- so the regression can prove CREATE OR REPLACE keeps those grants.
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE properties (
  id                 uuid PRIMARY KEY,
  property_type      text,
  transaction_type   text,
  district_en        text,
  status             text,
  market_status      text NOT NULL DEFAULT 'available',
  workflow_status    text NOT NULL DEFAULT 'active',
  bedrooms           integer,
  price_display      text,
  -- columns only scripts/market-status-report.sql reads (the fixture runs the whole report)
  slug               text,
  title_en           text,
  market_status_changed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_types (
  id                 uuid PRIMARY KEY,
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  is_available       boolean NOT NULL DEFAULT true,
  available_count    integer NOT NULL DEFAULT 1 CHECK (available_count >= 0),
  total_units        integer,
  next_available_date date
);

CREATE FUNCTION point_in_time_supply_snapshot() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM anon;
REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM authenticated;
