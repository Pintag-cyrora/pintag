-- Canonical Listing Status model: two independent axes replacing the single
-- free-text `properties.status` column as the thing product code reasons
-- about, without breaking any of it.
--
-- ============================================================================
-- WHY TWO COLUMNS, NOT ONE
-- ============================================================================
-- `status` today conflates two unrelated questions: "is this listing being
-- worked on internally" (draft vs live vs retired) and "can a buyer actually
-- get this property" (available vs sold vs reserved vs ...). A property can
-- be workflow-Active and market-Sold at the same time -- staff still want it
-- browsable (buyers should be able to open it, see "Sold", and be pointed at
-- similar listings), which today's single column has no way to express
-- without also making it look "for sale."
--
-- workflow_status: draft | active | archived -- staff-only, internal.
-- market_status:   available | reserved | rented | sold | fully_occupied |
--                   coming_soon | off_market -- public-facing.
--
-- ============================================================================
-- WHY `status` STAYS, SYNCED BY TRIGGER, RATHER THAN BEING REPLACED
-- ============================================================================
-- grep across every migration confirms `status` is load-bearing for RLS and
-- one RPC, and none of them ever check anything beyond `IN ('active',
-- 'available')`:
--   - contacts' public SELECT policy       (20260705000200)
--   - listing_events INSERT policies        (20260625000002, 20260715010000)
--   - unit_types' public SELECT policy      (20260720000000)
-- Every one of those exists to answer "is this listing publicly reachable at
-- all," which is exactly what workflow_status already answers on its own,
-- independent of market_status. So a trigger keeps `status` in sync:
-- workflow_status='active' -> status='active' (any market_status, including
-- sold/rented/off_market -- those stay browsable, just not purchasable);
-- workflow_status IN ('draft','archived') -> status=that same value (outside
-- the 'active'/'available' set, so every existing gate keeps hiding it
-- exactly as it does today). No RLS policy needed to change at all.
--
-- ============================================================================
-- WHY THE BACKFILL IS SPLIT FROM THE DEFAULT/CHECK CONSTRAINTS
-- ============================================================================
-- Adding the columns with a DEFAULT and immediately backfilling from the
-- (already-legacy-collapsed) `status` column would be idempotent only on the
-- FIRST run -- a second replay would see `status` already collapsed to
-- 'active'/'draft' by this same migration's own trigger, re-derive
-- market_status from it, and silently reset every sold/reserved/rented row
-- back to 'available'. So the columns start nullable/unconstrained, the
-- backfill only ever touches rows where the new column is still NULL
-- (a no-op on replay), and the default/NOT NULL/CHECK are applied last.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS workflow_status text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS market_status text;

-- ── Backfill from the legacy `status` column (idempotent: only NULL rows) ─
-- Existing values in production: active, available, under_offer, sold,
-- rented, draft (admin.html's old dropdown options).
UPDATE properties SET
  workflow_status = CASE WHEN status = 'draft' THEN 'draft' ELSE 'active' END,
  market_status = CASE
    WHEN status = 'under_offer' THEN 'reserved'
    WHEN status = 'sold'        THEN 'sold'
    WHEN status = 'rented'      THEN 'rented'
    ELSE 'available'
  END
WHERE workflow_status IS NULL;

ALTER TABLE properties ALTER COLUMN workflow_status SET DEFAULT 'active';
ALTER TABLE properties ALTER COLUMN workflow_status SET NOT NULL;
ALTER TABLE properties ALTER COLUMN market_status SET DEFAULT 'available';
ALTER TABLE properties ALTER COLUMN market_status SET NOT NULL;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_workflow_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_workflow_status_check
  CHECK (workflow_status IN ('draft','active','archived'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_market_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_market_status_check
  CHECK (market_status IN (
    'available','reserved','rented','sold','fully_occupied',
    'coming_soon','off_market'
  ));

COMMENT ON COLUMN properties.workflow_status IS
  'Internal editorial state: draft (not yet published), active (live), archived (retired). Drives visibility -- see trg_properties_status_sync. Distinct from market_status.';
COMMENT ON COLUMN properties.market_status IS
  'Public-facing availability. Drives the status badge, price-area replacement, primary CTA, search filters, and share previews on listing.html/listings.html/index.html. A sold/rented/off_market listing stays workflow_status=active and browsable -- only market_status changes what a buyer is told and offered.';

-- ── Keep legacy `status` in sync going forward ──────────────────────────
CREATE OR REPLACE FUNCTION sync_properties_legacy_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.status := CASE
    WHEN NEW.workflow_status = 'active' THEN 'active'
    ELSE NEW.workflow_status
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_status_sync ON properties;
CREATE TRIGGER trg_properties_status_sync
  BEFORE INSERT OR UPDATE OF workflow_status ON properties
  FOR EACH ROW EXECUTE FUNCTION sync_properties_legacy_status();

COMMENT ON FUNCTION sync_properties_legacy_status() IS
  'Keeps the legacy properties.status column equal to workflow_status (collapsed to "active" for any active listing regardless of market_status) so every existing RLS policy/RPC that still reads status IN (''active'',''available'') keeps working unchanged. market_status never affects legacy status -- a sold listing stays visible/browsable.';

-- Run the sync once for all existing rows so `status` reflects the new
-- columns immediately, not just on the next future UPDATE. Idempotent by
-- construction: re-deriving 'active' from workflow_status='active' (or
-- 'draft' from 'draft') is stable no matter how many times it runs.
UPDATE properties SET workflow_status = workflow_status;

CREATE INDEX IF NOT EXISTS idx_properties_market_status ON properties(market_status);
CREATE INDEX IF NOT EXISTS idx_properties_workflow_status ON properties(workflow_status);
