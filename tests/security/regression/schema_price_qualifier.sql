-- ============================================================================
-- Minimal fixture for the price-qualifier regression
-- (supabase/migrations/20261103000000_price_qualifier.sql).
--
-- Recreates the price columns of properties / unit_types AS THEY EXIST TODAY (right before this migration), including rows that already carry
-- prices, so applying the migration on top is a genuine upgrade test: existing data must be untouched. Same trimmed-fixture convention as the
-- other schema_*.sql files in this directory; not a replica of production.
-- ============================================================================

CREATE TABLE properties (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type     text,
  price_amount         numeric,
  price_currency       text,
  price_frequency      text,
  rent_price_amount    numeric,
  rent_price_currency  text,
  rent_price_frequency text,
  price_display        text
);

CREATE TABLE unit_types (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name_en              text,
  price_amount         numeric,
  price_currency       text,
  price_frequency      text,
  rent_price_amount    numeric,
  rent_price_currency  text,
  rent_price_frequency text
);

-- Pre-existing listings (before the migration): exact price, a typed legacy range, a multi-unit building, a sale_or_rent row, an empty row.
INSERT INTO properties (id, transaction_type, price_amount, price_currency, price_frequency, rent_price_amount, rent_price_currency, rent_price_frequency, price_display) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'for_rent',     350, 'USD', 'month', NULL, NULL, NULL, '$350 / month'),
  ('00000000-0000-0000-0000-0000000000a2', 'for_rent',     NULL, NULL, NULL, NULL, NULL, NULL, '$280-300 / month'),
  ('00000000-0000-0000-0000-0000000000a3', 'for_rent',     NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000000a4', 'sale_or_rent', 90000, 'USD', NULL, 400, 'USD', 'month', NULL),
  ('00000000-0000-0000-0000-0000000000a5', 'for_sale',     0, 'USD', NULL, NULL, NULL, NULL, NULL);
INSERT INTO unit_types (id, property_id, name_en, price_amount, price_currency, price_frequency) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', 'Studio', 350, 'USD', 'month'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a3', '2BR',    500, 'USD', 'month'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3', 'Inherits', NULL, NULL, NULL);
