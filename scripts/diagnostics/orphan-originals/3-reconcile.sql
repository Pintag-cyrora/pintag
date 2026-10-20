-- 3-reconcile.sql -- READ-ONLY per-object reconciliation of the "originals referenced by nothing". ONE plain SELECT: no
-- transaction control, no SET/RESET, no procedural code, no temp tables, no writes. Runs only after the preflight passed
-- (including its reconcile-schema verdict), inside a READ ONLY transaction opened by the psql command line.
--
-- The object set is EXACTLY the one in 2-diagnostic.sql: bucket property-images, not under renditions/, no property_images row
-- (raw path equality, any status) and not referenced -- as stored OR percent-decoded -- by properties.images, unit_types.images
-- or parties.photo_url. For each object it reports every reference / history source that mentions it:
--   current:  properties.images, unit_types.images, parties.photo_url, property_images        (all "no" by construction)
--   history:  gallery_assignments.photo_paths, properties_row_snapshots.row_data -> images, import_records.raw_payload (any
--             string that contains /property-images/), listing_image_snapshots, import_images
--   plus:     the upload time embedded in the file name, an eTag duplicate candidate (same eTag AND size as an object that IS
--             referenced by a live listing / unit / agent / active registry row -- a candidate, never proof), and rendition files.
-- Output per object: names, sizes, dates, record ids and listing ids only. No titles, contacts, operators, or payload text.
-- JSON is read with jsonb_path_query('strict $.**') and only STRING values are used, so any shape (array, object, scalar, null,
-- nested) is safe; a value that is not a usable path simply matches nothing (see 4-source-health.sql for how many rows that is).
-- Each object gets exactly ONE category (evidence_count counts history sources + the duplicate candidate):
--   >= 2 pieces of evidence ............................ multiple_evidence            (flagged, not forced into one source)
--   exactly one history source ......................... history_<source>_only
--   duplicate candidate only ........................... duplicate_of_live_image_only
--   no evidence, upload time before the first gallery snapshot ever recorded ... no_evidence_uploaded_before_provenance
--   no evidence, upload time after it .................. no_evidence_uploaded_after_provenance
--   no evidence and no usable upload time / no provenance start ... unclassifiable_no_evidence
WITH obj_all AS (
  SELECT so.name,
         CASE WHEN to_jsonb(so)->>'created_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
              THEN (to_jsonb(so)->>'created_at')::timestamptz END AS created_at,
         CASE WHEN to_jsonb(so)->'metadata'->>'size' ~ '^[0-9]{1,15}$'
              THEN (to_jsonb(so)->'metadata'->>'size')::bigint END AS size,
         nullif(coalesce(to_jsonb(so)->'metadata'->>'eTag', to_jsonb(so)->'metadata'->>'etag'), '') AS etag
  FROM storage.objects so
  WHERE so.bucket_id = 'property-images' AND so.name NOT LIKE 'renditions/%'
    AND current_setting('transaction_read_only') = 'on'),
rend AS (
  SELECT substring(so.name from '^renditions/(.+)/[^/]+$') AS stem, substring(so.name from '([^/]+)[.]webp$') AS profile
  FROM storage.objects so WHERE so.bucket_id = 'property-images' AND so.name LIKE 'renditions/%'),
names_raw AS (   -- every candidate name, tagged with its source; n = text after the last /property-images/, query string dropped
  SELECT 'live_listing' AS src, NULL::text AS rec_id, NULL::timestamptz AS rec_date, NULL::text AS extra1, NULL::text AS extra2,
         split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) AS n
    FROM properties p,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
   WHERE u.url LIKE '%/property-images/%'
  UNION ALL
  SELECT 'live_unit', NULL, NULL, NULL, NULL, split_part(regexp_replace(img, '^.*/property-images/', ''), '?', 1)
    FROM unit_types ut, unnest(coalesce(ut.images, ARRAY[]::text[])) AS img WHERE img LIKE '%/property-images/%'
  UNION ALL
  SELECT 'live_agent', NULL, NULL, NULL, NULL, split_part(regexp_replace(photo_url, '^.*/property-images/', ''), '?', 1)
    FROM parties WHERE photo_url LIKE '%/property-images/%'
  UNION ALL
  SELECT 'gallery_assignment', g.id::text, g.created_at, g.op, g.listing_id::text,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1)
    FROM gallery_assignments g, LATERAL jsonb_path_query(g.photo_paths, 'strict $.**') AS v
   WHERE jsonb_typeof(v) = 'string'
  UNION ALL
  SELECT 'deleted_listing_snapshot', r.id::text, r.created_at, r.op, r.property_id::text,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1)
    FROM properties_row_snapshots r, LATERAL jsonb_path_query(r.row_data -> 'images', 'strict $.**') AS v
   WHERE jsonb_typeof(v) = 'string'
  UNION ALL
  SELECT 'import_record', i.id::text, i.imported_at, NULL, i.listing_id::text,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1)
    FROM import_records i, LATERAL jsonb_path_query(i.raw_payload, 'strict $.**') AS v
   WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}') LIKE '%/property-images/%'
  UNION ALL
  SELECT 'listing_snapshot', s.id::text, s.created_at, NULL, s.listing_id::text,
         split_part(regexp_replace(t.x, '^.*/property-images/', ''), '?', 1)
    FROM listing_image_snapshots s, LATERAL (VALUES (s.storage_url), (s.storage_path)) AS t(x) WHERE t.x IS NOT NULL
  UNION ALL
  SELECT 'import_image', m.id::text, m.uploaded_at, NULL, m.listing_id::text,
         split_part(regexp_replace(t.x, '^.*/property-images/', ''), '?', 1)
    FROM import_images m, LATERAL (VALUES (m.storage_url), (m.storage_path)) AS t(x) WHERE t.x IS NOT NULL),
forms AS (   -- each name as stored AND fully percent-decoded (urllib.parse.unquote equivalent), compared as BYTES
  SELECT src, rec_id, rec_date, extra1, extra2, convert_to(n, 'UTF8') AS b FROM names_raw WHERE n <> ''
  UNION ALL
  SELECT src, rec_id, rec_date, extra1, extra2, dec FROM (
    SELECT src, rec_id, rec_date, extra1, extra2,
           (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1])
                                          ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM names_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d
   WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (   -- identical to 2-diagnostic.sql
  SELECT o.* FROM obj_all o
   WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM forms f WHERE f.src IN ('live_listing', 'live_unit', 'live_agent') AND f.b = convert_to(o.name, 'UTF8'))),
hit AS (
  SELECT o.name, f.src, count(*) AS hits, count(DISTINCT f.rec_id) AS records, max(f.rec_date) AS last_date,
         (array_agg(f.rec_id ORDER BY f.rec_date DESC NULLS LAST, f.rec_id))[1] AS last_record,
         (array_agg(f.extra1 ORDER BY f.rec_date DESC NULLS LAST, f.rec_id))[1] AS last_extra1,
         (array_agg(f.extra2 ORDER BY f.rec_date DESC NULLS LAST, f.rec_id))[1] AS last_extra2
    FROM orph o JOIN forms f ON f.b = convert_to(o.name, 'UTF8')
   GROUP BY o.name, f.src),
live_obj AS (   -- objects that ARE referenced by a live listing / unit / agent / active registry row
  SELECT a.name, a.etag, a.size FROM obj_all a
   WHERE a.etag IS NOT NULL
     AND (EXISTS (SELECT 1 FROM forms f WHERE f.src IN ('live_listing', 'live_unit', 'live_agent') AND f.b = convert_to(a.name, 'UTF8'))
          OR EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = a.name AND pi.status = 'active'))),
dup AS (
  SELECT o.name, count(*) AS dup_count, (array_agg(l.name ORDER BY l.name))[1] AS dup_of
    FROM orph o JOIN live_obj l ON l.etag = o.etag AND l.size IS NOT DISTINCT FROM o.size AND l.name <> o.name
   WHERE o.etag IS NOT NULL GROUP BY o.name),
rend_agg AS (SELECT stem, string_agg(DISTINCT profile, ',' ORDER BY profile) AS profiles FROM rend WHERE stem IS NOT NULL GROUP BY stem),
prov AS (SELECT min(created_at) AS first_snapshot FROM listing_image_snapshots),
base AS (
  SELECT o.name, o.size, o.created_at,
         CASE WHEN o.name ~ '^[0-9]{13}-' AND to_timestamp(substr(o.name, 1, 13)::bigint / 1000.0) BETWEEN timestamptz '2020-01-01' AND now() + interval '1 day'
              THEN to_timestamp(substr(o.name, 1, 13)::bigint / 1000.0) END AS name_ts,
         coalesce(hl.hits, 0) > 0 AS ref_listing, coalesce(hu.hits, 0) > 0 AS ref_unit, coalesce(ha.hits, 0) > 0 AS ref_agent,
         EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name) AS ref_registry,
         coalesce(ga.hits, 0) AS ga_hits, ga.records AS ga_records, ga.last_date AS ga_date, ga.last_record AS ga_record, ga.last_extra1 AS ga_op, ga.last_extra2 AS ga_listing,
         coalesce(ds.hits, 0) AS ds_hits, ds.records AS ds_records, ds.last_date AS ds_date, ds.last_record AS ds_record, ds.last_extra1 AS ds_op, ds.last_extra2 AS ds_listing,
         coalesce(ir.hits, 0) AS ir_hits, ir.records AS ir_records, ir.last_date AS ir_date, ir.last_record AS ir_record, ir.last_extra2 AS ir_listing,
         coalesce(ls.hits, 0) AS ls_hits, ls.records AS ls_records, ls.last_date AS ls_date, ls.last_record AS ls_record, ls.last_extra2 AS ls_listing,
         coalesce(ii.hits, 0) AS ii_hits, ii.records AS ii_records, ii.last_date AS ii_date, ii.last_record AS ii_record, ii.last_extra2 AS ii_listing,
         d.dup_of, coalesce(d.dup_count, 0) AS dup_count, ra.profiles AS renditions, p.first_snapshot
    FROM orph o
    LEFT JOIN hit hl ON hl.name = o.name AND hl.src = 'live_listing'
    LEFT JOIN hit hu ON hu.name = o.name AND hu.src = 'live_unit'
    LEFT JOIN hit ha ON ha.name = o.name AND ha.src = 'live_agent'
    LEFT JOIN hit ga ON ga.name = o.name AND ga.src = 'gallery_assignment'
    LEFT JOIN hit ds ON ds.name = o.name AND ds.src = 'deleted_listing_snapshot'
    LEFT JOIN hit ir ON ir.name = o.name AND ir.src = 'import_record'
    LEFT JOIN hit ls ON ls.name = o.name AND ls.src = 'listing_snapshot'
    LEFT JOIN hit ii ON ii.name = o.name AND ii.src = 'import_image'
    LEFT JOIN dup d ON d.name = o.name
    LEFT JOIN rend_agg ra ON ra.stem = regexp_replace(o.name, '[.][A-Za-z0-9]+$', '')
    CROSS JOIN prov p),
scored AS (
  SELECT b.*,
         (b.ga_hits > 0)::int + (b.ds_hits > 0)::int + (b.ir_hits > 0)::int + (b.ls_hits > 0)::int + (b.ii_hits > 0)::int AS history_sources,
         concat_ws(',', CASE WHEN b.ga_hits > 0 THEN 'gallery_assignment' END, CASE WHEN b.ds_hits > 0 THEN 'deleted_listing_snapshot' END,
                        CASE WHEN b.ir_hits > 0 THEN 'import_record' END, CASE WHEN b.ls_hits > 0 THEN 'listing_snapshot' END,
                        CASE WHEN b.ii_hits > 0 THEN 'import_image' END, CASE WHEN b.dup_count > 0 THEN 'duplicate_candidate' END) AS matched_sources
    FROM base b)
SELECT s.name AS object_name, s.size AS size_bytes, s.created_at AS storage_created_at, s.name_ts AS name_upload_ts,
       s.ref_listing, s.ref_unit, s.ref_agent, s.ref_registry,
       s.ga_hits AS gallery_assignment_hits, s.ga_date AS gallery_assignment_last_date, s.ga_record AS gallery_assignment_record,
       s.ga_op AS gallery_assignment_op, s.ga_listing AS gallery_assignment_listing,
       s.ds_hits AS deleted_snapshot_hits, s.ds_date AS deleted_snapshot_last_date, s.ds_record AS deleted_snapshot_record,
       s.ds_op AS deleted_snapshot_op, s.ds_listing AS deleted_snapshot_property,
       s.ir_hits AS import_record_hits, s.ir_date AS import_record_last_date, s.ir_record AS import_record_record, s.ir_listing AS import_record_listing,
       s.ls_hits AS listing_snapshot_hits, s.ls_date AS listing_snapshot_last_date, s.ls_record AS listing_snapshot_record, s.ls_listing AS listing_snapshot_listing,
       s.ii_hits AS import_image_hits, s.ii_date AS import_image_last_date, s.ii_record AS import_image_record, s.ii_listing AS import_image_listing,
       s.dup_of AS duplicate_of_live_object, s.dup_count AS duplicate_candidate_count,
       coalesce(s.renditions, '') AS renditions_present,
       s.history_sources + (s.dup_count > 0)::int AS evidence_count, s.matched_sources,
       CASE WHEN s.history_sources + (s.dup_count > 0)::int >= 2 THEN 'multiple_evidence'
            WHEN s.ga_hits > 0 THEN 'history_gallery_assignment_only'
            WHEN s.ds_hits > 0 THEN 'history_deleted_listing_snapshot_only'
            WHEN s.ir_hits > 0 THEN 'history_import_record_only'
            WHEN s.ls_hits > 0 THEN 'history_listing_snapshot_only'
            WHEN s.ii_hits > 0 THEN 'history_import_image_only'
            WHEN s.dup_count > 0 THEN 'duplicate_of_live_image_only'
            WHEN s.name_ts IS NULL OR s.first_snapshot IS NULL THEN 'unclassifiable_no_evidence'
            WHEN s.name_ts < s.first_snapshot THEN 'no_evidence_uploaded_before_provenance'
            ELSE 'no_evidence_uploaded_after_provenance' END AS category,
       CASE WHEN s.history_sources + (s.dup_count > 0)::int >= 2 THEN 'matches several sources (see matched_sources); not forced into one'
            WHEN s.ga_hits > 0 THEN 'named in gallery-recovery assign/unassign history; no live reference'
            WHEN s.ds_hits > 0 THEN 'was in the gallery of a listing that was later deleted (full-row snapshot)'
            WHEN s.ir_hits > 0 THEN 'was fetched or uploaded by a saved Smart Import (raw payload) but is not in the live gallery'
            WHEN s.ls_hits > 0 THEN 'was in a saved gallery snapshot but is no longer referenced'
            WHEN s.ii_hits > 0 THEN 'is mapped to an import record but is no longer referenced'
            WHEN s.dup_count > 0 THEN 'same eTag and size as a live-referenced object: duplicate CANDIDATE only, not proof'
            WHEN s.name_ts IS NULL THEN 'inconclusive: no history and the name has no usable upload time'
            WHEN s.first_snapshot IS NULL THEN 'inconclusive: no history and no gallery snapshot exists to date provenance'
            WHEN s.name_ts < s.first_snapshot THEN 'inconclusive: uploaded before gallery provenance existed, so it may have been in an unrecorded gallery'
            ELSE 'uploaded after provenance began and found in no gallery history: most likely never saved in a gallery (provenance writes are best effort)' END AS explanation
  FROM scored s
 ORDER BY s.name;
