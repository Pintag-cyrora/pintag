-- ============================================================================
-- RESTORE properties.views_week — production schema drift found by verification
-- ============================================================================
-- Found by the 2026-08-18 post-migration verification run, which called
-- public_listing_stats() as an anonymous visitor and got:
--
--   {"code":"42703","message":"column \"views_week\" does not exist"}
--
-- 42703 is a SCHEMA error, not a permission error: production's `properties`
-- table genuinely has no views_week column.
--
-- WHY THAT IS DRIFT, NOT DESIGN:
--   * 20260623000004_engagement_badges.sql declares it
--     (ALTER TABLE properties ADD COLUMN IF NOT EXISTS views_week INTEGER
--     DEFAULT 0) and that migration IS in production's applied ledger.
--   * STAGE_D_PENDING (the legacy-column cleanup) does NOT list it, so it was
--     never scheduled for removal.
--   * Two shipped public pages consume it: listing.html's FOMO lines
--     ("N people viewed this week") and listings.html's trending_score.
--   So the column is intended, is referenced by live code, and is missing.
--
-- WHAT IT HAD ALREADY BROKEN, SILENTLY, BEFORE THIS AUDIT:
--   increment_listing_view() has incremented views_week since 20260623000004.
--   Against a table without that column every call raises 42703 — so the
--   anonymous view counter has been failing outright, which also explains why
--   the pre-migration probe saw "view_count": null. Nothing alerted, because
--   listing.html fires the counter and ignores the result.
--
-- The security migrations did not cause this; they made it visible by calling
-- the affected functions from an anonymous session for the first time.
--
-- FIX: restore the declared column. Additive, idempotent, and it cannot lose
-- data — the column does not exist, so there is nothing to overwrite. Existing
-- rows get the declared default of 0, which is also the correct starting value
-- for a weekly counter.
--
-- Rollback: ALTER TABLE properties DROP COLUMN views_week;  (but that
-- re-breaks increment_listing_view, public_listing_stats, the FOMO lines and
-- trending_score — the column is load-bearing.)
-- ============================================================================

BEGIN;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS views_week integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN properties.views_week IS
  'Rolling weekly view counter. Incremented by increment_listing_view(), zeroed by reset_weekly_views(). Consumed by listing.html (FOMO lines) and listings.html (trending_score). Declared in 20260623000004; restored in 20260818010000 after production verification found it absent.';

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 1. The column is back:
--      SELECT column_name, data_type, column_default FROM information_schema.columns
--      WHERE table_name='properties' AND column_name='views_week';
-- 2. The anonymous view counter works again (as anon, on a live listing):
--      SELECT increment_listing_view('<a live listing uuid>');   -- no error
-- 3. Social proof returns the full shape again (as anon):
--      SELECT public_listing_stats('<a live listing uuid>');
--      -- EXPECT a views_week key, no 42703.
