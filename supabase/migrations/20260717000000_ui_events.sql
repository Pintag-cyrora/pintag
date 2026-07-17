-- First-party UI/product analytics layer. Deliberately separate from, and
-- does not replace, the existing business-intelligence event stream
-- (search_events / listing_events / lead_events, see
-- 20260715010000_behavioral_events.sql / 20260715000000_leads_crm.sql) —
-- those keep working exactly as they do today. ui_events exists purely to
-- answer UX questions the BI tables were never designed to answer (does
-- anyone use the map toggle, does anyone expand the description, which
-- filters get touched before someone gives up).
--
-- Shares the same session_id spine as the BI tables (via the existing
-- client-side getOrCreateSessionId() helper in session.js) so a UI click
-- stream is joinable against search/impression/click/lead rows on
-- session_id when needed — but stays its own table, matching this
-- schema's existing convention of small, purpose-built event tables
-- rather than one polymorphic events table.

CREATE TABLE IF NOT EXISTS ui_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    text,
  page          text NOT NULL,
  element_id    text NOT NULL,
  element_type  text,
  -- Only 'click' exists today (event delegation only listens for clicks —
  -- see tracking.js). CHECK-constrained like every other event_type column
  -- in this schema (listing_events, lead_events); loosen the same way
  -- 20260715010000_behavioral_events.sql loosened listing_events' when a
  -- second event type is actually needed.
  event_type    text NOT NULL DEFAULT 'click' CHECK (event_type IN ('click')),
  label         text,
  property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ui_events_page        ON ui_events(page);
CREATE INDEX IF NOT EXISTS idx_ui_events_element_id  ON ui_events(element_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_created     ON ui_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_events_property_id ON ui_events(property_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_session_id  ON ui_events(session_id);

COMMENT ON TABLE ui_events IS
  'First-party UX analytics: one row per tracked UI interaction (data-track attribute), auto-collected via event delegation in tracking.js. Product/UX layer only — search_events/listing_events/lead_events remain the business-intelligence layer and are untouched by this table.';

ALTER TABLE ui_events ENABLE ROW LEVEL SECURITY;

-- Same shape as check_search_event_rate_limit / check_listing_event_burst_limit
-- (20260715010000_behavioral_events.sql) — generous enough for a real
-- session's worth of genuine clicking, tight enough to block a scripted
-- flood. UI clicks are lower-volume than batched impressions, so the cap
-- sits between search_events' 20/min and listing_events' 200/min.
CREATE OR REPLACE FUNCTION check_ui_event_rate_limit(p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN (
    SELECT COUNT(*) FROM ui_events
    WHERE session_id = p_session_id
      AND created_at > NOW() - INTERVAL '1 minute'
  ) < 60;
END;
$$;
GRANT EXECUTE ON FUNCTION check_ui_event_rate_limit(text) TO anon;

-- Every public page issues these requests with only the anon apikey (no
-- user JWT — see listings.html/index.html/listing.html/agent.html's own
-- postEvent()), so anon is the only role that ever needs INSERT here,
-- exactly like search_events/listing_events.
DROP POLICY IF EXISTS "Allow anon ui event inserts" ON ui_events;
CREATE POLICY "Allow anon ui event inserts"
  ON ui_events FOR INSERT TO anon
  WITH CHECK (check_ui_event_rate_limit(session_id));

-- Staff-only read, matching search_events (no per-agent "own" scope here —
-- UI interactions aren't owned by a single agent the way a listing is).
DROP POLICY IF EXISTS "Staff read ui_events" ON ui_events;
CREATE POLICY "Staff read ui_events"
  ON ui_events FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));
