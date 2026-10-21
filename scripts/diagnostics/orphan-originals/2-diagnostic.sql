-- 2-diagnostic.sql -- READ-ONLY data diagnostic for "Originals referenced by nothing". ONE plain SELECT: no
-- transaction control, no SET/RESET, no procedural code, no temp tables, no writes. Run it only after 1-preflight.sql
-- passed, inside a READ ONLY transaction opened by the psql command line (not by this file).
-- Output = aggregate counts and a byte total ONLY: no object name, path or original filename is ever selected (the former
-- section 7 sample names were removed; per-object detail belongs in the validated reconciliation report).
--
-- Orphan selection == scripts/image-integrity.py + image_integrity_lib.py classify() "orphan_original":
--   bucket property-images, not under renditions/, no property_images row (ANY status), and the name is not
--   referenced -- as stored OR fully percent-decoded -- by properties.images, unit_types.images, parties.photo_url
--   (name = text after the last '/property-images/', query string dropped).
-- Optional columns (storage.objects.created_at/metadata, properties.deleted_at/workflow_status) are read through
-- to_jsonb(); a malformed size counts as unknown. If the session is NOT read-only, the object list is empty (total 0).
WITH obj AS (
  SELECT so.name,
         CASE WHEN to_jsonb(so)->>'created_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
              THEN (to_jsonb(so)->>'created_at')::timestamptz END AS created_at,
         CASE WHEN to_jsonb(so)->'metadata'->>'size' ~ '^[0-9]{1,15}$'
              THEN (to_jsonb(so)->'metadata'->>'size')::bigint END AS size
  FROM storage.objects so
  WHERE so.bucket_id = 'property-images'
    AND current_setting('transaction_read_only') = 'on'),
refs_raw AS (
  SELECT split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) AS n
    FROM properties p,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
   WHERE u.url LIKE '%/property-images/%'
  UNION
  SELECT split_part(regexp_replace(img, '^.*/property-images/', ''), '?', 1)
    FROM unit_types ut, unnest(coalesce(ut.images, ARRAY[]::text[])) AS img
   WHERE img LIKE '%/property-images/%'
  UNION
  SELECT split_part(regexp_replace(photo_url, '^.*/property-images/', ''), '?', 1)
    FROM parties WHERE photo_url LIKE '%/property-images/%'),
refs AS (   -- reference bytes: as stored, and percent-decoded (urllib.parse.unquote). Compared as BYTES so that
            -- an invalid UTF-8 sequence in a reference can never raise an error.
  SELECT convert_to(n, 'UTF8') AS b FROM refs_raw WHERE n <> ''
  UNION
  SELECT dec FROM (
    SELECT CASE WHEN n ~ '%[0-9A-Fa-f]{2}' THEN
      (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1])
                                     ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
         FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) END AS dec
    FROM refs_raw WHERE n <> '') d
  WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (
  SELECT o.*,
    CASE WHEN o.name ~ '^[0-9]{13}-[a-z0-9]{6}\.jpg$' THEN 'admin upload  <ms>-<rand6>.jpg'
         WHEN o.name ~ '^[0-9]{13}-'                  THEN 'add-property upload  <ms>-<original filename>'
         WHEN o.name LIKE 'agents/%'                  THEN 'agent photo  agents/<id>/<ts>.<ext>'
         WHEN o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'    THEN 'uuid-named'
         WHEN o.name ~ '^\.'                          THEN 'hidden/placeholder'
         ELSE 'other' END AS pattern,
    EXISTS (SELECT 1 FROM listing_image_snapshots s WHERE s.storage_path = o.name) AS in_snap,
    EXISTS (SELECT 1 FROM import_images i WHERE i.storage_path = o.name)           AS in_import
  FROM obj o
  WHERE o.name NOT LIKE 'renditions/%'
    AND NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
    AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.b = convert_to(o.name, 'UTF8')))
SELECT section, label, n FROM (
  SELECT 0 AS s, '0 session guard (must be on, else the object list is deliberately empty)' AS section,
         'transaction_read_only=' || current_setting('transaction_read_only') AS label, NULL::bigint AS n
  UNION ALL SELECT 1, '1 TOTAL - must equal "Originals referenced by nothing" in the report',
         pg_size_pretty(coalesce(sum(size), 0)) || ' (' || count(*) FILTER (WHERE size IS NULL) || ' with unknown size)', count(*) FROM orph
  UNION ALL SELECT 2, '2 by naming pattern', pattern, count(*) FROM orph GROUP BY pattern
  UNION ALL SELECT 3, '3 by upload month', coalesce(to_char(date_trunc('month', created_at), 'YYYY-MM'), 'unknown'), count(*) FROM orph GROUP BY 3
  UNION ALL SELECT 4, '4 recorded in history tables (no-FK provenance)',
         'gallery_snapshots=' || in_snap::text || ' import_images=' || in_import::text, count(*) FROM orph GROUP BY in_snap, in_import
  UNION ALL SELECT 5, '5 snapshot-mapped: state of the listing',
         CASE WHEN p.id IS NULL THEN 'listing hard-deleted'
              WHEN to_jsonb(p)->>'deleted_at' IS NOT NULL THEN 'listing soft-deleted'
              ELSE 'listing exists (' || coalesce(to_jsonb(p)->>'workflow_status', '?') || ')' END, count(DISTINCT o.name)
         FROM orph o JOIN listing_image_snapshots s ON s.storage_path = o.name
         LEFT JOIN properties p ON p.id::text = s.listing_id::text GROUP BY 3
  UNION ALL SELECT 6, '6 names with characters that could hide an encoding mismatch (space % ( ) + non-ascii)', '', count(*)
         FROM orph WHERE name ~ '[ %()+]' OR name ~ '[^\x01-\x7f]'
) t ORDER BY s, label;
