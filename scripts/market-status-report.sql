-- market-status-report.sql — READ-ONLY. Does not modify any data.
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

-- ── 3. What the public site actually shows today ────────────────────────
-- "All Listings" (the new, correct default): every row not workflow_status
-- ='draft' -- matches listings.html's `?or=(status.neq.draft,status.is.null)`
-- query filter exactly.
-- "Available Only" (the opt-in narrower view): same, further restricted to
-- the market_status values isPubliclyAvailable() in listing-status.js
-- treats as available.
SELECT
  count(*) FILTER (
    WHERE (status IS DISTINCT FROM 'draft')
  ) AS all_listings_view_count,
  count(*) FILTER (
    WHERE (status IS DISTINCT FROM 'draft')
      AND (market_status IS NULL OR market_status NOT IN
        ('reserved','rented','sold','fully_occupied','off_market'))
  ) AS available_only_view_count,
  count(*) AS total_rows_in_table
FROM properties;

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
