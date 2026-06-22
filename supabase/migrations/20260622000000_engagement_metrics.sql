-- Engagement metrics, activity signals, and event tracking for listings
-- Run in Supabase SQL Editor or via Supabase CLI

-- ── PROPERTIES: engagement columns ───────────────────────────────────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS view_count       INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS favorite_count   INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contact_count    INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trending_score   DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_previous   TEXT,
  ADD COLUMN IF NOT EXISTS is_verified      BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ   DEFAULT NOW();

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── AGENTS: response time for Fast Response badge ─────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS response_time_minutes INTEGER;

-- ── LISTING EVENTS: future engagement tracking ────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_events (
  id          BIGSERIAL    PRIMARY KEY,
  property_id UUID         REFERENCES properties(id) ON DELETE CASCADE,
  event_type  TEXT         NOT NULL CHECK (event_type IN ('view','contact','save','share')),
  session_id  TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_events_property ON listing_events(property_id);
CREATE INDEX IF NOT EXISTS idx_listing_events_type     ON listing_events(event_type);
CREATE INDEX IF NOT EXISTS idx_listing_events_created  ON listing_events(created_at DESC);

ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon event inserts" ON listing_events;
CREATE POLICY "Allow anon event inserts"
  ON listing_events FOR INSERT TO anon WITH CHECK (true);

-- ── HOT PROPERTY SCORING VIEW ─────────────────────────────────────────────────
-- trending_score weights: view=1, save=2, contact=5
-- Thresholds: hot>=100, trending>=50, popular>=20
CREATE OR REPLACE VIEW property_engagement AS
SELECT
  id,
  slug,
  view_count,
  favorite_count,
  contact_count,
  trending_score,
  ROUND(view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0, 2) AS computed_score,
  CASE
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 100 THEN 'hot'
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 50  THEN 'trending'
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 20  THEN 'popular'
    ELSE 'normal'
  END AS engagement_tier
FROM properties;
