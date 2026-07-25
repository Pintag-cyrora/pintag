-- Daily Intelligence Data Accuracy fix — closes the gap where every report
-- recomputed metrics live from intelligence_daily_metrics() (a STABLE SQL
-- function over the raw event tables) instead of reading a stored,
-- immutable record. In practice the event tables are append-only, so this
-- rarely produced different numbers on replay — but "rarely" is not the
-- same as "never," and there was no database-enforced guarantee that a
-- historical day's numbers could never shift (e.g. leads_closed_totals is
-- keyed off leads.updated_at, which genuinely can move a day's totals if a
-- lead's status changes after the fact touches a different day than
-- expected). This migration adds the actual stored snapshot: one row per
-- calendar day, written once, never updated.
--
-- Nothing existing is modified. daily_metrics_snapshot is purely additive
-- and intelligence_daily_metrics() is untouched — it's still the thing
-- that COMPUTES a day's numbers; this table is what PERSISTS them, exactly
-- once, so every future read of that day (a report generated today, the
-- same report regenerated in a year, a future trend chart) sees the same
-- values.

-- ── daily_metrics_snapshot — one immutable row per calendar day ──────────
CREATE TABLE IF NOT EXISTS daily_metrics_snapshot (
  day             date PRIMARY KEY,
  metrics         jsonb NOT NULL,
  -- Sample size this day's confidence is judged on — total searches, per
  -- the exact banding the product spec calls for (see
  -- data_confidence_from_sample_size() below). Stored alongside the label
  -- rather than only the label, so the raw number is always inspectable
  -- without re-deriving it from metrics->'search'->>'total'.
  sample_size     integer NOT NULL DEFAULT 0,
  data_confidence text NOT NULL CHECK (data_confidence IN ('low','moderate','high','very_high')),
  finalized_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE daily_metrics_snapshot IS
  'One immutable row per calendar day -- the actual Daily Metrics Snapshot. Written exactly once by ensure_daily_metrics_snapshot() (INSERT ... ON CONFLICT DO NOTHING) and never updated (see the trigger below) or deleted in normal operation. Every report -- daily, weekly, monthly, regenerated at any future date -- reads history from here, never by recomputing intelligence_daily_metrics() over live event tables for a past day.';

CREATE INDEX IF NOT EXISTS idx_daily_metrics_snapshot_day ON daily_metrics_snapshot(day DESC);

-- ── Immutability, enforced at the database level ─────────────────────────
-- "This snapshot should be finalized once each day and never recalculated
-- later" is a database guarantee here, not just an application convention:
-- any UPDATE attempt is rejected outright. Correcting a genuinely wrong
-- historical snapshot is a deliberate, explicit DELETE + re-finalize by
-- staff, never a silent overwrite.
CREATE OR REPLACE FUNCTION reject_daily_metrics_snapshot_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'daily_metrics_snapshot rows are immutable once written (day=%). Delete and re-finalize explicitly if a correction is genuinely needed.', OLD.day;
END;
$$;

DROP TRIGGER IF EXISTS trg_daily_metrics_snapshot_no_update ON daily_metrics_snapshot;
CREATE TRIGGER trg_daily_metrics_snapshot_no_update
  BEFORE UPDATE ON daily_metrics_snapshot
  FOR EACH ROW EXECUTE FUNCTION reject_daily_metrics_snapshot_update();

-- ── RLS — staff-only read, no client-role write at all ─────────────────
-- Written exclusively by ensure_daily_metrics_snapshot() via the edge
-- function's service-role key (bypasses RLS by design), matching every
-- other intelligence_* table's posture.
ALTER TABLE daily_metrics_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read daily_metrics_snapshot" ON daily_metrics_snapshot;
CREATE POLICY "Staff read daily_metrics_snapshot"
  ON daily_metrics_snapshot FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

-- ── Confidence banding — exact thresholds from the product spec ─────────
-- <10 searches -> low, 10-29 -> moderate, 30-99 -> high, 100+ -> very_high.
-- A separate, reusable function (not inlined into the snapshot query)
-- because report-time code (weekly/monthly period confidence, computed
-- from a summed sample size across several days) needs the exact same
-- banding logic, not a re-derived copy of it.
CREATE OR REPLACE FUNCTION data_confidence_from_sample_size(p_sample_size integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_sample_size < 10  THEN 'low'
    WHEN p_sample_size < 30  THEN 'moderate'
    WHEN p_sample_size < 100 THEN 'high'
    ELSE 'very_high'
  END;
$$;

-- ── Finalization — the only way rows enter this table ────────────────────
-- Set-based upsert over intelligence_daily_metrics(); ON CONFLICT DO
-- NOTHING is what makes re-running this for an already-finalized day a
-- true no-op rather than a silent recompute. Guards against ever
-- finalizing "today" (or a future date) -- the current day's numbers are
-- still in motion, so freezing them would misrepresent an incomplete day
-- as a finished one; callers should only ever pass a range ending on or
-- before yesterday, but this is enforced here too rather than trusted to
-- every caller.
CREATE OR REPLACE FUNCTION ensure_daily_metrics_snapshot(p_start date, p_end date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_end date := LEAST(p_end, CURRENT_DATE - 1);
BEGIN
  IF p_start > v_end THEN
    RETURN; -- nothing finalizable in range (e.g. p_start is today or later)
  END IF;

  INSERT INTO daily_metrics_snapshot (day, metrics, sample_size, data_confidence)
  SELECT
    m.day,
    m.metrics,
    coalesce((m.metrics->'search'->>'total')::integer, 0),
    data_confidence_from_sample_size(coalesce((m.metrics->'search'->>'total')::integer, 0))
  FROM intelligence_daily_metrics(p_start, v_end) m
  ON CONFLICT (day) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION ensure_daily_metrics_snapshot IS
  'Finalizes (writes exactly once) daily_metrics_snapshot rows for every day in [p_start, p_end] that is not already finalized and is not today-or-later. Idempotent: calling this again for an already-finalized range does nothing. Called by generate-intelligence-report before reading any historical metrics.';

-- ── intelligence_reports: confidence + the data-quality validation log ───
-- data_confidence mirrors the same banding for the report's own period
-- (a single day's sample_size for Daily; the summed sample_size across the
-- period for Weekly/Monthly). validation is the structured "internal
-- validation" log the product spec asks every report to carry: whether the
-- snapshot was finalized successfully, whether historical comparison data
-- existed, whether the contradiction-detection pass found anything, and
-- the confidence score -- so a report never presents conclusions without
-- also disclosing how much weight they deserve.
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS data_confidence text CHECK (data_confidence IN ('low','moderate','high','very_high'));
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS validation jsonb;

COMMENT ON COLUMN intelligence_reports.data_confidence IS
  'How much weight to place on this report''s conclusions, from the period''s own sample size (see data_confidence_from_sample_size()) -- independent of any single insight''s own statistical confidence.';
COMMENT ON COLUMN intelligence_reports.validation IS
  'The data-quality/validation log: { snapshot_finalized, all_metrics_calculated, historical_comparison_available, contradictions_detected: [...], confidence, narrative_fallback_used, validated_at }. Written by report-validator.js. A non-empty contradictions_detected means the AI narrative failed validation and a deterministic fallback body was used instead -- see narrative_fallback_used.';
