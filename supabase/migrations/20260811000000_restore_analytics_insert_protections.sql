-- ============================================================================
-- RESTORE ANALYTICS INSERT PROTECTIONS (lost in the single-admin lockdown)
-- ============================================================================
-- The single-admin lockdown (20260804120000 / 20260804130000) dropped every
-- pre-existing policy and recreated the anonymous analytics INSERT policies as
-- `WITH CHECK (true)`. That silently removed the write-abuse protections that
-- the earlier migrations enforced in the policy body:
--
--   lead_events     : listing must be active   + rate limit
--                     (20260625000002_security_hardening.sql)
--   listing_events  : property must be active  + dedup / burst
--                     (20260715010000_behavioral_events.sql)
--   search_events   : rate limit
--   ui_events       : rate limit
--   page_views      : rate limit
--
-- Result today: anon can POST unlimited events for ANY (incl. inactive /
-- non-existent) property. (Invalid event_type is still rejected — that is a
-- column CHECK constraint, which the lockdown did not touch.)
--
-- This migration re-adds those protections to the anon INSERT policies ONLY.
-- It preserves the single-admin lockdown in full: admin read/write, the
-- listing_events anon dedup-read SELECT, and every GRANT stay exactly as the
-- lockdown left them. Nothing but the five anon INSERT policies changes.
--
-- Design decisions (confirmed):
--   A. listing_events keeps NO `event_type IN ('impression','click')` narrowing
--      — the app legitimately inserts save/share/contact (components.js), and
--      event_type validity is already enforced by the table's column CHECK.
--   B. Duplicate protection is a STRICT per-session dedup (session + target +
--      event_type within a window), not a broad flood cap, and enforced in the
--      database — not client-side.
--   C. The lead-events limit is scoped PER SESSION, so one visitor's activity
--      can never exhaust (block) another visitor's.
--
-- Verified against a throwaway PostgreSQL 16 instance before shipping: legit
-- inserts (incl. save/share, different sessions) succeed; duplicate-same-session,
-- inactive/non-existent property, and invalid event_type are all rejected.
--
-- Relies on the existing check_search_event_rate_limit / check_ui_event_rate_limit
-- / check_page_view_rate_limit functions (created by their original migrations;
-- the lockdown dropped policies, not functions). Re-runnable.
-- ============================================================================

BEGIN;

-- ── C: per-session lead rate limit (30s dedup within a session) ─────────────
-- New 3-arg overload that includes the session, so different visitors never
-- block each other. SECURITY DEFINER so it can see all rows for the check.
CREATE OR REPLACE FUNCTION check_lead_rate_limit(p_listing_id uuid, p_event_type text, p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- A NULL session can't be de-duplicated; record it rather than drop it.
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM lead_events
    WHERE session_id = p_session_id
      AND listing_id = p_listing_id
      AND event_type = p_event_type
      AND created_at > now() - interval '30 seconds'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION check_lead_rate_limit(uuid, text, text) TO anon, authenticated;

-- ── B: strict per-session dedup for listing_events (30-minute window) ───────
CREATE OR REPLACE FUNCTION check_listing_event_dedup(p_session_id text, p_property_id uuid, p_event_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM listing_events
    WHERE session_id = p_session_id
      AND property_id = p_property_id
      AND event_type = p_event_type
      AND created_at > now() - interval '30 minutes'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION check_listing_event_dedup(text, uuid, text) TO anon, authenticated;

-- ── Replace the five WITH CHECK(true) anon INSERT policies ──────────────────
-- lead_events: active listing + per-session rate limit. (event_type validity is
-- enforced by the column CHECK.)
DROP POLICY IF EXISTS "anon insert lead_events" ON lead_events;
CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon
  WITH CHECK (
    listing_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_lead_rate_limit(listing_id, event_type, session_id)
  );

-- listing_events: active property + per-session dedup. NO impression/click
-- narrowing (see decision A) — save/share/contact keep working.
DROP POLICY IF EXISTS "anon insert listing_events" ON listing_events;
CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon
  WITH CHECK (
    property_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_listing_event_dedup(session_id, property_id, event_type)
  );

-- search_events / ui_events / page_views: restore their original per-session
-- rate limits (unchanged functions).
DROP POLICY IF EXISTS "anon insert search_events" ON search_events;
CREATE POLICY "anon insert search_events" ON search_events FOR INSERT TO anon
  WITH CHECK ( check_search_event_rate_limit(session_id) );

DROP POLICY IF EXISTS "anon insert ui_events" ON ui_events;
CREATE POLICY "anon insert ui_events" ON ui_events FOR INSERT TO anon
  WITH CHECK ( check_ui_event_rate_limit(session_id) );

DROP POLICY IF EXISTS "anon insert page_views" ON page_views;
CREATE POLICY "anon insert page_views" ON page_views FOR INSERT TO anon
  WITH CHECK ( check_page_view_rate_limit(session_id) );

COMMIT;

-- ── Verify (after COMMIT) ────────────────────────────────────────────────────
-- The five anon INSERT policies must no longer be WITH CHECK(true):
--   SELECT tablename, policyname, with_check FROM pg_policies
--   WHERE policyname LIKE 'anon insert %' ORDER BY tablename;
-- Admin/read/dedup-read policies from the lockdown remain present and unchanged.
