-- LAOS-WIDE LOCATION COVERAGE: province on every listing
--
-- Pintag was Vientiane-only: properties carried district_en/_lo/_zh (the 7
-- Vientiane Capital districts in DISTRICT_MAP) and NO province concept at all.
-- This adds the top-level location so listings can exist in all 17 provinces
-- plus Vientiane Capital.
--
-- Shape follows the EXISTING district convention exactly -- three denormalized
-- trilingual columns rather than a lookup table -- so every reader that already
-- does `district_en`/`district_lo` gets `province_en`/`province_lo` with no new
-- join and no new query shape. The canonical key registry lives in
-- provinces.js (LAO_PROVINCES); province_en stores that key verbatim.
--
-- Purely additive: three nullable columns, one CHECK, one index, and a backfill
-- that only fills the new columns. No column is dropped, no type changes, and
-- no pre-existing column is rewritten.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS province_en text,
  ADD COLUMN IF NOT EXISTS province_lo text,
  ADD COLUMN IF NOT EXISTS province_zh text;

COMMENT ON COLUMN properties.province_en IS
  'Canonical Laos top-level location key -- one of the 18 in provinces.js LAO_PROVINCES (17 provinces + Vientiane Capital). Vientiane Capital and Vientiane Province are DISTINCT and must never be conflated. NULL only on a row that predates this migration and has no recognisable Vientiane district. Read via resolveListingProvince(); the customer-facing filter is built by resolveAvailableProvinces() from real inventory, never from the registry.';
COMMENT ON COLUMN properties.province_lo IS 'Lao label for province_en, denormalized exactly as district_lo is.';
COMMENT ON COLUMN properties.province_zh IS 'Chinese label for province_en, denormalized exactly as district_zh is.';

-- Backfill: every existing listing is in Vientiane Capital. Every district in
-- DISTRICT_MAP is a Vientiane Capital district, so this is a statement of fact
-- about the current inventory, not a guess. Rows with an unrecognised district
-- are deliberately LEFT NULL rather than filed under the capital -- an unknown
-- location must not become a wrong one.
UPDATE properties
   SET province_en = 'Vientiane Capital',
       province_lo = 'ນະຄອນຫຼວງວຽງຈັນ',
       province_zh = '万象首都'
 WHERE province_en IS NULL
   AND district_en IN ('Sisattanak','Saysettha','Chanthabouly','Sikhottabong',
                       'Xaythany','Hadxaifong','Naxaithong');

-- Guard the key set at the database level so a typo ('Vientiane' alone, or a
-- duplicated 'Bokeo') cannot enter through any client. NULL stays allowed for
-- the un-backfillable legacy rows above.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_province_en_check;
ALTER TABLE properties ADD CONSTRAINT properties_province_en_check
  CHECK (province_en IS NULL OR province_en IN (
    'Vientiane Capital','Vientiane Province','Phongsaly','Luang Namtha',
    'Oudomxay','Bokeo','Luang Prabang','Houaphanh','Xayabouly','Xiangkhouang',
    'Xaisomboun','Bolikhamxay','Khammouane','Savannakhet','Salavan','Sekong',
    'Champasak','Attapeu'));

-- The customer filter counts by province across the visible set on every
-- render; index it the way district filtering is already served.
CREATE INDEX IF NOT EXISTS idx_properties_province_en ON properties(province_en);
