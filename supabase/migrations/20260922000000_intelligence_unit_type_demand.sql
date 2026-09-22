-- Intelligence: Unit-Type Demand. Extends the Metrics Engine so unit-type-
-- level demand (inquiries/WhatsApp clicks/leads for a SPECIFIC unit_types
-- row, not just the property it belongs to) can be analyzed, using the
-- unit_type_id/unit_id attribution PR #104 already threads through
-- lead_events -> leads (20260921000000_lead_unit_attribution.sql). Adds no
-- new table; extends intelligence_daily_metrics() and
-- point_in_time_supply_snapshot() only, following the exact same additive
-- pattern as 20260905000000_intelligence_customer_intent.sql and
-- 20260920000000_intelligence_demand_supply_gap.sql.
--
-- WHY A UNIT TYPE IS ITS OWN "SEGMENT" (unlike customer_intent_segments'
-- (transaction_type, property_type, district) bucket). customer_intent_
-- segments exists to compare DEMAND (from search_events, which has no
-- listing/unit-type identity at all) against SUPPLY across a whole market
-- slice, because a search is never about one specific property. A unit-type
-- inquiry is the opposite: the buyer clicked WhatsApp/Call FROM one specific
-- unit_types row (or a lead was created against it), so the natural
-- granularity is the unit_types row itself, not a market-wide bucket -- e.g.
-- the product spec's own worked example is "2-bedroom Room Type A units in
-- THIS PROPERTY", not "2-bedroom units across Sisattanak". Matching supply
-- is therefore also that exact row's own is_available/available_count, not
-- a market-wide count -- far simpler than customer_intent_segments'
-- by_segment/by_bedroom_segment machinery, and nothing to invent: unit_types
-- already carries its own supply figures (20260720000000_unit_types.sql).
--
-- PROPERTY-LEVEL LEADS STAY OUT, STRUCTURALLY, FOR FREE. Every query below
-- filters WHERE unit_type_id IS NOT NULL. A property-level CTA has always
-- produced unit_type_id: null (PR #104, by construction -- ptContactClick()
-- is only ever passed a unitTypeId when a unit card/selector was actually
-- involved), so this filter is not a heuristic guess at intent; it is
-- reading the exact same attribution flag PR #104 already guarantees is
-- correct. Nothing here infers a unit type for a property-level contact.
--
-- DELETED UNIT TYPE NEVER BREAKS THIS. unit_type_id is
-- REFERENCES unit_types(id) ON DELETE SET NULL (PR #104) -- once a unit
-- type is deleted, every lead_events/leads row that referenced it
-- (historical included) reverts to unit_type_id = NULL and simply stops
-- appearing in these aggregates from that point on, the same "undercount,
-- never crash" discipline every other join in this pipeline already
-- follows for a deleted property (see customer_intent_segments' own header).
-- This migration adds no new failure mode for that case.
--
-- CURRENT NAME/BEDROOMS/PRICE, NEVER A STORED SNAPSHOT. Both new blocks join
-- LIVE to unit_types (and properties, for district/transaction_type) at
-- query time -- identical to how intelligence_daily_metrics()'s existing
-- top_listings_by_views/ctr_by_property already join LIVE to properties for
-- a listing's current title. Renaming a unit type in admin.html changes
-- what a past day's demand row displays immediately, with zero write to
-- any historical row -- exactly the invariant dashboard.html's
-- resolveLeadUnitSummary() already relies on for the same reason.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. point_in_time_supply_snapshot() — add active_inventory.available_unit_types
-- ═══════════════════════════════════════════════════════════════════════
-- Same point-in-time contract as available_by_segment/
-- available_by_bedroom_segment (20260920000000): merged into
-- daily_metrics_snapshot only for the single most-recently-finalized day by
-- the EXISTING ensure_daily_metrics_snapshot(), which already copies the
-- WHOLE active_inventory object wholesale -- adding a key here needs no
-- change there. Filtered on the PARENT property's market_status='available'
-- AND workflow_status='active' (genuinely bookable), exactly like
-- available_by_segment, so a unit type on a sold/archived/draft listing is
-- never counted as real supply.
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
  available AS (
    SELECT property_type, district_en, transaction_type, bedrooms
    FROM properties
    WHERE market_status = 'available' AND workflow_status = 'active'
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
  -- row). "Available" means BOTH the unit type itself
  -- (is_available AND available_count > 0) AND its parent property is
  -- genuinely bookable, same population as available/available_by_segment.
  available_unit_types AS (
    SELECT jsonb_object_agg(ut.id::text, ut.available_count) AS obj
    FROM unit_types ut
    JOIN properties p ON p.id = ut.property_id
    WHERE ut.is_available
      AND ut.available_count > 0
      AND p.market_status = 'available'
      AND p.workflow_status = 'active'
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
  'Current-state read (active inventory + asking price percentiles + per-segment and per-unit-type inventory), not a time series. Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot(). available_unit_types is keyed by unit_types.id (text) -> available_count, filtered to unit types whose parent property is genuinely bookable (market_status=available AND workflow_status=active) AND which are themselves marked available with available_count > 0.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. intelligence_daily_metrics() — add unit_type_demand_segments
-- ═══════════════════════════════════════════════════════════════════════
-- Same contract as every existing field: pure, safely re-callable for any
-- historical range, zero judgment. One row per unit_types.id that had at
-- least one whatsapp_click/call_click/lead that day.
CREATE OR REPLACE FUNCTION intelligence_daily_metrics(p_start date, p_end date)
RETURNS TABLE(day date, metrics jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH days AS (
    SELECT generate_series(p_start, p_end, interval '1 day')::date AS d
  ),

  -- ── search_events ─────────────────────────────────────────────────────
  search_totals AS (
    SELECT created_at::date AS d,
      count(*) AS total,
      count(*) FILTER (WHERE result_count = 0) AS zero_result
    FROM search_events
    WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  search_by_district AS (
    SELECT d, jsonb_object_agg(district, cnt) AS obj FROM (
      SELECT created_at::date AS d, district, count(*) AS cnt
      FROM search_events
      WHERE created_at::date BETWEEN p_start AND p_end AND district IS NOT NULL
      GROUP BY 1, district
    ) x GROUP BY d
  ),
  search_by_type AS (
    SELECT d, jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT created_at::date AS d, property_type, count(*) AS cnt
      FROM search_events
      WHERE created_at::date BETWEEN p_start AND p_end AND property_type IS NOT NULL
      GROUP BY 1, property_type
    ) x GROUP BY d
  ),
  search_by_tx AS (
    SELECT d, jsonb_object_agg(transaction_type, cnt) AS obj FROM (
      SELECT created_at::date AS d, transaction_type, count(*) AS cnt
      FROM search_events
      WHERE created_at::date BETWEEN p_start AND p_end AND transaction_type IS NOT NULL
      GROUP BY 1, transaction_type
    ) x GROUP BY d
  ),
  most_searched_district AS (
    SELECT DISTINCT ON (d) d, key AS district
    FROM search_by_district, jsonb_each_text(obj)
    ORDER BY d, value::int DESC
  ),

  -- ── listing_events ────────────────────────────────────────────────────
  listing_totals AS (
    SELECT created_at::date AS d,
      count(*) FILTER (WHERE event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE event_type = 'click')      AS clicks,
      count(*) FILTER (WHERE event_type = 'view')        AS views
    FROM listing_events
    WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  views_by_district AS (
    SELECT d, jsonb_object_agg(district_en, cnt) AS obj FROM (
      SELECT le.created_at::date AS d, p.district_en, count(*) AS cnt
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE le.created_at::date BETWEEN p_start AND p_end AND le.event_type = 'view' AND p.district_en IS NOT NULL
      GROUP BY 1, p.district_en
    ) x GROUP BY d
  ),
  views_by_type AS (
    SELECT d, jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT le.created_at::date AS d, p.property_type, count(*) AS cnt
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE le.created_at::date BETWEEN p_start AND p_end AND le.event_type = 'view' AND p.property_type IS NOT NULL
      GROUP BY 1, p.property_type
    ) x GROUP BY d
  ),

  -- ── lead_events / leads ───────────────────────────────────────────────
  lead_event_totals AS (
    SELECT created_at::date AS d,
      count(*) FILTER (WHERE event_type = 'whatsapp_click') AS whatsapp_clicks,
      count(*) FILTER (WHERE event_type = 'call_click')      AS call_clicks
    FROM lead_events
    WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_created_totals AS (
    SELECT created_at::date AS d, count(*) AS n
    FROM leads WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_closed_totals AS (
    SELECT updated_at::date AS d, count(*) AS n
    FROM leads WHERE status = 'closed' AND updated_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_lost_totals AS (
    SELECT updated_at::date AS d, count(*) AS n
    FROM leads WHERE status = 'lost' AND updated_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),

  -- ── ui_events ─────────────────────────────────────────────────────────
  ui_totals AS (
    SELECT created_at::date AS d,
      count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS sessions_total,
      count(*) FILTER (WHERE element_id LIKE 'gallery-%')  AS gallery_events,
      count(*) FILTER (WHERE element_id = 'share-property') AS share_events,
      count(*) FILTER (WHERE element_id = 'favorite-property') AS favorite_events,
      count(*) FILTER (WHERE element_id IN ('map-open-link','map-embed','view-toggle-map')) AS map_events
    FROM ui_events
    WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  filter_usage AS (
    SELECT d, jsonb_object_agg(element_id, cnt) AS obj FROM (
      SELECT created_at::date AS d, element_id, count(*) AS cnt
      FROM ui_events
      WHERE created_at::date BETWEEN p_start AND p_end AND element_type IN ('filter','select','toggle')
      GROUP BY 1, element_id
    ) x GROUP BY d
  ),
  ui_element_counts AS (
    SELECT d, jsonb_object_agg(element_id, cnt) AS obj FROM (
      SELECT created_at::date AS d, element_id, count(*) AS cnt
      FROM ui_events
      WHERE created_at::date BETWEEN p_start AND p_end
      GROUP BY 1, element_id
    ) x GROUP BY d
  ),

  -- ── property performance leaderboards ────────────────────────────────
  top_by_views AS (
    SELECT d, jsonb_agg(row ORDER BY (row->>'views')::int DESC) AS arr FROM (
      SELECT le.created_at::date AS d,
        jsonb_build_object('property_id', p.id, 'title', coalesce(p.title_en, p.title_lo), 'views', count(*)) AS row
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE le.created_at::date BETWEEN p_start AND p_end AND le.event_type = 'view'
      GROUP BY le.created_at::date, p.id, p.title_en, p.title_lo
    ) x GROUP BY d
  ),
  most_viewed_listing AS (
    SELECT d, arr->0 AS listing FROM top_by_views
  ),
  ctr_by_property AS (
    SELECT le.created_at::date AS d, p.id, coalesce(p.title_en, p.title_lo) AS title,
      count(*) FILTER (WHERE le.event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE le.event_type = 'click')      AS clicks
    FROM listing_events le JOIN properties p ON p.id = le.property_id
    WHERE le.created_at::date BETWEEN p_start AND p_end AND le.event_type IN ('impression','click')
    GROUP BY 1, p.id, title
  ),
  top_by_ctr AS (
    SELECT d, jsonb_agg(row ORDER BY (row->>'ctr')::numeric DESC) AS arr FROM (
      SELECT d,
        jsonb_build_object('property_id', id, 'title', title, 'impressions', impressions,
                            'clicks', clicks, 'ctr', round(clicks::numeric / impressions, 3)) AS row
      FROM ctr_by_property WHERE impressions >= 5
    ) x GROUP BY d
  ),
  impressions_no_leads AS (
    SELECT cp.d,
      jsonb_agg(jsonb_build_object('property_id', cp.id, 'title', cp.title, 'impressions', cp.impressions)) AS arr
    FROM ctr_by_property cp
    WHERE cp.impressions >= 5
      AND NOT EXISTS (
        SELECT 1 FROM lead_events le
        WHERE le.listing_id = cp.id AND le.created_at::date = cp.d
      )
    GROUP BY cp.d
  ),

  -- ── new BI facts: listing lifecycle + market-velocity ──────────────────
  new_listings AS (
    SELECT created_at::date AS d, count(*) AS n
    FROM properties WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  removed_listings AS (
    SELECT removed_at::date AS d, count(*) AS n
    FROM properties_removal_log WHERE removed_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  days_on_market_totals AS (
    SELECT status_changed_at::date AS d,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(day FROM status_changed_at - created_at)) AS median_days,
      avg(EXTRACT(day FROM status_changed_at - created_at)) AS avg_days,
      count(*) AS n
    FROM properties
    WHERE status IN ('sold', 'rented')
      AND status_changed_at IS NOT NULL
      AND status_changed_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),

  -- ── Intelligence V2: Customer Intent segments ──────────────────────────
  seg_search AS (
    SELECT created_at::date AS d, transaction_type, property_type, district,
      count(*) AS search_count,
      round(avg(result_count)::numeric, 1) AS avg_result_count,
      count(*) FILTER (WHERE result_count = 0) AS zero_result_count
    FROM search_events
    WHERE created_at::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_price_counts AS (
    SELECT created_at::date AS d, transaction_type, property_type, district, price_min, price_max, count(*) AS cnt
    FROM search_events
    WHERE created_at::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6
  ),
  seg_top_price AS (
    SELECT DISTINCT ON (d, transaction_type, property_type, district)
      d, transaction_type, property_type, district, price_min, price_max
    FROM seg_price_counts
    ORDER BY d, transaction_type, property_type, district, cnt DESC
  ),
  seg_bedroom_counts AS (
    SELECT created_at::date AS d, transaction_type, property_type, district, bedrooms, count(*) AS cnt
    FROM search_events
    WHERE created_at::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
  ),
  seg_top_bedroom AS (
    SELECT DISTINCT ON (d, transaction_type, property_type, district)
      d, transaction_type, property_type, district, bedrooms AS top_bedroom_count
    FROM seg_bedroom_counts
    ORDER BY d, transaction_type, property_type, district, cnt DESC
  ),
  seg_bedroom_sample AS (
    SELECT created_at::date AS d, transaction_type, property_type, district, count(*) AS bedroom_sample_size
    FROM search_events
    WHERE created_at::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
      AND bedrooms IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_engagement AS (
    SELECT le.created_at::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) FILTER (WHERE le.event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE le.event_type = 'click')      AS clicks
    FROM listing_events le JOIN properties p ON p.id = le.property_id
    WHERE le.created_at::date BETWEEN p_start AND p_end
      AND le.event_type IN ('impression', 'click')
      AND p.transaction_type IS NOT NULL AND p.property_type IS NOT NULL AND p.district_en IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_leads_clicked AS (
    SELECT le.created_at::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) FILTER (WHERE le.event_type = 'whatsapp_click') AS whatsapp_clicks,
      count(*) FILTER (WHERE le.event_type = 'call_click')      AS call_clicks
    FROM lead_events le JOIN properties p ON p.id = le.listing_id
    WHERE le.created_at::date BETWEEN p_start AND p_end
      AND p.transaction_type IS NOT NULL AND p.property_type IS NOT NULL AND p.district_en IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_leads_created AS (
    SELECT l.created_at::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) AS leads_created
    FROM leads l JOIN properties p ON p.id = l.property_id
    WHERE l.created_at::date BETWEEN p_start AND p_end
      AND p.transaction_type IS NOT NULL AND p.property_type IS NOT NULL AND p.district_en IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_keys AS (
    SELECT d, transaction_type, property_type, district FROM seg_search
    UNION
    SELECT d, transaction_type, property_type, district FROM seg_engagement
    UNION
    SELECT d, transaction_type, property_type, district FROM seg_leads_clicked
    UNION
    SELECT d, transaction_type, property_type, district FROM seg_leads_created
  ),
  seg_combined AS (
    SELECT k.d, k.transaction_type, k.property_type, k.district,
      coalesce(ss.search_count, 0) AS search_count,
      ss.avg_result_count,
      coalesce(ss.zero_result_count, 0) AS zero_result_count,
      tp.price_min, tp.price_max,
      tb.top_bedroom_count,
      coalesce(tbs.bedroom_sample_size, 0) AS bedroom_sample_size,
      coalesce(se.impressions, 0) AS impressions,
      coalesce(se.clicks, 0) AS clicks,
      coalesce(slc.whatsapp_clicks, 0) AS whatsapp_clicks,
      coalesce(slc.call_clicks, 0) AS call_clicks,
      coalesce(slcr.leads_created, 0) AS leads_created
    FROM seg_keys k
    LEFT JOIN seg_search ss   ON ss.d = k.d  AND ss.transaction_type = k.transaction_type  AND ss.property_type = k.property_type  AND ss.district = k.district
    LEFT JOIN seg_top_price tp ON tp.d = k.d AND tp.transaction_type = k.transaction_type  AND tp.property_type = k.property_type  AND tp.district = k.district
    LEFT JOIN seg_top_bedroom tb ON tb.d = k.d AND tb.transaction_type = k.transaction_type AND tb.property_type = k.property_type AND tb.district = k.district
    LEFT JOIN seg_bedroom_sample tbs ON tbs.d = k.d AND tbs.transaction_type = k.transaction_type AND tbs.property_type = k.property_type AND tbs.district = k.district
    LEFT JOIN seg_engagement se ON se.d = k.d AND se.transaction_type = k.transaction_type AND se.property_type = k.property_type AND se.district = k.district
    LEFT JOIN seg_leads_clicked slc ON slc.d = k.d AND slc.transaction_type = k.transaction_type AND slc.property_type = k.property_type AND slc.district = k.district
    LEFT JOIN seg_leads_created slcr ON slcr.d = k.d AND slcr.transaction_type = k.transaction_type AND slcr.property_type = k.property_type AND slcr.district = k.district
  ),
  seg_json AS (
    SELECT d, jsonb_agg(
      jsonb_build_object(
        'transaction_type', transaction_type, 'property_type', property_type, 'district', district,
        'search_count', search_count, 'avg_result_count', avg_result_count, 'zero_result_count', zero_result_count,
        'top_price_band', CASE WHEN price_min IS NOT NULL OR price_max IS NOT NULL
          THEN jsonb_build_object('min', price_min, 'max', price_max) ELSE NULL END,
        'top_bedroom_count', top_bedroom_count,
        'bedroom_sample_size', bedroom_sample_size,
        'impressions', impressions, 'clicks', clicks,
        'whatsapp_clicks', whatsapp_clicks, 'call_clicks', call_clicks, 'leads_created', leads_created
      ) ORDER BY search_count DESC, impressions DESC
    ) AS arr
    FROM seg_combined
    GROUP BY d
  ),

  -- ── Intelligence V2: journey-join confidence ───────────────────────────
  journey_totals AS (
    SELECT created_at::date AS d,
      count(*) FILTER (WHERE event_type IN ('impression', 'click')) AS listing_events_total,
      count(*) FILTER (WHERE event_type IN ('impression', 'click') AND session_id IS NOT NULL) AS listing_events_with_session
    FROM listing_events
    WHERE created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  lead_session_totals AS (
    SELECT le.created_at::date AS d,
      count(*) AS lead_events_total,
      count(*) FILTER (WHERE le.session_id IS NOT NULL) AS lead_events_with_session,
      count(*) FILTER (WHERE le.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM listing_events x
        WHERE x.session_id = le.session_id AND x.event_type = 'click'
          AND x.created_at <= le.created_at
          AND x.created_at::date = le.created_at::date
      )) AS lead_events_matched_to_click
    FROM lead_events le
    WHERE le.created_at::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),

  -- ── Unit-Type Demand: per-unit_type_id inquiry/lead counts ─────────────
  -- Reads lead_events/leads WHERE unit_type_id IS NOT NULL only -- a
  -- property-level CTA (unit_type_id null, by construction, see PR #104)
  -- can never appear here, so property-level and unit-type-level demand
  -- stay structurally separate without any extra filtering logic.
  ut_lead_events AS (
    SELECT le.created_at::date AS d, le.unit_type_id,
      count(*) FILTER (WHERE le.event_type = 'whatsapp_click') AS whatsapp_clicks,
      count(*) FILTER (WHERE le.event_type = 'call_click')      AS call_clicks
    FROM lead_events le
    WHERE le.created_at::date BETWEEN p_start AND p_end
      AND le.unit_type_id IS NOT NULL
    GROUP BY 1, 2
  ),
  ut_leads_created AS (
    SELECT l.created_at::date AS d, l.unit_type_id, count(*) AS leads_created
    FROM leads l
    WHERE l.created_at::date BETWEEN p_start AND p_end
      AND l.unit_type_id IS NOT NULL
    GROUP BY 1, 2
  ),
  ut_keys AS (
    SELECT d, unit_type_id FROM ut_lead_events
    UNION
    SELECT d, unit_type_id FROM ut_leads_created
  ),
  -- Live join for CURRENT descriptive context (name/bedrooms/price/property/
  -- district/transaction_type) -- see this migration's header for why this
  -- is safe and expected, matching top_listings_by_views' own precedent.
  -- An INNER JOIN is correct, not a LEFT JOIN: ut_keys only ever contains a
  -- unit_type_id that still resolves (a deleted unit type's rows already
  -- reverted to NULL via ON DELETE SET NULL and were excluded above).
  ut_combined AS (
    SELECT k.d, k.unit_type_id,
      ut.name_en AS unit_type_name,
      ut.bedrooms,
      ut.price_amount, ut.price_currency, ut.price_frequency,
      ut.property_id,
      p.district_en AS district,
      p.transaction_type,
      coalesce(ule.whatsapp_clicks, 0) AS whatsapp_clicks,
      coalesce(ule.call_clicks, 0) AS call_clicks,
      coalesce(ulc.leads_created, 0) AS leads_created
    FROM ut_keys k
    JOIN unit_types ut ON ut.id = k.unit_type_id
    JOIN properties p ON p.id = ut.property_id
    LEFT JOIN ut_lead_events ule ON ule.d = k.d AND ule.unit_type_id = k.unit_type_id
    LEFT JOIN ut_leads_created ulc ON ulc.d = k.d AND ulc.unit_type_id = k.unit_type_id
  ),
  ut_json AS (
    SELECT d, jsonb_agg(
      jsonb_build_object(
        'unit_type_id', unit_type_id, 'unit_type_name', unit_type_name,
        'bedrooms', bedrooms,
        'price_amount', price_amount, 'price_currency', price_currency, 'price_frequency', price_frequency,
        'property_id', property_id, 'district', district, 'transaction_type', transaction_type,
        'whatsapp_clicks', whatsapp_clicks, 'call_clicks', call_clicks, 'leads_created', leads_created
      ) ORDER BY (whatsapp_clicks + call_clicks + leads_created) DESC
    ) AS arr
    FROM ut_combined
    GROUP BY d
  )

  SELECT days.d,
    jsonb_build_object(
      'search', jsonb_build_object(
        'total', coalesce(st.total, 0),
        'zero_result', coalesce(st.zero_result, 0),
        'by_district', coalesce(sbd.obj, '{}'::jsonb),
        'by_property_type', coalesce(sbt.obj, '{}'::jsonb),
        'by_transaction_type', coalesce(sbtx.obj, '{}'::jsonb)
      ),
      'listing_impressions', coalesce(lt.impressions, 0),
      'listing_clicks', coalesce(lt.clicks, 0),
      'listing_views', coalesce(lt.views, 0),
      'listing_ctr', CASE WHEN coalesce(lt.impressions,0) > 0
                       THEN round(lt.clicks::numeric / lt.impressions, 3) ELSE 0 END,
      'views_by_district', coalesce(vbd.obj, '{}'::jsonb),
      'views_by_property_type', coalesce(vbt.obj, '{}'::jsonb),
      'whatsapp_clicks', coalesce(let.whatsapp_clicks, 0),
      'call_clicks', coalesce(let.call_clicks, 0),
      'leads_created', coalesce(lct.n, 0),
      'leads_closed', coalesce(lclt.n, 0),
      'leads_lost', coalesce(llt.n, 0),
      'sessions_total', coalesce(ut.sessions_total, 0),
      'avg_listings_viewed_per_session', CASE WHEN coalesce(ut.sessions_total,0) > 0
                       THEN round(lt.views::numeric / ut.sessions_total, 2) ELSE 0 END,
      'gallery_events', coalesce(ut.gallery_events, 0),
      'share_events', coalesce(ut.share_events, 0),
      'favorite_events', coalesce(ut.favorite_events, 0),
      'map_events', coalesce(ut.map_events, 0),
      'filter_usage', coalesce(fu.obj, '{}'::jsonb),
      'ui_element_counts', coalesce(uec.obj, '{}'::jsonb),
      'top_listings_by_views', coalesce(tbv.arr, '[]'::jsonb),
      'top_listings_by_ctr', coalesce(tbc.arr, '[]'::jsonb),
      'impressions_no_leads', coalesce(inl.arr, '[]'::jsonb),
      'new_listings_added', coalesce(nl.n, 0),
      'listings_removed', coalesce(rlog.n, 0),
      'most_searched_district', msd.district,
      'most_viewed_listing', mvl.listing,
      'search_to_view_conversion', CASE WHEN coalesce(st.total,0) > 0
                       THEN round(coalesce(lt.views,0)::numeric / st.total, 3) ELSE 0 END,
      'view_to_contact_conversion', CASE WHEN coalesce(lt.views,0) > 0
                       THEN round((coalesce(let.whatsapp_clicks,0) + coalesce(let.call_clicks,0))::numeric / lt.views, 3) ELSE 0 END,
      'days_on_market', CASE WHEN dom.n IS NOT NULL
                       THEN jsonb_build_object('median', round(dom.median_days::numeric,1), 'avg', round(dom.avg_days::numeric,1), 'count', dom.n)
                       ELSE NULL END,
      'active_inventory', NULL,
      'asking_price', NULL,
      'customer_intent_segments', coalesce(sj.arr, '[]'::jsonb),
      'journey_join', jsonb_build_object(
        'listing_events_total', coalesce(jt.listing_events_total, 0),
        'listing_events_with_session', coalesce(jt.listing_events_with_session, 0),
        'lead_events_total', coalesce(lst.lead_events_total, 0),
        'lead_events_with_session', coalesce(lst.lead_events_with_session, 0),
        'lead_events_matched_to_click', coalesce(lst.lead_events_matched_to_click, 0)
      ),
      -- ── Unit-Type Demand addition ────────────────────────────────────
      'unit_type_demand_segments', coalesce(uj.arr, '[]'::jsonb)
    ) AS metrics
  FROM days
  LEFT JOIN search_totals st        ON st.d = days.d
  LEFT JOIN search_by_district sbd  ON sbd.d = days.d
  LEFT JOIN search_by_type sbt      ON sbt.d = days.d
  LEFT JOIN search_by_tx sbtx       ON sbtx.d = days.d
  LEFT JOIN most_searched_district msd ON msd.d = days.d
  LEFT JOIN listing_totals lt       ON lt.d = days.d
  LEFT JOIN views_by_district vbd   ON vbd.d = days.d
  LEFT JOIN views_by_type vbt       ON vbt.d = days.d
  LEFT JOIN lead_event_totals let   ON let.d = days.d
  LEFT JOIN leads_created_totals lct  ON lct.d = days.d
  LEFT JOIN leads_closed_totals lclt  ON lclt.d = days.d
  LEFT JOIN leads_lost_totals llt     ON llt.d = days.d
  LEFT JOIN ui_totals ut            ON ut.d = days.d
  LEFT JOIN filter_usage fu         ON fu.d = days.d
  LEFT JOIN ui_element_counts uec   ON uec.d = days.d
  LEFT JOIN top_by_views tbv        ON tbv.d = days.d
  LEFT JOIN most_viewed_listing mvl ON mvl.d = days.d
  LEFT JOIN top_by_ctr tbc          ON tbc.d = days.d
  LEFT JOIN impressions_no_leads inl ON inl.d = days.d
  LEFT JOIN new_listings nl         ON nl.d = days.d
  LEFT JOIN removed_listings rlog   ON rlog.d = days.d
  LEFT JOIN days_on_market_totals dom ON dom.d = days.d
  LEFT JOIN seg_json sj             ON sj.d = days.d
  LEFT JOIN journey_totals jt       ON jt.d = days.d
  LEFT JOIN lead_session_totals lst ON lst.d = days.d
  LEFT JOIN ut_json uj              ON uj.d = days.d
  ORDER BY days.d;
$$;

COMMENT ON FUNCTION intelligence_daily_metrics IS
  'The Metrics Engine: pure, judgment-free daily aggregation over the event tables plus listing-lifecycle facts, Intelligence V2''s customer-intent segments / journey-join confidence, and unit_type_demand_segments (per-unit_types.id whatsapp_clicks/call_clicks/leads_created, current name/bedrooms/price/property/district/transaction_type resolved live). Safely re-callable for any historical range -- every field here is a genuine per-day fact. active_inventory/asking_price are always null from this function; see point_in_time_supply_snapshot() and ensure_daily_metrics_snapshot() for how those point-in-time stock metrics (including available_unit_types) get attached, deliberately only to the newest finalized day.';
