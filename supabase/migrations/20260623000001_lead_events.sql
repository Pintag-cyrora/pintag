-- Lead Events tracking table
-- Run in Supabase SQL Editor → Database → SQL Editor

CREATE TABLE IF NOT EXISTS lead_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID,
  agent_id    UUID,
  event_type  TEXT NOT NULL,
  user_agent  TEXT,
  referrer    TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_listing_id ON lead_events(listing_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_agent_id   ON lead_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_created_at ON lead_events(created_at DESC);

ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access lead_events"   ON lead_events;
DROP POLICY IF EXISTS "Public insert lead_events"       ON lead_events;
DROP POLICY IF EXISTS "Authenticated read lead_events"  ON lead_events;

-- Admins (authenticated) have full access
CREATE POLICY "Admin full access lead_events"
  ON lead_events
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Anyone can insert (fire-and-forget from listing pages)
CREATE POLICY "Public insert lead_events"
  ON lead_events
  FOR INSERT
  TO anon
  WITH CHECK (true);
