-- 7-gallery-history-vs-snapshots.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no
-- writes. Runs only after the preflight passed (including reconcile-schema, gallery-schema and history-schema), inside a READ ONLY transaction opened
-- by the psql command line; outside one every count below is zero and the guard row says so.
--
-- Question: can the recorded gallery history (listing_image_snapshots, import_records) bracket WHEN the unreferenced originals whose LATEST Gallery
-- Recovery record is an 'assign' (or 'unassign') left their listing's gallery?
--
-- What the data can and cannot say (read this before the numbers):
--   * A listing_image_snapshots "state" (rows sharing one provenance_event_id) is a RECORD OF A GALLERY AS IT WAS SAVED at that time by the admin
--     listing editor (create, or an edit that changed the images). It is evidence of a gallery STATE, not of any removal.
--   * A removal is only BOUNDED when the first state recorded AFTER the Gallery Recovery record DEMONSTRABLY EXCLUDES that specific image (its normalized
--     name is looked up in that state's image set). Then (record time, first later state] is an UPPER BOUND on when the image left -- a "removal window".
--     If the image is still present in the first later state the removal is NOT bounded (it is reported separately and never counted as a window);
--     the query does not look at states after the first one.
--   * Gallery Recovery itself writes no snapshots, and the editor writes none when a save leaves the gallery EMPTY (snapshotImages returns early).
--     So "no later state" means the history cannot bound the removal, not that nothing changed.
--   * Importing again (import_records after the record) shows a re-import happened; it does not show it replaced the gallery.
--
-- Population and latest record: EXACTLY as 5-gallery-listing-state.sql (the objects 2-diagnostic.sql counts; latest gallery_assignments record per
-- object; objects whose latest records conflict at one instant are left out). Output is counts, dates and catalog-free labels only: no object name,
-- listing id, record id, title or payload is ever selected.
WITH obj_all AS (
  SELECT so.name
    FROM storage.objects so
   WHERE so.bucket_id = 'property-images' AND so.name NOT LIKE 'renditions/%'
     AND current_setting('transaction_read_only') = 'on'),
live_raw AS (
  SELECT split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) AS n
    FROM properties p, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
   WHERE u.url LIKE '%/property-images/%'
  UNION ALL SELECT split_part(regexp_replace(img, '^.*/property-images/', ''), '?', 1)
    FROM unit_types ut, unnest(coalesce(ut.images, ARRAY[]::text[])) AS img WHERE img LIKE '%/property-images/%'
  UNION ALL SELECT split_part(regexp_replace(photo_url, '^.*/property-images/', ''), '?', 1) FROM parties WHERE photo_url LIKE '%/property-images/%'),
ga_raw AS (
  SELECT g.id::text AS rec_id, g.created_at AS rec_ts, g.op::text AS op, g.listing_id::text AS listing_id,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1) AS n
    FROM gallery_assignments g, LATERAL jsonb_path_query(g.photo_paths, 'strict $.**') AS v WHERE jsonb_typeof(v) = 'string'),
live_forms AS (
  SELECT convert_to(n, 'UTF8') AS b FROM live_raw WHERE n <> ''
  UNION ALL
  SELECT dec FROM (
    SELECT (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM live_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
ga_forms AS (
  SELECT rec_id, rec_ts, op, listing_id, convert_to(n, 'UTF8') AS b FROM ga_raw WHERE n <> ''
  UNION ALL
  SELECT rec_id, rec_ts, op, listing_id, dec FROM (
    SELECT rec_id, rec_ts, op, listing_id,
           (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM ga_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (
  SELECT o.name FROM obj_all o
   WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM live_forms f WHERE f.b = convert_to(o.name, 'UTF8'))),
hits AS (SELECT DISTINCT o.name, f.rec_id, f.rec_ts, f.op, f.listing_id FROM orph o JOIN ga_forms f ON f.b = convert_to(o.name, 'UTF8')),
mx AS (SELECT name, max(rec_ts) AS max_ts FROM hits GROUP BY name),
tied AS (
  SELECT h.name, count(DISTINCT (h.listing_id, h.op)) AS tied_variants
    FROM hits h JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts GROUP BY h.name),
latest AS (
  SELECT DISTINCT ON (h.name) h.name, h.rec_ts, h.op, h.listing_id, t.tied_variants
    FROM hits h JOIN tied t ON t.name = h.name JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts
   ORDER BY h.name, h.rec_id),
scope AS (   -- unambiguous latest record, operation assign or unassign, with a usable listing id
  SELECT l.name, l.rec_ts, l.op, l.listing_id
    FROM latest l
   WHERE l.tied_variants = 1 AND l.op IN ('assign', 'unassign')
     AND l.listing_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
nm AS (   -- image names of the scoped listings: every snapshot row and the CURRENT gallery (property-images entries only)
  SELECT 'snap' AS kind, s.listing_id::text AS lid, coalesce(s.provenance_event_id::text, s.created_at::text) AS sk, s.created_at AS ts,
         split_part(regexp_replace(coalesce(nullif(s.storage_path, ''), s.storage_url, ''), '^.*/property-images/', ''), '?', 1) AS n
    FROM listing_image_snapshots s WHERE EXISTS (SELECT 1 FROM scope sc WHERE sc.listing_id = s.listing_id::text)
  UNION ALL
  SELECT 'cur', p.id::text, NULL, NULL, split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1)
    FROM properties p, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
   WHERE u.url LIKE '%/property-images/%' AND EXISTS (SELECT 1 FROM scope sc WHERE sc.listing_id = p.id::text)),
nmc AS (   -- canonical bytes b: percent-decoded when the name has %XX escapes, as stored otherwise; rb: the name exactly as stored
  SELECT kind, lid, sk, ts, n, convert_to(n, 'UTF8') AS rb,
         CASE WHEN n ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(n, 'UTF8'))
              ELSE convert_to(n, 'UTF8') END AS b
    FROM nm WHERE n <> ''),
states AS (SELECT lid, sk, min(ts) AS state_ts, count(DISTINCT b) AS state_n FROM nmc WHERE kind = 'snap' GROUP BY lid, sk),
cur AS (SELECT lid, count(DISTINCT b) AS cur_n FROM nmc WHERE kind = 'cur' GROUP BY lid),
scope_b AS (   -- each scoped object's own name, as stored (rb) and percent-decoded (b), for the lookup in a state's image set
  SELECT sc.*, convert_to(sc.name, 'UTF8') AS rb,
         CASE WHEN sc.name ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(sc.name, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(sc.name, 'UTF8'))
              ELSE convert_to(sc.name, 'UTF8') END AS b
    FROM scope sc),
obj AS (
  SELECT sc.name, sc.op, sc.listing_id AS lid, sc.rec_ts,
         EXISTS (SELECT 1 FROM properties p WHERE p.id::text = sc.listing_id) AS listing_row,
         (SELECT count(*) FROM states st WHERE st.lid = sc.listing_id) AS n_states,
         (SELECT count(*) FROM states st WHERE st.lid = sc.listing_id AND st.state_ts > sc.rec_ts) AS n_after,
         fa.state_ts AS first_after_ts, fa.state_n AS first_after_n,
         -- is THIS image in the FIRST later state's image set? (false when there is no later state; read together with first_after_ts)
         (fa.sk IS NOT NULL AND EXISTS (SELECT 1 FROM nmc x WHERE x.kind = 'snap' AND x.lid = sc.listing_id AND x.sk = fa.sk
                                          AND (x.b = sc.rb OR x.b = sc.b OR x.rb = sc.rb OR x.rb = sc.b))) AS in_first_after,
         coalesce((SELECT c.cur_n FROM cur c WHERE c.lid = sc.listing_id), 0) AS cur_n,
         (SELECT count(*) FROM import_records ir WHERE ir.listing_id::text = sc.listing_id AND ir.imported_at > sc.rec_ts) AS imports_after,
         (SELECT min(ir.imported_at) FROM import_records ir WHERE ir.listing_id::text = sc.listing_id AND ir.imported_at > sc.rec_ts) AS first_import_after
    FROM scope_b sc
    LEFT JOIN LATERAL (SELECT st.sk, st.state_ts, st.state_n FROM states st WHERE st.lid = sc.listing_id AND st.state_ts > sc.rec_ts ORDER BY st.state_ts, st.sk LIMIT 1) fa ON true),
lst AS (   -- one row per (listing, latest-record operation): is the listing's LATEST snapshot the same image set as its current gallery?
  SELECT DISTINCT ON (o.lid, o.op) o.lid, o.op, ls.sk,
         (SELECT count(*) FROM (SELECT b FROM nmc WHERE kind = 'snap' AND lid = o.lid AND sk = ls.sk EXCEPT SELECT b FROM nmc WHERE kind = 'cur' AND lid = o.lid) x) AS only_snap,
         (SELECT count(*) FROM (SELECT b FROM nmc WHERE kind = 'cur' AND lid = o.lid EXCEPT SELECT b FROM nmc WHERE kind = 'snap' AND lid = o.lid AND sk = ls.sk) x) AS only_cur,
         coalesce((SELECT c.cur_n FROM cur c WHERE c.lid = o.lid), 0) AS cur_n
    FROM obj o
    LEFT JOIN LATERAL (SELECT st.sk FROM states st WHERE st.lid = o.lid ORDER BY st.state_ts DESC, st.sk LIMIT 1) ls ON true
   ORDER BY o.lid, o.op)
SELECT section, label, n, listings FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || current_setting('transaction_read_only') AS label, NULL::bigint AS n, NULL::bigint AS listings
  UNION ALL SELECT 1, '1 unreferenced originals (must equal the stage-2 total)', '', count(*), NULL FROM orph
  UNION ALL SELECT 2, '2 scope: latest Gallery Recovery record, unambiguous, usable listing id', op, count(*), count(DISTINCT lid) FROM obj GROUP BY op
  UNION ALL SELECT 3, '3 history available (all listings): listing_image_snapshots rows / distinct listings',
         coalesce(to_char(min(created_at), 'YYYY-MM-DD') || ' to ' || to_char(max(created_at), 'YYYY-MM-DD'), 'none'), count(*), count(DISTINCT listing_id) FROM listing_image_snapshots WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 4, '4 history available (all listings): import_records rows / distinct listings',
         coalesce(to_char(min(imported_at), 'YYYY-MM-DD') || ' to ' || to_char(max(imported_at), 'YYYY-MM-DD'), 'none'), count(*), count(DISTINCT listing_id) FROM import_records WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 5, '5 ' || op || ': gallery states recorded for the object''s listing',
         CASE WHEN n_states = 0 THEN 'no gallery state recorded at all' WHEN n_after = 0 THEN 'states exist, none AFTER the latest record (removal cannot be bounded)' ELSE 'at least one state AFTER the latest record (the image is checked against the FIRST one in section 6)' END,
         count(*), count(DISTINCT lid) FROM obj GROUP BY op, 3
  UNION ALL SELECT 6, '6 ' || op || ': is the image in the FIRST gallery state recorded after the latest record?',
         CASE WHEN in_first_after THEN 'image STILL PRESENT in the first later state; removal not yet bounded' ELSE 'image ABSENT from the first later state: removal bounded (upper bound = that state)' END,
         count(*), count(DISTINCT lid) FROM obj WHERE first_after_ts IS NOT NULL GROUP BY op, 3
  UNION ALL SELECT 7, '7 ' || op || ': CONFIRMED removal window = latest record to the first later state that excludes the image (an UPPER bound on when it left)',
         CASE WHEN first_after_ts - rec_ts <= interval '1 day' THEN 'within 1 day' WHEN first_after_ts - rec_ts <= interval '7 days' THEN '2-7 days'
              WHEN first_after_ts - rec_ts <= interval '30 days' THEN '8-30 days' ELSE 'over 30 days' END,
         count(*), count(DISTINCT lid) FROM obj WHERE first_after_ts IS NOT NULL AND NOT in_first_after GROUP BY op, 3
  UNION ALL SELECT 8, '8 ' || op || ': dates of those bounding states (earliest to latest; images absent from them only)', coalesce(to_char(min(first_after_ts), 'YYYY-MM-DD') || ' to ' || to_char(max(first_after_ts), 'YYYY-MM-DD'), 'none'), count(*), count(DISTINCT lid)
         FROM obj WHERE first_after_ts IS NOT NULL AND NOT in_first_after GROUP BY op
  UNION ALL SELECT 9, '9 ' || op || ': image count of the first later state vs the current gallery (property-images entries)',
         CASE WHEN first_after_n = cur_n THEN 'same count' WHEN first_after_n > cur_n THEN 'state larger than the current gallery' ELSE 'state smaller than the current gallery' END,
         count(*), count(DISTINCT lid) FROM obj WHERE first_after_ts IS NOT NULL GROUP BY op, 3
  UNION ALL SELECT 10, '10 ' || op || ': listing''s LATEST snapshot vs its current gallery (listings)',
         CASE WHEN sk IS NULL THEN 'no snapshot' WHEN only_snap = 0 AND only_cur = 0 THEN 'same image set'
              WHEN only_snap > 0 AND only_cur = 0 THEN 'snapshot has images the gallery lacks' WHEN only_snap = 0 AND only_cur > 0 THEN 'gallery has images the snapshot lacks' ELSE 'both differ' END,
         count(*), count(DISTINCT lid) FROM lst GROUP BY op, 3
  UNION ALL SELECT 11, '11 ' || op || ': Smart Import records AFTER the latest record',
         CASE WHEN imports_after = 0 THEN 'none' ELSE 'at least one (first: ' || to_char(first_import_after, 'YYYY-MM') || ')' END, count(*), count(DISTINCT lid) FROM obj GROUP BY op, 3
  UNION ALL SELECT 12, '12 ' || op || ': listing row and current gallery (no snapshot is written when a save empties the gallery)',
         CASE WHEN NOT listing_row THEN 'no listing row' WHEN cur_n = 0 THEN 'current gallery has no property-images entries' ELSE 'current gallery has images' END, count(*), count(DISTINCT lid) FROM obj GROUP BY op, 3
) t ORDER BY s, section, label;
