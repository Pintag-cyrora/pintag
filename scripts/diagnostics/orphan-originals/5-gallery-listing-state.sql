-- 5-gallery-listing-state.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables,
-- no writes. Runs only after the preflight passed (including reconcile-schema and gallery-schema), inside a READ ONLY transaction
-- opened by the psql command line; outside one it returns no rows at all.
--
-- Question: for the unreferenced originals that Gallery Recovery history names, does the listing of the LATEST history record still
-- exist, and does that listing's current properties.images gallery still reference the photo?
--
-- Population: EXACTLY the objects 2-diagnostic.sql / 3-reconcile.sql count (bucket property-images, not under renditions/, no
-- property_images row, and not referenced -- as stored or percent-decoded -- by properties.images, unit_types.images or
-- parties.photo_url). One output row per such object, with or without history. (summarize_gallery.py checks the row count against
-- the stage-2 total; names are blanked for objects without history before anything is published.)
--
-- Latest record: the gallery_assignments record naming the object (JSON read with jsonb_path_query('strict $.**'), string values
-- only, raw and percent-decoded, compared as bytes) with the greatest created_at. If SEVERAL records share that exact timestamp and
-- DISAGREE on listing or operation, the object is 'ambiguous': no listing is picked, listing_state is blank, and the number of tied
-- records / tied listings is reported instead. (Identical duplicate records at the same instant are not a conflict.)
--
-- listing_state (of the latest record's listing_id): no_usable_listing_id | listing_missing (no properties row) |
--   listing_soft_deleted (row exists, deleted_at set) | listing_active (row exists, not deleted). photo_in_gallery says whether that
--   listing's CURRENT properties.images references the object (raw or decoded, the same matching as the population rule), so it can
--   only be true if the population definition were inconsistent: summarize_gallery.py treats any 't' as an error.
-- properties.deleted_at is read DIRECTLY and is required by the preflight's gallery-schema verdict (a timestamptz): if it were missing or of the
-- wrong type the run stops before this query, so a listing is never classified 'active' because its deletion state was unknown.
-- properties.updated_at stays optional (read through to_jsonb(); missing -> 'unknown' for the changed-after-record signal only).
-- Vocabulary is closed: operation, confidence and how-it-was-recorded print only known values, otherwise 'other' / 'n/a' / '(other)'.
-- No titles, contacts, operators or payload text are selected.
WITH obj_all AS (
  SELECT so.name,
         CASE WHEN to_jsonb(so)->'metadata'->>'size' ~ '^[0-9]{1,15}$' THEN (to_jsonb(so)->'metadata'->>'size')::bigint END AS size
    FROM storage.objects so
   WHERE so.bucket_id = 'property-images' AND so.name NOT LIKE 'renditions/%'
     AND current_setting('transaction_read_only') = 'on'),
live_raw AS (   -- every live reference; pid = the listing for properties.images, NULL for units and agents
  SELECT p.id::text AS pid, split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) AS n
    FROM properties p, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
   WHERE u.url LIKE '%/property-images/%'
  UNION ALL SELECT NULL, split_part(regexp_replace(img, '^.*/property-images/', ''), '?', 1)
    FROM unit_types ut, unnest(coalesce(ut.images, ARRAY[]::text[])) AS img WHERE img LIKE '%/property-images/%'
  UNION ALL SELECT NULL, split_part(regexp_replace(photo_url, '^.*/property-images/', ''), '?', 1) FROM parties WHERE photo_url LIKE '%/property-images/%'),
ga_raw AS (
  SELECT g.id::text AS rec_id, g.created_at AS rec_ts, g.op::text AS op, g.listing_id::text AS listing_id,
         CASE WHEN g.cluster_id IN ('by-listing', 'gallery-editor', 'move', 'no-matching') THEN g.cluster_id ELSE '(other)' END AS cluster_kind,
         CASE WHEN g.confidence IN ('high', 'medium', 'low') THEN g.confidence ELSE 'n/a' END AS confidence,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1) AS n
    FROM gallery_assignments g, LATERAL jsonb_path_query(g.photo_paths, 'strict $.**') AS v WHERE jsonb_typeof(v) = 'string'),
live_forms AS (   -- as stored AND fully percent-decoded (urllib.parse.unquote equivalent), as BYTES
  SELECT pid, convert_to(n, 'UTF8') AS b FROM live_raw WHERE n <> ''
  UNION ALL
  SELECT pid, dec FROM (
    SELECT pid, (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                   FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM live_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
ga_forms AS (
  SELECT rec_id, rec_ts, op, listing_id, cluster_kind, confidence, convert_to(n, 'UTF8') AS b FROM ga_raw WHERE n <> ''
  UNION ALL
  SELECT rec_id, rec_ts, op, listing_id, cluster_kind, confidence, dec FROM (
    SELECT rec_id, rec_ts, op, listing_id, cluster_kind, confidence,
           (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM ga_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (   -- identical to 2-diagnostic.sql / 3-reconcile.sql
  SELECT o.* FROM obj_all o
   WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM live_forms f WHERE f.b = convert_to(o.name, 'UTF8'))),
hits AS (   -- one row per (object, record): the raw and decoded forms of one record are the same record
  SELECT DISTINCT o.name, f.rec_id, f.rec_ts, f.op, f.listing_id, f.cluster_kind, f.confidence
    FROM orph o JOIN ga_forms f ON f.b = convert_to(o.name, 'UTF8')),
mx AS (SELECT name, max(rec_ts) AS max_ts FROM hits GROUP BY name),
tied AS (   -- the records at the latest instant, and how many DIFFERENT (listing, operation) answers they give
  SELECT h.name, count(*) AS tied_records, count(DISTINCT h.listing_id) AS tied_listings, count(DISTINCT (h.listing_id, h.op)) AS tied_variants
    FROM hits h JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts GROUP BY h.name),
latest AS (
  SELECT DISTINCT ON (h.name) h.*, t.tied_records, t.tied_listings, t.tied_variants
    FROM hits h JOIN tied t ON t.name = h.name JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts
   ORDER BY h.name, h.rec_id),
state AS (
  SELECT o.name, o.size, l.rec_id, l.rec_ts, l.op, l.listing_id, l.cluster_kind, l.confidence, l.tied_records, l.tied_listings, (l.tied_variants > 1) AS ambiguous,
         (l.name IS NOT NULL) AS has_history,
         CASE WHEN l.name IS NULL OR l.tied_variants > 1 THEN NULL
              WHEN l.listing_id IS NULL OR l.listing_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'no_usable_listing_id'
              WHEN p.id IS NULL THEN 'listing_missing'
              WHEN p.deleted_at IS NOT NULL THEN 'listing_soft_deleted'
              ELSE 'listing_active' END AS listing_state,
         (p.id IS NOT NULL AND EXISTS (SELECT 1 FROM live_forms f WHERE f.pid = p.id::text AND f.b = convert_to(o.name, 'UTF8'))) AS photo_in_gallery,
         CASE WHEN p.id IS NULL THEN NULL WHEN jsonb_typeof(p.images) = 'array' THEN jsonb_array_length(p.images) ELSE 0 END AS gallery_size,
         CASE WHEN p.id IS NULL OR l.tied_variants > 1 OR l.rec_ts IS NULL OR to_jsonb(p)->>'updated_at' IS NULL THEN 'unknown'
              WHEN (to_jsonb(p)->>'updated_at')::timestamptz > l.rec_ts THEN 'changed_after_record' ELSE 'not_changed_after_record' END AS touched
    FROM orph o
    LEFT JOIN latest l ON l.name = o.name
    LEFT JOIN properties p ON p.id::text = l.listing_id AND l.tied_variants = 1)
SELECT s.name AS object_name, s.size AS size_bytes, s.has_history,
       CASE WHEN NOT s.has_history THEN '' WHEN s.ambiguous THEN 'ambiguous' WHEN s.op IN ('assign', 'unassign') THEN s.op ELSE 'other' END AS latest_op,
       CASE WHEN s.ambiguous THEN NULL ELSE s.listing_id END AS listing_id,
       CASE WHEN s.ambiguous THEN NULL ELSE s.rec_id END AS record_id,
       s.rec_ts AS record_date, s.tied_records, s.tied_listings,
       coalesce(s.listing_state, '') AS listing_state, coalesce(s.photo_in_gallery, false) AS photo_in_gallery, s.gallery_size AS listing_gallery_size,
       CASE WHEN NOT s.has_history THEN '' ELSE s.touched END AS listing_changed_after_record,
       CASE WHEN NOT s.has_history OR s.ambiguous THEN '' ELSE s.confidence END AS confidence,
       CASE WHEN NOT s.has_history OR s.ambiguous THEN '' ELSE s.cluster_kind END AS recorded_via
  FROM state s
 ORDER BY s.name;
