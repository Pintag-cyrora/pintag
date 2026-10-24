-- 9-unusable-provenance-events.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no
-- writes. Runs only after the preflight passed (including reconcile-schema, gallery-schema, history-schema and provenance-schema), inside a READ ONLY
-- transaction opened by the psql command line; outside one every count below is zero and the guard row says so.
--
-- Question: stage 8 (8-gallery-provenance-photos-changed.sql) called some analysed Gallery Recovery 'assign' images "unusable": they have photos_changed
-- events inside their record-to-snapshot window, but NONE of those events has a before-list AND an after-list. WHY (what shape do the two stored values
-- have), and can the other existing records (the event's linked snapshot, delete snapshots of the listing row, Gallery Recovery records, import records,
-- other change-log events, the current gallery) say anything about THESE objects? Scope: exactly the objects stage 8 classifies 'unusable' (the first
-- part of this file is stage 8 copied verbatim up to its classification; nothing outside that set is analysed or counted).
--
-- Why an event can be unusable (verified in listing-provenance.js, admin.html and the listing_provenance migration, not assumed):
--   * captureEdit stores old_value = the listing's images BEFORE the save and new_value = the images being saved, each normalised so that undefined / ''
--     become null; the column is jsonb. A non-array value is therefore a stored null (SQL NULL or JSON null: no gallery before) or, if the data was ever
--     written some other way, a JSON string / object / number / boolean. stage 8 only reads values whose jsonb type is 'array'.
--   * This file reports the jsonb TYPE of each side (fixed labels, never the value) and, for the side(s) that ARE lists, whether they contain the image
--     (same exact matching as stage 8: bytes as stored or percent-decoded; relative path under /property-images/ or the external URL without its
--     query string; no prefix / substring matching). A JSON string is NOT parsed: it is reported as "string" and counted as no list.
-- Direct vs circumstantial (kept apart in the output, nothing here infers a removal from a timestamp):
--   * about THIS image, one side of an edit is direct: a before-list that has it, an after-list that has it or lacks it. A linked snapshot is the gallery
--     the editor saved after that edit (it also confirms the save). A delete snapshot (properties_row_snapshots) is the listing row as it was when it was
--     soft-deleted: a recorded gallery state, not a removal.
--   * Gallery Recovery records, import records and other change-log events are CIRCUMSTANTIAL: they show what else happened on the listing, never that
--     it changed this gallery. "No event" is not "no change": events are best-effort and Gallery Recovery writes none.
-- Output is counts and fixed labels only: no object name, image list, listing id, event id, record id, actor or payload is ever selected.
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
  SELECT g.id::text AS rec_id, g.created_at AS rec_ts, g.op::text AS op, g.listing_id::text AS listing_id, g.operator::text AS operator,
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
  SELECT rec_id, rec_ts, op, listing_id, operator, convert_to(n, 'UTF8') AS b FROM ga_raw WHERE n <> ''
  UNION ALL
  SELECT rec_id, rec_ts, op, listing_id, operator, dec FROM (
    SELECT rec_id, rec_ts, op, listing_id, operator,
           (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM ga_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (
  SELECT o.name FROM obj_all o
   WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM live_forms f WHERE f.b = convert_to(o.name, 'UTF8'))),
hits AS (SELECT DISTINCT o.name, f.rec_id, f.rec_ts, f.op, f.listing_id, f.operator FROM orph o JOIN ga_forms f ON f.b = convert_to(o.name, 'UTF8')),
mx AS (SELECT name, max(rec_ts) AS max_ts FROM hits GROUP BY name),
tied AS (
  SELECT h.name, count(DISTINCT (h.listing_id, h.op)) AS tied_variants
    FROM hits h JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts GROUP BY h.name),
latest AS (
  SELECT DISTINCT ON (h.name) h.name, h.rec_ts, h.op, h.listing_id, h.operator, t.tied_variants
    FROM hits h JOIN tied t ON t.name = h.name JOIN mx ON mx.name = h.name AND h.rec_ts IS NOT DISTINCT FROM mx.max_ts
   ORDER BY h.name, h.rec_id),
scope AS (   -- unambiguous latest record, operation assign or unassign, with a usable listing id
  SELECT l.name, l.rec_ts, l.op, l.listing_id, l.operator
    FROM latest l
   WHERE l.tied_variants = 1 AND l.op IN ('assign', 'unassign')
     AND l.listing_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
nm0 AS (   -- image names of the scoped listings: every snapshot row and the CURRENT gallery, one normalization for both sides
  SELECT 'snap' AS kind, s.listing_id::text AS lid, coalesce(s.provenance_event_id::text, s.created_at::text) AS sk, s.created_at AS ts, x.n, x.n2
    FROM listing_image_snapshots s
    CROSS JOIN LATERAL (
      SELECT CASE WHEN y.nu IS NOT NULL THEN y.nu WHEN y.ne IS NOT NULL THEN y.ne ELSE coalesce(y.np, '') END AS n,
             CASE WHEN y.nu IS NOT NULL AND y.np IS NOT NULL AND y.nu <> y.np AND right(y.nu, length(y.np) + 1) <> ('/' || y.np) THEN y.np END AS n2
        FROM (SELECT nullif(split_part(regexp_replace(coalesce(s.storage_path, ''), '^.*/property-images/', ''), '?', 1), '') AS np,
                     CASE WHEN s.storage_url LIKE '%/property-images/%' THEN nullif(split_part(regexp_replace(s.storage_url, '^.*/property-images/', ''), '?', 1), '') END AS nu,
                     nullif(split_part(coalesce(s.storage_url, ''), '?', 1), '') AS ne) y) x
   WHERE EXISTS (SELECT 1 FROM scope sc WHERE sc.listing_id = s.listing_id::text)),
nm AS (   -- role p = the image's name; role a = a second name only when the stored path and the URL disagree (used for the presence lookup only)
  SELECT kind, lid, sk, ts, n, 'p' AS role FROM nm0
  UNION ALL SELECT kind, lid, sk, ts, n2, 'a' FROM nm0 WHERE n2 IS NOT NULL),
nmc AS (   -- canonical bytes b: percent-decoded when the name has %XX escapes, as stored otherwise; rb: the name exactly as stored
  SELECT kind, lid, sk, ts, role, n, convert_to(n, 'UTF8') AS rb,
         CASE WHEN n ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(n, 'UTF8'))
              ELSE convert_to(n, 'UTF8') END AS b
    FROM nm WHERE n <> ''),
states AS (SELECT lid, sk, min(ts) AS state_ts, count(DISTINCT b) AS state_n FROM nmc WHERE kind = 'snap' AND role = 'p' GROUP BY lid, sk),
scope_b AS (   -- each scoped object's own name, as stored (rb) and percent-decoded (b), for the lookup in a state's image set
  SELECT sc.*, convert_to(sc.name, 'UTF8') AS rb,
         CASE WHEN sc.name ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(sc.name, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(sc.name, 'UTF8'))
              ELSE convert_to(sc.name, 'UTF8') END AS b
    FROM scope sc),
obj AS (   -- the scoped objects with their first later gallery state; in_first_after as in 7-gallery-history-vs-snapshots.sql
  SELECT sc.name, sc.op, sc.listing_id AS lid, sc.rec_ts, sc.operator, sc.rb, sc.b, fa.sk AS first_after_sk, fa.state_ts AS first_after_ts,
         (fa.sk IS NOT NULL AND EXISTS (SELECT 1 FROM nmc x WHERE x.kind = 'snap' AND x.lid = sc.listing_id AND x.sk = fa.sk
                                          AND (x.b = sc.rb OR x.b = sc.b OR x.rb = sc.rb OR x.rb = sc.b))) AS in_first_after
    FROM scope_b sc
    LEFT JOIN LATERAL (SELECT st.sk, st.state_ts FROM states st WHERE st.lid = sc.listing_id AND st.state_ts > sc.rec_ts ORDER BY st.state_ts, st.sk LIMIT 1) fa ON true),
bounded AS (SELECT * FROM obj WHERE op = 'assign' AND first_after_ts IS NOT NULL AND NOT in_first_after),
ev AS (
  SELECT lp.id::text AS eid, lp.listing_id::text AS lid, lp.created_at AS ts_client, nullif(lower(btrim(lp.actor)), '') AS actor_n, lp.old_value, lp.new_value,
         (jsonb_typeof(lp.old_value) = 'array' AND jsonb_typeof(lp.new_value) = 'array') AS usable
    FROM listing_provenance lp
   WHERE lp.event_type = 'photos_changed' AND current_setting('transaction_read_only') = 'on'
     AND EXISTS (SELECT 1 FROM bounded b WHERE b.lid = lp.listing_id::text)),
evn0 AS (   -- every entry of each usable event's before / after list, normalized like the snapshot names
  SELECT e.eid, 'old' AS side, CASE WHEN u.url LIKE '%/property-images/%' THEN split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(u.url, '?', 1) END AS n
    FROM ev e, LATERAL jsonb_array_elements_text(e.old_value) AS u(url) WHERE e.usable
  UNION ALL
  SELECT e.eid, 'new', CASE WHEN u.url LIKE '%/property-images/%' THEN split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(u.url, '?', 1) END
    FROM ev e, LATERAL jsonb_array_elements_text(e.new_value) AS u(url) WHERE e.usable),
evn AS (SELECT eid, side, n, convert_to(n, 'UTF8') AS rb, CASE WHEN n ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(n, 'UTF8'))
              ELSE convert_to(n, 'UTF8') END AS b FROM evn0 WHERE n <> ''),
lk AS (SELECT e.eid, min(st.state_ts) AS linked_ts FROM ev e JOIN states st ON st.lid = e.lid AND st.sk = e.eid GROUP BY e.eid),
pair AS (   -- one row per (analysed object, event of its listing inside the record-to-snapshot window)
  SELECT b.name, b.lid, b.first_after_ts, b.first_after_sk, b.operator, e.eid, e.actor_n, e.usable,
         coalesce(lk.linked_ts, e.ts_client) AS ev_ts, (lk.linked_ts IS NOT NULL) AS linked, (e.eid = b.first_after_sk) AS is_bounding,
         (e.usable AND EXISTS (SELECT 1 FROM evn x WHERE x.eid = e.eid AND x.side = 'old' AND (x.b = b.rb OR x.b = b.b OR x.rb = b.rb OR x.rb = b.b))) AS has_old,
         (e.usable AND EXISTS (SELECT 1 FROM evn x WHERE x.eid = e.eid AND x.side = 'new' AND (x.b = b.rb OR x.b = b.b OR x.rb = b.rb OR x.rb = b.b))) AS has_new
    FROM bounded b
    JOIN ev e ON e.lid = b.lid
    LEFT JOIN lk ON lk.eid = e.eid
   WHERE CASE WHEN lk.linked_ts IS NOT NULL THEN lk.linked_ts > b.rec_ts AND lk.linked_ts <= b.first_after_ts
              ELSE e.ts_client > b.rec_ts - interval '1 day' AND e.ts_client <= b.first_after_ts + interval '1 day' END),
agg AS (
  SELECT b.name, b.lid, b.rec_ts, b.first_after_ts, b.operator,
         count(p.eid) AS n_events, count(p.eid) FILTER (WHERE p.usable) AS n_usable,
         count(p.eid) FILTER (WHERE p.usable AND p.has_old AND NOT p.has_new) AS n_remove,
         count(p.eid) FILTER (WHERE p.usable AND p.has_old AND NOT p.has_new AND p.linked) AS n_remove_linked,
         count(p.eid) FILTER (WHERE p.usable AND NOT p.has_old AND p.has_new) AS n_add,
         count(p.eid) FILTER (WHERE p.usable AND NOT p.has_old AND NOT p.has_new) AS n_absent_before,
         min(p.ev_ts) FILTER (WHERE p.usable AND p.has_old AND NOT p.has_new) AS rem_ts,
         min(p.ev_ts) FILTER (WHERE p.usable AND NOT p.has_old AND NOT p.has_new) AS absent_ts,
         bool_or(p.is_bounding) FILTER (WHERE p.usable AND p.has_old AND NOT p.has_new) AS rem_is_bounding,
         (array_agg(p.actor_n) FILTER (WHERE p.usable AND p.has_old AND NOT p.has_new))[1] AS rem_actor
    FROM bounded b LEFT JOIN pair p ON p.name = b.name
   GROUP BY b.name, b.lid, b.rec_ts, b.first_after_ts, b.operator),
cls AS (
  SELECT a.*,
         CASE WHEN n_events = 0 THEN 'none'
              WHEN n_usable = 0 THEN 'unusable'
              WHEN n_remove > 1 OR n_add >= 1 OR (n_remove = 1 AND absent_ts < rem_ts) THEN 'ambiguous'
              WHEN n_remove = 1 AND n_remove_linked = 1 THEN 'direct_confirmed'
              WHEN n_remove = 1 THEN 'direct_unconfirmed'
              WHEN n_absent_before >= 1 THEN 'already_absent'
              ELSE 'circumstantial' END AS c
    FROM agg a)
,
uo AS (SELECT c.name, c.lid, c.rec_ts, c.first_after_ts FROM cls c WHERE c.c = 'unusable'),   -- the ONLY objects analysed below
ub AS (SELECT u.name, u.lid, u.rec_ts, u.first_after_ts, bd.rb, bd.b, bd.first_after_sk FROM uo u JOIN bounded bd ON bd.name = u.name),
lw AS (SELECT lid, min(rec_ts) AS lo, max(first_after_ts) AS hi FROM ub GROUP BY lid),   -- per listing: earliest record .. latest first-later state
win AS (   -- the events stage 8 put in each object's window (same rule: linked -> snapshot server time; unlinked -> browser time +/- 1 day)
  SELECT u.name, u.lid, u.rb, u.b, e.eid, e.old_value, e.new_value, (lk.linked_ts IS NOT NULL) AS linked, (e.eid = u.first_after_sk) AS bounding
    FROM ub u JOIN ev e ON e.lid = u.lid LEFT JOIN lk ON lk.eid = e.eid
   WHERE CASE WHEN lk.linked_ts IS NOT NULL THEN lk.linked_ts > u.rec_ts AND lk.linked_ts <= u.first_after_ts
              ELSE e.ts_client > u.rec_ts - interval '1 day' AND e.ts_client <= u.first_after_ts + interval '1 day' END),
listn AS (   -- every entry of every list that exists: event before/after lists, delete-snapshot galleries, the current gallery; one normalization
  SELECT 'ev' AS src, w.name AS k1, w.eid AS k2, 'old' AS side,
         CASE WHEN x.url LIKE '%/property-images/%' THEN split_part(regexp_replace(x.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(x.url, '?', 1) END AS n
    FROM win w, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.old_value) = 'array' THEN w.old_value ELSE '[]'::jsonb END) AS x(url)
  UNION ALL
  SELECT 'ev', w.name, w.eid, 'new',
         CASE WHEN x.url LIKE '%/property-images/%' THEN split_part(regexp_replace(x.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(x.url, '?', 1) END
    FROM win w, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.new_value) = 'array' THEN w.new_value ELSE '[]'::jsonb END) AS x(url)
  UNION ALL
  SELECT 'rs', u.name, r.id::text, 'img',
         CASE WHEN x.url LIKE '%/property-images/%' THEN split_part(regexp_replace(x.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(x.url, '?', 1) END
    FROM ub u JOIN properties_row_snapshots r ON r.property_id::text = u.lid,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.row_data -> 'images') = 'array' THEN r.row_data -> 'images' ELSE '[]'::jsonb END) AS x(url)
  UNION ALL
  SELECT 'cur', u.name, '', 'img',
         CASE WHEN x.url LIKE '%/property-images/%' THEN split_part(regexp_replace(x.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(x.url, '?', 1) END
    FROM ub u JOIN properties p ON p.id::text = u.lid,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS x(url)),
listc AS (SELECT src, k1, k2, side, n, convert_to(n, 'UTF8') AS rb,
                 CASE WHEN n ~ '%[0-9A-Fa-f]{2}'
                      THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                                       FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(n, 'UTF8'))
                      ELSE convert_to(n, 'UTF8') END AS b
            FROM listn WHERE n <> ''),
pr AS (   -- one row per (unusable object, event in its window): the jsonb type of each side and, for a list, whether it contains the image
  SELECT w.name, w.lid, w.eid, w.linked, w.bounding,
         CASE WHEN w.old_value IS NULL THEN 'SQL NULL' WHEN jsonb_typeof(w.old_value) = 'null' THEN 'JSON null'
              WHEN jsonb_typeof(w.old_value) = 'array' THEN CASE WHEN jsonb_array_length(w.old_value) = 0 THEN 'empty list' ELSE 'list' END
              ELSE jsonb_typeof(w.old_value) END AS old_shape,
         CASE WHEN w.new_value IS NULL THEN 'SQL NULL' WHEN jsonb_typeof(w.new_value) = 'null' THEN 'JSON null'
              WHEN jsonb_typeof(w.new_value) = 'array' THEN CASE WHEN jsonb_array_length(w.new_value) = 0 THEN 'empty list' ELSE 'list' END
              ELSE jsonb_typeof(w.new_value) END AS new_shape,
         coalesce(jsonb_typeof(w.old_value) = 'array', false) AS old_list, coalesce(jsonb_typeof(w.new_value) = 'array', false) AS new_list,
         EXISTS (SELECT 1 FROM listc x WHERE x.src = 'ev' AND x.k1 = w.name AND x.k2 = w.eid AND x.side = 'old' AND (x.b = w.b OR x.b = w.rb OR x.rb = w.rb OR x.rb = w.b)) AS has_old,
         EXISTS (SELECT 1 FROM listc x WHERE x.src = 'ev' AND x.k1 = w.name AND x.k2 = w.eid AND x.side = 'new' AND (x.b = w.b OR x.b = w.rb OR x.rb = w.rb OR x.rb = w.b)) AS has_new,
         EXISTS (SELECT 1 FROM nmc x WHERE x.kind = 'snap' AND x.lid = w.lid AND x.sk = w.eid AND (x.b = w.b OR x.b = w.rb OR x.rb = w.rb OR x.rb = w.b)) AS in_linked_snapshot
    FROM win w),
po AS (
  SELECT u.name, u.lid, count(p.eid) AS n_ev,
         count(p.eid) FILTER (WHERE p.old_list AND p.new_list) AS both_n,
         count(p.eid) FILTER (WHERE p.old_list AND p.has_old AND NOT p.new_list) AS c_n,
         count(p.eid) FILTER (WHERE p.new_list AND p.has_new AND NOT p.old_list) AS a_n,
         count(p.eid) FILTER (WHERE p.old_list AND NOT p.has_old AND NOT p.new_list) AS b_n,
         count(p.eid) FILTER (WHERE p.new_list AND NOT p.has_new AND NOT p.old_list) AS d_n,
         count(p.eid) FILTER (WHERE NOT p.old_list AND NOT p.new_list) AS e_n
    FROM ub u LEFT JOIN pr p ON p.name = u.name GROUP BY u.name, u.lid),
pcl AS (
  SELECT po.*, CASE WHEN n_ev = 0 THEN 'no event in the window'
                    WHEN both_n > 0 THEN 'INCONSISTENT: an event in the window has both lists (stage 8 would not call it unusable)'
                    WHEN (c_n > 0 OR d_n > 0) AND (a_n > 0 OR b_n > 0) THEN 'conflicting: one event points to a removal, another says the edit did not remove it'
                    WHEN c_n > 0 THEN 'before-list HAS the image, after-list is not a list: a removal cannot be shown (the after-list is missing)'
                    WHEN a_n > 0 THEN 'after-list HAS the image, before-list is not a list: this edit left the image in the gallery'
                    WHEN b_n > 0 THEN 'before-list LACKS the image, after-list is not a list: this edit did not remove it'
                    WHEN d_n > 0 THEN 'after-list LACKS the image, before-list is not a list: whether it was there before is unknown'
                    ELSE 'neither side is a list: no membership evidence from this edit' END AS lab
    FROM po),
rsx AS (   -- delete snapshots of the listing row (a recorded gallery STATE), placed against each object's own record-to-first-later-state window
  SELECT u.name, u.lid, r.id::text AS rid,
         CASE WHEN r.created_at <= u.rec_ts THEN 'before the Gallery Recovery record'
              WHEN r.created_at <= u.first_after_ts THEN 'between the record and the first later gallery state' ELSE 'after the first later gallery state' END AS pos,
         CASE WHEN coalesce(jsonb_typeof(r.row_data -> 'images'), 'none') <> 'array' THEN 'images is not a list'
              WHEN EXISTS (SELECT 1 FROM listc x WHERE x.src = 'rs' AND x.k1 = u.name AND x.k2 = r.id::text AND (x.b = u.b OR x.b = u.rb OR x.rb = u.rb OR x.rb = u.b)) THEN 'list HAS the image'
              ELSE 'list LACKS the image' END AS has
    FROM ub u JOIN properties_row_snapshots r ON r.property_id::text = u.lid),
gr AS (SELECT DISTINCT rec_id, rec_ts, CASE WHEN op IN ('assign', 'unassign') THEN op ELSE 'other operation' END AS op, listing_id FROM ga_raw),
grx AS (   -- other Gallery Recovery records on the same listings (circumstantial), against each object's own window
  SELECT u.name, u.lid, g.rec_id, g.op,
         CASE WHEN g.rec_ts < u.rec_ts THEN 'before the object''s latest record' WHEN g.rec_ts = u.rec_ts THEN 'at the same instant as the object''s latest record (includes that record)'
              WHEN g.rec_ts <= u.first_after_ts THEN 'between the latest record and the first later gallery state' ELSE 'after the first later gallery state' END AS pos
    FROM ub u JOIN gr g ON g.listing_id = u.lid),
imx AS (   -- import records of the same listings (circumstantial), against the listing span
  SELECT w.lid, ir.id::text AS iid,
         CASE WHEN ir.imported_at <= w.lo THEN 'before the earliest record' WHEN ir.imported_at <= w.hi THEN 'between the earliest record and the latest first later state' ELSE 'after the latest first later state' END AS pos
    FROM lw w JOIN import_records ir ON ir.listing_id::text = w.lid),
lpx AS (   -- every change-log event of the same listings (circumstantial unless it is one of the window events above), browser clock, against the listing span
  SELECT w.lid, lp.id::text AS eid,
         CASE WHEN lp.event_type IN ('listing_created', 'smart_import', 'field_changed', 'price_changed', 'map_changed', 'agent_changed', 'owner_changed', 'contact_changed',
                                     'photos_changed', 'ai_generation', 'listing_deleted') THEN lp.event_type ELSE 'other type' END AS et,
         CASE WHEN lp.created_at <= w.lo THEN 'before the earliest record' WHEN lp.created_at <= w.hi THEN 'between the earliest record and the latest first later state' ELSE 'after the latest first later state' END AS pos,
         (jsonb_typeof(lp.old_value) = 'array' AND jsonb_typeof(lp.new_value) = 'array') AS both_lists
    FROM lw w JOIN listing_provenance lp ON lp.listing_id::text = w.lid AND current_setting('transaction_read_only') = 'on'),
cur AS (
  SELECT u.name, u.lid,
         CASE WHEN p.id IS NULL THEN 'listing row missing' WHEN p.deleted_at IS NOT NULL THEN 'listing soft-deleted' ELSE 'listing active' END AS st,
         CASE WHEN p.id IS NULL THEN 'n/a' WHEN coalesce(jsonb_typeof(p.images), 'none') <> 'array' THEN 'images not a list'
              WHEN jsonb_array_length(p.images) = 0 THEN 'gallery empty' WHEN jsonb_array_length(p.images) <= 5 THEN 'gallery 1-5 images'
              WHEN jsonb_array_length(p.images) <= 20 THEN 'gallery 6-20 images' ELSE 'gallery over 20 images' END AS gal,
         EXISTS (SELECT 1 FROM listc x WHERE x.src = 'cur' AND x.k1 = u.name AND (x.b = u.b OR x.b = u.rb OR x.rb = u.rb OR x.rb = u.b)) AS present_now
    FROM ub u LEFT JOIN properties p ON p.id::text = u.lid)
SELECT section, label, n, listings FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || current_setting('transaction_read_only') AS label, NULL::bigint AS n, NULL::bigint AS listings
  UNION ALL SELECT 1, '1 unreferenced originals (must equal the stage-2 total)', '', count(*), NULL FROM orph
  UNION ALL SELECT 2, '2 scope: the objects stage 8 classifies unusable (the only objects analysed below)', 'objects', count(*), count(DISTINCT lid) FROM ub
  UNION ALL SELECT 3, '3 photos_changed events inside those objects'' windows (distinct events)', 'all', count(DISTINCT eid), count(DISTINCT lid) FROM pr
  UNION ALL SELECT 3, '3 photos_changed events inside those objects'' windows (distinct events)', 'with a linked saved snapshot (save confirmed)', count(DISTINCT eid), count(DISTINCT lid) FROM pr WHERE linked
  UNION ALL SELECT 3, '3 photos_changed events inside those objects'' windows (distinct events)', 'with BOTH lists (must be 0: stage 8 would not call them unusable)', count(DISTINCT eid), count(DISTINCT lid) FROM pr WHERE old_list AND new_list
  UNION ALL SELECT 4, '4 why unusable: jsonb type of the stored before-list / after-list (event counts)', 'before=' || old_shape || ', after=' || new_shape, count(DISTINCT eid), count(DISTINCT lid) FROM pr GROUP BY old_shape, new_shape
  UNION ALL SELECT 5, '5 what the edit events say about THIS image (objects; direct, from the lists that exist)', lab, count(*), count(DISTINCT lid) FROM pcl GROUP BY lab
  UNION ALL SELECT 6, '6 linked snapshot = the gallery the editor saved after the edit (direct for the after-state; object x event pairs)',
         CASE WHEN NOT linked THEN 'event has no linked snapshot (save not confirmed, or the saved gallery was empty)'
              WHEN in_linked_snapshot THEN 'linked snapshot CONTAINS the image' ELSE 'linked snapshot LACKS the image' END
         || CASE WHEN bounding THEN '; it IS the first later gallery state' ELSE '' END, count(*), count(DISTINCT lid) FROM pr GROUP BY 3
  UNION ALL SELECT 7, '7 delete snapshots of the listing row (a recorded gallery state; objects x snapshots)', op_label, n, l FROM (
         SELECT 'no delete snapshot of the listing' AS op_label, (SELECT count(*) FROM ub WHERE NOT EXISTS (SELECT 1 FROM rsx WHERE rsx.name = ub.name)) AS n,
                (SELECT count(DISTINCT lid) FROM ub WHERE NOT EXISTS (SELECT 1 FROM rsx WHERE rsx.name = ub.name)) AS l
         UNION ALL SELECT pos || ': ' || has, count(*), count(DISTINCT lid) FROM rsx GROUP BY pos, has) z
  UNION ALL SELECT 8, '8 other Gallery Recovery records on the same listings (circumstantial; distinct records)', op || ' record ' || pos, count(DISTINCT rec_id), count(DISTINCT lid) FROM grx GROUP BY op, pos
  UNION ALL SELECT 9, '9 import records of the same listings (circumstantial: an import record does not show an import changed this gallery; distinct records)', pos, count(DISTINCT iid), count(DISTINCT lid) FROM imx GROUP BY pos
  UNION ALL SELECT 10, '10 change-log events of the same listings by type, browser clock (circumstantial; distinct events)', et || ' ' || pos, count(DISTINCT eid), count(DISTINCT lid) FROM lpx GROUP BY et, pos
  UNION ALL SELECT 10, '10 change-log events of the same listings by type, browser clock (circumstantial; distinct events)', 'photos_changed with BOTH lists, any time', count(DISTINCT eid), count(DISTINCT lid) FROM lpx WHERE et = 'photos_changed' AND both_lists
  UNION ALL SELECT 11, '11 current state of the listing (objects)', st || '; ' || gal, count(*), count(DISTINCT lid) FROM cur GROUP BY st, gal
  UNION ALL SELECT 11, '11 current state of the listing (objects)', 'image present in the current gallery (must be 0: the population is defined as referenced by nothing)', count(*) FILTER (WHERE present_now), count(DISTINCT lid) FILTER (WHERE present_now) FROM cur
) t ORDER BY s, section, label;
