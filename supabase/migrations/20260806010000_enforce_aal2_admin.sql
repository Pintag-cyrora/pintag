-- ============================================================================
-- L1 SECURITY BASELINE (1/3): AAL2 (MFA) ENFORCED AT THE DATA LAYER
-- ============================================================================
-- Finding (audit 2026-08-06): MFA was enforced only in the browser
-- (admin-auth.js). is_pintag_admin() checked allowlist membership but not the
-- session's assurance level, so a password-only (AAL1) session — issued by
-- GoTrue BEFORE the TOTP step — passed every RLS policy and every edge
-- function. The lock was on the door, not the vault.
--
-- Fix: is_pintag_admin() now also requires the caller's JWT to carry
-- aal = 'aal2' (Supabase sets this claim only after a successful MFA
-- verify). Because RLS policies, storage policies, admin-gated SECURITY
-- DEFINER functions, and all four admin edge functions (via the
-- /rest/v1/rpc/is_pintag_admin call, which runs under the caller's JWT)
-- all flow through this ONE function, this single change closes every
-- surface at once.
--
-- Fail-closed by construction: a missing/absent JWT (anon, background),
-- a malformed claim, or aal1 all yield FALSE.
--
-- Explicitly NOT affected:
--   * service_role / postgres (SQL editor, pg_cron, pintag-studio CI):
--     they bypass RLS entirely and never depended on is_pintag_admin.
--   * The password-reset + TOTP-enrollment flow: it talks to the Auth API
--     (GoTrue), which does not consult this function.
--   * Public read policies (they don't call is_pintag_admin).
--
-- Also in this migration: listing_timeline() — the one admin-facing
-- SECURITY DEFINER function that had NO internal admin gate (it relied
-- only on REVOKE-from-public + GRANT-to-authenticated) — now checks
-- is_pintag_admin() in its body like rebuild_gallery()/
-- listing_recovery_status() already do. Any authenticated non-admin call
-- now fails instead of reading full field-level provenance history.
--
-- Rollback: re-run the CREATE OR REPLACE FUNCTION blocks from
-- 20260804130000_single_admin_cyrora_lockdown.sql (is_pintag_admin) and
-- 20260805010000_listing_provenance.sql (listing_timeline). One statement
-- each; no data is touched by this migration.
-- ============================================================================

BEGIN;

-- ── 1. The single authorization primitive now requires MFA ──────────────────
-- coalesce(...,'aal1'): no JWT / no claim = fail closed.
CREATE OR REPLACE FUNCTION is_pintag_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM admin_accounts WHERE auth_user_id = p_uid)
     AND coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;

COMMENT ON FUNCTION is_pintag_admin(uuid) IS
  'The single write-authorization primitive: allowlist membership (admin_accounts) AND an MFA-verified session (JWT aal=aal2). Fails closed when either is absent. Every RLS policy, storage policy, and admin edge function flows through this check.';

-- ── 2. listing_timeline(): add the missing internal admin gate ──────────────
-- SECURITY DEFINER bypasses RLS, so the gate must live in the body.
-- Same pattern as rebuild_gallery()/rebuild_gallery_snapshot()/
-- listing_recovery_status(); now also inherits the AAL2 requirement above.
CREATE OR REPLACE FUNCTION listing_timeline(p_listing uuid)
RETURNS TABLE (
  at timestamptz, event_type text, source text, field_name text,
  old_value jsonb, new_value jsonb, actor text, import_uuid uuid, details jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
  SELECT lp.created_at, lp.event_type, lp.source, lp.field_name,
         lp.old_value, lp.new_value, lp.actor, lp.import_uuid, lp.details
  FROM listing_provenance lp
  WHERE lp.listing_id = p_listing
  ORDER BY lp.created_at;
END;
$$;

COMMIT;

-- ── Verify (run as each case) ───────────────────────────────────────────────
-- 1. AAL1 session (sign in with password, STOP before the TOTP code), then:
--      curl PATCH /rest/v1/properties?id=eq.<any>  → 0 rows updated (denied)
--      curl POST  /functions/v1/generate-listing-content → 401/403
-- 2. AAL2 session (complete TOTP): both of the above succeed.
-- 3. select is_pintag_admin(auth.uid());  via PostgREST rpc with AAL2 → true.
-- 4. Non-admin authenticated: select * from listing_timeline('<uuid>') → error.
