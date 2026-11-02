-- Anonymous visitors can WRITE listing events but must not READ them.
--
-- FINDING (audit 2026-11): policy "anon dedup read listing_events" is `FOR SELECT TO anon USING (true)` (created by the single-admin lockdown 20260804130000, and
-- kept "exactly as the lockdown left it" by 20260811000000). With the public key, `GET /rest/v1/listing_events?select=*` returns EVERY row: property id,
-- event type, session id and timestamp for all listings and all visitors. Competitors can read engagement per listing; anyone can follow a session id across
-- listings. (A second, older policy "Allow anon dedup self-check" limited reads to the last 30 minutes; the lockdown's `true` policy makes it moot.)
--
-- THE ORIGINAL REQUIREMENT: "do not record the same (session, listing, event type) twice within 30 minutes". That check is check_listing_event_dedup(), which is
-- SECURITY DEFINER, runs inside the anon INSERT policy's WITH CHECK (20260811000000), and sees every row regardless of the caller's own privileges. So the
-- anonymous SELECT policy was never what made deduplication work. Likewise check_event_target_ceiling() (20260817010000) is SECURITY DEFINER.
-- The browser only ever writes (`Prefer: return=minimal`, no `.select()`), and the only reader is analytics-inspector.html, which runs as the administrator
-- (policy "admin read listing_events", is_pintag_admin()).
--
-- CHANGE: drop both anonymous SELECT policies and revoke anon's table privilege, so the key itself cannot read the table (permission denied, not just zero rows).
-- Untouched: the anon INSERT policy (active-listing + dedup + per-target ceiling), anon INSERT/USAGE grants, the administrator read policy, every other table.
--
-- RESIDUAL (documented, not changed): check_listing_event_dedup(session, property, type) stays executable by anon (the insert policy needs it) and answers whether a
-- specific session already viewed a specific listing in the last 30 minutes. Exploiting it requires already knowing a random session id.
-- ALSO RESIDUAL: an INSERT ... RETURNING by anon now fails (RETURNING needs SELECT). No code in this repository asks for a representation.
--
-- Idempotent. Rollback: GRANT SELECT ON listing_events TO anon; and re-create the policy.

DROP POLICY IF EXISTS "anon dedup read listing_events" ON listing_events;
DROP POLICY IF EXISTS "Allow anon dedup self-check" ON listing_events;

REVOKE SELECT ON TABLE listing_events FROM anon;
