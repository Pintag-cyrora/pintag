-- ============================================================================
-- PRICE QUALIFIER REGRESSION ASSERTIONS
-- (supabase/migrations/20261103000000_price_qualifier.sql)
--
--     bash tests/security/regression/run-price-qualifier-pg.sh
--
-- Proves: (1) the migration is additive -- every pre-existing row is untouched and every new column is NULL; (2) exactly four columns are
-- added to each of properties and unit_types; (3) valid exact / from / range values are accepted on both legs of both tables (single-unit and
-- multi-unit shapes); (4) every invalid shape is refused by the database: unknown qualifier, a range without a maximum, a maximum that does not
-- exceed the amount, a range without its own amount, a maximum with a non-range qualifier, a non-positive maximum; (5) idempotency is proven by
-- the runner (the migration is applied twice).
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'REGRESSION FAILED: %', p_what; END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

-- runs a statement that MUST be refused by a CHECK constraint (SQLSTATE 23514); anything else (success or another error) fails the assertion
CREATE OR REPLACE FUNCTION assert_check_violation(p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok  refused: %', p_what;
    RETURN;
  END;
  RAISE EXCEPTION 'REGRESSION FAILED: accepted but must be refused: %', p_what;
END $$;

CREATE OR REPLACE FUNCTION assert_accepted(p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE NOTICE '  ok  accepted: %', p_what;
END $$;

\echo ''
\echo '=== Additive: pre-existing rows untouched, new columns NULL, exactly four columns added per table ==='
DO $$
DECLARE r record;
BEGIN
  PERFORM assert((SELECT count(*) FROM properties) = 5 AND (SELECT count(*) FROM unit_types) = 3, 'row counts unchanged (5 properties, 3 unit types)');
  PERFORM assert((SELECT count(*) FROM properties WHERE price_qualifier IS NOT NULL OR price_max_amount IS NOT NULL
                    OR rent_price_qualifier IS NOT NULL OR rent_price_max_amount IS NOT NULL) = 0, 'every pre-existing property has NULL qualifier columns');
  PERFORM assert((SELECT count(*) FROM unit_types WHERE price_qualifier IS NOT NULL OR price_max_amount IS NOT NULL
                    OR rent_price_qualifier IS NOT NULL OR rent_price_max_amount IS NOT NULL) = 0, 'every pre-existing unit type has NULL qualifier columns');
  SELECT * INTO r FROM properties WHERE id = '00000000-0000-0000-0000-0000000000a1';
  PERFORM assert(r.price_amount = 350 AND r.price_currency = 'USD' AND r.price_frequency = 'month' AND r.price_display = '$350 / month', 'exact-price listing unchanged');
  SELECT * INTO r FROM properties WHERE id = '00000000-0000-0000-0000-0000000000a2';
  PERFORM assert(r.price_amount IS NULL AND r.price_display = '$280-300 / month', 'typed legacy range unchanged');
  SELECT * INTO r FROM properties WHERE id = '00000000-0000-0000-0000-0000000000a4';
  PERFORM assert(r.price_amount = 90000 AND r.rent_price_amount = 400, 'sale_or_rent legs unchanged');
  PERFORM assert((SELECT count(*) FROM information_schema.columns WHERE table_name = 'properties'
                    AND column_name IN ('price_qualifier', 'price_max_amount', 'rent_price_qualifier', 'rent_price_max_amount')) = 4, 'four columns on properties');
  PERFORM assert((SELECT count(*) FROM information_schema.columns WHERE table_name = 'unit_types'
                    AND column_name IN ('price_qualifier', 'price_max_amount', 'rent_price_qualifier', 'rent_price_max_amount')) = 4, 'four columns on unit_types');
  PERFORM assert((SELECT count(*) FROM information_schema.columns WHERE table_name = 'properties') = 13, 'properties has 9 + 4 columns (nothing else added)');
  PERFORM assert((SELECT count(*) FROM information_schema.columns WHERE table_name = 'unit_types') = 13, 'unit_types has 9 + 4 columns (nothing else added)');
  PERFORM assert((SELECT bool_and(is_nullable = 'YES' AND column_default IS NULL) FROM information_schema.columns
                   WHERE table_name IN ('properties', 'unit_types') AND column_name IN ('price_qualifier', 'price_max_amount', 'rent_price_qualifier', 'rent_price_max_amount')),
                 'all new columns are nullable with no default');
END $$;

\echo ''
\echo '=== Accepted: exact / from / range on both legs, single-unit (property) and multi-unit (unit types) ==='
DO $$
DECLARE p text := '00000000-0000-0000-0000-0000000000a1'; a3 text := '00000000-0000-0000-0000-0000000000a3'; a4 text := '00000000-0000-0000-0000-0000000000a4';
BEGIN
  PERFORM assert_accepted(format($f$UPDATE properties SET price_qualifier = 'exact' WHERE id = %L$f$, p), 'property exact');
  PERFORM assert_accepted(format($f$UPDATE properties SET price_qualifier = 'from' WHERE id = %L$f$, p), 'single-unit property marked as a starting price');
  PERFORM assert_accepted(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = 500 WHERE id = %L$f$, p), 'single-unit explicit range 350-500');
  PERFORM assert_accepted(format($f$UPDATE properties SET price_qualifier = NULL, price_max_amount = NULL WHERE id = %L$f$, p), 'qualifier can be cleared back to NULL');
  PERFORM assert_accepted(format($f$UPDATE properties SET rent_price_qualifier = 'range', rent_price_max_amount = 600 WHERE id = %L$f$, a4), 'sale_or_rent: rent leg range 400-600');
  PERFORM assert_accepted(format($f$UPDATE properties SET price_qualifier = 'from' WHERE id = %L$f$, a4), 'sale_or_rent: sale leg starting price');
  PERFORM assert_accepted(format($f$UPDATE unit_types SET price_qualifier = 'range', price_max_amount = 450 WHERE id = '00000000-0000-0000-0000-0000000000b1'$f$), 'unit range 350-450');
  PERFORM assert_accepted($f$UPDATE unit_types SET price_qualifier = 'exact' WHERE id = '00000000-0000-0000-0000-0000000000b2'$f$, 'unit exact (overrides a property-level qualifier)');
  PERFORM assert_accepted($f$UPDATE unit_types SET price_qualifier = 'from' WHERE id = '00000000-0000-0000-0000-0000000000b3'$f$, 'a unit that inherits its price may still carry a qualifier of NULL/from (no own-amount requirement for exact/from)');
  PERFORM assert((SELECT price_max_amount FROM unit_types WHERE id = '00000000-0000-0000-0000-0000000000b1') = 450, 'unit range maximum stored');
END $$;

\echo ''
\echo '=== Refused by the database ==='
DO $$
DECLARE a1 text := '00000000-0000-0000-0000-0000000000a1'; a3 text := '00000000-0000-0000-0000-0000000000a3'; a4 text := '00000000-0000-0000-0000-0000000000a4';
        a5 text := '00000000-0000-0000-0000-0000000000a5'; b3 text := '00000000-0000-0000-0000-0000000000b3'; b1 text := '00000000-0000-0000-0000-0000000000b1';
BEGIN
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'cheap' WHERE id = %L$f$, a1), 'unknown qualifier value (properties)');
  PERFORM assert_check_violation(format($f$UPDATE properties SET rent_price_qualifier = 'Exact' WHERE id = %L$f$, a4), 'qualifier is case-sensitive (rent leg)');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range' WHERE id = %L$f$, a1), 'range without a maximum');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = 350 WHERE id = %L$f$, a1), 'maximum equal to the amount');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = 100 WHERE id = %L$f$, a1), 'maximum below the amount');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = 500 WHERE id = %L$f$, a3), 'range without its own amount (no inferred range)');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = 500 WHERE id = %L$f$, a5), 'range on a zero amount');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'exact', price_max_amount = 500 WHERE id = %L$f$, a1), 'a maximum with qualifier exact');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'from', price_max_amount = 500 WHERE id = %L$f$, a1), 'a maximum with qualifier from');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_max_amount = 500 WHERE id = %L$f$, a1), 'a maximum with no qualifier');
  PERFORM assert_check_violation(format($f$UPDATE properties SET price_qualifier = 'range', price_max_amount = -5 WHERE id = %L$f$, a1), 'a non-positive maximum');
  PERFORM assert_check_violation(format($f$UPDATE properties SET rent_price_qualifier = 'range', rent_price_max_amount = 300 WHERE id = %L$f$, a4), 'rent leg: maximum below the rent amount');
  PERFORM assert_check_violation(format($f$UPDATE properties SET rent_price_qualifier = 'range', rent_price_max_amount = 600 WHERE id = %L$f$, a1), 'rent leg: range without a rent amount');
  PERFORM assert_check_violation(format($f$UPDATE properties SET rent_price_max_amount = 600 WHERE id = %L$f$, a1), 'rent leg: maximum without the range qualifier');
  PERFORM assert_check_violation(format($f$UPDATE unit_types SET price_qualifier = 'cheap' WHERE id = %L$f$, b1), 'unknown qualifier value (unit_types)');
  PERFORM assert_check_violation(format($f$UPDATE unit_types SET price_qualifier = 'range', price_max_amount = 450 WHERE id = %L$f$, b3), 'unit range without its OWN amount (inheriting a building price is not enough)');
  PERFORM assert_check_violation(format($f$UPDATE unit_types SET price_max_amount = 100 WHERE id = %L$f$, b1), 'unit: maximum below the amount while range');
  PERFORM assert_check_violation(format($f$UPDATE unit_types SET price_qualifier = 'exact' WHERE id = %L$f$, b1), 'unit: switching to exact while a maximum remains');
  PERFORM assert_check_violation(format($f$UPDATE unit_types SET rent_price_qualifier = 'range', rent_price_max_amount = 900 WHERE id = %L$f$, b1), 'unit rent leg: range without a rent amount');
  PERFORM assert_check_violation(format($f$INSERT INTO properties (price_amount, price_qualifier) VALUES (100, 'range')$f$), 'INSERT of an incomplete range');
  PERFORM assert_check_violation(format($f$INSERT INTO unit_types (property_id, name_en, price_amount, price_qualifier, price_max_amount) VALUES (%L, 'X', 100, 'range', 90)$f$, a1), 'INSERT of a unit range with max below amount');
END $$;

\echo ''
\echo '=== Rows that were refused left the data unchanged ==='
DO $$
BEGIN
  PERFORM assert((SELECT price_qualifier FROM properties WHERE id = '00000000-0000-0000-0000-0000000000a1') IS NULL
             AND (SELECT price_amount FROM properties WHERE id = '00000000-0000-0000-0000-0000000000a1') = 350, 'a refused update left the property untouched');
  PERFORM assert((SELECT count(*) FROM properties) = 5 AND (SELECT count(*) FROM unit_types) = 3, 'a refused insert added no row');
END $$;

\echo ''
\echo 'All price-qualifier assertions passed.'
