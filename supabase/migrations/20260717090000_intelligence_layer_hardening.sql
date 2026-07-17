-- Intelligence Layer hardening — closes the operational-resilience and
-- concurrency gaps found in a pre-merge architecture review (see the plan
-- doc's "Pre-merge architecture review: Intelligence Layer hardening"
-- section). Three additions: two partial unique indexes enforcing
-- invariants at the database level rather than relying solely on
-- application logic, a single-row claim table for serializing concurrent
-- daily Insight Engine sweeps, and a staff DELETE policy enabling the
-- manual preview workflow's Delete button. Does not touch any existing
-- column or row.

-- ── Only one generated report per (report_type, period_start, period_end) ──
-- A status='failed' row may coexist with a later successful retry for the
-- same period (failures aren't unique-constrained); two status='generated'
-- rows for the same period can never coexist. The edge function's own
-- idempotency check (find-existing-before-generating) is what makes the
-- common case fast and returns a clean response; this index is what makes
-- the guarantee true regardless of which caller, retry, or future code
-- path attempts to write.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_reports_period_generated
  ON intelligence_reports(report_type, period_start, period_end)
  WHERE status = 'generated';

-- ── Only one active (unresolved) insight per real-world condition ─────────
-- Defense-in-depth backstop behind the sweep lock below: if the lock is
-- ever bypassed or two sweeps somehow still race, this is what actually
-- prevents two open insights from tracking the same condition.
--
-- Expression index using coalesce(), not a plain column index: standard
-- SQL unique indexes treat NULL as distinct from NULL, so a plain index on
-- (dimension_district, dimension_property_type, dimension_property_id)
-- would silently NOT catch a duplicate whenever those dimensions are
-- NULL — the common case, since most insight types use only one
-- dimension (or none). Confirmed empirically: a plain-column version of
-- this index let a duplicate through in local testing. Sentinel-coalescing
-- NULLs to '' mirrors insightKey() in insight-engine.js exactly
-- (`dims.district || ''`), so the database-enforced key and the
-- application-level matching key are the same key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_insights_open_condition
  ON intelligence_insights(
    type, metric_key,
    coalesce(dimension_district, ''),
    coalesce(dimension_property_type, ''),
    coalesce(dimension_property_id::text, '')
  )
  WHERE resolved_at IS NULL;

-- ── Daily sweep lock — a single-row claim table ────────────────────────────
-- Prevents two concurrent daily Insight Engine sweeps from both reading
-- "no open insight for key X" before either commits, and both inserting.
-- Deliberately NOT a Postgres session-level advisory lock: Supabase's REST
-- API is served over a pooled connection where consecutive HTTP calls from
-- the edge function are not guaranteed to land on the same underlying
-- database session, so an advisory lock acquired in one request and
-- released in another could be silently released by (or held forever by)
-- the wrong connection. A row-level UPDATE, by contrast, is race-safe
-- under Postgres's own row locking regardless of connection pooling and
-- needs no "same session" requirement to release correctly — the edge
-- function's own acquire/release logic is a plain atomic PATCH on this row.
CREATE TABLE IF NOT EXISTS intelligence_sweep_lock (
  id         text PRIMARY KEY,
  locked_at  timestamptz
);
INSERT INTO intelligence_sweep_lock (id, locked_at)
  VALUES ('daily_sweep', NULL)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE intelligence_sweep_lock ENABLE ROW LEVEL SECURITY;
-- No SELECT policy for any client role — this table is purely an internal
-- coordination primitive for the edge function's service-role writes, not
-- data anyone (including staff) has a reason to read via the API.

-- ── Staff DELETE on intelligence_reports — the manual preview workflow ────
-- Reports are disposable; intelligence_insights is the source of truth
-- (see INTELLIGENCE_ARCHITECTURE.md's Database Invariants). Deleting a
-- report cascades to report_insights (existing ON DELETE CASCADE) but
-- never touches intelligence_insights — destroying a generated view must
-- never destroy the underlying tracked conditions or their history.
DROP POLICY IF EXISTS "Staff delete intelligence_reports" ON intelligence_reports;
CREATE POLICY "Staff delete intelligence_reports"
  ON intelligence_reports FOR DELETE TO authenticated
  USING (is_pintag_staff(auth.uid()));
