-- 1-preflight.sql -- READ-ONLY, CATALOG ONLY. ONE plain SELECT: it reads pg_catalog / information views and role facts, never a data row of any
-- public table. Runs inside the READ ONLY transaction that psql opens on the command line. Output rows: area | item | status. Two verdicts follow:
--   VERDICT | catalogue-schema | PASS   every table/column the catalogue query reads exists, has the expected type and is SELECT-able
--   VERDICT | role+session     | PASS   the connection cannot write, row-level security cannot hide rows from it, and the transaction is READ ONLY
-- run.sh refuses to run the data query unless BOTH say PASS and no row says WARN. A WARN (for example row-level security applying to this role,
-- which would hide rows and make every count untrustworthy) also makes role+session FAIL, so no reader can take PASS as "all rows visible".
WITH need(sch, tbl, col, typ) AS (VALUES
    ('public', 'properties',       'id',               NULL::text),
    ('public', 'properties',       'deleted_at',       'timestamp with time zone'),
    ('public', 'properties',       'status',           NULL),   -- the column the public read policy tests (see 2-catalogue.sql, "published")
    ('public', 'properties',       'workflow_status',  NULL),
    ('public', 'properties',       'market_status',    NULL),
    ('public', 'properties',       'transaction_type', NULL),
    ('public', 'properties',       'images',           'jsonb'),
    ('public', 'properties',       'created_at',       NULL),
    ('public', 'unit_types',       'id',               NULL),
    ('public', 'unit_types',       'property_id',      NULL),
    ('public', 'leads',            'property_id',      NULL),
    ('public', 'property_images',  'property_id',      NULL),
    ('public', 'property_contacts','property_id',      NULL)),
have AS (
  SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, c.oid AS relid
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND n.nspname = 'public'),
tabs AS (
  SELECT DISTINCT x.tbl, c.oid AS relid, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, c.relowner AS owner
    FROM need x LEFT JOIN pg_class c ON c.relname = x.tbl AND c.relnamespace = 'public'::regnamespace),
me AS (SELECT rolsuper, rolbypassrls, oid AS roid FROM pg_roles WHERE rolname = current_user),
rows_all(ord, area, item, status) AS (
  SELECT 10, 'catalogue-schema', x.sch || '.' || x.tbl || '.' || x.col,
         CASE WHEN h.col IS NULL THEN 'MISSING'
              WHEN x.typ IS NOT NULL AND h.typ <> x.typ THEN 'WRONG_TYPE (is ' || h.typ || ', expected ' || x.typ || ')'
              WHEN NOT has_table_privilege(h.relid, 'SELECT') THEN 'NO_SELECT'
              ELSE 'ok' END
    FROM need x LEFT JOIN have h ON h.sch = x.sch AND h.tbl = x.tbl AND h.col = x.col
  UNION ALL
  SELECT 20, 'role', 'table-level INSERT/UPDATE/DELETE/TRUNCATE on ' || t.tbl,
         CASE WHEN t.relid IS NULL THEN 'FAIL (table missing)'
              WHEN has_table_privilege(t.relid, 'INSERT') OR has_table_privilege(t.relid, 'UPDATE')
                OR has_table_privilege(t.relid, 'DELETE') OR has_table_privilege(t.relid, 'TRUNCATE') THEN 'FAIL (this role can write)'
              ELSE 'ok' END
    FROM tabs t
  UNION ALL
  SELECT 21, 'role', 'row-level security cannot hide rows of ' || t.tbl || ' (counts would be UNTRUSTWORTHY)',
         CASE WHEN t.relid IS NULL THEN 'FAIL (table missing)'
              WHEN t.rls AND NOT (SELECT rolbypassrls OR rolsuper FROM me) AND (t.forced OR t.owner <> (SELECT roid FROM me)) THEN 'WARN (RLS applies to this role)'
              ELSE 'ok' END
    FROM tabs t
  UNION ALL
  SELECT 22, 'role', 'superuser (a backup reader should not be one)',
         CASE WHEN (SELECT rolsuper FROM me) THEN 'FAIL (superuser)' ELSE 'ok' END
  UNION ALL
  SELECT 30, 'session', 'transaction_read_only (must be on: the READ ONLY transaction is open)',
         CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'ok' ELSE 'FAIL (transaction is not read only)' END
)
SELECT area, item, status FROM (
  SELECT ord, area, item, status FROM rows_all
  UNION ALL SELECT 90, 'VERDICT', 'catalogue-schema',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area = 'catalogue-schema' AND status <> 'ok') THEN 'FAIL' ELSE 'PASS' END
  UNION ALL SELECT 91, 'VERDICT', 'role+session',
         CASE WHEN EXISTS (SELECT 1 FROM rows_all WHERE area IN ('role', 'session') AND (status LIKE 'FAIL%' OR status LIKE 'WARN%')) THEN 'FAIL' ELSE 'PASS' END
) t ORDER BY ord, item;
