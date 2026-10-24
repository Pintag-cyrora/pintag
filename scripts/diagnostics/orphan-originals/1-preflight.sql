-- 1-preflight.sql -- READ-ONLY, catalog-only preflight. One plain SELECT: no procedural blocks, no table data is read.
-- Part A checks that every table/column the diagnostic needs exists, has the expected type and is readable.
-- Part B audits the connected role and the session. It is a conservative WARNING system (it can FAIL on things that are
-- harmless, never PASS on the things it checks if they are present), NOT a proof that no write path exists.
-- Write-type privileges (rows 30-32): the ONLY ones tolerated are the four platform objects that Supabase's pg_cron / pg_net
-- extensions grant to PUBLIC (so every role has them): cron.job_run_details, net._http_response, net.http_request_queue and
-- net.http_request_queue_id_seq -- exact schema.name AND kind, and only while every privilege the role holds on them is itself
-- granted to PUBLIC (no direct grant, not the owner). Anything else is a FAIL, with its name printed.
-- Part C (area 'reconcile-schema') checks the extra tables/columns only 3-reconcile.sql / 4-source-health.sql need (the recovery
-- and import history tables). It has its OWN verdict, so a missing history column never hides the stage-2 diagnostic, and it
-- never loosens Parts A/B: those verdicts are computed exactly as before.
-- Part D (area 'gallery-schema') checks the extra columns only 5-gallery-listing-state.sql reads (gallery_assignments.cluster_id/confidence and
-- properties.deleted_at as a timestamptz, so a listing is never called active when its deletion state is unknown), with its OWN
-- verdict (the other verdicts are computed exactly as before).
-- Part E (area 'history-schema') checks listing_image_snapshots.provenance_event_id, which only 7-gallery-history-vs-snapshots.sql groups gallery
-- states by, with its OWN verdict (the other verdicts are computed exactly as before).
-- Output: "area | item | status" rows; the last five rows are "VERDICT | ... | PASS/FAIL". Contains only names and counts.
WITH need(sch, tbl, col, typ) AS (VALUES
    ('storage',  'objects',                'bucket_id',    NULL::text),
    ('storage',  'objects',                'name',         NULL),
    ('public',   'properties',             'id',           NULL),
    ('public',   'properties',             'images',       'jsonb'),
    ('public',   'unit_types',             'images',       'text[]'),
    ('public',   'parties',                'photo_url',    NULL),
    ('public',   'property_images',        'storage_path', NULL),
    ('public',   'listing_image_snapshots','listing_id',   NULL),
    ('public',   'listing_image_snapshots','storage_path', NULL),
    ('public',   'import_images',          'storage_path', NULL)),
need3(sch, tbl, col, typ) AS (VALUES   -- stage 3 only (reconciliation); judged by the separate 'reconcile-schema' verdict
    ('storage',  'objects',                'created_at',   NULL::text),
    ('storage',  'objects',                'metadata',     'jsonb'),
    ('public',   'property_images',        'status',       NULL),
    ('public',   'gallery_assignments',    'id',           NULL),
    ('public',   'gallery_assignments',    'op',           NULL),
    ('public',   'gallery_assignments',    'listing_id',   NULL),
    ('public',   'gallery_assignments',    'photo_paths',  'jsonb'),
    ('public',   'gallery_assignments',    'created_at',   NULL),
    ('public',   'properties_row_snapshots','id',          NULL),
    ('public',   'properties_row_snapshots','property_id', NULL),
    ('public',   'properties_row_snapshots','op',          NULL),
    ('public',   'properties_row_snapshots','row_data',    'jsonb'),
    ('public',   'properties_row_snapshots','created_at',  NULL),
    ('public',   'import_records',         'id',           NULL),
    ('public',   'import_records',         'listing_id',   NULL),
    ('public',   'import_records',         'raw_payload',  'jsonb'),
    ('public',   'import_records',         'imported_at',  NULL),
    ('public',   'listing_image_snapshots','id',           NULL),
    ('public',   'listing_image_snapshots','storage_url',  NULL),
    ('public',   'listing_image_snapshots','created_at',   NULL),
    ('public',   'import_images',          'id',           NULL),
    ('public',   'import_images',          'listing_id',   NULL),
    ('public',   'import_images',          'storage_url',  NULL),
    ('public',   'import_images',          'uploaded_at',  NULL)),
need5(sch, tbl, col, typ) AS (VALUES   -- gallery listing-state stage only; judged by the separate 'gallery-schema' verdict
    ('public',   'gallery_assignments',    'cluster_id',   NULL::text),
    ('public',   'gallery_assignments',    'confidence',   NULL),
    ('public',   'properties',             'deleted_at',   'timestamp with time zone'),   -- required: an unknown deletion state must never read as "active"
    ('public',   'properties',             'id',           NULL),
    ('public',   'properties',             'images',       'jsonb')),
need6(sch, tbl, col, typ) AS (VALUES   -- gallery history vs snapshots stage only; judged by the separate 'history-schema' verdict
    ('public',   'listing_image_snapshots','provenance_event_id', 'uuid'),
    ('public',   'import_records',         'imported_at',        NULL)),
have AS (
  SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, c.oid AS relid
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')),
me AS (SELECT * FROM pg_roles WHERE rolname = current_user),
scope AS (   -- every non-system relation/schema, for the privilege counts
  SELECT c.oid, c.relkind, n.oid AS nsp, n.nspname AS sch, c.relname AS name, c.relacl, c.relowner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'),
allowed(sch, name, kind) AS (VALUES   -- the ONLY tolerated write-type privileges (see the header comment)
    ('cron', 'job_run_details',           'r'),
    ('net',  '_http_response',            'r'),
    ('net',  'http_request_queue',        'r'),
    ('net',  'http_request_queue_id_seq', 'S')),
wr AS (   -- per relation: the write-type privileges the role holds (each function is only called on the kinds it accepts)
  SELECT s.*,
         CASE WHEN s.relkind IN ('r', 'p')
              THEN ARRAY(SELECT p FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p WHERE has_table_privilege(s.oid, p))
              ELSE ARRAY[]::text[] END AS tbl_privs,
         CASE WHEN s.relkind = 'S'
              THEN ARRAY(SELECT p FROM unnest(ARRAY['USAGE', 'UPDATE']) p WHERE has_sequence_privilege(s.oid, p))
              ELSE ARRAY[]::text[] END AS seq_privs,
         CASE WHEN s.relkind IN ('r', 'p', 'v', 'm', 'f') THEN has_any_column_privilege(s.oid, 'INSERT,UPDATE') ELSE false END AS col_any
  FROM scope s),
wr2 AS (   -- only relations where the role holds something; flag what PUBLIC does NOT explain
  SELECT w.*,
         EXISTS (SELECT 1 FROM unnest(w.tbl_privs || w.seq_privs) p
                  WHERE NOT EXISTS (SELECT 1 FROM aclexplode(w.relacl) x WHERE x.grantee = 0 AND x.privilege_type = p)) AS direct_tbl,
         CASE WHEN w.relkind IN ('r', 'p', 'v', 'm', 'f')
              THEN EXISTS (SELECT 1 FROM pg_attribute a, unnest(ARRAY['INSERT', 'UPDATE']) p
                            WHERE a.attrelid = w.oid AND a.attnum > 0 AND NOT a.attisdropped
                              AND has_column_privilege(w.oid, a.attnum, p)
                              AND NOT EXISTS (SELECT 1 FROM aclexplode(w.relacl) x WHERE x.grantee = 0 AND x.privilege_type = p)
                              AND NOT EXISTS (SELECT 1 FROM aclexplode(a.attacl) y WHERE y.grantee = 0 AND y.privilege_type = p))
              ELSE false END AS direct_col,
         (w.relowner = (SELECT oid FROM me)) AS is_owner,
         EXISTS (SELECT 1 FROM allowed al WHERE al.sch = w.sch AND al.name = w.name AND al.kind = w.relkind::text) AS on_allowlist
  FROM wr w
  WHERE cardinality(w.tbl_privs) > 0 OR cardinality(w.seq_privs) > 0 OR w.col_any),
wr3 AS (
  SELECT *, (on_allowlist AND NOT direct_tbl AND NOT direct_col AND NOT is_owner) AS allowed_ok FROM wr2),
rows_all AS (
  SELECT 10 AS ord, 'schema' AS area, x.sch || '.' || x.tbl || '.' || x.col AS item,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END AS status
    FROM need x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
  UNION ALL
  SELECT 12, 'reconcile-schema', x.sch || '.' || x.tbl || '.' || x.col,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END
    FROM need3 x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
  UNION ALL
  SELECT 14, 'gallery-schema', x.sch || '.' || x.tbl || '.' || x.col,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END
    FROM need5 x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
  UNION ALL
  SELECT 15, 'history-schema', x.sch || '.' || x.tbl || '.' || x.col,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END
    FROM need6 x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
  UNION ALL SELECT 13, 'reconcile-schema', 'tables read only by the reconciliation with row-level security this role cannot bypass (counts would be UNTRUSTWORTHY)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ': ' || coalesce(names, '') || ')' END
    FROM (SELECT count(*) AS n, string_agg(DISTINCT c.relnamespace::regnamespace::text || '.' || c.relname, ', ') AS names
            FROM pg_class c, me
           WHERE c.oid IN (SELECT relid FROM have WHERE (sch, tbl) IN (SELECT sch, tbl FROM need3))
             AND c.relrowsecurity
             AND NOT (me.rolsuper OR me.rolbypassrls OR (c.relowner = me.oid AND NOT c.relforcerowsecurity))) q
  UNION ALL SELECT 21, 'role', 'rolsuper',       CASE WHEN rolsuper       THEN 'FAIL (true)' ELSE 'ok' END FROM me
  UNION ALL SELECT 22, 'role', 'rolcreaterole',  CASE WHEN rolcreaterole  THEN 'FAIL (true)' ELSE 'ok' END FROM me
  UNION ALL SELECT 23, 'role', 'rolcreatedb',    CASE WHEN rolcreatedb    THEN 'FAIL (true)' ELSE 'ok' END FROM me
  UNION ALL SELECT 24, 'role', 'rolreplication', CASE WHEN rolreplication THEN 'FAIL (true)' ELSE 'ok' END FROM me
  UNION ALL SELECT 25, 'role', 'rolbypassrls (a backup reader should have it, else row-level security can hide rows from the counts)',
         CASE WHEN rolbypassrls THEN 'info true' ELSE 'WARN false: see the row-level-security check below' END FROM me
  UNION ALL SELECT 26, 'role', 'rolinherit (info)', 'info ' || rolinherit::text FROM me
  UNION ALL SELECT 27, 'role', 'tables read by the diagnostic with row-level security this role cannot bypass (counts would be UNTRUSTWORTHY)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ': ' || coalesce(names, '') || ')' END
    FROM (SELECT count(*) AS n, string_agg(DISTINCT c.relnamespace::regnamespace::text || '.' || c.relname, ', ') AS names
            FROM pg_class c, me
           WHERE c.oid IN (SELECT relid FROM have WHERE (sch, tbl) IN (SELECT sch, tbl FROM need))
             AND c.relrowsecurity
             AND NOT (me.rolsuper OR me.rolbypassrls OR (c.relowner = me.oid AND NOT c.relforcerowsecurity))) q
  UNION ALL SELECT 30, 'role', 'tables with table-level INSERT/UPDATE/DELETE/TRUNCATE (other than the 4 allowed PUBLIC-granted platform objects)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ': ' || coalesce(names, '') || ')' END
    FROM (SELECT count(*) AS n, array_to_string((array_agg(sch || '.' || name ORDER BY sch, name))[1:20], ', ') AS names
            FROM wr3 WHERE NOT allowed_ok AND cardinality(tbl_privs) > 0) q
  UNION ALL SELECT 31, 'role', 'relations with column-level INSERT/UPDATE (other than the 4 allowed PUBLIC-granted platform objects)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ': ' || coalesce(names, '') || ')' END
    FROM (SELECT count(*) AS n, array_to_string((array_agg(sch || '.' || name ORDER BY sch, name))[1:20], ', ') AS names
            FROM wr3 WHERE NOT allowed_ok AND col_any) q
  UNION ALL SELECT 32, 'role', 'sequences with USAGE/UPDATE (other than the allowed PUBLIC-granted platform sequence)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ': ' || coalesce(names, '') || ')' END
    FROM (SELECT count(*) AS n, array_to_string((array_agg(sch || '.' || name ORDER BY sch, name))[1:20], ', ') AS names
            FROM wr3 WHERE NOT allowed_ok AND cardinality(seq_privs) > 0) q
  UNION ALL SELECT 33, 'role', 'non-system schemas with CREATE',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ')' END
    FROM (SELECT count(DISTINCT nsp) AS n FROM scope WHERE has_schema_privilege(nsp, 'CREATE')) q
  UNION ALL SELECT 34, 'role', 'membership in ANY other role (direct or inherited, INHERIT or not; no exceptions)',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ')' END
    FROM (SELECT count(*) AS n FROM pg_roles r, me WHERE r.oid <> me.oid AND pg_has_role(me.oid, r.oid, 'MEMBER')) q
  UNION ALL SELECT 35, 'role', 'SECURITY DEFINER functions this role can EXECUTE (info only: could write on its behalf)',
         'info ' || n::text
    FROM (SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
           WHERE p.prosecdef AND s.nspname !~ '^pg_' AND s.nspname <> 'information_schema' AND has_function_privilege(p.oid, 'EXECUTE')) q
  UNION ALL SELECT 36, 'role', 'database CREATE/TEMP (info only)',
         'info create=' || has_database_privilege(current_database(), 'CREATE')::text || ' temp=' || has_database_privilege(current_database(), 'TEMP')::text
  UNION ALL SELECT 37, 'role', 'allowed PUBLIC-granted platform write privileges present (info: pg_cron / pg_net objects every role has)',
         'info ' || n::text || ' of 4' || CASE WHEN n > 0 THEN ': ' || names ELSE '' END
    FROM (SELECT count(*) AS n, array_to_string(array_agg(sch || '.' || name ORDER BY sch, name), ', ') AS names FROM wr3 WHERE allowed_ok) q
  UNION ALL SELECT 40, 'session', 'transaction_read_only (must be on: the READ ONLY transaction is open)',
         CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'ok' ELSE 'FAIL (' || current_setting('transaction_read_only') || ')' END
  UNION ALL SELECT 41, 'session', 'default_transaction_read_only (info only: a connection pooler may drop startup options; the READ ONLY transaction above is what is enforced)',
         'info ' || current_setting('default_transaction_read_only'))
SELECT area, item, status FROM (
  SELECT ord, area, item, status FROM rows_all
  UNION ALL SELECT 90, 'VERDICT', 'schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 91, 'VERDICT', 'role+session',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area IN ('role', 'session') AND status LIKE 'FAIL%') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 94, 'VERDICT', 'history-schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'history-schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 93, 'VERDICT', 'gallery-schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'gallery-schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 92, 'VERDICT', 'reconcile-schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'reconcile-schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
) t ORDER BY ord, item;
