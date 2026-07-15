-- Leads CRM: turns the existing anonymous lead_events click log into an
-- actionable pipeline agents can manage day to day (status, customer info,
-- notes) without touching lead_events itself at all.
--
-- lead_events stays exactly what it is today: an anonymous, rate-limited,
-- append-only click log, publicly insertable by design (see
-- 20260623000001_lead_events.sql / 20260625000002_security_hardening.sql).
-- Extending it in place with mutable, agent-owned fields would conflate two
-- very different trust levels on one table — the same kind of drift the
-- Buyer Contact/Platform Identity work (20260705*) already fixed once for
-- properties/agents. `leads` is a separate, additive table instead.

CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  party_id        uuid REFERENCES parties(id) ON DELETE SET NULL,
  lead_event_id   uuid REFERENCES lead_events(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN (
                    'new','contacted','viewing_scheduled','negotiating','closed','lost')),
  -- Real column, not a hardcoded UI string — forward-compatible if another
  -- channel becomes lead-worthy later. Only 'whatsapp' is allowed today,
  -- matching the current "Message Agent" trigger below exactly.
  contact_method  text NOT NULL DEFAULT 'whatsapp' CHECK (contact_method IN ('whatsapp')),
  -- A WhatsApp click alone never tells Pintag who the buyer is — that
  -- conversation happens entirely off-platform, inside WhatsApp. Both start
  -- NULL on every new lead; the agent fills them in once they've actually
  -- exchanged messages with the buyer.
  customer_name   text,
  customer_phone  text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_property_id ON leads(property_id);
CREATE INDEX idx_leads_party_id    ON leads(party_id);
CREATE INDEX idx_leads_status      ON leads(status);
CREATE INDEX idx_leads_created_at  ON leads(created_at DESC);

COMMENT ON TABLE leads IS
  'The agent-managed CRM pipeline — one row per "Message Agent" (WhatsApp) click, created automatically by trg_lead_events_create_lead. Distinct from lead_events, which stays the raw anonymous click log.';

-- Reuses the existing global update_updated_at() trigger function (defined
-- in 20260622000000_engagement_metrics.sql) rather than redefining it.
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Lead creation — zero changes to the existing click path ────────────────
-- trackLead() in listing.html, the anon INSERT policy on lead_events, and
-- its 30-second rate limit (check_lead_rate_limit()) are completely
-- untouched. This trigger is the only new thing, and it only reacts to rows
-- that already made it past all of that — "keep this behavior exactly as
-- it is" is literally true, not just approximately true.
--
-- Scoped to event_type = 'whatsapp_click' specifically — that's the literal
-- "Message Agent" button. The separate Call button stays exactly what it is
-- today: a raw analytics event, not a CRM lead. This also matches the
-- funnel's own top label ("Message Clicks", not "Contact Clicks").
--
-- Each rate-limited click creates one new lead — no cross-visit dedup.
-- A WhatsApp click is anonymous, so there's no reliable signal to tell
-- whether two clicks over time are the same buyer or two different ones;
-- guessing would risk silently merging two real buyers into one lead.
-- Agents can recognize a genuine repeat inquiry themselves and use `notes`.
CREATE OR REPLACE FUNCTION create_lead_from_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_type = 'whatsapp_click' AND NEW.listing_id IS NOT NULL THEN
    INSERT INTO leads (property_id, party_id, lead_event_id)
    VALUES (NEW.listing_id, NEW.agent_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lead_events_create_lead
  AFTER INSERT ON lead_events
  FOR EACH ROW EXECUTE FUNCTION create_lead_from_event();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mirrors the exact pattern already established for contacts/properties
-- (is_pintag_staff / owned_party_ids from 20260705000000_agents_becomes_parties.sql)
-- — nothing new invented. No anon access at all: unlike lead_events, this
-- table is never written to by the public click path (the trigger above
-- runs as SECURITY DEFINER, bypassing RLS for that one insert).
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access leads"
  ON leads TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Party manage own leads"
  ON leads FOR SELECT TO authenticated
  USING (party_id IN (SELECT owned_party_ids(auth.uid())));

CREATE POLICY "Party update own leads"
  ON leads FOR UPDATE TO authenticated
  USING (party_id IN (SELECT owned_party_ids(auth.uid())))
  WITH CHECK (party_id IN (SELECT owned_party_ids(auth.uid())));
