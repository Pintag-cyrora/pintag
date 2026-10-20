-- 4-source-health.sql -- READ-ONLY. How much of each history source can 3-reconcile.sql actually read? ONE plain SELECT, aggregate
-- counts and dates only (no names, no payload text). A row counts as "usable" when it yields at least one non-empty candidate
-- name by the same rules 3-reconcile.sql uses (JSON read with jsonb_path_query('strict $.**'), string values only; raw_payload
-- strings must contain /property-images/). Rows that are null, scalar, or contain no usable string are "unusable": they match
-- nothing, so this shows how much history could not be searched at all.
WITH rows_all AS (
  SELECT 'gallery_assignments.photo_paths' AS source, g.created_at AS rec_date,
         EXISTS (SELECT 1 FROM jsonb_path_query(g.photo_paths, 'strict $.**') AS v WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}') <> '') AS usable
    FROM gallery_assignments g
  UNION ALL
  SELECT 'properties_row_snapshots.row_data->images', r.created_at,
         EXISTS (SELECT 1 FROM jsonb_path_query(r.row_data -> 'images', 'strict $.**') AS v WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}') <> '')
    FROM properties_row_snapshots r
  UNION ALL
  SELECT 'import_records.raw_payload', i.imported_at,
         EXISTS (SELECT 1 FROM jsonb_path_query(i.raw_payload, 'strict $.**') AS v WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}') LIKE '%/property-images/%')
    FROM import_records i
  UNION ALL
  SELECT 'listing_image_snapshots', s.created_at, coalesce(s.storage_url, '') <> '' OR coalesce(s.storage_path, '') <> ''
    FROM listing_image_snapshots s
  UNION ALL
  SELECT 'import_images', m.uploaded_at, coalesce(m.storage_url, '') <> '' OR coalesce(m.storage_path, '') <> ''
    FROM import_images m)
SELECT source, count(*) AS rows_total, count(*) FILTER (WHERE usable) AS rows_usable, count(*) FILTER (WHERE NOT usable) AS rows_unusable,
       min(rec_date) AS first_date, max(rec_date) AS last_date
  FROM rows_all GROUP BY source ORDER BY source;
