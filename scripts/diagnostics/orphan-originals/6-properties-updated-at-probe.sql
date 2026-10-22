-- 6-properties-updated-at-probe.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no
-- writes. Runs only after the preflight passed, inside a READ ONLY transaction opened by the psql command line; the session-guard row says so.
--
-- Question: can "did the listing change after the Gallery Recovery record?" be answered at all? The gallery listing-state report said "unknown" for all
-- 107 assign objects, which means properties.updated_at is missing or NULL for those listings -- yet 20260622000000_engagement_metrics.sql gives it a
-- default and a BEFORE UPDATE trigger. This probe reports, as COUNTS, DATES and CATALOG FACTS only (no ids, names, titles or payloads):
--   * whether the column exists, its type, whether it has a default, and whether the trigger exists and is enabled;
--   * how many properties rows have a non-NULL updated_at, and the earliest / latest date and a per-month histogram;
--   * for the listings that have ANY Gallery Recovery record: how many have a value, and how many changed after their latest record.
-- It never selects a listing id, record id or object name.
WITH guard AS (SELECT current_setting('transaction_read_only') = 'on' AS ok),
col AS (
  SELECT format_type(a.atttypid, a.atttypmod) AS typ, a.atthasdef AS has_default
    FROM pg_attribute a
   WHERE a.attrelid = 'public.properties'::regclass AND a.attname = 'updated_at' AND a.attnum > 0 AND NOT a.attisdropped),
trg AS (
  SELECT t.tgenabled::text AS enabled FROM pg_trigger t
   WHERE t.tgrelid = 'public.properties'::regclass AND NOT t.tgisinternal AND t.tgname = 'trg_properties_updated_at'),
vals AS (
  SELECT (to_jsonb(p) ? 'updated_at') AS has_key,
         CASE WHEN to_jsonb(p)->>'updated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (to_jsonb(p)->>'updated_at')::timestamptz END AS ts
    FROM properties p, guard WHERE guard.ok),
last_rec AS (
  SELECT g.listing_id, max(g.created_at) AS last_ts FROM gallery_assignments g, guard WHERE guard.ok AND g.listing_id IS NOT NULL GROUP BY g.listing_id),
rel AS (
  SELECT l.last_ts,
         CASE WHEN to_jsonb(p)->>'updated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (to_jsonb(p)->>'updated_at')::timestamptz END AS ts
    FROM last_rec l JOIN properties p ON p.id = l.listing_id)
SELECT section, label, n FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || (SELECT current_setting('transaction_read_only')) AS label, NULL::bigint AS n
  UNION ALL SELECT 1, '1 properties rows', '', count(*) FROM vals
  UNION ALL SELECT 2, '2 updated_at column definition (catalog)',
         coalesce((SELECT 'present, type ' || typ || ', default ' || CASE WHEN has_default THEN 'yes' ELSE 'NO' END FROM col), 'ABSENT'), NULL
  UNION ALL SELECT 3, '3 trigger trg_properties_updated_at (catalog)',
         coalesce((SELECT 'present, enabled=' || enabled FROM trg), 'ABSENT'), NULL
  UNION ALL SELECT 4, '4 rows by updated_at state',
         CASE WHEN NOT has_key THEN 'column not visible in the row' WHEN ts IS NULL THEN 'NULL or unreadable' ELSE 'has a value' END, count(*) FROM vals GROUP BY has_key, (ts IS NULL)
  UNION ALL SELECT 5, '5 earliest / latest updated_at (dates only)', coalesce(to_char(min(ts), 'YYYY-MM-DD') || ' / ' || to_char(max(ts), 'YYYY-MM-DD'), 'no values'), count(ts) FROM vals
  UNION ALL SELECT 6, '6 rows by month of updated_at', to_char(date_trunc('month', ts), 'YYYY-MM'), count(*) FROM vals WHERE ts IS NOT NULL GROUP BY 3
  UNION ALL SELECT 7, '7 listings with any Gallery Recovery record: updated_at state and comparison with their LATEST record',
         CASE WHEN ts IS NULL THEN 'updated_at NULL or unreadable' WHEN ts > last_ts THEN 'changed after the latest record' ELSE 'not changed since the latest record' END, count(*) FROM rel GROUP BY 3
  UNION ALL SELECT 8, '8 listings with any Gallery Recovery record: total', '', count(*) FROM last_rec
) t ORDER BY s, label;
