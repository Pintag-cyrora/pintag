-- Lead Events tracking table
-- Run in Supabase SQL Editor → Database → SQL Editor

CREATE TABLE IF NOT EXISTS lead_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID,
  agent_id    UUID,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'whatsapp_click','call_click','messenger_click',
                'telegram_click','line_click','contact_click'
              )),
  user_agent  TEXT,
  referrer    TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_listing_id ON lead_events(listing_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_agent_id   ON lead_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_created_at ON lead_events(created_at DESC);

ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

-- Drop any old policies before recreating
DROP POLICY IF EXISTS "Admin full access lead_events"       ON lead_events;
DROP POLICY IF EXISTS "Agent read own leads"                ON lead_events;
DROP POLICY IF EXISTS "Public insert lead_events"           ON lead_events;
DROP POLICY IF EXISTS "Authenticated read lead_events"      ON lead_events;

-- 1. Admin full access (read, insert, update, delete)
CREATE POLICY "Admin full access lead_events"
  ON lead_events
  TO authenticated
  USING     (auth.email() = 'admin@pintag.io')
  WITH CHECK(auth.email() = 'admin@pintag.io');

-- 2. Agents can read only their own leads (agent_id matches their user id)
CREATE POLICY "Agent read own leads"
  ON lead_events
  FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- 3. Anyone (anon) can insert a lead — validated by CHECK constraint on event_type above
CREATE POLICY "Public insert lead_events"
  ON lead_events
  FOR INSERT
  TO anon
  WITH CHECK (true);
