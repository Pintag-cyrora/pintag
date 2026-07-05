-- Backfill contacts for every existing listing from the legacy denormalized
-- agent_* columns, deduping so a shared reception/office contact used across
-- many listings becomes ONE contacts row rather than one-per-listing.
--
-- Legacy columns being read here (agent_title/agent_name/agent_name_lo/
-- agent_photo/agent_photo_url/agent_whatsapp/agent_phone/agent_rating/
-- agent_listing_count/agent_response_time) are NOT dropped by this
-- migration — Stage D drops them only after this backfill is confirmed
-- complete in prod. agent_phone/agent_rating/agent_listing_count/
-- agent_response_time are known to always be null in current app code, so
-- they aren't used as a phone source here.

-- Sentinel contact: used whenever a listing has no usable phone number to
-- backfill from (agent_whatsapp was the only real phone-ish field, and it's
-- frequently null). Surfaced afterward as an ongoing staff cleanup queue in
-- admin.html, not a one-shot fix-and-forget.
INSERT INTO contacts (id, role, name, phone, whatsapp)
VALUES (
  '00000000-0000-0000-0000-0000000000c1',
  'other',
  'PENDING — Pintag staff to confirm buyer contact',
  '0000000000',
  NULL
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  g RECORD;
  new_contact_id uuid;
BEGIN
  FOR g IN
    SELECT managed_by_party_id, agent_name, agent_name_lo, agent_whatsapp,
           array_agg(id) AS property_ids
    FROM properties
    WHERE contact_id IS NULL
    GROUP BY managed_by_party_id, agent_name, agent_name_lo, agent_whatsapp
  LOOP
    -- No usable phone to backfill (agent_whatsapp null) — route to sentinel,
    -- regardless of whether a name/party was on file, since contacts.phone
    -- is NOT NULL and we won't fabricate a number.
    IF g.agent_whatsapp IS NULL OR g.agent_whatsapp = '' THEN
      UPDATE properties SET contact_id = '00000000-0000-0000-0000-0000000000c1'
      WHERE id = ANY(g.property_ids);
      CONTINUE;
    END IF;

    INSERT INTO contacts (role, name, phone, whatsapp, party_id)
    VALUES (
      CASE WHEN g.managed_by_party_id IS NOT NULL THEN 'agent' ELSE 'other' END,
      COALESCE(g.agent_name, g.agent_name_lo),
      g.agent_whatsapp,
      g.agent_whatsapp,
      g.managed_by_party_id
    )
    RETURNING id INTO new_contact_id;

    UPDATE properties SET contact_id = new_contact_id
    WHERE id = ANY(g.property_ids);
  END LOOP;
END $$;

-- Verification (run manually and record the result in the deploy ticket
-- before proceeding to Stage C):
--
--   SELECT count(*) FILTER (WHERE contact_id IS NULL)                                  AS still_null,
--          count(*) FILTER (WHERE contact_id = '00000000-0000-0000-0000-0000000000c1') AS sentinel_count
--   FROM properties;
--
-- `still_null` must be 0. `sentinel_count` is the staff cleanup backlog
-- (expected > 0 — every listing with no agent_whatsapp on file — and is
-- tracked as an ongoing admin.html filter, not blocked on).
