-- market-status-report.sql — READ-ONLY. Does not modify any data.
--
-- Updated for the Availability State Integration: sections 3 and 6-8 follow the CANONICAL availability rules
-- (property-availability.js; PRs #136/#137) instead of market_status alone. Run each numbered query on its own.
--
-- Written after the "public site shows only one listing" incident
-- (2026-08-03, fixed in listings.html commit b4a45a4): the public site's
-- default view was silently filtering to market_status='available' only
-- (see listings.html's currentAvailOnly). That client-side bug is fixed,
-- but it means production has likely never had its market_status
-- distribution actually reviewed by a human -- this report is that review.
--
-- Usage:
--   psql "<connection string>" -f scripts/market-status-report.sql
--
-- What to look for: if a large share of listings sit in reserved/rented/
-- sold/fully_occupied/off_market and that does NOT match what staff
-- believe is actually true (i.e. most inventory should be 'available'),
-- something wrote bad market_status values independently of this
-- incident -- that would be a second, separate bug to chase (check
-- 20260729000000_listing_status_model.sql's backfill logic and anything
-- that calls the admin.html status editor in bulk).

-- ── 1. Overall distribution ─────────────────────────────────────────────
-- The headline number: how many of everything currently sits in each
-- market_status, and what fraction of the whole that is.
SELECT
  market_status,
  count(*) AS total,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_all
FROM properties
GROUP BY market_status
ORDER BY total DESC;

-- ── 2. Cross-tab with workflow_status ───────────────────────────────────
-- A row can be workflow_status='draft'/'archived' independent of its
-- market_status -- this separates "not publicly listed at all" from
-- "publicly listed but marked unavailable," since only the latter is what
-- the public listings page's Available-Only filter actually hides.
SELECT
  workflow_status,
  market_status,
  count(*) AS total
FROM properties
GROUP BY workflow_status, market_status
ORDER BY workflow_status, total DESC;

-- ── 3. What the public site actually shows today ───────────────────────
-- "All Listings" (the default): every row not workflow_status='draft' --
-- matches listings.html's `?or=(status.neq.draft,status.is.null)` query filter.
-- "Available Only" (the opt-in narrower view) now follows the CANONICAL
-- availability rules (property-availability.js, PRs #136/#137): coming_soon,
-- sold and off_market are out; a single-unit property's own rented/reserved/
-- fully_occupied beats a lone open unit; a multi-unit property is in while at
-- least one unit is genuinely open; a property whose units are all closed is out
-- even though market_status says 'available'. The OLD market_status-only count is
-- shown beside it so the difference (the listings the fix moves) is visible.
WITH unit_state AS (
  SELECT ut.property_id,
    CASE WHEN ut.is_available IS FALSE THEN CASE WHEN ut.total_units IS NOT NULL THEN 'coming_soon' ELSE 'temporarily_unavailable' END
         WHEN ut.available_count > 0 THEN 'available'
         WHEN ut.next_available_date IS NOT NULL THEN 'fully_occupied'
         ELSE 'temporarily_unavailable' END AS st
  FROM unit_types ut
), prop_units AS (
  SELECT property_id, count(*) AS n_units,
         count(*) FILTER (WHERE st = 'available')   AS n_open,
         count(*) FILTER (WHERE st = 'coming_soon') AS n_soon
  FROM unit_state GROUP BY property_id
), canon AS (
  SELECT p.*, coalesce(pu.n_units, 0) AS n_units, coalesce(pu.n_open, 0) AS n_open,
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon') THEN false
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
           THEN (coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
         ELSE (coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1)
    END AS is_available,
    -- the status the site SHOWS (effectiveMarket in property-availability.js)
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon', 'reserved', 'rented', 'fully_occupied')
              AND NOT (coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
                       AND coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
           THEN p.market_status
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied') THEN 'available'
         WHEN coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1 THEN 'available'
         WHEN pu.n_soon = pu.n_units THEN 'coming_soon'
         ELSE 'fully_occupied' END AS effective_market
  FROM properties p
  LEFT JOIN prop_units pu ON pu.property_id = p.id
)
SELECT
  count(*) FILTER (WHERE status IS DISTINCT FROM 'draft') AS all_listings_view_count,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'draft' AND is_available) AS available_only_view_count,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'draft'
      AND (market_status IS NULL OR market_status NOT IN ('reserved','rented','sold','fully_occupied','off_market'))) AS available_only_old_market_status_only,
  count(*) AS total_rows_in_table
FROM canon;

-- ── 4. Sample of unavailable listings, newest first ─────────────────────
-- A quick human-readable spot check: do these 25 actually look like real
-- rented/sold/reserved properties, or does something look off (e.g. a
-- freshly created listing already marked 'sold')?
SELECT
  id, slug, title_en, property_type, transaction_type,
  workflow_status, market_status, market_status_changed_at,
  created_at, updated_at
FROM properties
WHERE market_status IN ('reserved','rented','sold','fully_occupied','off_market')
ORDER BY created_at DESC
LIMIT 25;

-- ── 5. Suspicious pattern: marked unavailable very close to creation ────
-- A listing marked sold/rented within hours of being created is much more
-- likely to be a data-entry defect (wrong default, bulk-edit mistake) than
-- a real, fast transaction. market_status_changed_at is NULL for any row
-- that has never had a real, trigger-recorded transition (see
-- 20260801000000_market_status_transition_tracking.sql) -- those rows are
-- excluded here since there's no real timestamp to compare against; they
-- still show up in section 4 above.
SELECT
  id, slug, title_en, market_status,
  created_at, market_status_changed_at,
  extract(epoch FROM (market_status_changed_at - created_at)) / 3600.0 AS hours_to_unavailable
FROM properties
WHERE market_status IN ('reserved','rented','sold','fully_occupied','off_market')
  AND market_status_changed_at IS NOT NULL
  AND market_status_changed_at < created_at + interval '24 hours'
ORDER BY hours_to_unavailable ASC;

-- ── 6. Canonical availability vs the stored market_status ───────────────
-- One row per (stored market_status -> status the site now SHOWS). Rows where the two differ are the listings whose
-- public presentation follows their unit rows (or the single-unit / coming_soon rules) instead of the dropdown.
WITH unit_state AS (
  SELECT ut.property_id,
    CASE WHEN ut.is_available IS FALSE THEN CASE WHEN ut.total_units IS NOT NULL THEN 'coming_soon' ELSE 'temporarily_unavailable' END
         WHEN ut.available_count > 0 THEN 'available'
         WHEN ut.next_available_date IS NOT NULL THEN 'fully_occupied'
         ELSE 'temporarily_unavailable' END AS st
  FROM unit_types ut
), prop_units AS (
  SELECT property_id, count(*) AS n_units,
         count(*) FILTER (WHERE st = 'available')   AS n_open,
         count(*) FILTER (WHERE st = 'coming_soon') AS n_soon
  FROM unit_state GROUP BY property_id
), canon AS (
  SELECT p.*, coalesce(pu.n_units, 0) AS n_units, coalesce(pu.n_open, 0) AS n_open,
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon') THEN false
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
           THEN (coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
         ELSE (coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1)
    END AS is_available,
    -- the status the site SHOWS (effectiveMarket in property-availability.js)
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon', 'reserved', 'rented', 'fully_occupied')
              AND NOT (coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
                       AND coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
           THEN p.market_status
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied') THEN 'available'
         WHEN coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1 THEN 'available'
         WHEN pu.n_soon = pu.n_units THEN 'coming_soon'
         ELSE 'fully_occupied' END AS effective_market
  FROM properties p
  LEFT JOIN prop_units pu ON pu.property_id = p.id
)
SELECT market_status AS stored_market_status, effective_market AS shown_market_status, is_available AS contactable,
       count(*) AS listings
FROM canon
WHERE workflow_status = 'active'
GROUP BY 1, 2, 3
ORDER BY (market_status = effective_market), listings DESC;

-- ── 7. Inconsistencies between market_status and unit availability ─────
-- Counts per class (active listings). These are what the admin editor now warns about. READ-ONLY: nothing is changed.
WITH unit_state AS (
  SELECT ut.property_id,
    CASE WHEN ut.is_available IS FALSE THEN CASE WHEN ut.total_units IS NOT NULL THEN 'coming_soon' ELSE 'temporarily_unavailable' END
         WHEN ut.available_count > 0 THEN 'available'
         WHEN ut.next_available_date IS NOT NULL THEN 'fully_occupied'
         ELSE 'temporarily_unavailable' END AS st
  FROM unit_types ut
), prop_units AS (
  SELECT property_id, count(*) AS n_units,
         count(*) FILTER (WHERE st = 'available')   AS n_open,
         count(*) FILTER (WHERE st = 'coming_soon') AS n_soon
  FROM unit_state GROUP BY property_id
), canon AS (
  SELECT p.*, coalesce(pu.n_units, 0) AS n_units, coalesce(pu.n_open, 0) AS n_open,
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon') THEN false
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
           THEN (coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
         ELSE (coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1)
    END AS is_available,
    -- the status the site SHOWS (effectiveMarket in property-availability.js)
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon', 'reserved', 'rented', 'fully_occupied')
              AND NOT (coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
                       AND coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
           THEN p.market_status
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied') THEN 'available'
         WHEN coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1 THEN 'available'
         WHEN pu.n_soon = pu.n_units THEN 'coming_soon'
         ELSE 'fully_occupied' END AS effective_market
  FROM properties p
  LEFT JOIN prop_units pu ON pu.property_id = p.id
)
, cls AS (
  SELECT 'A1 market_status=available but the unit rows say none is open (shown as Fully Occupied / Coming Soon)' AS anomaly, id FROM canon WHERE workflow_status = 'active' AND market_status = 'available' AND n_units > 0 AND n_open = 0
  UNION ALL SELECT 'A2 single-unit: rented/reserved/fully_occupied but its lone unit is open (the property status wins)', id FROM canon WHERE workflow_status = 'active' AND market_status IN ('reserved','rented','fully_occupied') AND n_units = 1 AND n_open = 1
  UNION ALL SELECT 'A3 multi-unit: rented/reserved/fully_occupied but >=1 unit is open (shown as available)', id FROM canon WHERE workflow_status = 'active' AND market_status IN ('reserved','rented','fully_occupied') AND n_units >= 2 AND n_open >= 1
  UNION ALL SELECT 'A4 sold/off_market but a unit is open (not contactable)', id FROM canon WHERE workflow_status = 'active' AND market_status IN ('sold','off_market') AND n_open >= 1
  UNION ALL SELECT 'A5 coming_soon (any)', id FROM canon WHERE workflow_status = 'active' AND market_status = 'coming_soon'
  UNION ALL SELECT 'A6 coming_soon with open units (not contactable)', id FROM canon WHERE workflow_status = 'active' AND market_status = 'coming_soon' AND n_open >= 1
  UNION ALL SELECT 'A7 multi-unit with >=1 open and >=1 closed unit (normal: unit-level availability)', id FROM canon WHERE workflow_status = 'active' AND n_units >= 2 AND n_open >= 1 AND n_open < n_units
  UNION ALL SELECT 'A8 multi-unit, no unit open', id FROM canon WHERE workflow_status = 'active' AND n_units >= 2 AND n_open = 0
)
SELECT anomaly, count(*) AS listings FROM cls GROUP BY anomaly ORDER BY anomaly;

-- ── 8. Detail for the contradictory classes (A1-A4, A6), up to 200 rows ─
WITH unit_state AS (
  SELECT ut.property_id,
    CASE WHEN ut.is_available IS FALSE THEN CASE WHEN ut.total_units IS NOT NULL THEN 'coming_soon' ELSE 'temporarily_unavailable' END
         WHEN ut.available_count > 0 THEN 'available'
         WHEN ut.next_available_date IS NOT NULL THEN 'fully_occupied'
         ELSE 'temporarily_unavailable' END AS st
  FROM unit_types ut
), prop_units AS (
  SELECT property_id, count(*) AS n_units,
         count(*) FILTER (WHERE st = 'available')   AS n_open,
         count(*) FILTER (WHERE st = 'coming_soon') AS n_soon
  FROM unit_state GROUP BY property_id
), canon AS (
  SELECT p.*, coalesce(pu.n_units, 0) AS n_units, coalesce(pu.n_open, 0) AS n_open,
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon') THEN false
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
           THEN (coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
         ELSE (coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1)
    END AS is_available,
    -- the status the site SHOWS (effectiveMarket in property-availability.js)
    CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon', 'reserved', 'rented', 'fully_occupied')
              AND NOT (coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
                       AND coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
           THEN p.market_status
         WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied') THEN 'available'
         WHEN coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1 THEN 'available'
         WHEN pu.n_soon = pu.n_units THEN 'coming_soon'
         ELSE 'fully_occupied' END AS effective_market
  FROM properties p
  LEFT JOIN prop_units pu ON pu.property_id = p.id
)
SELECT slug, title_en, transaction_type, market_status AS stored, effective_market AS shown, n_units, n_open,
  CASE WHEN market_status = 'available' AND n_units > 0 AND n_open = 0 THEN 'A1'
       WHEN market_status IN ('reserved','rented','fully_occupied') AND n_units = 1 AND n_open = 1 THEN 'A2'
       WHEN market_status IN ('reserved','rented','fully_occupied') AND n_units >= 2 AND n_open >= 1 THEN 'A3'
       WHEN market_status IN ('sold','off_market') AND n_open >= 1 THEN 'A4'
       WHEN market_status = 'coming_soon' AND n_open >= 1 THEN 'A6' END AS class
FROM canon
WHERE workflow_status = 'active'
  AND ((market_status = 'available' AND n_units > 0 AND n_open = 0)
    OR (market_status IN ('reserved','rented','fully_occupied') AND n_open >= 1)
    OR (market_status IN ('sold','off_market') AND n_open >= 1)
    OR (market_status = 'coming_soon' AND n_open >= 1))
ORDER BY class, slug
LIMIT 200;
