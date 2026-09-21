-- ============================================================================
-- Minimal fixture for the Intelligence Demand/Supply/Gap regression
-- (supabase/migrations/20260920000000_intelligence_demand_supply_gap.sql).
--
-- This migration touches ONLY point_in_time_supply_snapshot(), which reads
-- ONLY the `properties` table -- trimmed to exactly the columns that
-- function references, same "not a full replica of production's schema"
-- convention already used by schema_intelligence_vientiane_calendar.sql in
-- this same directory. No events/leads/snapshot tables are needed here
-- since this function has no dependency on them.
-- ============================================================================

CREATE TABLE properties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_type     text,
  district_en       text,
  transaction_type  text,
  price_display     text,
  status            text,       -- legacy column; NOT trigger-synced here (the
                                 -- trigger lives in 20260729000000, not loaded
                                 -- by this fixture) -- set explicitly per row
                                 -- to model exactly what it would produce.
  market_status     text,
  workflow_status   text,
  bedrooms           integer
);
