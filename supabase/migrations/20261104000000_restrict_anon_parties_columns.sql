-- Anonymous visitors may read only the PUBLIC-PROFILE columns of `parties`.
--
-- FINDING (audit 2026-11): the policy "public read parties" is `FOR SELECT TO public USING (true)` (20260705000400, re-created by the single-admin
-- lockdown 20260804130000). Row-level security filters ROWS, not columns, and nothing restricted column privileges, so the public key could
-- `GET /rest/v1/parties?select=*` and receive every party row with EVERY column: auth_user_id (which agent has a login, and the id of that login),
-- phone, email, created_by and anything else the hand-built table holds.
--
-- WHAT THE APPLICATION ACTUALLY NEEDS (searched in index/listings/listing/agents/agent/for-agents and the shared card code):
--   id, type, slug, name_en, name_lo, photo_url, agency_name, bio_en, bio_lo, is_verified, is_active (filter), whatsapp (agent card button),
--   languages (agents.html), created_at (for-agents ordering)
-- ... and nothing else. Those are the only columns granted to anon below. Filtering and ordering on a column also need SELECT on it, so every
-- column used in a WHERE/ORDER BY is in the list.
--
-- WHAT CHANGES
--   1. anon loses its table-level SELECT and gets column-level SELECT on the list above only (columns that do not exist are skipped, so the
--      migration also applies to a database whose table is slimmer).
--   2. Signed-in non-administrators can no longer read other parties' rows: the policy for `authenticated` is "administrator OR my own row".
--      (Administrators are unaffected: is_pintag_admin() requires the allowlist AND an aal2 session.)
--   Anonymous INSERT/UPDATE/DELETE were already revoked by the lockdown; REVOKE ALL below makes that explicit and idempotent.
--
-- WHAT STAYS: the anonymous row filter is unchanged (all rows), so embedded `parties(...)` in listing queries behave exactly as before. Whether
-- inactive parties should be hidden from anonymous readers is a product decision, not made here.
--
-- APPLICATION ORDER (important): agent.html and agents.html fetched `parties?...` with no select list (= every column). They now name their columns.
-- Deploy that code BEFORE applying this migration; with the migration applied, a bare `parties` request from the public key is refused (42501).
--
-- Idempotent. Rollback: GRANT SELECT ON parties TO anon; and re-create the previous policies.

REVOKE ALL ON TABLE parties FROM anon;

DO $$
DECLARE
  wanted text[] := ARRAY['id','type','slug','name_en','name_lo','photo_url','agency_name','bio_en','bio_lo','is_verified','is_active','whatsapp','languages','created_at'];
  present text[];
BEGIN
  SELECT coalesce(array_agg(column_name::text ORDER BY ordinal_position), ARRAY[]::text[]) INTO present
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'parties' AND column_name = ANY (wanted);
  IF array_length(present, 1) IS NULL THEN RAISE EXCEPTION 'parties has none of the expected public columns'; END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE parties TO anon', (SELECT string_agg(quote_ident(c), ', ') FROM unnest(present) c));
END $$;

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read parties" ON parties;
DROP POLICY IF EXISTS "Public read parties" ON parties;
CREATE POLICY "public read parties" ON parties FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "authenticated read own or admin parties" ON parties;
CREATE POLICY "authenticated read own or admin parties" ON parties FOR SELECT TO authenticated
  USING (is_pintag_admin(auth.uid()) OR auth_user_id = auth.uid());

COMMENT ON POLICY "public read parties" ON parties IS
  'Row filter for anonymous readers (all rows). Column exposure is limited by column-level GRANTs to the public-profile columns; see 20261104000000_restrict_anon_parties_columns.sql.';
