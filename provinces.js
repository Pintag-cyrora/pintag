// provinces.js — the single source of truth for Laos TOP-LEVEL LOCATIONS
// (17 provinces + Vientiane Capital) and for deriving the customer-facing
// province filter from real inventory.
//
// Same loading convention as currency.js/terminology.js/contact-languages.js:
// plain global vars, no build step, dependency-free (no `document`/`window` in
// the registry or resolvers) so the identical file loads in a browser <script>
// and in a Deno edge function.
//
// ============================================================================
// ARCHITECTURAL RULES
// ============================================================================
//
// 1. LAO_PROVINCES is the single source of truth for province metadata: the
//    canonical English key stored in the database, the Lao and Chinese labels,
//    and the display order. No other file may define any of these.
//
// 2. Registry array order is the CANONICAL order (Vientiane Capital first as
//    the commercial centre, then north to south). The customer filter sorts by
//    COUNT DESCENDING — most inventory first is what a filter is for — and
//    falls back to this registry order to break ties, so the list is always
//    deterministic. Never alphabetize in a consumer, and never re-sort a
//    resolved list.
//
// 3. resolveAvailableProvinces() is the ONLY public API for "which provinces
//    should the customer filter offer". No page may build that list itself.
//
// 4. Adding or renaming a province is ONE entry here plus, if it is a rename,
//    a migration. No consumer changes.
//
// 5. THE CUSTOMER FILTER IS INVENTORY-DRIVEN, NEVER THE RAW REGISTRY. A
//    province appears only when it actually has visible listings matching the
//    other active filters. The registry supplies LABELS and ORDER; the
//    listings supply MEMBERSHIP. Rendering the registry directly would let a
//    customer pick a province and land on "No listings found", which is the
//    specific failure this module exists to prevent.
//
// 6. VISIBILITY IS NOT REDEFINED HERE. This module never decides what
//    "published" means. It counts whatever rows the caller hands it, and the
//    caller passes the array the page already fetched — which is filtered by
//    the existing query (`or=(status.neq.draft,status.is.null)`) and by RLS.
//    A second definition of "visible" is exactly how a draft leaks into a
//    public filter.
//
// 7. ADMIN IS NOT THE CUSTOMER FILTER. Admin/add/edit forms render the full
//    registry (getAllProvinces()), because an agent must be able to create the
//    first listing in a province that has none yet. Only the customer-facing
//    search UI hides empty provinces.
// ============================================================================

var PROVINCES_SCHEMA_VERSION = 1;

// The canonical 18. `key` is what lands in properties.province_en and must
// never change without a migration.
//
// NOTE ON THE COUNT: Laos has 17 provinces plus the prefecture of Vientiane
// Capital. Vientiane Capital and Vientiane Province are DISTINCT entities and
// are listed separately here — conflating them is the classic Laos data bug.
// Xaisomboun (created 2013 from parts of Xiangkhouang and Vientiane Province)
// is a full province and is included.
var LAO_PROVINCES = [
  { key: 'Vientiane Capital',  lo: 'ນະຄອນຫຼວງວຽງຈັນ', zh: '万象首都' },
  { key: 'Vientiane Province', lo: 'ແຂວງວຽງຈັນ',       zh: '万象省'   },
  { key: 'Phongsaly',          lo: 'ຜົ້ງສາລີ',          zh: '丰沙里'   },
  { key: 'Luang Namtha',       lo: 'ຫຼວງນ້ຳທາ',        zh: '琅南塔'   },
  { key: 'Oudomxay',           lo: 'ອຸດົມໄຊ',           zh: '乌多姆赛' },
  { key: 'Bokeo',              lo: 'ບໍ່ແກ້ວ',            zh: '博胶'     },
  { key: 'Luang Prabang',      lo: 'ຫຼວງພະບາງ',        zh: '琅勃拉邦' },
  { key: 'Houaphanh',          lo: 'ຫົວພັນ',            zh: '华潘'     },
  { key: 'Xayabouly',          lo: 'ໄຊຍະບູລີ',          zh: '沙耶武里' },
  { key: 'Xiangkhouang',       lo: 'ຊຽງຂວາງ',          zh: '川圹'     },
  { key: 'Xaisomboun',         lo: 'ໄຊສົມບູນ',          zh: '赛宋本'   },
  { key: 'Bolikhamxay',        lo: 'ບໍລິຄຳໄຊ',          zh: '波里坎赛' },
  { key: 'Khammouane',         lo: 'ຄຳມ່ວນ',            zh: '甘蒙'     },
  { key: 'Savannakhet',        lo: 'ສະຫວັນນະເຂດ',      zh: '沙湾拿吉' },
  { key: 'Salavan',            lo: 'ສາລະວັນ',           zh: '沙拉湾'   },
  { key: 'Sekong',             lo: 'ເຊກອງ',             zh: '塞公'     },
  { key: 'Champasak',          lo: 'ຈຳປາສັກ',           zh: '占巴塞'   },
  { key: 'Attapeu',            lo: 'ອັດຕະປື',           zh: '阿速坡'   }
];

// The default for every listing that predates the province field: Pintag was
// Vientiane-only, and every district in DISTRICT_MAP is a Vientiane Capital
// district. Used by the migration's backfill and by admin's new-listing form.
var DEFAULT_PROVINCE = 'Vientiane Capital';

function provinceByKey(key) {
  if (!key) return null;
  var k = String(key).trim();
  for (var i = 0; i < LAO_PROVINCES.length; i++) {
    if (LAO_PROVINCES[i].key === k) return LAO_PROVINCES[i];
  }
  return null;
}

function isValidProvince(key) { return provinceByKey(key) !== null; }

// The full registry, for ADMIN forms only (rule 7).
function getAllProvinces() { return LAO_PROVINCES.slice(); }

function provinceLabel(key, lang) {
  var p = provinceByKey(key);
  if (!p) return key || null;
  if (lang === 'lo') return p.lo;
  if (lang === 'zh') return p.zh;
  return p.key;
}

// The province a listing belongs to. Falls back to DEFAULT_PROVINCE only when
// the row has a Vientiane Capital district but no province yet — i.e. an
// un-backfilled legacy row. A row with neither resolves to null and is simply
// not counted, rather than being silently filed under the capital.
function resolveListingProvince(property, vientianeDistricts) {
  if (!property) return null;
  var explicit = property.province_en || property.province || null;
  if (explicit && isValidProvince(explicit)) return explicit;
  if (explicit) return null;                       // present but unrecognised
  var d = property.district_en || property.district || null;
  if (d && vientianeDistricts && vientianeDistricts.indexOf(d) !== -1) return DEFAULT_PROVINCE;
  return null;
}

// ---------------------------------------------------------------------------
// resolveAvailableProvinces(listings, opts) — the customer filter (rule 3).
//
// `listings` MUST already be the visible set the page fetched (rule 6).
// opts.matches  — optional predicate applied per listing so the province list
//                 respects the OTHER active filters. Without it the counts
//                 would promise inventory that vanishes the moment the
//                 customer's existing Rent/Apartment selection is applied.
// opts.vientianeDistricts — district keys that imply Vientiane Capital for
//                 legacy rows.
//
// Returns [{ key, label(lang) via provinceLabel, count }] in REGISTRY order,
// containing ONLY provinces with count > 0.
// ---------------------------------------------------------------------------
function resolveAvailableProvinces(listings, opts) {
  opts = opts || {};
  var rows = Array.isArray(listings) ? listings : [];
  var matches = (typeof opts.matches === 'function') ? opts.matches : null;
  var vd = opts.vientianeDistricts || null;

  var counts = {};
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i];
    if (matches && !matches(p)) continue;
    var key = resolveListingProvince(p, vd);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }

  // Count descending, registry order as a stable tie-break (rule 2).
  var out = [];
  for (var j = 0; j < LAO_PROVINCES.length; j++) {
    var k = LAO_PROVINCES[j].key;
    if (counts[k] > 0) out.push({ key: k, count: counts[k], order: j });
  }
  out.sort(function (a, b) { return (b.count - a.count) || (a.order - b.order); });
  for (var m = 0; m < out.length; m++) delete out[m].order;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROVINCES_SCHEMA_VERSION, LAO_PROVINCES, DEFAULT_PROVINCE,
    provinceByKey, isValidProvince, getAllProvinces, provinceLabel,
    resolveListingProvince, resolveAvailableProvinces
  };
}
