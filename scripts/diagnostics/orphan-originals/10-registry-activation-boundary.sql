-- 10-registry-activation-boundary.sql -- READ-ONLY. ONE plain SELECT: no transaction control, no SET/RESET, no procedural code, no temp tables, no
-- writes. Runs only after the preflight passed (including reconcile-schema, gallery-schema, history-schema, provenance-schema and registry-schema), inside a
-- READ ONLY transaction opened by the psql command line; outside one every count below is zero and the guard row says so.
--
-- Question: the integrity check reports 553 unreferenced originals ("orphans"): objects with NO property_images row in any status that no listing, unit type or
-- agent references. The registry (table, trigger trg_property_images_sync, one-time backfill from properties.images) was applied to production by
-- apply-migration run 32142932661, "Applying migration 20260813000000_property_images_registry.sql" at 2026-08-18 13:32:37 UTC. Is the lack of a registry
-- row for those objects explained by WHEN they were in a gallery (before the registry existed), or does some object demonstrably sit in a gallery on or
-- after that instant without a row (a sync failure)? Population: the SAME 553 as 2-diagnostic.sql (copied rules); run.sh refuses to print anything if the
-- count differs from stage 2.
--
-- What counts as evidence that an object was IN a listing's gallery (properties.images) -- and what does not:
--   direct, SERVER time (exact enough for a boundary a day wide or more):
--     * a Gallery Recovery 'assign' record: gallery-recovery.html writes the record only AFTER the properties.images update succeeded, so the record's
--       server time is when the image had just been put into the gallery
--     * a listing_image_snapshots row: a gallery STATE the editor saved (server time of the write)
--     * the BEFORE-list of an editor photos_changed event whose save is confirmed by a linked snapshot: the list is read from the database before the
--       save (captureEdit), so the image was in the gallery just before that save; its time is the linked snapshot's server time (seconds after the save)
--   direct, BROWSER clock (approximate: the client sets created_at; compared with the boundary only with a ONE-DAY margin on each side):
--     * the BEFORE-list of a photos_changed event with no linked snapshot. The list was still read from the database, so it is real membership evidence,
--       but the save may have failed and the time is the browser's
--   circumstantial (never promoted to membership): a Gallery Recovery 'unassign' record (some paths unassign a photo that is not in any gallery), the
--   AFTER-list of an editor event without a linked snapshot (an intended gallery, save unconfirmed), an import_images row. A null / missing / non-array
--   before-list is NOT evidence of anything, absent or present. The event's before-list is the listing's properties.images as it was: null means the
--   gallery was empty, so a missing side is never read as a removal.
-- An object is only "expected to have a row" when direct evidence puts it in a gallery at or after the boundary: then either the one-time backfill (image
-- already in the gallery at the boundary) or the trigger (image added later) should have registered it. Before the boundary nothing could: the table did
-- not exist.
-- Gallery STATES and absence. A listing_image_snapshots state is the set of rows sharing one provenance_event_id (or, with none, one created_at): one row per image
-- of the saved gallery, image_order 0..n-1, written in one request. A state is RECONSTRUCTABLE ("complete") only when every row has a usable name (a URL or a path)
-- and image_order is exactly 0..n-1 with no gap, repeat or null; otherwise its membership is unknown and it proves nothing. "Removed before activation" needs,
-- for EVERY listing in which the object has direct evidence, a complete state recorded AFTER the object's last evidence in that listing, that demonstrably
-- excludes it (no row of the state names the object), and all of those states dated before the boundary. A later snapshot is never read as "gone" because it
-- exists: if the later state(s) cannot be reconstructed, or there is no later state in some listing, the object stays indeterminate. The editor writes NO
-- snapshot when a save leaves the gallery empty, so an emptied gallery is invisible here: it is never read as exclusion either. Absence is only ever shown
-- by a recorded state; it is not inferred from a missing record, an old timestamp or an empty list.
-- LIMIT: a recorded exclusion is NOT proof that the object stayed out of every gallery afterwards (bucket 4 is "recorded exclusion", not "removed"). Writers that
-- leave no, or an incomplete, record exist: edit-listing.html and add-property.html write properties.images with no editor event and no snapshot; the admin editor's
-- change log and snapshots are best-effort (a failure never blocks a save); Gallery Recovery inserts its gallery_assignments record AFTER the update and only logs a
-- failed insert. An unrecorded re-add (and a later unrecorded removal) can therefore still be classified into bucket 4 and would then hide a discrepancy. Only buckets
-- 1-3 are positive evidence of membership at or after the instant; every other bucket can confirm nothing about absence. Likewise a state that names the object in a
-- spelling the matcher cannot see would be read as excluding it.
-- Spelling: the registry stores the path as written in the URL (percent-encoded); an unreferenced object whose registry row exists only under another
-- spelling is counted separately.
-- Output is counts, dates of registry rows and fixed labels only: no object name, image list, listing id, event id, record id, actor or payload is selected.
WITH bnd AS (SELECT timestamptz '2026-08-18 13:32:37+00' AS b),
obj_all AS (
  SELECT so.name,
         CASE WHEN to_jsonb(so)->>'created_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (to_jsonb(so)->>'created_at')::timestamptz END AS created_at
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
live_forms AS (
  SELECT convert_to(n, 'UTF8') AS b FROM live_raw WHERE n <> ''
  UNION ALL
  SELECT dec FROM (
    SELECT (SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
              FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)) AS dec
      FROM live_raw WHERE n ~ '%[0-9A-Fa-f]{2}') d WHERE dec IS NOT NULL AND length(dec) > 0),
orph AS (   -- the stage-2 population, with the object's own bytes as stored (rb) and percent-decoded (b) and its upload time
  SELECT o.name, o.created_at, convert_to(o.name, 'UTF8') AS rb,
         CASE WHEN o.name ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(o.name, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(o.name, 'UTF8'))
              ELSE convert_to(o.name, 'UTF8') END AS b
    FROM obj_all o
   WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM live_forms f WHERE f.b = convert_to(o.name, 'UTF8'))),
evt AS (SELECT lp.id::text AS eid, lp.listing_id::text AS lid, lp.created_at AS cts, lp.old_value, lp.new_value
          FROM listing_provenance lp WHERE lp.event_type = 'photos_changed' AND current_setting('transaction_read_only') = 'on'),
lk AS (SELECT e.eid, min(s.created_at) AS linked_ts FROM evt e JOIN listing_image_snapshots s ON s.provenance_event_id::text = e.eid GROUP BY e.eid),
stm AS (   -- recorded gallery STATES (snapshot rows sharing an event id, else a timestamp), with whether their membership can be reconstructed
  SELECT s.listing_id::text AS lid, coalesce(s.provenance_event_id::text, s.created_at::text) AS sk, min(s.created_at) AS ts, count(*) AS n_rows,
         bool_and(coalesce(nullif(btrim(s.storage_url), ''), nullif(btrim(s.storage_path), '')) IS NOT NULL) AS all_named,
         (count(s.image_order) = count(*) AND count(DISTINCT s.image_order) = count(*) AND min(s.image_order) = 0 AND max(s.image_order) = count(*) - 1) AS order_ok
    FROM listing_image_snapshots s WHERE current_setting('transaction_read_only') = 'on' GROUP BY 1, 2),
stc AS (SELECT lid, sk, ts, (all_named AND order_ok) AS complete, all_named, order_ok FROM stm),
ent0 AS (   -- every name any evidence source mentions, one normalization (path after /property-images/, query dropped)
  SELECT CASE WHEN g.op = 'assign' THEN 'ga_assign' ELSE 'ga_unassign' END AS src, g.listing_id::text AS lid, g.created_at AS ts, NULL::text AS sk,
         split_part(regexp_replace(v #>> '{}', '^.*/property-images/', ''), '?', 1) AS n
    FROM gallery_assignments g, LATERAL jsonb_path_query(g.photo_paths, 'strict $.**') AS v
   WHERE jsonb_typeof(v) = 'string' AND current_setting('transaction_read_only') = 'on'
  UNION ALL
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evt e WHERE e.eid = s.provenance_event_id::text) THEN 'snap_linked' ELSE 'snap_other' END, s.listing_id::text, s.created_at,
         coalesce(s.provenance_event_id::text, s.created_at::text), x.n
    FROM listing_image_snapshots s
    CROSS JOIN LATERAL (   -- the image's name, exactly as stage 8 builds it: the URL path when the URL is ours, else the URL itself, else the stored path; the stored path is a
                           -- SECOND name only when it is not just the tail of the URL path (the editor stores the last URL segment as storage_path, so a basename alone must
                           -- never name a different, root-level object)
      SELECT y.n FROM (SELECT nullif(split_part(regexp_replace(coalesce(s.storage_path, ''), '^.*/property-images/', ''), '?', 1), '') AS np,
                              CASE WHEN s.storage_url LIKE '%/property-images/%' THEN nullif(split_part(regexp_replace(s.storage_url, '^.*/property-images/', ''), '?', 1), '') END AS nu,
                              nullif(split_part(coalesce(s.storage_url, ''), '?', 1), '') AS ne) z,
           LATERAL (VALUES (CASE WHEN z.nu IS NOT NULL THEN z.nu WHEN z.ne IS NOT NULL THEN z.ne ELSE z.np END),
                           (CASE WHEN z.nu IS NOT NULL AND z.np IS NOT NULL AND z.nu <> z.np AND right(z.nu, length(z.np) + 1) <> ('/' || z.np) THEN z.np END)) AS y(n)) AS x(n)
   WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL
  SELECT CASE WHEN lk.linked_ts IS NOT NULL THEN 'ev_old_linked' ELSE 'ev_old_browser' END, e.lid, coalesce(lk.linked_ts, e.cts), NULL::text,
         CASE WHEN u.url LIKE '%/property-images/%' THEN split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(u.url, '?', 1) END
    FROM evt e LEFT JOIN lk ON lk.eid = e.eid,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.old_value) = 'array' THEN e.old_value ELSE '[]'::jsonb END) AS u(url)
  UNION ALL   -- after-lists only when the save is NOT confirmed (a confirmed one is the linked snapshot state above)
  SELECT 'ev_new_browser', e.lid, e.cts, NULL::text,
         CASE WHEN u.url LIKE '%/property-images/%' THEN split_part(regexp_replace(u.url, '^.*/property-images/', ''), '?', 1) ELSE split_part(u.url, '?', 1) END
    FROM evt e LEFT JOIN lk ON lk.eid = e.eid,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.new_value) = 'array' AND lk.linked_ts IS NULL THEN e.new_value ELSE '[]'::jsonb END) AS u(url)
  UNION ALL
  SELECT 'imp', i.listing_id::text, NULL::timestamptz, NULL::text, x.n
    FROM import_images i
    CROSS JOIN LATERAL (   -- the image's name, exactly as stage 8 builds it: the URL path when the URL is ours, else the URL itself, else the stored path; the stored path is a
                           -- SECOND name only when it is not just the tail of the URL path (the editor stores the last URL segment as storage_path, so a basename alone must
                           -- never name a different, root-level object)
      SELECT y.n FROM (SELECT nullif(split_part(regexp_replace(coalesce(i.storage_path, ''), '^.*/property-images/', ''), '?', 1), '') AS np,
                              CASE WHEN i.storage_url LIKE '%/property-images/%' THEN nullif(split_part(regexp_replace(i.storage_url, '^.*/property-images/', ''), '?', 1), '') END AS nu,
                              nullif(split_part(coalesce(i.storage_url, ''), '?', 1), '') AS ne) z,
           LATERAL (VALUES (CASE WHEN z.nu IS NOT NULL THEN z.nu WHEN z.ne IS NOT NULL THEN z.ne ELSE z.np END),
                           (CASE WHEN z.nu IS NOT NULL AND z.np IS NOT NULL AND z.nu <> z.np AND right(z.nu, length(z.np) + 1) <> ('/' || z.np) THEN z.np END)) AS y(n)) AS x(n)
   WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL
  SELECT 'reg', pi.property_id::text, NULL::timestamptz, NULL::text, pi.storage_path FROM property_images pi WHERE current_setting('transaction_read_only') = 'on'),
ent AS (
  SELECT src, lid, ts, sk, n, convert_to(n, 'UTF8') AS rb,
         CASE WHEN n ~ '%[0-9A-Fa-f]{2}'
              THEN coalesce((SELECT decode(string_agg(CASE WHEN m.a[1] IS NOT NULL THEN lower(m.a[1]) ELSE encode(convert_to(m.a[2], 'UTF8'), 'hex') END, '' ORDER BY m.i), 'hex')
                               FROM regexp_matches(n, '%([0-9A-Fa-f]{2})|(%|[^%])', 'g') WITH ORDINALITY AS m(a, i)), convert_to(n, 'UTF8'))
              ELSE convert_to(n, 'UTF8') END AS b
    FROM ent0 WHERE n IS NOT NULL AND n <> ''),
mt AS (SELECT o.name, x.src, x.lid, x.ts, x.sk FROM orph o JOIN ent x ON x.b = o.b OR x.b = o.rb OR x.rb = o.rb OR x.rb = o.b),
mxa AS (   -- per object: its LATEST direct server-time evidence of gallery membership (ties: snapshot of a saved edit, then editor before-list, other snapshot, assign record)
  SELECT DISTINCT ON (name) name, lid, ts, src FROM mt WHERE src IN ('ga_assign', 'snap_linked', 'snap_other', 'ev_old_linked')
   ORDER BY name, ts DESC, CASE src WHEN 'snap_linked' THEN 1 WHEN 'ev_old_linked' THEN 2 WHEN 'snap_other' THEN 3 ELSE 4 END),
apx AS (SELECT name, max(ts) AS ts FROM mt WHERE src = 'ev_old_browser' GROUP BY name),
circ AS (SELECT DISTINCT name FROM mt WHERE src IN ('ga_unassign', 'ev_new_browser', 'imp')),
regm AS (SELECT DISTINCT name FROM mt WHERE src = 'reg'),
plx AS (   -- per object AND listing: the latest direct server-time evidence in THAT listing (the same tie order as above)
  SELECT DISTINCT ON (name, lid) name, lid, ts, src FROM mt WHERE src IN ('ga_assign', 'snap_linked', 'snap_other', 'ev_old_linked')
   ORDER BY name, lid, ts DESC, CASE src WHEN 'snap_linked' THEN 1 WHEN 'ev_old_linked' THEN 2 WHEN 'snap_other' THEN 3 ELSE 4 END),
rl AS (   -- per object and listing: recorded states AFTER that evidence (for a saved edit's before-list, its own state at the same instant), and the first one that is
          -- COMPLETE and demonstrably EXCLUDES the object (no snapshot row of that state names it)
  SELECT p.name, p.lid, count(c.sk) AS n_later,
         min(c.ts) FILTER (WHERE c.complete AND NOT EXISTS (SELECT 1 FROM mt m2 WHERE m2.name = p.name AND m2.lid = c.lid AND m2.sk = c.sk)) AS excl_ts
    FROM plx p LEFT JOIN stc c ON c.lid = p.lid AND (c.ts > p.ts OR (c.ts = p.ts AND p.src = 'ev_old_linked'))
   GROUP BY p.name, p.lid),
pob AS (
  SELECT name, bool_and(excl_ts IS NOT NULL) AS all_excl, max(excl_ts) AS max_excl,
         bool_or(excl_ts IS NULL AND n_later > 0) AS any_unrecon, bool_or(n_later = 0) AS any_nolater
    FROM rl GROUP BY name),
ob AS (
  SELECT o.name, o.created_at, m.ts AS mx_ts, m.src AS mx_src, m.lid AS mx_lid, r.all_excl, r.max_excl, r.any_unrecon, r.any_nolater, a.ts AS apx_ts,
         (c.name IS NOT NULL) AS has_circ, (g.name IS NOT NULL) AS has_reg
    FROM orph o LEFT JOIN mxa m ON m.name = o.name LEFT JOIN pob r ON r.name = o.name LEFT JOIN apx a ON a.name = o.name
         LEFT JOIN circ c ON c.name = o.name LEFT JOIN regm g ON g.name = o.name),
cb AS (
  SELECT ob.*, (SELECT b FROM bnd) AS bb,
         CASE WHEN mx_ts >= (SELECT b FROM bnd) THEN '1 direct, server time: in a gallery ON/AFTER activation (a registry row is expected if the sync worked)'
              WHEN apx_ts > (SELECT b FROM bnd) + interval '1 day' THEN '2 direct, browser clock: in a gallery MORE THAN A DAY after activation (approximate; a row is expected if the sync worked)'
              WHEN apx_ts >= (SELECT b FROM bnd) - interval '1 day' THEN '3 direct, browser clock: in a gallery within a day of activation (cannot be placed before or after)'
              WHEN mx_ts IS NOT NULL AND all_excl AND max_excl < (SELECT b FROM bnd) THEN '4 RECORDED EXCLUSION before activation: in every listing a complete recorded gallery state before it excludes the object (does NOT prove it stayed absent: an unrecorded re-add is possible)'
              WHEN mx_ts IS NOT NULL AND all_excl THEN '5 excluded by complete recorded states, but at least one such state is on/after activation (removal date undecidable)'
              WHEN mx_ts IS NOT NULL AND any_unrecon THEN '6 INDETERMINATE: a later recorded state exists but its membership cannot be reconstructed (missing names or image order), so absence is not shown'
              WHEN mx_ts IS NOT NULL THEN '7 INDETERMINATE: last in a gallery before activation; no later recorded gallery state in some listing (an emptied gallery leaves no snapshot)'
              WHEN apx_ts IS NOT NULL THEN '8 direct, browser clock only: in a gallery more than a day before activation (removal date unknown)'
              WHEN has_circ THEN '9 circumstantial evidence only (unassign record, unconfirmed after-list or import row): no proof it was ever in a gallery'
              ELSE '10 no evidence of any kind' END AS bucket,
         CASE WHEN mx_ts IS NOT NULL THEN 'direct, server time' WHEN apx_ts IS NOT NULL THEN 'direct, browser clock only' WHEN has_circ THEN 'circumstantial only' ELSE 'none' END AS strength
    FROM ob),
grp AS (   -- the two upload groups asked about
  SELECT cb.*, (to_char(date_trunc('month', created_at), 'YYYY-MM') IN ('2026-09', '2026-10')) AS sepoct, (created_at >= (SELECT b FROM bnd)) AS post_act FROM cb),
trg AS (
  SELECT t.tgenabled, t.tgtype, t.tgisinternal, c.relname, n.nspname, p.proname, p.prosecdef, p.prosrc,
         (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = t.tgrelid AND a.attname = 'images' AND NOT a.attisdropped) AS images_attnum,
         string_to_array(nullif(t.tgattr::text, ''), ' ')::int[] AS cols
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgname = 'trg_property_images_sync' AND NOT t.tgisinternal AND current_setting('transaction_read_only') = 'on'),
trgc AS (
  SELECT count(*) AS present,
         count(*) FILTER (WHERE nspname = 'public' AND relname = 'properties') AS on_properties,
         count(*) FILTER (WHERE tgenabled = 'O') AS en_origin, count(*) FILTER (WHERE tgenabled = 'D') AS en_disabled,
         count(*) FILTER (WHERE tgenabled = 'R') AS en_replica, count(*) FILTER (WHERE tgenabled = 'A') AS en_always,
         count(*) FILTER (WHERE (tgtype & 1) <> 0 AND (tgtype & 2) = 0 AND (tgtype & 64) = 0) AS after_row,
         count(*) FILTER (WHERE (tgtype & 4) <> 0) AS on_insert, count(*) FILTER (WHERE (tgtype & 16) <> 0) AS on_update,
         count(*) FILTER (WHERE (tgtype & 8) <> 0) AS on_delete, count(*) FILTER (WHERE (tgtype & 32) <> 0) AS on_truncate,
         count(*) FILTER (WHERE images_attnum IS NOT NULL AND cols = ARRAY[images_attnum::int]) AS update_of_images_only,
         count(*) FILTER (WHERE proname = 'pintag_property_images_trg') AS fn_expected,
         count(*) FILTER (WHERE prosecdef) AS fn_secdef,
         count(*) FILTER (WHERE prosrc LIKE '%pintag_sync_property_images%') AS fn_calls_sync,
         count(*) FILTER (WHERE prosrc ~* 'exception[[:space:]]+when[[:space:]]+others') AS fn_swallows
    FROM trg),
gal AS (
  SELECT CASE WHEN p.images IS NULL THEN 'SQL NULL' WHEN jsonb_typeof(p.images) = 'null' THEN 'JSON null'
              WHEN jsonb_typeof(p.images) = 'array' THEN CASE WHEN jsonb_array_length(p.images) = 0 THEN 'array, empty' ELSE 'array, non-empty' END
              ELSE jsonb_typeof(p.images) END AS shape,
         CASE WHEN p.deleted_at IS NULL THEN 'listing not soft-deleted' ELSE 'listing soft-deleted' END AS st,
         (jsonb_typeof(p.images) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) AS e
                                                        WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') = '')) AS odd_entry
    FROM properties p WHERE current_setting('transaction_read_only') = 'on')
SELECT section, label, n, listings FROM (
  SELECT 0 AS s, '0 session guard (must be on, else every count below is deliberately zero)' AS section, 'transaction_read_only=' || current_setting('transaction_read_only') AS label, NULL::bigint AS n, NULL::bigint AS listings
  UNION ALL SELECT 1, '1 unreferenced originals (must equal the stage-2 total)', '', count(*), NULL FROM orph
  UNION ALL SELECT 2, '2 activation boundary used (apply-migration run 32142932661, server time)', to_char((SELECT b FROM bnd) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC', NULL, NULL
  UNION ALL SELECT 2, '2 limitation (read bucket 4 with this)', 'records can be missing: edit-listing.html and add-property.html write galleries with no event or snapshot, and editor logging and the Gallery Recovery record are best-effort, so a recorded exclusion does not prove an object stayed absent; only buckets 1-3 are positive evidence of membership', NULL, NULL
  UNION ALL SELECT 3, '3 unregistered originals: strongest evidence of when each was in a gallery, against the boundary (exclusive; the buckets add up to section 1)', bucket, count(*), count(DISTINCT coalesce(mx_lid, '')) FILTER (WHERE mx_lid IS NOT NULL) FROM cb GROUP BY bucket
  UNION ALL SELECT 3, '3 unregistered originals: strongest evidence of when each was in a gallery, against the boundary (exclusive; the buckets add up to section 1)', 'total of the buckets (must equal section 1)', count(*), NULL FROM cb
  UNION ALL SELECT 4, '4 bucket 1 by the source of the latest server-time evidence (objects)',
         CASE mx_src WHEN 'ga_assign' THEN 'Gallery Recovery assign record' WHEN 'snap_linked' THEN 'recorded snapshot state of a saved editor edit (linked to a photos_changed event)'
                     WHEN 'snap_other' THEN 'recorded snapshot state not linked to a photos_changed event' ELSE 'before-list of a saved editor edit (save confirmed by a linked snapshot)' END,
         count(*), count(DISTINCT mx_lid) FROM cb WHERE mx_ts >= bb GROUP BY mx_src
  UNION ALL SELECT 5, '5 each source on its own (objects; an object can appear under several sources): dated before / on-or-after the boundary',
         CASE src WHEN 'ga_assign' THEN 'direct: Gallery Recovery assign record' WHEN 'snap_linked' THEN 'direct: snapshot state of a saved editor edit' WHEN 'snap_other' THEN 'direct: other snapshot state'
                  WHEN 'ev_old_linked' THEN 'direct: editor before-list, save confirmed' WHEN 'ev_old_browser' THEN 'direct, browser clock: editor before-list, save not confirmed'
                  WHEN 'ga_unassign' THEN 'circumstantial: Gallery Recovery unassign record' WHEN 'ev_new_browser' THEN 'circumstantial, browser clock: editor after-list, save not confirmed'
                  ELSE 'circumstantial: import_images row (not dated)' END
         || ': ' || CASE WHEN last_ts IS NULL THEN 'no time used'
                         WHEN src IN ('ev_old_browser', 'ev_new_browser') THEN CASE WHEN last_ts > (SELECT b FROM bnd) + interval '1 day' THEN 'latest more than a day AFTER' WHEN last_ts >= (SELECT b FROM bnd) - interval '1 day' THEN 'latest within a day of the boundary' ELSE 'latest more than a day BEFORE' END
                         WHEN last_ts >= (SELECT b FROM bnd) THEN 'latest on/after the boundary' ELSE 'latest before the boundary' END,
         count(*), NULL
    FROM (SELECT name, src, max(ts) AS last_ts FROM mt WHERE src <> 'reg' GROUP BY name, src) q GROUP BY 3
  UNION ALL SELECT 6, '6 objects uploaded in September or October 2026 (storage created_at, same month rule as stage 2): evidence of any kind', 'all such objects (stage 2 reported 129 on 2026-10-24)', count(*), NULL FROM grp WHERE sepoct
  UNION ALL SELECT 6, '6 objects uploaded in September or October 2026 (storage created_at, same month rule as stage 2): evidence of any kind', 'strongest evidence: ' || strength, count(*), NULL FROM grp WHERE sepoct GROUP BY strength
  UNION ALL SELECT 6, '6 objects uploaded in September or October 2026 (storage created_at, same month rule as stage 2): evidence of any kind', 'bucket ' || bucket, count(*), NULL FROM grp WHERE sepoct GROUP BY bucket
  UNION ALL SELECT 6, '6 objects uploaded in September or October 2026 (storage created_at, same month rule as stage 2): evidence of any kind', 'server-time evidence dated BEFORE the object''s own upload time (inconsistent: clock or re-upload)', count(*), NULL FROM grp WHERE sepoct AND mx_ts < created_at
  UNION ALL SELECT 7, '7 objects uploaded on/after the activation instant (any month): evidence of any kind', 'all such objects', count(*), NULL FROM grp WHERE post_act
  UNION ALL SELECT 7, '7 objects uploaded on/after the activation instant (any month): evidence of any kind', 'strongest evidence: ' || strength, count(*), NULL FROM grp WHERE post_act GROUP BY strength
  UNION ALL SELECT 7, '7 objects uploaded on/after the activation instant (any month): evidence of any kind', 'objects with no upload time recorded', count(*), NULL FROM grp WHERE created_at IS NULL
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'rows', count(*), count(DISTINCT property_id) FROM property_images WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'earliest row created_at ' || coalesce(to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC', 'none'), NULL, NULL FROM property_images WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'latest row created_at ' || coalesce(to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC', 'none'), NULL, NULL FROM property_images WHERE current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'status ' || coalesce(status, 'NULL'), count(*), count(DISTINCT property_id) FROM property_images WHERE current_setting('transaction_read_only') = 'on' GROUP BY status
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'rows created BEFORE the activation instant (expected 0)', count(*), NULL FROM property_images WHERE created_at < (SELECT b FROM bnd) AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'rows created within 1 minute AFTER the activation instant (the one-time backfill)', count(*), NULL FROM property_images
         WHERE created_at >= (SELECT b FROM bnd) AND created_at < (SELECT b FROM bnd) + interval '1 minute' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 8, '8 registry history (property_images, all statuses)', 'rows created more than 1 minute after the activation instant (the trigger)', count(*), NULL FROM property_images
         WHERE created_at >= (SELECT b FROM bnd) + interval '1 minute' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 9, '9 trigger trg_property_images_sync (pg_trigger catalog; counts of matching triggers)', l, v, NULL FROM trgc,
         LATERAL (VALUES ('exists (any table)', present), ('attached to public.properties', on_properties), ('enabled: fires in ordinary sessions (origin)', en_origin), ('disabled', en_disabled),
                         ('enabled for replica sessions only', en_replica), ('enabled always', en_always), ('AFTER ... FOR EACH ROW', after_row), ('fires on INSERT', on_insert),
                         ('fires on UPDATE', on_update), ('fires on DELETE (not expected)', on_delete), ('fires on TRUNCATE (not expected)', on_truncate),
                         ('UPDATE restricted to the images column', update_of_images_only), ('runs function pintag_property_images_trg', fn_expected), ('function is SECURITY DEFINER', fn_secdef),
                         ('function source calls pintag_sync_property_images', fn_calls_sync), ('function source swallows errors (EXCEPTION WHEN OTHERS)', fn_swallows)) AS x(l, v)
  UNION ALL SELECT 9, '9 trigger trg_property_images_sync (pg_trigger catalog; counts of matching triggers)', 'OTHER triggers that run pintag_property_images_trg (any name)', count(*), NULL
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'pintag_property_images_trg' AND t.tgname <> 'trg_property_images_sync' AND NOT t.tgisinternal AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 9, '9 trigger trg_property_images_sync (pg_trigger catalog; counts of matching triggers)', 'function pintag_sync_property_images exists', count(*), NULL
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'pintag_sync_property_images' AND current_setting('transaction_read_only') = 'on'
  UNION ALL SELECT 10, '10 properties.images value shape (listings; a non-array value is skipped by the sync, and a string or object makes it raise an error the trigger swallows)', shape || '; ' || st, count(*), count(*) FROM gal GROUP BY shape, st
  UNION ALL SELECT 10, '10 properties.images value shape (listings; a non-array value is skipped by the sync, and a string or object makes it raise an error the trigger swallows)', 'array with an entry that is not a non-empty string', count(*), count(*) FROM gal WHERE odd_entry
  UNION ALL SELECT 12, '12 recorded gallery states (listing_image_snapshots grouped by event id / timestamp; all listings): can their membership be reconstructed?', 'states', count(*), count(DISTINCT lid) FROM stc
  UNION ALL SELECT 12, '12 recorded gallery states (listing_image_snapshots grouped by event id / timestamp; all listings): can their membership be reconstructed?', 'complete: every row named, image_order exactly 0..n-1', count(*), count(DISTINCT lid) FROM stc WHERE complete
  UNION ALL SELECT 12, '12 recorded gallery states (listing_image_snapshots grouped by event id / timestamp; all listings): can their membership be reconstructed?', 'NOT reconstructable: a row with neither URL nor path', count(*), count(DISTINCT lid) FROM stc WHERE NOT all_named
  UNION ALL SELECT 12, '12 recorded gallery states (listing_image_snapshots grouped by event id / timestamp; all listings): can their membership be reconstructed?', 'NOT reconstructable: image_order null, repeated, not starting at 0 or with a gap', count(*), count(DISTINCT lid) FROM stc WHERE NOT order_ok
  UNION ALL SELECT 11, '11 unregistered originals that match a registry row only under ANOTHER spelling (stored percent-encoded vs raw name)', 'objects', count(*), NULL FROM cb WHERE has_reg
) t ORDER BY s, section, label;
