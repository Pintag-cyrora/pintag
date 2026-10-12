-- Intelligence: canonical availability in the supply snapshot.
--
-- Replaces point_in_time_supply_snapshot() (CREATE OR REPLACE; same signature, same owner, same ACL -- the
-- REVOKEs from 20260921010000 are preserved by CREATE OR REPLACE) so the "genuinely bookable" supply keys follow the
-- canonical availability rules the site shipped in PRs #136/#137 (property-availability.js), instead of
-- `market_status = 'available'` alone:
--
--   available_by_segment / available_by_bedroom_segment / available_unit_types
--
-- BEFORE: a property counted as bookable supply when market_status = 'available' AND workflow_status = 'active',
--   so (a) a building whose every unit is closed still counted as available supply, (b) a multi-unit property
--   whose market_status was left on rented/reserved/fully_occupied but which has an open unit was dropped, and
--   (c) unit types were counted only under market_status = 'available' parents.
-- AFTER (the rules, identical to property-availability.js):
--   * sold / off_market / coming_soon                      not supply, whatever the unit rows say
--   * reserved / rented / fully_occupied                   not supply, EXCEPT a multi-unit property (>= 2 unit
--                                                          types) with at least one open unit
--   * available (or unset)                                 supply unless it has unit rows and none is open
--   * a unit is open only if is_available AND available_count > 0 (next_available_date never opens a unit)
--   * available_unit_types = open units of a property that is supply
-- Draft / archived (workflow_status <> 'active') stay excluded, exactly as before.
--
-- NOT changed (byte-identical to 20260922000000): the `active` population and everything derived from it
-- (total, by_property_type, by_district, by_segment, asking_price). Those answer "how much inventory exists on the
-- site", not "what can a customer book", so they keep the legacy `status` filter on purpose.
--
-- The rules live ONCE here as inline CTEs (no new function, view or table: a new object in public would inherit the
-- project's default grants, and this stays a pure replacement of an existing, locked-down function). They are pinned
-- to the browser resolver by tests/security/regression/run-availability-canonical-pg.sh, which generates every
-- market_status x unit-configuration state from property-availability.js and compares this function's output.
--
-- Read-only; no schema change; not applied by the repository's migration workflow (manual apply, like
-- 20261008000000 / 20261009000000). ROLLBACK: re-run 20260922000000_intelligence_unit_type_demand.sql (its
-- CREATE OR REPLACE restores the previous body).

BEGIN;

CREATE OR REPLACE FUNCTION point_in_time_supply_snapshot()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH active AS (
    SELECT property_type, district_en, transaction_type,
      NULLIF(regexp_replace(coalesce(price_display, ''), '[^0-9.]', '', 'g'), '') AS price_text
    FROM properties
    WHERE status IN ('active', 'available')
  ),
  by_type AS (
    SELECT jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT property_type, count(*) AS cnt FROM active WHERE property_type IS NOT NULL GROUP BY property_type
    ) x
  ),
  by_district AS (
    SELECT jsonb_object_agg(district_en, cnt) AS obj FROM (
      SELECT district_en, count(*) AS cnt FROM active WHERE district_en IS NOT NULL GROUP BY district_en
    ) x
  ),
  by_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || property_type || '|' || district_en AS seg_key, count(*) AS cnt
      FROM active
      WHERE transaction_type IS NOT NULL AND property_type IS NOT NULL AND district_en IS NOT NULL
      GROUP BY 1
    ) x
  ),
  priced AS (
    SELECT transaction_type, price_text::numeric AS price
    FROM active
    WHERE price_text IS NOT NULL
      AND price_text ~ '^[0-9]+(\.[0-9]+)?$'
      AND transaction_type IN ('for_sale', 'for_rent')
  ),
  price_stats AS (
    SELECT transaction_type,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median,
      avg(price) AS avg,
      count(*) AS n
    FROM priced GROUP BY transaction_type
  ),
  -- ── CANONICAL AVAILABILITY (a SQL port of property-availability.js) ──────────────────────────────────
  -- unit_state mirrors resolveUnitAvailability() (unit-availability.js): a unit is open only when it is flagged
  -- available AND available_count > 0; a date (next_available_date) only labels a closed unit, it never opens one.
  unit_state AS (
    SELECT ut.id, ut.property_id, ut.available_count,
      CASE WHEN ut.is_available IS FALSE THEN CASE WHEN ut.total_units IS NOT NULL THEN 'coming_soon' ELSE 'temporarily_unavailable' END
           WHEN ut.available_count > 0 THEN 'available'
           WHEN ut.next_available_date IS NOT NULL THEN 'fully_occupied'
           ELSE 'temporarily_unavailable' END AS st
    FROM unit_types ut
  ),
  prop_units AS (
    SELECT property_id, count(*) AS n_units, count(*) FILTER (WHERE st = 'available') AS n_open
    FROM unit_state GROUP BY property_id
  ),
  -- resolvePropertyAvailability(): sold / off_market / coming_soon are unavailable whatever the units say; a
  -- reserved / rented / fully_occupied property is unavailable unless it is MULTI-unit (>= 2 unit types) with an open
  -- unit (a single-unit property's own status wins over a lone open unit row); otherwise (available / unset) a
  -- property is available when it has no unit rows or at least one open unit.
  canon AS (
    SELECT p.id, p.property_type, p.district_en, p.transaction_type, p.bedrooms,
      CASE WHEN coalesce(p.market_status, 'available') IN ('sold', 'off_market', 'coming_soon') THEN false
           WHEN coalesce(p.market_status, 'available') IN ('reserved', 'rented', 'fully_occupied')
             THEN (coalesce(pu.n_units, 0) >= 2 AND coalesce(pu.n_open, 0) >= 1)
           ELSE (coalesce(pu.n_units, 0) = 0 OR coalesce(pu.n_open, 0) >= 1)
      END AS is_available
    FROM properties p
    LEFT JOIN prop_units pu ON pu.property_id = p.id
    WHERE p.workflow_status = 'active'
  ),
  available AS (
    SELECT property_type, district_en, transaction_type, bedrooms
    FROM canon
    WHERE is_available
  ),
  available_by_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || property_type || '|' || district_en AS seg_key, count(*) AS cnt
      FROM available
      WHERE transaction_type IS NOT NULL AND property_type IS NOT NULL AND district_en IS NOT NULL
      GROUP BY 1
    ) x
  ),
  bedroom_bucketed AS (
    SELECT transaction_type, district_en,
      CASE WHEN bedrooms >= 4 THEN '4+' ELSE bedrooms::text END AS bedroom_bucket
    FROM available
    WHERE bedrooms IS NOT NULL AND bedrooms >= 0
      AND transaction_type IS NOT NULL AND district_en IS NOT NULL
  ),
  available_by_bedroom_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || district_en || '|' || bedroom_bucket AS seg_key, count(*) AS cnt
      FROM bedroom_bucketed
      GROUP BY 1
    ) x
  ),
  -- Unit-type-level supply: each unit_types row IS its own segment, keyed
  -- by id (a plain uuid, not a composite string -- unlike by_segment there
  -- is no coarser bucketing to do, since this already identifies one exact
  -- row). "Available" means BOTH the unit type itself is open (is_available
  -- AND available_count > 0) AND its parent property is available under the
  -- canonical rules above -- so a lone open unit of a rented / reserved /
  -- fully_occupied single-unit property is NOT supply, while an open unit of a
  -- multi-unit property whose market_status is stale is.
  available_unit_types AS (
    SELECT jsonb_object_agg(us.id::text, us.available_count) AS obj
    FROM unit_state us
    JOIN canon c ON c.id = us.property_id
    WHERE us.st = 'available'
      AND c.is_available
  )
  SELECT jsonb_build_object(
    'active_inventory', jsonb_build_object(
      'total', (SELECT count(*) FROM active),
      'by_property_type', coalesce((SELECT obj FROM by_type), '{}'::jsonb),
      'by_district', coalesce((SELECT obj FROM by_district), '{}'::jsonb),
      'by_segment', coalesce((SELECT obj FROM by_segment), '{}'::jsonb),
      'available_by_segment', coalesce((SELECT obj FROM available_by_segment), '{}'::jsonb),
      'available_by_bedroom_segment', coalesce((SELECT obj FROM available_by_bedroom_segment), '{}'::jsonb),
      'available_unit_types', coalesce((SELECT obj FROM available_unit_types), '{}'::jsonb)
    ),
    'asking_price', coalesce((
      SELECT jsonb_object_agg(transaction_type, jsonb_build_object(
        'median', round(median::numeric, 0), 'avg', round(avg::numeric, 0), 'count', n
      ))
      FROM price_stats
    ), '{}'::jsonb)
  );
$$;

COMMENT ON FUNCTION point_in_time_supply_snapshot IS
  'Current-state read (active inventory + asking price percentiles + per-segment and per-unit-type inventory), not a time series. Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot(). available_by_segment / available_by_bedroom_segment / available_unit_types use the CANONICAL availability rules (property-availability.js ported to SQL): sold/off_market/coming_soon never; reserved/rented/fully_occupied only for a multi-unit property with an open unit; available only if it has no unit rows or an open unit; a unit is open when is_available AND available_count > 0. available_unit_types is keyed by unit_types.id (text) -> available_count.';

COMMIT;
