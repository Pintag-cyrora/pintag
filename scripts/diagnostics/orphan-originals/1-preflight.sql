-- 1-preflight.sql -- READ-ONLY, catalog-only preflight. One plain SELECT: no procedural blocks, no table data is read.
-- Part A checks that every table/column the diagnostic needs exists, has the expected type and is readable.
-- Part B audits the connected role and the session. It is a conservative WARNING system (it can FAIL on things that are
-- harmless, never PASS on the things it checks if they are present), NOT a proof that no write path exists.
-- Output: "area | item | status" rows; the last two rows are "VERDICT | ... | PASS/FAIL". Contains only names and counts.
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
have AS (
  SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, c.oid AS relid
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')),
me AS (SELECT * FROM pg_roles WHERE rolname = current_user),
scope AS (   -- every non-system relation/schema, for the privilege counts
  SELECT c.oid, c.relkind, n.oid AS nsp FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'),
rows_all AS (
  SELECT 10 AS ord, 'schema' AS area, x.sch || '.' || x.tbl || '.' || x.col AS item,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END AS status
    FROM need x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
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
  UNION ALL SELECT 30, 'role', 'tables with table-level INSERT/UPDATE/DELETE/TRUNCATE',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ')' END
    FROM (SELECT count(*) AS n FROM scope WHERE CASE WHEN relkind IN ('r', 'p') THEN has_table_privilege(oid, 'INSERT,UPDATE,DELETE,TRUNCATE') ELSE false END) q
  UNION ALL SELECT 31, 'role', 'relations with column-level INSERT/UPDATE',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ')' END
    FROM (SELECT count(*) AS n FROM scope WHERE CASE WHEN relkind IN ('r', 'p', 'v', 'm', 'f') THEN has_any_column_privilege(oid, 'INSERT,UPDATE') ELSE false END) q
  UNION ALL SELECT 32, 'role', 'sequences with USAGE/UPDATE',
         CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL (' || n || ')' END
    FROM (SELECT count(*) AS n FROM scope WHERE CASE WHEN relkind = 'S' THEN has_sequence_privilege(oid, 'USAGE,UPDATE') ELSE false END) q
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
  UNION ALL SELECT 40, 'session', 'transaction_read_only (must be on: the READ ONLY transaction is open)',
         CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'ok' ELSE 'FAIL (' || current_setting('transaction_read_only') || ')' END
  UNION ALL SELECT 41, 'session', 'default_transaction_read_only (must be on: PGOPTIONS was applied by the server or pooler)',
         CASE WHEN current_setting('default_transaction_read_only') = 'on' THEN 'ok' ELSE 'FAIL (' || current_setting('default_transaction_read_only') || ')' END)
SELECT area, item, status FROM (
  SELECT ord, area, item, status FROM rows_all
  UNION ALL SELECT 90, 'VERDICT', 'schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 91, 'VERDICT', 'role+session',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area IN ('role', 'session') AND status LIKE 'FAIL%') THEN 'FAIL' ELSE 'PASS' END
) t ORDER BY ord, item;
