-- ============================================================================
-- AUTHORIZATION IDENTITY BINDING + ANALYTICS ABUSE BOUNDS (2026-08-17, pass 2)
-- ============================================================================
-- Follow-up to 20260817000000_security_audit_hardening.sql. Three changes, all
-- additive; no data is modified and no existing behaviour for a legitimate
-- caller changes.
--
--   1. is_pintag_admin(p_uid) stops answering about an identity the caller did
--      not prove they own.
--   2. A per-target ceiling on anonymous analytics inserts that session-id
--      rotation cannot bypass (F-08).
--   3. A per-listing ceiling on anonymous view-count increments (F-09).
--
-- On (2) and (3), read this before tuning the numbers: the DATABASE IS NOT THE
-- RIGHT PLACE for the primary rate limit, and this migration does not pretend
-- otherwise. PostgREST sees no trustworthy client network identity, so the only
-- keys available in a policy are ones the client itself supplies. What follows
-- is therefore a *damage ceiling*, not a rate limiter: it converts "unbounded"
-- into "bounded per target per minute", which is worth having on its own but is
-- explicitly the SECOND layer. The primary control is Cloudflare rate limiting
-- at the edge — see docs/RATE_LIMITING.md for the exact rules and why the split
-- is drawn here.
--
-- Both ceilings FAIL OPEN by construction: if the bookkeeping errors for any
-- reason, the event is still recorded. These are analytics counters, and
-- silently losing real traffic is a worse outcome than admitting some fake
-- traffic. Nothing security-critical depends on them.
-- ============================================================================

BEGIN;

-- ── 1. Bind is_pintag_admin() to the caller's own proven identity ───────────
-- The function takes the identity to check as an ARGUMENT, and is granted to
-- anon and authenticated. Every real call site passes a server-derived value:
-- RLS policies pass auth.uid(), and the four admin edge functions pass the id
-- returned by /auth/v1/user for the caller's own token (verified: all 69 SQL
-- call sites use auth.uid(); all four functions send `p_uid: user.id`). So
-- nothing legitimate ever asks about somebody else.
--
-- But the signature invites it. Today an MFA-verified non-admin could call
-- is_pintag_admin('<some uuid>') and learn whether that uuid is an
-- administrator — a small oracle, and a large footgun: the next function or
-- policy that forwards a client-supplied id into this check would become a
-- straightforward privilege escalation, and it would look correct at the call
-- site. This is the same class of mistake as the auth.email() guard fixed in
-- 20260817000000, caught before it had a chance to be exploited rather than
-- after.
--
-- Fix: answer only about auth.uid(). A NULL argument means "me". Any other
-- identity returns false rather than raising, so a policy that somehow passed
-- the wrong id fails CLOSED instead of erroring in a way that might be caught
-- and ignored.
--
-- Rollback: re-run the CREATE OR REPLACE block from 20260806010000.
CREATE OR REPLACE FUNCTION is_pintag_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND (p_uid IS NULL OR p_uid = auth.uid())
     AND EXISTS (SELECT 1 FROM admin_accounts WHERE auth_user_id = auth.uid())
     AND coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;

COMMENT ON FUNCTION is_pintag_admin(uuid) IS
  'The single write-authorization primitive: the CALLER''s own allowlist membership (admin_accounts) AND an MFA-verified session (JWT aal=aal2). Answers only about auth.uid() — passing any other identity returns false, so a client-supplied id can never be laundered into an authorization decision. Fails closed when the JWT, the allowlist row, or aal2 is absent.';

-- ── 2. Per-target ceiling on anonymous analytics inserts (F-08) ─────────────
-- The existing checks (check_lead_rate_limit, check_listing_event_dedup) key on
-- session_id, which session.js generates in the browser. An attacker sends a
-- fresh uuid per request and every window resets, so the effective limit is
-- infinity. Those checks remain — they are genuinely useful against accidental
-- double-fires from real visitors, which is what they were written for — but
-- they are no longer the only thing standing between an attacker and unbounded
-- inserts.
--
-- This adds a ceiling keyed on the TARGET (the listing and event type), which
-- the attacker cannot rotate: forging a new session id does not give them a new
-- listing to inflate. Chosen so that real traffic never reaches it:
--
--   * lead_events    30/min per (listing, event_type). A lead event is a
--     WhatsApp/call/contact click. One listing receiving 30 genuine contact
--     clicks inside one minute has never happened on this platform; the cap is
--     an order of magnitude above the busiest real listing.
--   * listing_events 300/min per (property, event_type). Deliberately much
--     higher: listings.html fires an impression per rendered card, so a single
--     popular listing legitimately accrues one impression per page view, and a
--     burst of real visitors must not be throttled.
--
-- Exceeding a ceiling drops the analytics row. It does NOT fail the request the
-- visitor made, break the page, or affect anything the visitor sees.
CREATE OR REPLACE FUNCTION check_event_target_ceiling(
  p_table text, p_target uuid, p_event_type text, p_limit integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_target IS NULL THEN RETURN true; END IF;
  IF p_table = 'lead_events' THEN
    SELECT count(*) INTO n FROM lead_events
     WHERE listing_id = p_target AND event_type = p_event_type
       AND created_at > now() - interval '1 minute';
  ELSIF p_table = 'listing_events' THEN
    SELECT count(*) INTO n FROM listing_events
     WHERE property_id = p_target AND event_type = p_event_type
       AND created_at > now() - interval '1 minute';
  ELSE
    RETURN true;
  END IF;
  RETURN coalesce(n, 0) < p_limit;
EXCEPTION WHEN OTHERS THEN
  -- Fail OPEN: never lose real analytics because the ceiling check itself broke.
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION check_event_target_ceiling(text, uuid, text, integer) TO anon, authenticated;

COMMENT ON FUNCTION check_event_target_ceiling(text, uuid, text, integer) IS
  'Per-target ceiling for anonymous analytics inserts. Keyed on the listing, NOT on the client-supplied session_id, so rotating session ids cannot bypass it. A damage ceiling, not the primary rate limit — that is Cloudflare (docs/RATE_LIMITING.md). Fails open.';

-- Re-create the two anon INSERT policies, preserving every existing condition
-- from 20260811000000 and adding the ceiling. The active-listing requirement
-- and the per-session dedup are unchanged.
DROP POLICY IF EXISTS "anon insert lead_events" ON lead_events;
CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon
  WITH CHECK (
    listing_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_lead_rate_limit(listing_id, event_type, session_id)
    AND check_event_target_ceiling('lead_events', listing_id, event_type, 30)
  );

DROP POLICY IF EXISTS "anon insert listing_events" ON listing_events;
CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon
  WITH CHECK (
    property_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_listing_event_dedup(session_id, property_id, event_type)
    AND check_event_target_ceiling('listing_events', property_id, event_type, 300)
  );

-- Supporting indexes: both ceilings are a count over a 1-minute tail for one
-- target, so without these the check would degrade into a scan as the tables
-- grow. Partial on recent rows is not possible (now() is not immutable), so
-- these are plain composite indexes ending in created_at.
CREATE INDEX IF NOT EXISTS idx_lead_events_target_window
  ON lead_events (listing_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_events_target_window
  ON listing_events (property_id, event_type, created_at DESC);

-- ── 3. Per-listing ceiling on anonymous view increments (F-09) ──────────────
-- increment_listing_view() is granted to anon and takes no session at all, so
-- there is nothing to dedup against — it was simply unbounded. A loop could
-- drive any active listing's view_count arbitrarily high, which feeds the
-- "Most Viewed in District" badge, the engagement tiers, and the intelligence
-- reports.
--
-- A tiny fixed-size counter table gives an O(1) per-listing minute window with
-- no scan. 120 increments per listing per minute is far above any real Pintag
-- listing (that is two page views per second, sustained, on ONE property) and
-- turns "unbounded" into a hard, predictable bound.
--
-- This bounds the RATE, not the lifetime total — an attacker patient enough can
-- still accumulate over days. That residual is accepted here and closed at the
-- edge instead; see docs/RATE_LIMITING.md. Stating it plainly because a ceiling
-- that looks like a rate limiter but is not one is worse than none.
CREATE TABLE IF NOT EXISTS listing_view_throttle (
  property_id  uuid PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  hits         integer     NOT NULL DEFAULT 0
);
ALTER TABLE listing_view_throttle ENABLE ROW LEVEL SECURITY;
-- No policies at all: written only by the SECURITY DEFINER function below and
-- readable only by the administrator, like every other internal bookkeeping
-- table in this schema.
DROP POLICY IF EXISTS "admin read listing_view_throttle" ON listing_view_throttle;
CREATE POLICY "admin read listing_view_throttle" ON listing_view_throttle
  FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

COMMENT ON TABLE listing_view_throttle IS
  'One row per listing holding the current minute window and its increment count. Bookkeeping for increment_listing_view()''s abuse ceiling; not analytics data and never read by the application.';

CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz := date_trunc('minute', now());
  v_hits   integer;
  VIEW_CEILING CONSTANT integer := 120;   -- per listing, per minute
BEGIN
  -- Ceiling bookkeeping. Wrapped so that ANY failure here falls through to the
  -- plain increment: a broken counter must never stop a real visit being
  -- counted (fail open — this is a popularity metric, not an access control).
  BEGIN
    INSERT INTO listing_view_throttle AS t (property_id, window_start, hits)
    VALUES (p_listing_id, v_window, 1)
    ON CONFLICT (property_id) DO UPDATE
      SET hits = CASE WHEN t.window_start = v_window THEN t.hits + 1 ELSE 1 END,
          window_start = v_window
    RETURNING t.hits INTO v_hits;

    IF v_hits > VIEW_CEILING THEN
      RETURN;   -- over the ceiling for this minute: silently do not count
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;       -- fall through and count the view
  END;

  UPDATE properties
  SET view_count = COALESCE(view_count, 0) + 1,
      views_week = COALESCE(views_week, 0) + 1
  WHERE id = p_listing_id
    AND status = 'active'
    AND deleted_at IS NULL;
END;
$$;

COMMENT ON FUNCTION increment_listing_view(UUID) IS
  'Anonymous view counter for a publicly-visible listing. Bounded to 120 increments per listing per minute (listing_view_throttle) so a burst cannot inflate popularity; the ceiling fails open. Only bounds the rate — the lifetime total is protected at the edge (docs/RATE_LIMITING.md).';

-- ── 4. Diagnostic: what client network identity can the database actually see?
-- Whether an IP-keyed limit is implementable inside Postgres depends entirely
-- on whether PostgREST forwards a trustworthy client address, which cannot be
-- determined from the repository — it depends on the deployed proxy chain. This
-- read-only, admin-only function reports exactly what the database sees so the
-- question can be settled against production instead of guessed at. It is a
-- diagnostic, not a control, and nothing depends on its result.
CREATE OR REPLACE FUNCTION pintag_client_network_probe()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE h jsonb;
BEGIN
  IF NOT is_pintag_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;
  BEGIN
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN h := NULL;
  END;
  RETURN jsonb_build_object(
    'headers_guc_present', h IS NOT NULL,
    'x_forwarded_for',     h ->> 'x-forwarded-for',
    'cf_connecting_ip',    h ->> 'cf-connecting-ip',
    'x_real_ip',           h ->> 'x-real-ip',
    'inet_client_addr',    inet_client_addr()::text
  );
END $$;
REVOKE ALL ON FUNCTION pintag_client_network_probe() FROM public;
GRANT EXECUTE ON FUNCTION pintag_client_network_probe() TO authenticated;

COMMENT ON FUNCTION pintag_client_network_probe() IS
  'Admin-only diagnostic: reports whether PostgREST forwards a usable client IP (request.headers GUC / XFF / CF-Connecting-IP). Decides whether an IP-keyed database rate limit is implementable at all. Read-only; no control depends on it.';

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 1. Identity binding — as an MFA-verified ADMIN:
--      select is_pintag_admin(auth.uid());                       -- true
--      select is_pintag_admin('00000000-0000-0000-0000-000000000000'); -- false
--    As any non-admin, both are false.
-- 2. Ceilings are wired into the policies:
--      SELECT tablename, with_check FROM pg_policies
--      WHERE policyname IN ('anon insert lead_events','anon insert listing_events');
--      -- EXPECT both to reference check_event_target_ceiling.
-- 3. Client-network probe (admin, MFA):
--      select pintag_client_network_probe();
--    If x_forwarded_for / cf_connecting_ip is populated and trustworthy, an
--    IP-keyed limit becomes implementable in-database; until then Cloudflare
--    is the only place it can be enforced correctly.
-- 4. Regression suite: bash tests/security/regression/run-local-pg.sh
