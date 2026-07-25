-- Intelligence Layer -> production-grade BI: expands the Daily Metrics
-- Snapshot with real business metrics (new/removed listings, active
-- inventory, asking price, days on market, top district/listing,
-- conversion ratios) and adds version metadata to every generated report,
-- per the product owner's BI roadmap. Guiding principle unchanged from
-- 20260724000000_daily_metrics_snapshot.sql: every new metric here is
-- either (a) a genuine historical fact safely re-derivable for any past
-- date, or (b) an explicitly-flagged point-in-time read that is only ever
-- attached to the single most-recently-finalized day, never fabricated
-- across a historical range. Metrics that cannot honestly be computed from
-- what Pintag actually records today (new vs. returning visitors -- no
-- persistent cross-session visitor id exists, only a per-tab session_id;
-- see INTELLIGENCE_ARCHITECTURE.md) are deliberately left out rather than
-- approximated with something that would silently measure the wrong
-- thing.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. properties.status_changed_at — enables real "days on market"
-- ═══════════════════════════════════════════════════════════════════════
-- properties has no status-change history table, so "when did this listing
-- move to sold/rented" is unknowable for anything that already happened.
-- Going forward, this column + trigger makes it a real, honest fact.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

-- Backfill: a listing that is ALREADY sold/rented as of this migration has
-- an unknown transition date -- left NULL (unknown), not fabricated as "0
-- days on market" or as created_at. A listing in any other status has not
-- been observed to change since tracking started, which created_at
-- correctly represents (its most recent status change IS its creation).
UPDATE properties
SET status_changed_at = CASE WHEN status IN ('sold','rented') THEN NULL ELSE created_at END
WHERE status_changed_at IS NULL;

-- Covers both INSERT and UPDATE: a brand-new row's status_changed_at
-- should start equal to created_at (its only status change so far is the
-- one that created it), exactly matching the migration's own backfill
-- rule for existing non-sold/rented rows below. Without the INSERT branch,
-- every property created after this migration would silently start with
-- status_changed_at = NULL (BEFORE UPDATE alone never fires on INSERT),
-- reintroducing the exact "unknown transition date" gap this column
-- exists to close -- caught by local verification before this shipped.
CREATE OR REPLACE FUNCTION set_properties_status_changed_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Mirrors the migration's own backfill rule below: a row inserted
    -- already in a terminal status (e.g. importing a historical closed
    -- listing) has an unknown real transition date, so leave it NULL
    -- rather than fabricating "0 days on market."
    IF NEW.status_changed_at IS NULL THEN
      NEW.status_changed_at := CASE WHEN NEW.status IN ('sold','rented')
        THEN NULL ELSE coalesce(NEW.created_at, now()) END;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_status_changed_at ON properties;
CREATE TRIGGER trg_properties_status_changed_at
  BEFORE INSERT OR UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_properties_status_changed_at();

COMMENT ON COLUMN properties.status_changed_at IS
  'Timestamp of this row''s most recent status change, maintained by trg_properties_status_changed_at. NULL means "already sold/rented before this column existed, transition date unknown" -- never treated as 0 days on market. Powers intelligence_daily_metrics()''s days_on_market figure.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. properties_removal_log — enables real "listings removed"
-- ═══════════════════════════════════════════════════════════════════════
-- admin.html's deleteListing() performs a real hard DELETE FROM properties,
-- which otherwise leaves zero trace a listing ever existed. This table +
-- AFTER DELETE trigger is what makes "listings removed" a real, honest
-- daily metric from this migration forward. Deletions before this
-- migration are not retroactively knowable and correctly show as 0 in
-- intelligence_daily_metrics(), not fabricated.
CREATE TABLE IF NOT EXISTS properties_removal_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL,
  title_en          text,
  title_lo          text,
  property_type     text,
  district_en       text,
  transaction_type  text,
  status_at_removal text,
  listed_at         timestamptz,
  removed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_removal_log_removed_at ON properties_removal_log(removed_at DESC);

COMMENT ON TABLE properties_removal_log IS
  'One row per properties deletion, written only by trg_properties_removal_log (SECURITY DEFINER, fires regardless of the deleting session''s own RLS) -- never by application code directly. Not a general audit log; exists specifically so "listings removed" can be a real daily count.';

CREATE OR REPLACE FUNCTION log_properties_removal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO properties_removal_log
    (property_id, title_en, title_lo, property_type, district_en, transaction_type, status_at_removal, listed_at)
  VALUES
    (OLD.id, OLD.title_en, OLD.title_lo, OLD.property_type, OLD.district_en, OLD.transaction_type, OLD.status, OLD.created_at);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_removal_log ON properties;
CREATE TRIGGER trg_properties_removal_log
  AFTER DELETE ON properties
  FOR EACH ROW EXECUTE FUNCTION log_properties_removal();

ALTER TABLE properties_removal_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read properties_removal_log" ON properties_removal_log;
CREATE POLICY "Staff read properties_removal_log"
  ON properties_removal_log FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

-- ═══════════════════════════════════════════════════════════════════════
-- 3. point_in_time_supply_snapshot() — current-state read, used carefully
-- ═══════════════════════════════════════════════════════════════════════
-- Active inventory counts and asking-price percentiles as of RIGHT NOW --
-- a stock reading, not a time series. Deliberately a separate function
-- from intelligence_daily_metrics() (which is safely re-callable for any
-- historical date range) so it is structurally impossible to accidentally
-- attach "today's inventory" to a past day during a multi-day backfill --
-- see ensure_daily_metrics_snapshot() below, the only caller, which
-- attaches this only to the single most-recently-finalized day.
--
-- Price parsing mirrors listings.html's own client-side sortProperties()
-- (strip everything but digits/dot from price_display, parse as a number)
-- rather than trusting sale_price/rent_price to be clean numerics --
-- same source of truth the buyer-facing site itself already sorts by.
-- Listings whose price_display doesn't parse as a plain number are
-- excluded from the price percentiles rather than guessed at.
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
  )
  SELECT jsonb_build_object(
    'active_inventory', jsonb_build_object(
      'total', (SELECT count(*) FROM active),
      'by_property_type', coalesce((SELECT obj FROM by_type), '{}'::jsonb),
      'by_district', coalesce((SELECT obj FROM by_district), '{}'::jsonb)
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
  'Current-state read (active inventory + asking price percentiles), not a time series. Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot().';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. intelligence_daily_metrics() — extended with new scalar/flow metrics
-- ═══════════════════════════════════════════════════════════════════════
-- Same contract as before: pure, safely re-callable for any historical
-- range, zero judgment. Every field added here is a genuine per-day
-- historical fact (a flow, not a stock) -- new listings created that day,
-- listings removed that day, status transitions that happened that day,
-- and simple ratios of other fields already computed that day. Point-in-
-- time stock metrics (active_inventory, asking_price) are intentionally
-- NOT added here -- see point_in_time_supply_snapshot() above.
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
  -- Approximation, disclosed: leads has no status-change history, so
  -- "closed/lost that day" is read as "currently closed/lost, last touched
  -- that day" — the best available signal without a separate history table.
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
    -- Minimum-impressions floor avoids "100% CTR" noise from a listing
    -- shown once and clicked once.
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
      -- ── BI additions ────────────────────────────────────────────────
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
      -- Point-in-time stock metrics: never computed here. Left null for
      -- every day; ensure_daily_metrics_snapshot() merges a real reading
      -- in for the single most-recently-finalized day only.
      'active_inventory', NULL,
      'asking_price', NULL
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
  ORDER BY days.d;
$$;

COMMENT ON FUNCTION intelligence_daily_metrics IS
  'The Metrics Engine: pure, judgment-free daily aggregation over the event tables plus listing-lifecycle facts (new/removed/days-on-market). Safely re-callable for any historical range -- every field here is a genuine per-day fact. active_inventory/asking_price are always null from this function; see point_in_time_supply_snapshot() and ensure_daily_metrics_snapshot() for how those point-in-time stock metrics get attached, deliberately only to the newest finalized day.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ensure_daily_metrics_snapshot() — attach point-in-time supply once
-- ═══════════════════════════════════════════════════════════════════════
-- Same finalization contract as before (INSERT ... ON CONFLICT DO NOTHING,
-- never touches today-or-later). The one addition: active_inventory /
-- asking_price are merged in from point_in_time_supply_snapshot() ONLY for
-- v_end (the single most-recently-finalized day this call could possibly
-- produce) -- any earlier day being finalized in the same batch call
-- (e.g. the first run after a gap) correctly gets null for both, honestly
-- representing "we don't know what supply looked like on that day."
CREATE OR REPLACE FUNCTION ensure_daily_metrics_snapshot(p_start date, p_end date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_end date := LEAST(p_end, CURRENT_DATE - 1);
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
  'Finalizes (writes exactly once) daily_metrics_snapshot rows for every day in [p_start, p_end] that is not already finalized and is not today-or-later. Idempotent: calling this again for an already-finalized range does nothing. Attaches a real point-in-time active_inventory/asking_price reading only to the single newest day being finalized (v_end) -- see point_in_time_supply_snapshot(). Called by generate-intelligence-report before reading any historical metrics.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. intelligence_reports — version metadata for traceability/reproducibility
-- ═══════════════════════════════════════════════════════════════════════
-- generated_at (existing) already IS "Generated Timestamp"; model_used
-- (existing) already IS "AI Model Version" (e.g. 'gemini-2.5-flash' or
-- 'deterministic' for quiet-day/validation-fallback reports) -- neither is
-- duplicated here. The four genuinely new axes:
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS snapshot_version text;
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS report_version text;
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE intelligence_reports ADD COLUMN IF NOT EXISTS validator_version text;

-- Left NULL here, not backfilled with today's version: rows generated
-- before this migration were not, in fact, generated under any tracked
-- version, and claiming otherwise would violate INTELLIGENCE_ARCHITECTURE.
-- md's Versioning rule ("historical reports must stay interpretable
-- exactly as they were generated"). Only ever populated going forward by
-- generate-intelligence-report/index.ts, sourced from versions.js.
COMMENT ON COLUMN intelligence_reports.snapshot_version IS
  'Version tag (see versions.js) of the daily_metrics_snapshot jsonb shape this report was generated from. NULL = generated before version tracking existed.';
COMMENT ON COLUMN intelligence_reports.report_version IS
  'Version tag of intelligence_reports'' own row shape/semantics at generation time. NULL = generated before version tracking existed.';
COMMENT ON COLUMN intelligence_reports.prompt_version IS
  'Version tag of the Gemini prompt template (buildPrompt() in report-composer.js). NULL for quiet-day/deterministic reports, which never call Gemini, and for reports generated before version tracking existed.';
COMMENT ON COLUMN intelligence_reports.validator_version IS
  'Version tag of report-validator.js''s rule set used to validate this report before publication. NULL for quiet-day/deterministic reports (never validated, since nothing was narrated) and for reports generated before version tracking existed.';
