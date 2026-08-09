-- ============================================================================
-- PARTY VISIBILITY — soft-hide an agent without deleting it
-- ============================================================================
-- Need: hide an agent (a parties row, type='agent') from the public profile
-- pages and the admin assignment picker, while KEEPING the row and every
-- managed_by_party_id link intact. Listings the agent already manages keep
-- showing them; only their standalone profile and their availability for NEW
-- assignments change. Fully reversible (set is_active back to true).
--
-- Additive and safe: one nullable-free boolean column defaulting to true, so
-- every existing party stays visible exactly as before until explicitly hidden.
-- No data is modified. No policy/RLS change (staff already own parties writes;
-- public read stays as-is — the app filters on is_active for visibility).
-- ============================================================================

BEGIN;

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN parties.is_active IS
  'Soft visibility. false hides the party (agent) from the public profile pages (agents.html/agent.html) and the admin assignment picker, WITHOUT deleting the row or its managed_by_party_id links. Listings already managed by a hidden agent keep showing them. Reversible: set true to show again.';

-- Public/admin both filter on (type, is_active); keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_parties_type_active ON parties (type, is_active);

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────
--   SELECT count(*) FILTER (WHERE is_active) AS visible,
--          count(*) FILTER (WHERE NOT is_active) AS hidden
--   FROM parties WHERE type='agent';
-- Right after this migration: hidden = 0 (nothing hidden yet).
