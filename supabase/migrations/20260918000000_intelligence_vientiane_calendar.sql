-- ============================================================================
-- INTELLIGENCE REPORTING CALENDAR: UTC -> Asia/Vientiane
-- ============================================================================
-- Pintag is a Laos-based business; every visitor, agent, and staff member
-- reading a Daily Intelligence Report is in Asia/Vientiane (UTC+7, no DST).
-- Before this migration, intelligence_daily_metrics() and
-- ensure_daily_metrics_snapshot() bucketed every event into a calendar day
-- via a bare `created_at::date` / `CURRENT_DATE` cast. For a `timestamptz`
-- column, that cast implicitly converts to the DATABASE SESSION's current
-- `TimeZone` setting before truncating -- which, on this project, is UTC.
-- The generate-intelligence-report edge function's own `yesterdayUTC()`
-- (see date-boundary.js) independently confirms this was deliberate, not
-- accidental: the whole pipeline's "today"/"yesterday" has always meant the
-- UTC calendar day.
--
-- WHY THIS IS WRONG FOR THIS BUSINESS. Asia/Vientiane is UTC+7, so a UTC
-- calendar day D covers Vientiane wall-clock time from 07:00 on day D
-- through 06:59:59 on day D+1 -- the boundary sits in the middle of the
-- Laotian business day, not at Laotian midnight. Confirmed materially, on
-- live production ui_events (2026-09-16: 517 rows landed on the same
-- calendar day under both conventions, 146 did not -- roughly 22% of a
-- single day's rows were on the "wrong" side of the UTC boundary relative
-- to a Vientiane reader's own clock).
--
-- WHAT THIS MIGRATION DOES. Replaces every calendar-day-bucketing cast in
-- intelligence_daily_metrics() with the explicit, session-INDEPENDENT idiom
-- `(<col> AT TIME ZONE 'Asia/Vientiane')::date`, and replaces
-- ensure_daily_metrics_snapshot()'s `CURRENT_DATE` finalization check with
-- `(now() AT TIME ZONE 'Asia/Vientiane')::date`. This does NOT touch the
-- database's own TimeZone GUC (still UTC) or any timestamptz column's
-- storage (still UTC instants, unchanged) -- only how those instants are
-- interpreted for reporting purposes, spelled out explicitly at each usage
-- site rather than relying on the session's ambient default.
--
-- WHAT IS DELIBERATELY LEFT UNCONVERTED (pure instant/duration math, not
-- calendar-day bucketing, and therefore timezone-invariant already):
--   * `generate_series(p_start, p_end, interval '1 day')::date` -- p_start/
--     p_end are already `date` parameters, not timestamptz; there is no
--     instant to convert.
--   * `EXTRACT(day FROM status_changed_at - created_at)` (days_on_market) --
--     a difference between two timestamptz instants is a real interval
--     regardless of what timezone either side is viewed in.
--   * `x.created_at <= le.created_at` (lead_session_totals) -- instant
--     ordering, not a calendar-day comparison.
--
-- WHAT ELSE WAS AUDITED FOR CONSISTENCY (per the same "which calendar day
-- does this belong to" question, beyond the created_at sites the
-- investigation specifically named): `updated_at::date` (leads_closed/
-- leads_lost), `removed_at::date` (removed_listings), and
-- `status_changed_at::date` (days_on_market's own bucketing column, as
-- opposed to the EXTRACT() duration above) all bucket a timestamptz into a
-- report day exactly like created_at does, so they are converted the same
-- way for consistency. The same-day equality check inside
-- lead_session_totals (`x.created_at::date = le.created_at::date`) is
-- converted on BOTH sides so "same day" keeps meaning the same thing.
--
-- CRON. The daily/weekly/monthly pg_cron jobs documented in
-- docs/intelligence/OPERATIONS.md are UNCHANGED by this migration (their
-- schedule strings are set via the SQL editor, outside any tracked
-- migration, and this task does not touch them). See that document's
-- updated comment for why 00:05 UTC (07:05 Vientiane) remains a correct
-- firing time under the new Vientiane boundary -- it has MORE safety
-- margin than it did under UTC, not less.
--
-- HISTORICAL DATA. Existing daily_metrics_snapshot rows are NOT modified,
-- deleted, or backfilled by this migration. They remain exactly what they
-- always were: daily aggregates bucketed by the UTC calendar day, as of
-- whenever they were originally finalized. Every day finalized AFTER this
-- migration is applied will be bucketed by the Vientiane calendar day
-- instead -- there is a real discontinuity at the cutover date. Deciding
-- whether/how to reconcile historical rows to the new convention is an
-- explicitly separate, later decision, not part of this change.
--
-- SQL/JS AGREEMENT. The 'Asia/Vientiane' literal here must always match
-- REPORT_TIMEZONE in supabase/functions/generate-intelligence-report/
-- date-boundary.js -- that module is what computes the p_start/p_end
-- values passed into these functions. The two are not mechanically linked;
-- if this identifier is ever revisited, that module must change with it.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION intelligence_daily_metrics(p_start date, p_end date)
RETURNS TABLE(day date, metrics jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH days AS (
    SELECT generate_series(p_start, p_end, interval '1 day')::date AS d
  ),

  -- ── search_events ─────────────────────────────────────────────────────
  search_totals AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(*) AS total,
      count(*) FILTER (WHERE result_count = 0) AS zero_result
    FROM search_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  search_by_district AS (
    SELECT d, jsonb_object_agg(district, cnt) AS obj FROM (
      SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, district, count(*) AS cnt
      FROM search_events
      WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND district IS NOT NULL
      GROUP BY 1, district
    ) x GROUP BY d
  ),
  search_by_type AS (
    SELECT d, jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, property_type, count(*) AS cnt
      FROM search_events
      WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND property_type IS NOT NULL
      GROUP BY 1, property_type
    ) x GROUP BY d
  ),
  search_by_tx AS (
    SELECT d, jsonb_object_agg(transaction_type, cnt) AS obj FROM (
      SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, transaction_type, count(*) AS cnt
      FROM search_events
      WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND transaction_type IS NOT NULL
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
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(*) FILTER (WHERE event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE event_type = 'click')      AS clicks,
      count(*) FILTER (WHERE event_type = 'view')        AS views
    FROM listing_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  views_by_district AS (
    SELECT d, jsonb_object_agg(district_en, cnt) AS obj FROM (
      SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.district_en, count(*) AS cnt
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND le.event_type = 'view' AND p.district_en IS NOT NULL
      GROUP BY 1, p.district_en
    ) x GROUP BY d
  ),
  views_by_type AS (
    SELECT d, jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.property_type, count(*) AS cnt
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND le.event_type = 'view' AND p.property_type IS NOT NULL
      GROUP BY 1, p.property_type
    ) x GROUP BY d
  ),

  -- ── lead_events / leads ───────────────────────────────────────────────
  lead_event_totals AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(*) FILTER (WHERE event_type = 'whatsapp_click') AS whatsapp_clicks,
      count(*) FILTER (WHERE event_type = 'call_click')      AS call_clicks
    FROM lead_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_created_totals AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, count(*) AS n
    FROM leads WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_closed_totals AS (
    SELECT (updated_at AT TIME ZONE 'Asia/Vientiane')::date AS d, count(*) AS n
    FROM leads WHERE status = 'closed' AND (updated_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  leads_lost_totals AS (
    SELECT (updated_at AT TIME ZONE 'Asia/Vientiane')::date AS d, count(*) AS n
    FROM leads WHERE status = 'lost' AND (updated_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),

  -- ── ui_events ─────────────────────────────────────────────────────────
  ui_totals AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS sessions_total,
      count(*) FILTER (WHERE element_id LIKE 'gallery-%')  AS gallery_events,
      count(*) FILTER (WHERE element_id = 'share-property') AS share_events,
      count(*) FILTER (WHERE element_id = 'favorite-property') AS favorite_events,
      count(*) FILTER (WHERE element_id IN ('map-open-link','map-embed','view-toggle-map')) AS map_events
    FROM ui_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  filter_usage AS (
    SELECT d, jsonb_object_agg(element_id, cnt) AS obj FROM (
      SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, element_id, count(*) AS cnt
      FROM ui_events
      WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND element_type IN ('filter','select','toggle')
      GROUP BY 1, element_id
    ) x GROUP BY d
  ),
  ui_element_counts AS (
    SELECT d, jsonb_object_agg(element_id, cnt) AS obj FROM (
      SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, element_id, count(*) AS cnt
      FROM ui_events
      WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      GROUP BY 1, element_id
    ) x GROUP BY d
  ),

  -- ── property performance leaderboards ────────────────────────────────
  top_by_views AS (
    SELECT d, jsonb_agg(row ORDER BY (row->>'views')::int DESC) AS arr FROM (
      SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
        jsonb_build_object('property_id', p.id, 'title', coalesce(p.title_en, p.title_lo), 'views', count(*)) AS row
      FROM listing_events le JOIN properties p ON p.id = le.property_id
      WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND le.event_type = 'view'
      GROUP BY (le.created_at AT TIME ZONE 'Asia/Vientiane')::date, p.id, p.title_en, p.title_lo
    ) x GROUP BY d
  ),
  most_viewed_listing AS (
    SELECT d, arr->0 AS listing FROM top_by_views
  ),
  ctr_by_property AS (
    SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.id, coalesce(p.title_en, p.title_lo) AS title,
      count(*) FILTER (WHERE le.event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE le.event_type = 'click')      AS clicks
    FROM listing_events le JOIN properties p ON p.id = le.property_id
    WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end AND le.event_type IN ('impression','click')
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
        WHERE le.listing_id = cp.id AND (le.created_at AT TIME ZONE 'Asia/Vientiane')::date = cp.d
      )
    GROUP BY cp.d
  ),

  -- ── new BI facts: listing lifecycle + market-velocity ──────────────────
  new_listings AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, count(*) AS n
    FROM properties WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  removed_listings AS (
    SELECT (removed_at AT TIME ZONE 'Asia/Vientiane')::date AS d, count(*) AS n
    FROM properties_removal_log WHERE (removed_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  days_on_market_totals AS (
    SELECT (status_changed_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(day FROM status_changed_at - created_at)) AS median_days,
      avg(EXTRACT(day FROM status_changed_at - created_at)) AS avg_days,
      count(*) AS n
    FROM properties
    WHERE status IN ('sold', 'rented')
      AND status_changed_at IS NOT NULL
      AND (status_changed_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),

  -- ── Intelligence V2: Customer Intent segments ──────────────────────────
  -- (transaction_type, property_type, district) -- see
  -- 20260905000000_intelligence_customer_intent.sql's header comment for
  -- why the exact price band is not part of the key either. Search-side
  -- counts come straight off search_events (the real filters a customer
  -- actually applied); engagement/lead counts are attributed to a segment
  -- by joining the underlying listing back to properties, the SAME join
  -- views_by_district/views_by_type already use -- an impression/click/
  -- lead is "in" a segment because the LISTING it happened on belongs
  -- there, not because a client-side filter snapshot says so
  -- (listing_events.search_filters is a raw, variable-shaped client
  -- snapshot, not a reliable join key).
  seg_search AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, transaction_type, property_type, district,
      count(*) AS search_count,
      round(avg(result_count)::numeric, 1) AS avg_result_count,
      count(*) FILTER (WHERE result_count = 0) AS zero_result_count
    FROM search_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_price_counts AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, transaction_type, property_type, district, price_min, price_max, count(*) AS cnt
    FROM search_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6
  ),
  seg_top_price AS (
    -- The single most-searched price band per segment per day -- reported
    -- as context ("customers wanting X most often asked for $Y-$Z"), not
    -- used as part of the join key (see header comment).
    SELECT DISTINCT ON (d, transaction_type, property_type, district)
      d, transaction_type, property_type, district, price_min, price_max
    FROM seg_price_counts
    ORDER BY d, transaction_type, property_type, district, cnt DESC
  ),
  seg_bedroom_counts AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, transaction_type, property_type, district, bedrooms, count(*) AS cnt
    FROM search_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
  ),
  seg_top_bedroom AS (
    -- The single most-searched bedroom value per segment per day, exactly
    -- mirroring seg_top_price's DISTINCT ON ... ORDER BY cnt DESC shape.
    -- bedrooms IS NULL ("Any"/no preference) is a legitimate candidate
    -- here, same as price_min/price_max can both be NULL in seg_top_price
    -- -- a segment whose plurality is "no preference" reports NULL, not a
    -- fabricated number.
    SELECT DISTINCT ON (d, transaction_type, property_type, district)
      d, transaction_type, property_type, district, bedrooms AS top_bedroom_count
    FROM seg_bedroom_counts
    ORDER BY d, transaction_type, property_type, district, cnt DESC
  ),
  seg_bedroom_sample AS (
    -- Only the searches that actually carried a bedroom preference
    -- (excludes NULL/"Any"). This is deliberately NOT search_count --
    -- search_count includes every "Any" search too, which would let a
    -- segment look like it has plenty of signal about bedroom preference
    -- when almost none of it is actually about bedrooms.
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, transaction_type, property_type, district, count(*) AS bedroom_sample_size
    FROM search_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND transaction_type IS NOT NULL AND property_type IS NOT NULL AND district IS NOT NULL
      AND bedrooms IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_engagement AS (
    SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) FILTER (WHERE le.event_type = 'impression') AS impressions,
      count(*) FILTER (WHERE le.event_type = 'click')      AS clicks
    FROM listing_events le JOIN properties p ON p.id = le.property_id
    WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND le.event_type IN ('impression', 'click')
      AND p.transaction_type IS NOT NULL AND p.property_type IS NOT NULL AND p.district_en IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_leads_clicked AS (
    SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) FILTER (WHERE le.event_type = 'whatsapp_click') AS whatsapp_clicks,
      count(*) FILTER (WHERE le.event_type = 'call_click')      AS call_clicks
    FROM lead_events le JOIN properties p ON p.id = le.listing_id
    WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
      AND p.transaction_type IS NOT NULL AND p.property_type IS NOT NULL AND p.district_en IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  seg_leads_created AS (
    SELECT (l.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, p.transaction_type, p.property_type, p.district_en AS district,
      count(*) AS leads_created
    FROM leads l JOIN properties p ON p.id = l.property_id
    WHERE (l.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
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
  -- How much of the search -> impression/click -> contact chain is
  -- actually traceable through session_id in THIS data, measured, not
  -- assumed. Same-day only (a disclosed approximation, matching
  -- sessions_total's own cross-day disclosure in metrics-utils.js) --
  -- a session spanning midnight undercounts here rather than overcounts.
  journey_totals AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(*) FILTER (WHERE event_type IN ('impression', 'click')) AS listing_events_total,
      count(*) FILTER (WHERE event_type IN ('impression', 'click') AND session_id IS NOT NULL) AS listing_events_with_session
    FROM listing_events
    WHERE (created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  lead_session_totals AS (
    SELECT (le.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
      count(*) AS lead_events_total,
      count(*) FILTER (WHERE le.session_id IS NOT NULL) AS lead_events_with_session,
      count(*) FILTER (WHERE le.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM listing_events x
        WHERE x.session_id = le.session_id AND x.event_type = 'click'
          AND x.created_at <= le.created_at
          AND (x.created_at AT TIME ZONE 'Asia/Vientiane')::date = (le.created_at AT TIME ZONE 'Asia/Vientiane')::date
      )) AS lead_events_matched_to_click
    FROM lead_events le
    WHERE (le.created_at AT TIME ZONE 'Asia/Vientiane')::date BETWEEN p_start AND p_end
    GROUP BY 1
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
      -- ── Intelligence V2 additions ─────────────────────────────────────
      'customer_intent_segments', coalesce(sj.arr, '[]'::jsonb),
      'journey_join', jsonb_build_object(
        'listing_events_total', coalesce(jt.listing_events_total, 0),
        'listing_events_with_session', coalesce(jt.listing_events_with_session, 0),
        'lead_events_total', coalesce(lst.lead_events_total, 0),
        'lead_events_with_session', coalesce(lst.lead_events_with_session, 0),
        'lead_events_matched_to_click', coalesce(lst.lead_events_matched_to_click, 0)
      )
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
  ORDER BY days.d;
$$;

COMMENT ON FUNCTION intelligence_daily_metrics IS
  'The Metrics Engine: pure, judgment-free daily aggregation over the event tables plus listing-lifecycle facts and Intelligence V2''s customer-intent segments (now including top_bedroom_count/bedroom_sample_size) / journey-join confidence. Every calendar-day bucket is the Asia/Vientiane day (via AT TIME ZONE), not the UTC day the database session itself uses -- see 20260918000000_intelligence_vientiane_calendar.sql. Safely re-callable for any historical range -- every field here is a genuine per-day fact. active_inventory/asking_price are always null from this function; see point_in_time_supply_snapshot() and ensure_daily_metrics_snapshot() for how those point-in-time stock metrics get attached, deliberately only to the newest finalized day.';

CREATE OR REPLACE FUNCTION ensure_daily_metrics_snapshot(p_start date, p_end date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_end date := LEAST(p_end, (now() AT TIME ZONE 'Asia/Vientiane')::date - 1);
  v_supply jsonb;
BEGIN
  IF p_start > v_end THEN
    RETURN; -- nothing finalizable in range (e.g. p_start is today or later)
  END IF;

  -- Only compute the current-state read when v_end isn't already
  -- finalized (this function runs on every cron tick; no need to query
  -- properties again once that day's row already exists and ON CONFLICT
  -- will skip it anyway).
  IF NOT EXISTS (SELECT 1 FROM daily_metrics_snapshot WHERE day = v_end) THEN
    v_supply := point_in_time_supply_snapshot();
  END IF;

  INSERT INTO daily_metrics_snapshot (day, metrics, sample_size, data_confidence)
  SELECT
    m.day,
    CASE WHEN m.day = v_end
      THEN m.metrics || jsonb_build_object(
             'active_inventory', v_supply -> 'active_inventory',
             'asking_price', v_supply -> 'asking_price'
           )
      ELSE m.metrics
    END,
    coalesce((m.metrics->'search'->>'total')::integer, 0),
    data_confidence_from_sample_size(coalesce((m.metrics->'search'->>'total')::integer, 0))
  FROM intelligence_daily_metrics(p_start, v_end) m
  ON CONFLICT (day) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION ensure_daily_metrics_snapshot IS
  'Finalizes (writes exactly once) daily_metrics_snapshot rows for every day in [p_start, p_end] that is not already finalized and is not today-or-later, where "today" is the Asia/Vientiane calendar day (see 20260918000000_intelligence_vientiane_calendar.sql), not the database session''s own UTC CURRENT_DATE. Idempotent: calling this again for an already-finalized range does nothing. Attaches a real point-in-time active_inventory/asking_price reading only to the single newest day being finalized (v_end) -- see point_in_time_supply_snapshot(). Called by generate-intelligence-report before reading any historical metrics. Historical snapshot rows finalized before this migration remain bucketed by the UTC calendar day they were originally computed under -- this migration does not modify, delete, or backfill them.';

COMMIT;
