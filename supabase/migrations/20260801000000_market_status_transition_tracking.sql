-- Rented Listings UX v2 — real (never fabricated) status-transition timing.
--
-- The v1 Rented Listings UX asked for a "Rented 12 days ago" / "Rented •
-- July 2026" date on unavailable listings, explicitly "if the data exists
-- (or can be derived) ... do not fabricate dates." Nothing in the schema
-- records WHEN a listing's market_status last changed -- properties.updated_at
-- (20260622000000_engagement_metrics.sql) is a poor substitute: it's bumped
-- by trg_properties_updated_at on *any* column edit (a typo fix in the
-- description, an admin re-uploading a photo), not specifically a status
-- change, so "days since updated_at" would silently be wrong (and would
-- read as fabricated precision) far more often than it happened to be right.
--
-- This migration adds a dedicated, trigger-maintained timestamp for exactly
-- one thing: the last time market_status itself changed. Existing rows get
-- NULL here (we genuinely don't know when a listing already marked
-- sold/rented today actually transitioned -- that's the "do not fabricate"
-- rule applied to historical data, not just future display logic); only
-- transitions that happen after this migration deploys get a real value.
-- The frontend (listing.html) already treats a null date as "just show the
-- status badge with no date," never inventing one -- see
-- listing-status.js's formatStatusChangeDate().

ALTER TABLE properties ADD COLUMN IF NOT EXISTS market_status_changed_at timestamptz;

COMMENT ON COLUMN properties.market_status_changed_at IS
  'When market_status last actually changed (trigger-maintained, see trg_properties_market_status_changed_at). NULL for any row that has never had a market_status change recorded since this column was added -- never backfilled/estimated, per the "do not fabricate dates" rule. Distinct from updated_at, which bumps on every column edit.';

CREATE OR REPLACE FUNCTION set_market_status_changed_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.market_status_changed_at := now();
  ELSIF NEW.market_status IS DISTINCT FROM OLD.market_status THEN
    NEW.market_status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_market_status_changed_at ON properties;
CREATE TRIGGER trg_properties_market_status_changed_at
  BEFORE INSERT OR UPDATE OF market_status ON properties
  FOR EACH ROW EXECUTE FUNCTION set_market_status_changed_at();

COMMENT ON FUNCTION set_market_status_changed_at() IS
  'Stamps properties.market_status_changed_at with now() on INSERT and on any UPDATE that actually changes market_status -- never on an unrelated column edit (the trigger is scoped to UPDATE OF market_status, not a bare UPDATE).';

-- ── market_transition_stats ─────────────────────────────────────────────
-- "Homes like this typically rent within 9 days" (Rented Listings UX v2,
-- Priority 6 "Market Statistics"). Computed strictly from rows that have a
-- REAL market_status_changed_at (i.e. transitioned after this migration
-- shipped) -- never estimated from a partial/proxy signal. Returns
-- sample_size = 0 (and null avg/median) when there isn't enough real data
-- yet; the frontend must not render anything from a 0-sample response, the
-- same "don't show a statistic from too small a sample" convention already
-- used elsewhere on this site (Best Value's 3-peer minimum, etc).
CREATE OR REPLACE FUNCTION market_transition_stats(
  p_property_type   text,
  p_district_en      text,
  p_transaction_type text
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sample_size    INTEGER := 0;
  v_avg_days       NUMERIC;
  v_median_days    NUMERIC;
  v_target_status  text[];
BEGIN
  -- "Rented within" only makes sense for a rental; "Sold within" only for
  -- a sale -- comparing across transaction types would blend two different
  -- markets into one meaningless number.
  v_target_status := CASE
    WHEN p_transaction_type = 'for_sale' THEN ARRAY['sold']
    WHEN p_transaction_type = 'for_rent' THEN ARRAY['rented']
    ELSE ARRAY['sold','rented']
  END;

  WITH transitioned AS (
    SELECT EXTRACT(EPOCH FROM (market_status_changed_at - created_at)) / 86400.0 AS days
    FROM properties
    WHERE property_type = p_property_type
      AND district_en = p_district_en
      AND transaction_type = p_transaction_type
      AND market_status = ANY(v_target_status)
      AND market_status_changed_at IS NOT NULL
      AND created_at IS NOT NULL
      AND market_status_changed_at > created_at
  )
  SELECT COUNT(*), AVG(days), PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days)
  INTO v_sample_size, v_avg_days, v_median_days
  FROM transitioned;

  IF v_sample_size < 3 THEN
    RETURN json_build_object('sample_size', 0, 'avg_days', NULL, 'median_days', NULL);
  END IF;

  RETURN json_build_object(
    'sample_size', v_sample_size,
    'avg_days',    ROUND(v_avg_days, 1),
    'median_days', ROUND(v_median_days, 1)
  );
END;
$$;

COMMENT ON FUNCTION market_transition_stats(text, text, text) IS
  'Median/avg days-to-transition (listed -> sold/rented) for comparable listings, computed only from rows with a real market_status_changed_at. Returns sample_size=0 when fewer than 3 comparable transitions exist -- callers must not render a statistic in that case.';

GRANT EXECUTE ON FUNCTION market_transition_stats(text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION market_transition_stats(text, text, text) TO authenticated;
