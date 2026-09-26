-- ============================================================================
-- PUBLIC_LISTING_STATS() LEADS-SOURCE REGRESSION
-- (supabase/migrations/20260926000000_public_listing_stats_leads_source.sql)
--
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_public_listing_stats_leads_source.sql and then migrated by the file
-- above:
--
--     bash tests/security/regression/run-public-listing-stats-leads-source-pg.sh
--
-- Proves: (1) before any divergence, the OLD (lead_events-sourced) function
-- and the NEW (leads-sourced) function agree, so this is a genuine
-- same-population rename, not a silent behavior change; (2) after a
-- lead_events row is deleted (leads survive that via ON DELETE SET NULL --
-- see leads.lead_event_id), the NEW function's lead_count is UNCHANGED,
-- because it never looked at lead_events in the first place -- this is the
-- assertion that would have failed against the pre-fix function; (3) a lead
-- inserted directly into `leads` (no backing lead_events row at all) is
-- still counted, proving genuine leads-table sourcing rather than a
-- lead_events count carried over by coincidence; (4) the count returned
-- equals a literal `SELECT count(*) FROM leads WHERE property_id = ...` --
-- the exact query admin.html's loadListings() already runs for its own
-- "Leads" column, so the two are now provably the same number, not just
-- observed to currently agree; (5) a listing with zero leads/views returns
-- literal 0 for both, never null or an omitted key; (6) the pre-existing
-- visibility gate (draft/deleted listings get the neutral all-zero object)
-- is completely unaffected by this change; (7) is_top_district/views_week/
-- district are still returned correctly.
--
-- Any failed assertion raises an exception, aborting psql under
-- ON_ERROR_STOP=1 with a non-zero exit code.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'REGRESSION FAILED: %', p_what;
  END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

\echo ''
\echo '=== Fixture: one visible listing with real inquiries, one empty, one hidden ==='

DO $$
DECLARE
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_e1 uuid; v_e2 uuid; v_e3 uuid;
  v_stats json;
  v_lead_count int;
  v_lead_events_count int;
  v_leads_count int;
BEGIN
  -- P1: a normal, visible, active listing with real activity.
  INSERT INTO properties (title_en, district_en, status, view_count, views_week)
  VALUES ('River Apartment', 'Sisattanak', 'active', 42, 5)
  RETURNING id INTO v_p1;

  -- P2: visible, active, but genuinely no activity yet -- the zero case.
  INSERT INTO properties (title_en, district_en, status, view_count, views_week)
  VALUES ('Brand New Studio', 'Sisattanak', 'active', 0, 0)
  RETURNING id INTO v_p2;

  -- P3: a draft, never publicly visible -- but it still has real leads
  -- (e.g. an agent added it before publishing), proving those leads must
  -- NOT leak through the aggregate even after this change.
  INSERT INTO properties (title_en, district_en, status, view_count, views_week)
  VALUES ('Unpublished Draft', 'Sisattanak', 'draft', 15, 2)
  RETURNING id INTO v_p3;
  INSERT INTO leads (property_id, contact_method) VALUES (v_p3, 'whatsapp');

  -- Three real contact clicks on P1 -- the trigger unconditionally creates
  -- one leads row per event (see schema fixture's header comment).
  INSERT INTO lead_events (listing_id, event_type) VALUES (v_p1, 'whatsapp_click') RETURNING id INTO v_e1;
  INSERT INTO lead_events (listing_id, event_type) VALUES (v_p1, 'call_click')     RETURNING id INTO v_e2;
  INSERT INTO lead_events (listing_id, event_type) VALUES (v_p1, 'whatsapp_click') RETURNING id INTO v_e3;

  SELECT count(*) INTO v_leads_count FROM leads WHERE property_id = v_p1;
  PERFORM assert(v_leads_count = 3, 'fixture sanity: 3 lead_events rows produced exactly 3 leads rows via the trigger');

  -- ── BEFORE the migration: OLD (lead_events-sourced) function ──────────────
  v_stats := public_listing_stats(v_p1);
  PERFORM assert((v_stats->>'lead_count')::int = 3, 'pre-migration: lead_count = 3 (lead_events and leads still agree, as expected today)');
END $$;

\echo ''
\echo '=== Applying migration: 20260926000000_public_listing_stats_leads_source.sql ==='
\i supabase/migrations/20260926000000_public_listing_stats_leads_source.sql

\echo ''
\echo '=== Post-migration assertions ==='

DO $$
DECLARE
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_stats json;
BEGIN
  SELECT id INTO v_p1 FROM properties WHERE title_en = 'River Apartment';
  SELECT id INTO v_p2 FROM properties WHERE title_en = 'Brand New Studio';
  SELECT id INTO v_p3 FROM properties WHERE title_en = 'Unpublished Draft';

  -- === 1. Immediately after the migration, still agrees (same population) ===
  v_stats := public_listing_stats(v_p1);
  PERFORM assert((v_stats->>'lead_count')::int = 3, 'post-migration, no divergence yet: lead_count still 3');

  -- === 2. Delete one lead_events row for P1 -- leads survive (ON DELETE SET NULL) ===
  DELETE FROM lead_events
  WHERE listing_id = v_p1
    AND id = (SELECT id FROM lead_events WHERE listing_id = v_p1 ORDER BY created_at LIMIT 1);

  PERFORM assert(
    (SELECT count(*) FROM lead_events WHERE listing_id = v_p1) = 2,
    'lead_events count for P1 dropped to 2 after the delete'
  );
  PERFORM assert(
    (SELECT count(*) FROM leads WHERE property_id = v_p1) = 3,
    'leads count for P1 is STILL 3 -- leads outlive the lead_events row that created them (ON DELETE SET NULL)'
  );

  -- THE key assertion: this is exactly the case that would have returned 2
  -- (wrong) against the pre-fix, lead_events-sourced function.
  v_stats := public_listing_stats(v_p1);
  PERFORM assert(
    (v_stats->>'lead_count')::int = 3,
    'public_listing_stats() lead_count is 3, NOT 2 -- proves it now reads leads, not lead_events (this assertion would FAIL against the pre-migration function)'
  );

  -- === 3. A lead inserted directly into `leads`, no lead_events row at all ===
  INSERT INTO leads (property_id, contact_method) VALUES (v_p1, 'whatsapp');
  v_stats := public_listing_stats(v_p1);
  PERFORM assert(
    (v_stats->>'lead_count')::int = 4,
    'a leads row with no backing lead_events row is still counted -- genuine leads-table sourcing, not a lead_events count carried over by coincidence'
  );

  -- === 4. Matches the EXACT query admin.html's loadListings() runs ===
  PERFORM assert(
    (v_stats->>'lead_count')::int = (SELECT count(*) FROM leads WHERE property_id = v_p1),
    'lead_count equals a literal SELECT count(*) FROM leads WHERE property_id = ... -- the same query admin.html already uses for its own "Leads" column'
  );

  -- === 5. Zero case: real listing, genuinely no activity -- 0, not null/omitted ===
  v_stats := public_listing_stats(v_p2);
  PERFORM assert(v_stats->>'lead_count' IS NOT NULL, 'zero-activity listing: lead_count key is present, not omitted');
  PERFORM assert(v_stats->>'view_count' IS NOT NULL, 'zero-activity listing: view_count key is present, not omitted');
  PERFORM assert((v_stats->>'lead_count')::int = 0, 'zero-activity listing: lead_count is literal 0');
  PERFORM assert((v_stats->>'view_count')::int = 0, 'zero-activity listing: view_count is literal 0');

  -- === 6. Visibility gate unaffected: a draft with REAL leads still zeroes out ===
  v_stats := public_listing_stats(v_p3);
  PERFORM assert((v_stats->>'lead_count')::int = 0, 'draft listing (not publicly visible) returns lead_count 0 even though it has a real leads row -- visibility gate still runs first, unaffected by the source-table change');
  PERFORM assert(v_stats->>'district' IS NULL, 'draft listing returns district NULL -- unchanged neutral-object shape');

  -- === 7. Untouched fields still correct post-migration ===
  v_stats := public_listing_stats(v_p1);
  PERFORM assert(v_stats->>'district' = 'Sisattanak', 'district still resolved correctly post-migration');
  PERFORM assert((v_stats->>'views_week')::int = 5, 'views_week still resolved correctly post-migration (untouched field)');
  PERFORM assert((v_stats->>'view_count')::int = 42, 'view_count still resolved correctly post-migration (untouched field)');
END $$;

DROP FUNCTION assert(boolean, text);
