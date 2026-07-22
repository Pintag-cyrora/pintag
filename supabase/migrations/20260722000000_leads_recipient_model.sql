-- Analytics Lead Model refactor: make "Lead" (Property Inquiry) the primary
-- entity, with the recipient as metadata on it — not the other way around.
--
-- Problem being fixed: today a "lead" only really exists when the click's
-- lead_events.agent_id happens to be populated, and agent_id is populated
-- from properties.managed_by_party_id — the Platform Identity (who manages
-- the listing inside Pintag), not the Buyer Contact (who the buyer actually
-- reaches, contacts.id/contacts.role — see ARCHITECTURE.md). A listing with
-- only a Reception/Owner/Sales Office contact and no agent party has always
-- silently fallen out of every agent-keyed breakdown in admin.html, even
-- though a real inquiry happened. Separately, create_lead_from_event() has
-- only ever fired on event_type = 'whatsapp_click' — a call_click has never
-- produced a leads CRM row at all, so "how many inquiries did Pintag
-- generate" has always undercounted by excluding an entire contact channel.
--
-- Fix: thread contacts.id through the whole chain (lead_events -> leads),
-- snapshot contacts.role/is_verified onto leads at creation time (same
-- snapshot-at-creation-time pattern already used for leads.party_id —
-- "managing agent at creation time" — so a report stays stable even if the
-- underlying contact's role or verification later changes), and fire the
-- trigger on every event_type, not just whatsapp_click. The recipient
-- becomes an attribute of the lead, not what defines it — a future
-- recipient_type value (contacts.role already has room to grow: 'owner',
-- 'agent', 'property_manager', 'reception', 'sales_office', 'developer',
-- 'family_representative', 'other') or a future contact channel works
-- automatically, with no further analytics redesign.
--
-- Fully additive: lead_events' existing columns/RLS/rate-limit are
-- untouched; the historical backfill below only INSERTs leads rows that
-- never existed and fills in the two brand-new NULL columns on existing
-- rows — it never mutates any pre-existing, previously-meaningful value.

-- ── lead_events: thread the Buyer Contact through ───────────────────────────
-- Nullable — trackLead() callers that don't pass a contact_id keep working
-- identically (mirrors how session_id was added in 20260715010000).
ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN lead_events.contact_id IS
  'The contacts row the buyer actually reached (Buyer Contact), independent of lead_events.agent_id (Platform Identity / managed_by_party_id). Nullable — not-yet-updated callers omit it.';

CREATE INDEX IF NOT EXISTS idx_lead_events_contact_id ON lead_events(contact_id);

-- ── leads: recipient becomes metadata on the lead, not its definition ──────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

-- Snapshotted at creation time from contacts.role (falls back to 'agent'
-- when only a Platform Identity party is linked with no specific contact —
-- matching what every pre-existing lead implicitly already assumed — or
-- 'unknown' when neither is available). Reuses contacts.role's exact
-- vocabulary rather than inventing a parallel one, so a new contact role
-- automatically becomes a new, valid recipient_type with zero code changes
-- here.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS recipient_type text CHECK (recipient_type IN (
    'owner','agent','property_manager','reception',
    'sales_office','developer','family_representative','other','unknown'
  ));

-- Snapshotted from contacts.is_verified (or parties.is_verified as a
-- fallback when only a party is linked) — gives "Verified Agent" vs.
-- "Unverified Broker" for free, no new verification concept needed. NULL
-- when neither side is known.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS recipient_verified boolean;

CREATE INDEX IF NOT EXISTS idx_leads_contact_id      ON leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_recipient_type  ON leads(recipient_type);

COMMENT ON COLUMN leads.recipient_type IS
  'Snapshot of contacts.role (or a derived agent/unknown fallback) at the moment this lead was created — stable for historical reporting even if the underlying contact''s role changes later.';
COMMENT ON COLUMN leads.recipient_verified IS
  'Snapshot of contacts.is_verified (or parties.is_verified as fallback) at creation time — same stability rationale as recipient_type.';

-- Widen the channel vocabulary to match every event_type lead_events already
-- accepts (whatsapp_click/call_click/messenger_click/telegram_click/
-- line_click/contact_click, each with its '_click' suffix stripped) instead
-- of hardcoding just 'whatsapp' — this is what lets a call_click produce a
-- real CRM lead below.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_contact_method_check;
ALTER TABLE leads ADD CONSTRAINT leads_contact_method_check
  CHECK (contact_method IN ('whatsapp','call','messenger','telegram','line','contact'));

-- ── Trigger rewrite: every inquiry becomes a lead, not just WhatsApp ────────
-- Previously scoped to event_type = 'whatsapp_click' only. Every value in
-- lead_events.event_type's CHECK represents a real user-initiated contact
-- action from a listing, so every one of them should produce a leads row —
-- "how many property inquiries did Pintag generate," not "how many went to
-- an agent over WhatsApp."
CREATE OR REPLACE FUNCTION create_lead_from_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contact_role       text;
  v_contact_verified   boolean;
  v_party_verified     boolean;
  v_recipient_type     text;
  v_recipient_verified boolean;
BEGIN
  IF NEW.listing_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT role, is_verified INTO v_contact_role, v_contact_verified
    FROM contacts WHERE id = NEW.contact_id;
  END IF;

  IF NEW.agent_id IS NOT NULL THEN
    SELECT is_verified INTO v_party_verified FROM parties WHERE id = NEW.agent_id;
  END IF;

  v_recipient_type := COALESCE(v_contact_role,
    CASE WHEN NEW.agent_id IS NOT NULL THEN 'agent' ELSE 'unknown' END);
  v_recipient_verified := COALESCE(v_contact_verified, v_party_verified);

  INSERT INTO leads (
    property_id, party_id, contact_id, lead_event_id,
    contact_method, recipient_type, recipient_verified
  )
  VALUES (
    NEW.listing_id, NEW.agent_id, NEW.contact_id, NEW.id,
    regexp_replace(NEW.event_type, '_click$', ''),
    v_recipient_type, v_recipient_verified
  );

  RETURN NEW;
END;
$$;

-- trg_lead_events_create_lead itself is untouched (still AFTER INSERT ON
-- lead_events FOR EACH ROW EXECUTE FUNCTION create_lead_from_event()) —
-- only the function body changed, so no DROP/CREATE TRIGGER needed here.

-- ── Historical backfill (additive only) ─────────────────────────────────────
-- 1. INSERT leads rows for historical lead_events that never got one — every
--    non-whatsapp_click event before this migration, since the old trigger
--    only matched that one event_type. Never touches any leads row that
--    already exists.
-- created_at/updated_at are set explicitly to the original lead_events row's
-- timestamp, not left to default to NOW() at migration time — otherwise
-- every backfilled lead would appear to have been "created today," which
-- would corrupt historical trend counts (admin.html's Today/Week/Month
-- KPIs) and put a false spike in the Intelligence Layer's daily metrics
-- (intelligence_daily_metrics()'s leads_created_totals) on whichever day
-- this migration happens to run.
INSERT INTO leads (
  property_id, party_id, contact_id, lead_event_id,
  contact_method, recipient_type, recipient_verified, status,
  created_at, updated_at
)
SELECT
  le.listing_id,
  le.agent_id,
  le.contact_id,
  le.id,
  regexp_replace(le.event_type, '_click$', ''),
  CASE WHEN le.agent_id IS NOT NULL THEN 'agent' ELSE 'unknown' END,
  (SELECT p.is_verified FROM parties p WHERE p.id = le.agent_id),
  'new',
  le.created_at,
  le.created_at
FROM lead_events le
WHERE le.listing_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.lead_event_id = le.id);

-- 2. Backfill recipient_type/recipient_verified on pre-existing leads rows
--    (created by the old whatsapp_click-only trigger, so these two brand-new
--    columns are still NULL on them). contact_id stays NULL on these rows —
--    lead_events.contact_id didn't exist yet when they were created, so
--    there is nothing real to backfill it from; only party_id is derivable.
UPDATE leads
SET recipient_type     = CASE WHEN party_id IS NOT NULL THEN 'agent' ELSE 'unknown' END,
    recipient_verified = (SELECT p.is_verified FROM parties p WHERE p.id = leads.party_id)
WHERE recipient_type IS NULL;
