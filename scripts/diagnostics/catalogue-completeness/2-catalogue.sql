-- 2-catalogue.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no writes. It runs only
-- after the preflight passed, inside a READ ONLY transaction opened by the psql command line; section 0 says so and, if the session were not read
-- only, every count below is deliberately zero.
--
-- Question: what does the current catalogue actually contain? "Published" = exactly the rule of the public read policy on properties
-- (migration 20260806020000): deleted_at IS NULL AND status IN ('active','available'). The editorial rule (workflow_status = 'active') is reported
-- beside it, and any listing on which the two disagree is counted, so the headline number is what an anonymous visitor can actually see. Everything is a COUNT (or a date-by-month count) per fixed label. No listing id, title, name, phone, address, URL, coordinate,
-- price value, object name or payload is ever selected into the output; the map-link and price sections classify with regular expressions and
-- print only the class. The price classes APPROXIMATE the formatter in components.js (ptFormatPriceLine); they are a completeness measure, not a
-- second source of truth for what a visitor sees.
WITH guard AS (SELECT current_setting('transaction_read_only') = 'on' AS ok),
units AS (
  SELECT u.property_id,
         count(*) AS n_units,
         count(*) FILTER (WHERE a.amt IS NOT NULL) AS n_priced,
         count(DISTINCT a.amt) FILTER (WHERE a.amt IS NOT NULL) AS n_amounts,
         count(DISTINCT coalesce(a.cur, '?') || '/' || coalesce(a.frq, '?')) FILTER (WHERE a.amt IS NOT NULL) AS n_cf,
         count(*) FILTER (WHERE to_jsonb(u)->>'is_available' = 'true') AS n_avail
    FROM unit_types u, guard,
         LATERAL (SELECT x.amt, x.cur, x.frq FROM (
                    SELECT CASE WHEN to_jsonb(u)->>'price_amount' ~ '^[0-9]+([.][0-9]+)?$' THEN (to_jsonb(u)->>'price_amount')::numeric ELSE 0 END AS sa,
                           CASE WHEN to_jsonb(u)->>'rent_price_amount' ~ '^[0-9]+([.][0-9]+)?$' THEN (to_jsonb(u)->>'rent_price_amount')::numeric ELSE 0 END AS ra) v,
                  LATERAL (SELECT CASE WHEN v.sa > 0 THEN v.sa WHEN v.ra > 0 THEN v.ra END AS amt,
                                  CASE WHEN v.sa > 0 THEN to_jsonb(u)->>'price_currency' ELSE to_jsonb(u)->>'rent_price_currency' END AS cur,
                                  CASE WHEN v.sa > 0 THEN to_jsonb(u)->>'price_frequency' ELSE to_jsonb(u)->>'rent_price_frequency' END AS frq) x) a
   WHERE guard.ok
   GROUP BY u.property_id),
l AS (
  SELECT p.id,
         (p.deleted_at IS NOT NULL) AS soft_deleted,
         (p.deleted_at IS NULL AND p.status IN ('active', 'available')) AS published,
         (p.deleted_at IS NULL AND p.workflow_status = 'active') AS wf_active,
         CASE WHEN p.workflow_status::text ~ '^[a-z_]{1,30}$' THEN p.workflow_status::text ELSE 'other (not a plain code)' END AS workflow_status,
         CASE WHEN p.market_status::text ~ '^[a-z_]{1,30}$' THEN p.market_status::text ELSE 'other (not a plain code)' END AS market_status,
         CASE WHEN p.transaction_type::text ~ '^[a-z_]{1,30}$' THEN p.transaction_type::text ELSE 'other (not a plain code)' END AS transaction_type,
         p.created_at,
         CASE WHEN btrim(to_jsonb(p)->>'property_type') ~ '^[a-z_]{1,30}$' THEN btrim(to_jsonb(p)->>'property_type')
              WHEN nullif(btrim(to_jsonb(p)->>'property_type'), '') IS NULL THEN 'none' ELSE 'other (not a plain code)' END AS ptype,
         CASE WHEN jsonb_typeof(p.images) = 'array'
              THEN (SELECT count(*) FROM jsonb_array_elements(p.images) e WHERE jsonb_typeof(e) = 'string' AND btrim(e #>> '{}') <> '')
              ELSE 0 END AS n_images,
         EXISTS (SELECT 1 FROM property_images pi WHERE pi.property_id = p.id) AS has_registry,
         coalesce(un.n_units, 0) AS n_units, coalesce(un.n_priced, 0) AS n_priced, coalesce(un.n_amounts, 0) AS n_amounts,
         coalesce(un.n_cf, 0) AS n_cf, coalesce(un.n_avail, 0) AS n_avail,
         ((CASE WHEN to_jsonb(p)->>'price_amount' ~ '^[0-9]+([.][0-9]+)?$' THEN (to_jsonb(p)->>'price_amount')::numeric ELSE 0 END) > 0) AS ok_sale_amt,
         ((CASE WHEN to_jsonb(p)->>'rent_price_amount' ~ '^[0-9]+([.][0-9]+)?$' THEN (to_jsonb(p)->>'rent_price_amount')::numeric ELSE 0 END) > 0) AS ok_rent_amt,
         (nullif(btrim(to_jsonb(p)->>'price_amount'), '') IS NOT NULL OR nullif(btrim(to_jsonb(p)->>'rent_price_amount'), '') IS NOT NULL) AS any_amt_text,
         (nullif(btrim(to_jsonb(p)->>'price_display'), '') IS NOT NULL OR nullif(btrim(to_jsonb(p)->>'sale_price'), '') IS NOT NULL
          OR nullif(btrim(to_jsonb(p)->>'rent_price'), '') IS NOT NULL) AS has_text_price,
         CASE WHEN coalesce(nullif(btrim(to_jsonb(p)->>'price_currency'), ''), nullif(btrim(to_jsonb(p)->>'rent_price_currency'), '')) ~ '^[A-Z]{3}$'
              THEN coalesce(nullif(btrim(to_jsonb(p)->>'price_currency'), ''), nullif(btrim(to_jsonb(p)->>'rent_price_currency'), ''))
              WHEN coalesce(nullif(btrim(to_jsonb(p)->>'price_currency'), ''), nullif(btrim(to_jsonb(p)->>'rent_price_currency'), '')) IS NULL THEN 'none'
              ELSE 'other (not a 3-letter code)' END AS cur,
         (nullif(btrim(to_jsonb(p)->>'title_lo'), '') IS NOT NULL) AS t_lo, (nullif(btrim(to_jsonb(p)->>'title_en'), '') IS NOT NULL) AS t_en,
         (nullif(btrim(to_jsonb(p)->>'title_zh'), '') IS NOT NULL) AS t_zh,
         (nullif(btrim(to_jsonb(p)->>'description_lo'), '') IS NOT NULL) AS d_lo, (nullif(btrim(to_jsonb(p)->>'description_en'), '') IS NOT NULL) AS d_en,
         (nullif(btrim(to_jsonb(p)->>'description_zh'), '') IS NOT NULL) AS d_zh,
         lower(btrim(to_jsonb(p)->>'title_en')) AS title_key,
         (nullif(to_jsonb(p)->>'managed_by_party_id', '') IS NOT NULL) AS has_party,
         (nullif(to_jsonb(p)->>'contact_id', '') IS NOT NULL OR EXISTS (SELECT 1 FROM property_contacts pc WHERE pc.property_id = p.id)) AS has_contact,
         (nullif(to_jsonb(p)->>'owner_id', '') IS NOT NULL) AS has_owner,
         (nullif(btrim(to_jsonb(p)->>'district_en'), '') IS NOT NULL) AS has_district,
         (nullif(btrim(to_jsonb(p)->>'village_en'), '') IS NOT NULL) AS has_village,
         (nullif(btrim(to_jsonb(p)->>'province'), '') IS NOT NULL) AS has_province,
         coalesce(to_jsonb(p)->>'map_embed_url', '') AS map_url,
         CASE WHEN to_jsonb(p)->>'available_from' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              THEN (to_jsonb(p)->>'available_from')::date END AS avail_from,
         EXISTS (SELECT 1 FROM leads ld WHERE ld.property_id = p.id) AS has_lead
    FROM properties p
    LEFT JOIN units un ON un.property_id = p.id, guard
   WHERE guard.ok),
pub AS (SELECT * FROM l WHERE published),
pubk AS (
  SELECT pub.*,
         CASE WHEN ok_sale_amt OR ok_rent_amt THEN 'listing-level structured price'
              WHEN n_priced > 0 THEN 'unit-level structured prices only'
              WHEN any_amt_text THEN 'amount present but not a positive number (falls back to Price on request)'
              WHEN has_text_price THEN 'legacy text price only'
              ELSE 'no price (shows Price on request)' END AS price_class,
         CASE WHEN n_units < 2 THEN 'fewer than 2 unit types'
              WHEN n_priced < 2 THEN '2+ unit types, fewer than 2 priced'
              WHEN n_cf > 1 THEN '2+ priced units, mixed currency or frequency (Prices vary)'
              WHEN n_amounts > 1 THEN '2+ priced units, prices differ (From)'
              ELSE '2+ priced units, identical prices (exact)' END AS multi_class,
         count(*) OVER (PARTITION BY title_key) AS title_n,
         CASE WHEN map_url = '' THEN 'no map link'
              WHEN map_url ~* '^https?://(maps[.]app[.]goo[.]gl|goo[.]gl|g[.]co)/' THEN 'short link (no coordinates until resolved)'
              WHEN map_url ~ '(!3d|@|[?&]q=)-?[0-9]+[.][0-9]{5,}' THEN 'carries coordinates with 5+ decimals (about 1 m)'
              WHEN map_url ~ '(!3d|@|[?&]q=)-?[0-9]+[.][0-9]{1,4}' THEN 'carries coordinates with 1-4 decimals'
              ELSE 'link without parseable coordinates' END AS map_class
    FROM pub)
SELECT section, label, n FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || (SELECT current_setting('transaction_read_only')) AS label, NULL::bigint AS n
  UNION ALL SELECT 1, '1 properties rows', 'all rows', count(*) FROM l
  UNION ALL SELECT 1, '1 properties rows', 'soft-deleted', count(*) FROM l WHERE soft_deleted
  UNION ALL SELECT 1, '1 properties rows', 'not soft-deleted', count(*) FROM l WHERE NOT soft_deleted
  UNION ALL SELECT 1, '1 properties rows', 'PUBLISHED (what the public read policy shows: not soft-deleted and status active/available)', count(*) FROM l WHERE published
  UNION ALL SELECT 1, '1 properties rows', 'published by the editorial rule (not soft-deleted and workflow_status = active)', count(*) FROM l WHERE wf_active
  UNION ALL SELECT 1, '1 properties rows', 'listings on which the two rules DISAGREE (should be 0)', count(*) FROM l WHERE published <> wf_active
  UNION ALL SELECT 2, '2 not soft-deleted by workflow_status', workflow_status, count(*) FROM l WHERE NOT soft_deleted GROUP BY 3
  UNION ALL SELECT 3, '3 published by market_status', market_status, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 4, '4 published by transaction_type', coalesce(transaction_type, 'NULL'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 5, '5 published by property_type', ptype, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 6, '6 published by number of images in the gallery',
         CASE WHEN n_images = 0 THEN 'a: no images' WHEN n_images <= 2 THEN 'b: 1-2' WHEN n_images <= 5 THEN 'c: 3-5' WHEN n_images <= 11 THEN 'd: 6-11' ELSE 'e: 12+' END, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 7, '7 published: gallery versus image registry (property_images)',
         CASE WHEN n_images > 0 AND has_registry THEN 'gallery and registry rows' WHEN n_images > 0 THEN 'gallery, NO registry rows'
              WHEN has_registry THEN 'registry rows, EMPTY gallery' ELSE 'neither' END, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 8, '8 published by price class', price_class, count(*) FROM pubk GROUP BY 3
  UNION ALL SELECT 9, '9 published by currency (listing level, else the sale/rent leg)', cur, count(*) FROM pubk GROUP BY 3
  UNION ALL SELECT 10, '10 published by unit-type price pattern (approximates the formatter)', multi_class, count(*) FROM pubk GROUP BY 3
  UNION ALL SELECT 11, '11 published by unit-type count',
         CASE WHEN n_units = 0 THEN '0' WHEN n_units = 1 THEN '1' WHEN n_units <= 3 THEN '2-3' ELSE '4+' END, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 12, '12 published: availability consistency',
         CASE WHEN market_status = 'available' AND n_units >= 2 AND n_avail = 0 THEN 'market_status available but no unit type is available'
              WHEN market_status = 'available' AND avail_from IS NOT NULL AND avail_from < (now() AT TIME ZONE 'Asia/Vientiane')::date THEN 'market_status available with an Available From date in the past'
              WHEN market_status <> 'available' AND n_units >= 2 AND n_avail > 0 THEN 'market_status not available but a unit type is available'
              ELSE 'no inconsistency detected' END, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 13, '13 published by title languages present',
         coalesce(nullif(btrim((CASE WHEN t_lo THEN 'lo ' ELSE '' END) || (CASE WHEN t_en THEN 'en ' ELSE '' END) || (CASE WHEN t_zh THEN 'zh' ELSE '' END)), ''), 'none'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 14, '14 published by description languages present',
         coalesce(nullif(btrim((CASE WHEN d_lo THEN 'lo ' ELSE '' END) || (CASE WHEN d_en THEN 'en ' ELSE '' END) || (CASE WHEN d_zh THEN 'zh' ELSE '' END)), ''), 'none'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 15, '15 published: contact and ownership links',
         coalesce(nullif(btrim((CASE WHEN has_party THEN 'party ' ELSE '' END) || (CASE WHEN has_contact THEN 'contact ' ELSE '' END) || (CASE WHEN has_owner THEN 'owner' ELSE '' END)), ''), 'none'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 16, '16 published: location fields present',
         coalesce(nullif(btrim((CASE WHEN has_province THEN 'province ' ELSE '' END) || (CASE WHEN has_district THEN 'district ' ELSE '' END) || (CASE WHEN has_village THEN 'village' ELSE '' END)), ''), 'none'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 17, '17 published by map link class (PRIVACY: precision of the public map link; no URL or coordinate is printed)', map_class, count(*) FROM pubk GROUP BY 3
  UNION ALL SELECT 18, '18 published: duplicate English titles (listings sharing a title with another published listing)',
         CASE WHEN title_key IS NULL OR title_key = '' THEN 'no English title' WHEN title_n > 1 THEN 'shares its English title' ELSE 'unique' END, count(*) FROM pubk GROUP BY 3
  UNION ALL SELECT 19, '19 published: lead history', CASE WHEN has_lead THEN 'has at least one lead' ELSE 'no lead ever' END, count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 20, '20 published by month created', to_char(date_trunc('month', created_at), 'YYYY-MM'), count(*) FROM pub GROUP BY 3
  UNION ALL SELECT 21, '21 visibility cross-check: rows this connection saw vs the planner estimate in the catalogue (advisory: statistics can lag; also compare section 1 with an independent count)',
         x.label || CASE WHEN c.reltuples < 0 THEN ': no estimate yet (table never analyzed)'
                         WHEN x.seen < 0.9 * c.reltuples THEN ': FEWER rows seen than the estimate of ' || round(c.reltuples)::text || ' (possible hidden rows)'
                         ELSE ': consistent with the estimate (' || round(c.reltuples)::text || ')' END, x.seen
    FROM (SELECT 'properties' AS label, (SELECT count(*) FROM l) AS seen
          UNION ALL SELECT 'unit_types', (SELECT coalesce(sum(n_units), 0) FROM units)) x
    JOIN pg_class c ON c.relname = x.label AND c.relnamespace = 'public'::regnamespace
) t ORDER BY s, section, label;
