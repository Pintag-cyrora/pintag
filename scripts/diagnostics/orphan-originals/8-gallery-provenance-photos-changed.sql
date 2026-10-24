-- 8-gallery-provenance-photos-changed.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no
-- writes. Runs only after the preflight passed (including reconcile-schema, gallery-schema, history-schema and provenance-schema), inside a READ ONLY
-- transaction opened by the psql command line; outside one every count below is zero and the guard row says so.
--
-- Question: can the admin listing editor's own change log (listing_provenance, event_type 'photos_changed') explain why the Gallery Recovery 'assign'
-- images are missing from their listings' galleries? Analysed here: the 'assign' objects whose first gallery state recorded after the latest Gallery
-- Recovery record DEMONSTRABLY EXCLUDES the image (the "bounded" objects of 7-gallery-history-vs-snapshots.sql; the same rules, copied verbatim).
--
-- What the evidence is (verified in listing-provenance.js / admin.html before writing this):
--   * captureEdit fetches the listing's CURRENT images BEFORE the save and writes one photos_changed event: old_value = the full gallery before, new_value
--     = the full gallery being saved (both jsonb arrays of URLs). That is DIRECT before/after membership for the edit.
--   * The event is written BEFORE the save is attempted. If the save then fails the event still exists, so an event alone does not prove the change was
--     applied. The editor writes a gallery snapshot AFTER a successful save, anchored to that event (listing_image_snapshots.provenance_event_id = the
--     event id), but only when the saved gallery is not empty. An event with such a linked snapshot is "save confirmed"; without one it is "not confirmed".
--   * created_at on these events is the BROWSER clock (the client sets it); snapshot created_at is the server clock. For a confirmed event the linked
--     snapshot's server time is used; for an unconfirmed one the browser time is used with a one-day tolerance around the record-to-snapshot window.
--   * actor is the admin email. The admin area has a single authorized account, so the actor cannot tell the editor from Gallery Recovery or one person
--     from another; it is reported only as present / equal to the Gallery Recovery operator, never as a value.
--   * Events are best-effort (a failure to write one never blocks a save), so "no event" is not "no edit".
--
-- Per analysed object (mutually exclusive, first match wins) -- looking only at photos_changed events of its listing inside the record-to-snapshot window:
--   none               no event in the window
--   unusable           events in the window, none with before AND after image lists
--   ambiguous          more than one event removes the image, or an event ADDS it back, or an event whose before-list already lacks it comes before the
--                      removing event
--   direct_confirmed   exactly one event has the image in its before-list and not in its after-list, and a snapshot linked to it proves the save
--   direct_unconfirmed same, but no linked snapshot (save not proven; the gallery may have been empty, the snapshot write may have failed)
--   already_absent     an event's before-list already lacks the image and none removes it: that edit did NOT remove it; the removal came by a path the
--                      editor log does not show
--   circumstantial     events in the window, none of them involves the image (timing only; no causation)
-- An event in the window is never treated as the cause just because of its time: only direct_confirmed / direct_unconfirmed carry before/after evidence
-- about THIS image, and even those show what an edit did, not who or what intended it. Names are compared exactly (bytes, as stored or percent-decoded;
-- relative path under /property-images/ or the external URL without its query string), never by prefix or substring.
-- Output is counts, dates and fixed labels only: no object name, image list, listing id, event id, actor or payload is ever selected.
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
SELECT section, label, n, listings FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || current_setting('transaction_read_only') AS label, NULL::bigint AS n, NULL::bigint AS listings
  UNION ALL SELECT 1, '1 unreferenced originals (must equal the stage-2 total)', '', count(*), NULL FROM orph
  UNION ALL SELECT 2, '2 scope: assign objects (latest record unambiguous, usable listing id)',
         CASE WHEN first_after_ts IS NULL THEN 'no later gallery state (NOT analysed here: see the history diagnostic)'
              WHEN in_first_after THEN 'first later state still contains the image (NOT analysed here)'
              ELSE 'first later state EXCLUDES the image (analysed here)' END, count(*), count(DISTINCT lid) FROM obj WHERE op = 'assign' GROUP BY 3
  UNION ALL SELECT 3, '3 photos_changed events, all listings: total and date range (browser clock)', coalesce(to_char(min(created_at), 'YYYY-MM-DD') || ' to ' || to_char(max(created_at), 'YYYY-MM-DD'), 'none'), count(*), count(DISTINCT listing_id)
         FROM listing_provenance WHERE event_type = 'photos_changed' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 3, '3 photos_changed events, all listings: with before AND after image lists (usable)', '', count(*), count(DISTINCT listing_id)
         FROM listing_provenance WHERE event_type = 'photos_changed' AND jsonb_typeof(old_value) = 'array' AND jsonb_typeof(new_value) = 'array' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 3, '3 photos_changed events, all listings: with an actor recorded (number of DISTINCT actor values in the label)',
         'distinct actors: ' || count(DISTINCT nullif(lower(btrim(actor)), '')), count(*) FILTER (WHERE nullif(btrim(actor), '') IS NOT NULL), count(DISTINCT listing_id) FILTER (WHERE nullif(btrim(actor), '') IS NOT NULL)
         FROM listing_provenance WHERE event_type = 'photos_changed' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 3, '3 photos_changed events, all listings: with a linked saved snapshot (save confirmed)', '', count(*), count(DISTINCT lp.listing_id)
         FROM listing_provenance lp WHERE lp.event_type = 'photos_changed' AND current_setting('transaction_read_only') = 'on'
           AND EXISTS (SELECT 1 FROM listing_image_snapshots s WHERE s.provenance_event_id::text = lp.id::text)
  UNION ALL SELECT 4, '4 analysed objects: what the photos_changed events in the record-to-snapshot window show', c, count(*), count(DISTINCT lid) FROM cls GROUP BY c
  UNION ALL SELECT 5, '5 direct evidence: the removing event vs the first later gallery state (can it narrow the window?)',
         c || ': ' || CASE WHEN rem_is_bounding THEN 'the removing event IS the first later gallery state (no narrowing)'
                           WHEN rem_ts < rec_ts THEN 'event time is BEFORE the record (browser-clock difference; no valid narrowing)'
                           WHEN rem_ts < first_after_ts - interval '1 hour' THEN 'earlier than the first later state by more than 1 hour (narrows the window)'
                           ELSE 'within 1 hour of the first later state (no meaningful narrowing)' END, count(*), count(DISTINCT lid)
         FROM cls WHERE c IN ('direct_confirmed', 'direct_unconfirmed') GROUP BY c, 3
  UNION ALL SELECT 6, '6 direct evidence: latest assign record to the removing event',
         c || ': ' || CASE WHEN rem_ts < rec_ts THEN 'event time is BEFORE the record (browser-clock difference inside the 1-day tolerance; not a real narrowing)'
                           WHEN rem_ts - rec_ts <= interval '1 day' THEN 'within 1 day' WHEN rem_ts - rec_ts <= interval '7 days' THEN '2-7 days'
                           WHEN rem_ts - rec_ts <= interval '30 days' THEN '8-30 days' ELSE 'over 30 days' END, count(*), count(DISTINCT lid)
         FROM cls WHERE c IN ('direct_confirmed', 'direct_unconfirmed') GROUP BY c, 3
  UNION ALL SELECT 7, '7 direct evidence: actor of the removing event (values are never printed; the account is a single shared admin login)',
         CASE WHEN rem_actor IS NULL THEN 'no actor recorded on the removing event'
              WHEN operator IS NULL OR btrim(operator) = '' THEN 'actor recorded; the Gallery Recovery operator is not'
              WHEN rem_actor = lower(btrim(operator)) THEN 'actor equals the Gallery Recovery operator of the latest assign record'
              ELSE 'actor differs from the Gallery Recovery operator' END, count(*), count(DISTINCT lid)
         FROM cls WHERE c IN ('direct_confirmed', 'direct_unconfirmed') GROUP BY 3
  UNION ALL SELECT 8, '8 distinct photos_changed events inside any record-to-snapshot window (timing only unless section 4 says direct)', '', count(DISTINCT eid), count(DISTINCT lid) FROM pair
) t ORDER BY s, section, label;
