-- Behavioral event tracking: the Intelligence layer.
--
-- Product direction (see plan doc, "Decision: pivot confirmed"): agents
-- already live inside WhatsApp and are unlikely to reliably maintain a
-- CRM pipeline. Pintag's durable moat is instead the marketplace-wide
-- behavioral data every visitor generates automatically just by browsing
-- — search, impression, click, detail view, WhatsApp click — none of
-- which requires anyone to type anything. This migration adds the two
-- genuinely missing links in that chain (search events, and list-level
-- impression/click events) and closes one gap in an existing link
-- (lead_events had no session_id, breaking end-to-end correlation).
--
-- Deliberately NOT a redesign of search or the browsing UI — pure
-- instrumentation of interactions that already exist. See the plan doc's
-- "Scope discipline" section.

-- ── search_events — one row per search performed ───────────────────────────
-- Flat filter columns, not a JSONB blob — matches this schema's existing
-- convention (properties itself is flat columns for exactly the same
-- reason: filterable/aggregable directly in SQL). result_count = 0 is the
-- literal "zero-result search = unmet demand" signal; no separate flag.
CREATE TABLE search_events (
  id                bigserial PRIMARY KEY,
  session_id        text,
  district          text,
  property_type     text,
  transaction_type  text,
  price_min         numeric,
  price_max         numeric,
  bedrooms          integer,
  result_count      integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_events_created ON search_events(created_at DESC);
CREATE INDEX idx_search_events_district ON search_events(district);
CREATE INDEX idx_search_events_type ON search_events(property_type);

COMMENT ON TABLE search_events IS
  'One row per search performed on listings.html — filters used, result count, and (via result_count = 0) unmet demand. Fires once per settled search, not per keystroke.';

ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_search_event_rate_limit(p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN (
    SELECT COUNT(*) FROM search_events
    WHERE session_id = p_session_id
      AND created_at > NOW() - INTERVAL '1 minute'
  ) < 20;
END;
$$;
GRANT EXECUTE ON FUNCTION check_search_event_rate_limit(text) TO anon;

CREATE POLICY "Allow anon search event inserts"
  ON search_events FOR INSERT TO anon
  WITH CHECK (check_search_event_rate_limit(session_id));

CREATE POLICY "Staff read search_events"
  ON search_events FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

-- ── listing_events — extend the existing (currently unused) table ──────────
-- 'impression'/'click' read as "listing_impression"/"listing_click" — the
-- table itself supplies the "listing_" scope. Deliberately distinct from
-- the existing 'view' (opened the full detail page, already wired to
-- increment_listing_view()): impression/click are a step earlier in the
-- funnel, inside a list rather than on the detail page.
ALTER TABLE listing_events
  ADD COLUMN IF NOT EXISTS source          text,
  ADD COLUMN IF NOT EXISTS search_position integer,
  ADD COLUMN IF NOT EXISTS search_filters  jsonb;

COMMENT ON COLUMN listing_events.source IS
  'Where this event happened: search | homepage | similar | agent_profile | recommendation.';
COMMENT ON COLUMN listing_events.search_position IS
  '1-indexed rank in the list this card was shown at, when applicable.';
COMMENT ON COLUMN listing_events.search_filters IS
  'Snapshot of active filters at the time of the event, when source = search.';

ALTER TABLE listing_events DROP CONSTRAINT IF EXISTS listing_events_event_type_check;
ALTER TABLE listing_events ADD CONSTRAINT listing_events_event_type_check
  CHECK (event_type IN ('view','contact','save','share','impression','click'));

-- A user legitimately sees the same listing card across multiple
-- searches/pages within one session — deduping impression/click the same
-- way the existing 'view'/'contact'/'save'/'share' policy dedups (30 min
-- per session+property+event_type) would silently undercount every CTR
-- number. This is a second, additional permissive INSERT policy scoped
-- to only impression/click; Postgres OR-combines permissive policies for
-- the same command, so this doesn't touch or weaken the existing policy
-- for the other four event types at all — it only ever adds coverage.
CREATE OR REPLACE FUNCTION check_listing_event_burst_limit(p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN (
    SELECT COUNT(*) FROM listing_events
    WHERE session_id = p_session_id
      AND event_type IN ('impression','click')
      AND created_at > NOW() - INTERVAL '1 minute'
  ) < 200; -- generous enough for a real batched page of card impressions
END;
$$;
GRANT EXECUTE ON FUNCTION check_listing_event_burst_limit(text) TO anon;

CREATE POLICY "Allow anon impression and click inserts"
  ON listing_events FOR INSERT TO anon
  WITH CHECK (
    event_type IN ('impression','click')
    AND property_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_listing_event_burst_limit(session_id)
  );

-- listing_events had RLS enabled but no SELECT policy at all — meaning
-- nothing, not even staff, could read it back. Adding read access is
-- required for any of this to be usable, not optional follow-up.
CREATE POLICY "Staff read listing_events"
  ON listing_events FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

CREATE POLICY "Party read own listing_events"
  ON listing_events FOR SELECT TO authenticated
  USING (
    property_id IN (
      SELECT id FROM properties WHERE managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
    )
  );

-- Pre-existing bug, found while adding the SELECT policies above and
-- fixed here since it's the exact same policy surface: the original
-- view/contact/save/share dedup policy (20260625000002) checks
-- `NOT EXISTS (SELECT 1 FROM listing_events existing WHERE ...)` — but
-- that subquery runs as the `anon` role, and until the two policies just
-- above, `anon` had no SELECT policy on this table at all. Under RLS, a
-- role with no applicable SELECT policy sees zero rows, so the dedup
-- subquery has always found "no existing row" and the 30-minute dedup
-- has silently never actually blocked anything. Verified directly:
-- `SET ROLE anon; SELECT count(*) FROM listing_events;` returned 0
-- despite rows existing, confirming the bug empirically, not just in
-- theory. Fix: a narrow anon SELECT policy scoped to exactly what the
-- dedup check needs (recent rows with a session_id) and nothing more —
-- not blanket read access. This makes the *existing* dedup behavior
-- (unchanged rule, unchanged intent) actually take effect for the first
-- time; it does not change what gets deduped or how.
CREATE POLICY "Allow anon dedup self-check"
  ON listing_events FOR SELECT TO anon
  USING (
    session_id IS NOT NULL
    AND created_at > NOW() - INTERVAL '30 minutes'
  );

-- ── lead_events — one additive column, closing the chain ───────────────────
-- Nullable: every existing call to trackLead() in listing.html keeps
-- working identically without passing it. Once a shared client-side
-- session id exists (getOrCreateSessionId()), trackLead() can pass the
-- same session id that stamped the search/impression/click that led
-- here, making the full buyer-journey chain joinable end to end.
ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS session_id text;
COMMENT ON COLUMN lead_events.session_id IS
  'Same client-side session id used by search_events/listing_events, so a WhatsApp click can be correlated back to the search/impression/click that led to it. Nullable — existing trackLead() calls are unaffected either way.';
