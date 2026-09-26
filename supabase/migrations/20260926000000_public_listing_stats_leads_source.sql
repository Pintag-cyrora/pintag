-- public_listing_stats(): source inquiry counts from `leads`, not
-- `lead_events`, so they can never drift from the number staff already see.
--
-- CONTEXT: this fixes the data source behind the new "Views · Inquiries"
-- social-proof row on listing.html (components.js/listing.html changes in
-- the same PR). That row, and admin.html's own per-listing "👁 Views ·
-- 📞 Leads" column, must show the same number for the same listing.
--
-- admin.html (loadListings()) already made this exact choice once, with an
-- explicit comment: "leads, not lead_events -- the canonical Lead (Property
-- Inquiry) entity, one row per inquiry across every contact channel ...
-- same source the Analytics tab now uses, so this column and Total Leads
-- always agree." public_listing_stats() (20260623000002, amended by
-- 20260623000004_engagement_badges.sql and 20260817000000_security_audit_
-- hardening.sql) was never updated to match -- it still aggregates
-- lead_count/lead_week/lead_month straight from lead_events.
--
-- In today's production schema these two counts happen to agree: every
-- lead_events row with a non-null listing_id unconditionally creates
-- exactly one leads row (create_lead_from_event(), unconditional since
-- 20260722000000_leads_recipient_model.sql), and leads rows are never
-- deleted (only status-updated) -- see tests/security/regression/
-- public_listing_stats_leads_source_regression.sql for the trigger-history
-- audit that established this. But that agreement was an unasserted
-- invariant, not a guarantee: leads.lead_event_id is ON DELETE SET NULL
-- (leads intentionally survive lead_events row deletion, e.g. a future
-- click-log retention job), and nothing stops a future direct insert into
-- leads (a manually-logged inquiry) that has no lead_events row at all.
-- Either would silently make the public number and admin's number disagree
-- again. Sourcing both from the same table removes the possibility instead
-- of relying on it staying true.
--
-- Everything else (the visibility gate, is_top_district, views_week, the
-- SECURITY DEFINER/search_path/STABLE markers, the anon/authenticated
-- grants -- unaffected by CREATE OR REPLACE on an unchanged signature) is
-- copied verbatim from 20260817000000_security_audit_hardening.sql.
--
-- Rollback: re-run the CREATE OR REPLACE block from
-- 20260817000000_security_audit_hardening.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_count  INTEGER := 0;
  v_lead_week   INTEGER := 0;
  v_lead_month  INTEGER := 0;
  v_view_count  INTEGER := 0;
  v_views_week  INTEGER := 0;
  v_is_top      BOOLEAN := FALSE;
  v_district    TEXT;
  v_visible     BOOLEAN := FALSE;
BEGIN
  -- Visibility gate FIRST: mirrors the "public read active properties" policy
  -- (20260806020000) exactly. A definer function granted to anon must never
  -- answer questions about a row anon cannot read. Unchanged from
  -- 20260817000000.
  SELECT TRUE, COALESCE(view_count, 0), COALESCE(views_week, 0), district_en
    INTO v_visible, v_view_count, v_views_week, v_district
  FROM properties
  WHERE id = p_listing_id
    AND status IN ('active', 'available')
    AND deleted_at IS NULL;

  IF NOT COALESCE(v_visible, FALSE) THEN
    -- Same shape as a real response, all zeroes: a not-visible listing is
    -- indistinguishable from one with no activity, so this cannot be used
    -- as an existence oracle either. Unchanged from 20260817000000.
    RETURN json_build_object(
      'lead_count', 0, 'lead_week', 0, 'lead_month', 0,
      'view_count', 0, 'views_week', 0,
      'is_top_district', FALSE, 'district', NULL
    );
  END IF;

  -- CHANGED: leads, not lead_events -- see header comment. property_id is
  -- the same value lead_events.listing_id would have been copied from at
  -- INSERT time (create_lead_from_event()), so this is a straight rename
  -- of the source table, not a different population.
  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM leads
  WHERE property_id = p_listing_id;

  IF v_district IS NOT NULL AND v_view_count > 0 THEN
    SELECT (p_listing_id = (
      SELECT id FROM properties
      WHERE district_en = v_district
        AND status = 'active'
        AND deleted_at IS NULL
      ORDER BY COALESCE(view_count, 0) DESC
      LIMIT 1
    )) INTO v_is_top;
  END IF;

  RETURN json_build_object(
    'lead_count',      v_lead_count,
    'lead_week',       v_lead_week,
    'lead_month',      v_lead_month,
    'view_count',      v_view_count,
    'views_week',      v_views_week,
    'is_top_district', COALESCE(v_is_top, FALSE),
    'district',        v_district
  );
END;
$$;

COMMENT ON FUNCTION public_listing_stats(UUID) IS
  'Public social-proof aggregates for ONE listing. SECURITY DEFINER (it reads leads, which anon cannot select), so it re-implements the public read predicate itself and returns zeroed stats for any listing anon could not read directly. lead_count/lead_week/lead_month come from `leads` (the canonical Lead/Inquiry entity, property_id-scoped) -- the same table and the same per-listing scope admin.html and dashboard.html already use for their own "Leads" figures, so the two can never disagree.';

COMMIT;

-- ── Verify (Supabase SQL editor / psql) ─────────────────────────────────────
-- 1. Anon: SELECT public_listing_stats('<a live listing uuid>');
--      EXPECT: lead_count equal to
--        SELECT count(*) FROM leads WHERE property_id = '<same uuid>';
--      (which may now differ from
--        SELECT count(*) FROM lead_events WHERE listing_id = '<same uuid>';
--      if any lead_events row for it has since been deleted or any lead
--      was ever added directly -- that is the fix, not a bug.)
-- 2. Anon: SELECT public_listing_stats('<a draft listing uuid>');
--      EXPECT: all-zero object, district null -- unchanged from before.
-- 3. Regression suite:
--      bash tests/security/regression/run-public-listing-stats-leads-source-pg.sh
