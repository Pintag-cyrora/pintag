-- ============================================================================
-- Fixture ADDENDUM for the Contact Intent funnel regression
-- (supabase/migrations/20261008000000_analytics_contact_intent_funnel.sql).
--
-- Loaded AFTER schema_analytics_laos_calendar_days.sql (roles, auth.uid(),
-- is_pintag_staff() stub, properties, snapshots, removal log, unit_types,
-- lead_events, leads, page_views, ...). That fixture's ui_events is trimmed to
-- the columns the older RPCs read; the funnel also needs the columns production
-- has (20260717000000_ui_events.sql): element_type, property_id -> properties
-- ON DELETE SET NULL (a hard-deleted listing nulls the id on its events, which
-- the funnel must report rather than invent), and metadata.
-- ============================================================================
ALTER TABLE ui_events ADD COLUMN IF NOT EXISTS page         text;
ALTER TABLE ui_events ADD COLUMN IF NOT EXISTS element_type text;
ALTER TABLE ui_events ADD COLUMN IF NOT EXISTS property_id  uuid REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE ui_events ADD COLUMN IF NOT EXISTS metadata     jsonb;
CREATE INDEX IF NOT EXISTS idx_ui_events_element_id  ON ui_events(element_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_session_id  ON ui_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_property_id ON ui_events(property_id);
