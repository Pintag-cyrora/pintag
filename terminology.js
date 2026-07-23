// terminology.js — shared terminology registry, used by admin.html,
// add-property.html, edit-listing.html, and (via PROPERTY_TYPE_DISPLAY
// below) listing.html, listings.html, and index.html. Same convention as
// amenities.js: plain global vars, no build step, loaded via
// <script src="terminology.js"> before each page's own inline <script>.
//
// isMultiUnitBuilding()/resolveUnitType() near the bottom of this file are
// the Multi-Unit Buildings (Phase 1) resolver — see
// supabase/migrations/20260720000000_unit_types.sql.
//
// PROPERTY_TYPES is the single source of truth for property-type labels
// (English/Lao/Chinese) — do not hardcode these strings elsewhere.
//
// PROPERTY_TYPE_FIELDS drives the "Property Details" section of the
// listing form: which fields are relevant for a given property type, so
// the form can be rendered from this schema instead of showing every
// field for every type (e.g. Land never shows Bedrooms/Bathrooms).
//
// PHASE 1 SCOPE (house/townhouse/villa/apartment/condo/commercial): every
// field maps to a column that already exists and is already wired
// end-to-end (bedrooms, bathrooms, sqm, sqm_land, floors, year_built,
// parking_spaces, furnished), or references a filtered subset of the
// existing FEATURES/AMENITIES registries via kind:'checkbox_ref'
// (pool/garden/balcony/elevator etc. stay as checkboxes there — they are
// NOT duplicated as new columns here).
//
// PHASE 2 (land — wired in below as of the
// 20260709000000_land_specific_fields.sql migration): land_width_m,
// land_length_m, road_frontage_m, road_width_m, road_surface,
// land_category, land_shape, land_terrain, existing_structure, and
// land_best_use. IMPORTANT: this migration must actually be applied to
// whichever database the running code talks to (pintag-dev, then
// production, each its own explicit step) BEFORE this file is deployed
// there — PostgREST rejects save payloads that reference unknown columns,
// so deploying this code ahead of the migration would break saving every
// Land listing.
//
// Still not yet implemented: apartment/condo floor_number + maintenance_fee
// + building_facilities, commercial main_road_access. Same rule applies —
// don't add fields referencing these until their own migration has been
// applied where the code will run.
//
// Two of Land's fields deliberately answer different questions:
//   land_category — the land's current legal/primary categorization
//                    (residential/commercial/agricultural/industrial/
//                    mixed_use). What it legally/primarily IS today.
//   land_best_use  — buyer-facing development potential, multi-select
//                    (apartment_development/villa/warehouse/retail/resort/
//                    investment). What a buyer COULD do with it. A lot
//                    categorized "residential" today can still be an
//                    excellent Apartment Development opportunity.
//
// Adding a future property type (Warehouse, Hotel, Office, Factory) means
// adding one new entry to each of these two objects — no changes to any
// form's HTML or to the render/save/load functions that consume them.

var PROPERTY_TYPES = {
  house:      {en:'House',      lo:'ເຮືອນ',        zh:'独栋别墅'},
  townhouse:  {en:'Townhouse',  lo:'ທາວເຮົາສ໌',    zh:'联排别墅'},
  villa:      {en:'Villa',      lo:'ວິນລ່າ',        zh:'别墅'},
  apartment:  {en:'Apartment',  lo:'ອາພາດເມັນ',    zh:'公寓'},
  condo:      {en:'Condo',      lo:'ຄອນໂດ',        zh:'公寓楼'},
  commercial: {en:'Commercial', lo:'ອາຄານພານິດ',   zh:'商业地产'},
  land:       {en:'Land',       lo:'ທີ່ດິນ',        zh:'土地'}
};

// Shared option lists reused by multiple types' `furnished` field.
var FURNISHED_OPTIONS = [
  {value:'',            label:{en:'Not specified',       lo:'ບໍ່ໄດ້ລະບຸ',            zh:'未指定'}},
  {value:'fully',       label:{en:'Fully Furnished',      lo:'ມີເຄື່ອງເຟີນີເຈີຄົບ',   zh:'全套家具'}},
  {value:'partially',   label:{en:'Partially Furnished',  lo:'ມີເຄື່ອງເຟີນີເຈີບາງສ່ວນ', zh:'部分家具'}},
  {value:'unfurnished', label:{en:'Unfurnished',          lo:'ບໍ່ມີເຄື່ອງເຟີນີເຈີ',    zh:'无家具'}}
];

// Unit-type-only option list (no building-level equivalent field) — used by
// resolveUnitType()'s `orientation` output and the admin Unit Type card.
var ORIENTATION_OPTIONS = [
  {value:'',          label:{en:'Not specified', lo:'ບໍ່ໄດ້ລະບຸ',     zh:'未指定'}},
  {value:'north',     label:{en:'North-Facing',  lo:'ຫັນໜ້າໄປທິດເໜືອ', zh:'朝北'}},
  {value:'south',     label:{en:'South-Facing',  lo:'ຫັນໜ້າໄປທິດໃຕ້',  zh:'朝南'}},
  {value:'east',      label:{en:'East-Facing',   lo:'ຫັນໜ້າໄປທິດຕາເວັນອອກ', zh:'朝东'}},
  {value:'west',      label:{en:'West-Facing',   lo:'ຫັນໜ້າໄປທິດຕາເວັນຕົກ', zh:'朝西'}},
  {value:'river',     label:{en:'River-Facing',  lo:'ຫັນໜ້າໄປແມ່ນ້ຳ',  zh:'临江'}},
  {value:'city',      label:{en:'City-Facing',   lo:'ຫັນໜ້າໄປໃນເມືອງ', zh:'朝市区'}},
  {value:'courtyard', label:{en:'Courtyard-Facing', lo:'ຫັນໜ້າໄປສະໜາມພາຍໃນ', zh:'朝内院'}}
];

function _bedrooms(placeholder)  { return {id:'f-bedrooms',       column:'bedrooms',       kind:'number', label:{en:'Bedrooms',lo:'ຫ້ອງນອນ',zh:'卧室'},       min:0, placeholder:placeholder||'4'}; }
function _bathrooms(placeholder) { return {id:'f-bathrooms',      column:'bathrooms',      kind:'number', label:{en:'Bathrooms',lo:'ຫ້ອງນ້ຳ',zh:'浴室'},      min:0, placeholder:placeholder||'4'}; }
function _sqm(label, placeholder){ return {id:'f-sqm',            column:'sqm',            kind:'number', label:label,                                       min:0, placeholder:placeholder||'420'}; }
function _sqmLand(placeholder)   { return {id:'f-sqm-land',       column:'sqm_land',       kind:'number', label:{en:'Land Size (sqm)',lo:'ເນື້ອທີ່ດິນ (ຕາລາງແມັດ)',zh:'土地面积(平方米)'}, min:0, placeholder:placeholder||'720'}; }
function _floors(placeholder)    { return {id:'f-floors',         column:'floors',         kind:'number', label:{en:'Floors',lo:'ຊັ້ນ',zh:'楼层数'},           min:1, placeholder:placeholder||'2'}; }
function _yearBuilt()            { return {id:'f-year-built',     column:'year_built',     kind:'number', label:{en:'Year Built',lo:'ປີກໍ່ສ້າງ',zh:'建成年份'}, min:1950, max:2035, placeholder:'2022'}; }
function _parkingSpaces()        { return {id:'f-parking-spaces', column:'parking_spaces', kind:'number', label:{en:'Parking Spaces',lo:'ບ່ອນຈອດລົດ',zh:'停车位'}, min:0, placeholder:'2'}; }
function _furnished()            { return {id:'f-furnished',      column:'furnished',      kind:'select', label:{en:'Furnished',lo:'ເຄື່ອງເຟີນີເຈີ',zh:'装修情况'}, options:FURNISHED_OPTIONS}; }
function _featuresRef(keys)      { return {id:'f-features-check',  kind:'checkbox_ref', registry:'FEATURES',  keys:keys}; }
function _amenitiesRef(keys)     { return {id:'f-amenities-check', kind:'checkbox_ref', registry:'AMENITIES', keys:keys}; }

// ── Land-specific fields (Phase 2) ─────────────────────────────────────
// Lao translations below are a best-effort first pass, not sourced from an
// existing glossary — worth a native-speaker review pass before this goes
// live, same caveat noted for "Commercial" in PROPERTY_TYPES above.
function _landWidth()    { return {id:'f-land-width',    column:'land_width_m',    kind:'number', label:{en:'Width (m)',  lo:'ຄວາມກວ້າງ (ແມັດ)', zh:'宽度(米)'}, min:0, placeholder:'20'}; }
function _landLength()   { return {id:'f-land-length',   column:'land_length_m',   kind:'number', label:{en:'Length (m)', lo:'ຄວາມຍາວ (ແມັດ)',   zh:'长度(米)'}, min:0, placeholder:'30'}; }
function _roadFrontage() { return {id:'f-road-frontage', column:'road_frontage_m', kind:'number', label:{en:'Road Frontage (m)', lo:'ໜ້າຕິດຖະໜົນ (ແມັດ)', zh:'临路面宽(米)'}, min:0, placeholder:'12'}; }
function _roadWidth()    { return {id:'f-road-width',    column:'road_width_m',    kind:'number', label:{en:'Road Width (m)',    lo:'ຄວາມກວ້າງຖະໜົນ (ແມັດ)', zh:'道路宽度(米)'}, min:0, placeholder:'6'}; }

var ROAD_SURFACE_OPTIONS = [
  {value:'',         label:{en:'Not specified', lo:'ບໍ່ໄດ້ລະບຸ',   zh:'未指定'}},
  {value:'asphalt',  label:{en:'Asphalt',       lo:'ຢາງມະຕອຍ',    zh:'沥青'}},
  {value:'concrete', label:{en:'Concrete',      lo:'ຄອນກຣີດ',     zh:'混凝土'}},
  {value:'gravel',   label:{en:'Gravel',        lo:'ຫີນກ້ອນ',     zh:'碎石'}},
  {value:'dirt',     label:{en:'Dirt',          lo:'ດິນ',         zh:'土路'}}
];
function _roadSurface() { return {id:'f-road-surface', column:'road_surface', kind:'select', label:{en:'Road Surface', lo:'ຜິວໜ້າຖະໜົນ', zh:'路面材质'}, options:ROAD_SURFACE_OPTIONS}; }

// Land Category: the land's current legal/primary categorization —
// distinct from Best Use (below), which is buyer-facing development
// potential. See the file-level comment above for why both exist.
var LAND_CATEGORY_OPTIONS = [
  {value:'',             label:{en:'Not specified', lo:'ບໍ່ໄດ້ລະບຸ',       zh:'未指定'}},
  {value:'residential',  label:{en:'Residential',   lo:'ທີ່ດິນທີ່ຢູ່ອາໄສ',  zh:'住宅用地'}},
  {value:'commercial',   label:{en:'Commercial',    lo:'ທີ່ດິນທຸລະກິດ',    zh:'商业用地'}},
  {value:'agricultural', label:{en:'Agricultural',  lo:'ທີ່ດິນກະສິກຳ',     zh:'农业用地'}},
  {value:'industrial',   label:{en:'Industrial',    lo:'ທີ່ດິນອຸດສາຫະກຳ',  zh:'工业用地'}},
  {value:'mixed_use',    label:{en:'Mixed Use',     lo:'ທີ່ດິນປະສົມປະສານ', zh:'综合用地'}}
];
function _landCategory() { return {id:'f-land-category', column:'land_category', kind:'select', label:{en:'Land Category', lo:'ໝວດໝູ່ທີ່ດິນ', zh:'土地类别'}, options:LAND_CATEGORY_OPTIONS}; }

var LAND_SHAPE_OPTIONS = [
  {value:'',           label:{en:'Not specified', lo:'ບໍ່ໄດ້ລະບຸ',           zh:'未指定'}},
  {value:'rectangle',  label:{en:'Rectangle',     lo:'ສີ່ຫລ່ຽມຜືນຜ້າ',       zh:'长方形'}},
  {value:'square',     label:{en:'Square',        lo:'ສີ່ຫລ່ຽມຈັດຕຸລັດ',     zh:'正方形'}},
  {value:'corner_lot', label:{en:'Corner Lot',    lo:'ທີ່ດິນມູມ',           zh:'转角地块'}},
  {value:'triangle',   label:{en:'Triangle',      lo:'ສາມຫລ່ຽມ',           zh:'三角形'}},
  {value:'irregular',  label:{en:'Irregular',     lo:'ບໍ່ເປັນຮູບຊົງແນ່ນອນ',  zh:'不规则形'}}
];
function _landShape() { return {id:'f-land-shape', column:'land_shape', kind:'select', label:{en:'Shape', lo:'ຮູບຊົງ', zh:'形状'}, options:LAND_SHAPE_OPTIONS}; }

var LAND_TERRAIN_OPTIONS = [
  {value:'',              label:{en:'Not specified', lo:'ບໍ່ໄດ້ລະບຸ',              zh:'未指定'}},
  {value:'flat',          label:{en:'Flat',          lo:'ພື້ນທີ່ພຽງ',              zh:'平坦'}},
  {value:'slight_slope',  label:{en:'Slight Slope',  lo:'ພື້ນທີ່ມີຄວາມຊັນເລັກນ້ອຍ', zh:'轻微坡度'}},
  {value:'hillside',      label:{en:'Hillside',      lo:'ພື້ນທີ່ເນີນພູ',           zh:'山坡地'}},
  {value:'filled',        label:{en:'Filled',        lo:'ດິນຖົມແລ້ວ',             zh:'已填土'}},
  {value:'needs_filling', label:{en:'Needs Filling', lo:'ຕ້ອງການຖົມດິນ',          zh:'需要填土'}}
];
function _landTerrain() { return {id:'f-land-terrain', column:'land_terrain', kind:'select', label:{en:'Terrain', lo:'ສະພາບພື້ນທີ່', zh:'地形'}, options:LAND_TERRAIN_OPTIONS}; }

var EXISTING_STRUCTURE_OPTIONS = [
  {value:'',                    label:{en:'Not specified',       lo:'ບໍ່ໄດ້ລະບຸ',    zh:'未指定'}},
  {value:'vacant_land',         label:{en:'Vacant Land',         lo:'ທີ່ດິນຫວ່າງ',   zh:'空地'}},
  {value:'old_house',          label:{en:'Old House',           lo:'ເຮືອນເກົ່າ',    zh:'旧房屋'}},
  {value:'warehouse',           label:{en:'Warehouse',           lo:'ໂກດັງ',        zh:'仓库'}},
  {value:'commercial_building', label:{en:'Commercial Building', lo:'ອາຄານພານິດ',   zh:'商业建筑'}},
  {value:'farm_building',       label:{en:'Farm Building',       lo:'ອາຄານກະສິກຳ',  zh:'农场建筑'}}
];
function _existingStructure() { return {id:'f-existing-structure', column:'existing_structure', kind:'select', label:{en:'Existing Structure', lo:'ສິ່ງກໍ່ສ້າງທີ່ມີຢູ່', zh:'现有建筑物'}, options:EXISTING_STRUCTURE_OPTIONS}; }

// Best Use: buyer-facing development potential, multi-select — deliberately
// separate from land_category above (see file-level comment). Rendered as
// a checkbox group (kind:'multi_checkbox'), not a native <select multiple>,
// for the same mobile-friendliness reason FEATURES/AMENITIES use checkboxes.
var BEST_USE_OPTIONS = [
  {value:'apartment_development', label:{en:'Apartment Development', lo:'ພັດທະນາອາພາດເມັນ',   zh:'公寓开发'}},
  {value:'villa',                 label:{en:'Villa',                 lo:'ວິນລ່າ',              zh:'别墅'}},
  {value:'warehouse',             label:{en:'Warehouse',             lo:'ໂກດັງ',               zh:'仓库'}},
  {value:'retail',                label:{en:'Retail',                lo:'ຮ້ານຄ້າຍ່ອຍ',          zh:'零售'}},
  {value:'resort',                label:{en:'Resort',                lo:'ຣີສອດ',               zh:'度假村'}},
  {value:'investment',            label:{en:'Investment',            lo:'ການລົງທຶນ',            zh:'投资'}}
];
function _bestUse() { return {id:'f-best-use', column:'land_best_use', kind:'multi_checkbox', label:{en:'Best Use', lo:'ການນຳໃຊ້ທີ່ດີທີ່ສຸດ', zh:'最佳用途'}, options:BEST_USE_OPTIONS}; }

var PROPERTY_TYPE_FIELDS = {

  house: [
    _bedrooms(), _bathrooms(), _sqm({en:'Building Size (sqm)',lo:'ຂະໜາດອາຄານ (ຕາລາງແມັດ)',zh:'建筑面积(平方米)'}),
    _sqmLand(), _floors(), _yearBuilt(), _parkingSpaces(), _furnished(),
    _featuresRef(['pool','garden','balcony','security','smart_home','pet_friendly','gym','office_room','maid_room','jacuzzi','ac','river_view','mountain_view','european_kitchen','living_room','walk_in_closet','storage_room','water_pump','covered_parking']),
    _amenitiesRef(['ac','fan','water_heater','furnished','bed','wardrobe','kitchen','fridge','stove','dining_table','washing_machine','parking','pool','gym','security','cctv','pets_allowed','balcony','rooftop','smart','solar','generator','bbq','garden'])
  ],

  townhouse: [
    _bedrooms(), _bathrooms(), _sqm({en:'Building Size (sqm)',lo:'ຂະໜາດອາຄານ (ຕາລາງແມັດ)',zh:'建筑面积(平方米)'}),
    _sqmLand(), _floors(), _yearBuilt(), _parkingSpaces(), _furnished(),
    _featuresRef(['garden','balcony','security','smart_home','pet_friendly','ac','european_kitchen','living_room','walk_in_closet','storage_room','water_pump','covered_parking']),
    _amenitiesRef(['ac','fan','water_heater','furnished','bed','wardrobe','kitchen','fridge','stove','dining_table','washing_machine','parking','security','cctv','pets_allowed','balcony','generator'])
  ],

  villa: [
    _bedrooms(), _bathrooms(), _sqm({en:'Building Size (sqm)',lo:'ຂະໜາດອາຄານ (ຕາລາງແມັດ)',zh:'建筑面积(平方米)'}),
    _sqmLand(), _floors(), _yearBuilt(), _parkingSpaces(), _furnished(),
    _featuresRef(['pool','garden','balcony','security','smart_home','pet_friendly','gym','office_room','maid_room','jacuzzi','ac','river_view','mountain_view','european_kitchen','living_room','walk_in_closet','storage_room','water_pump','covered_parking']),
    _amenitiesRef(['ac','fan','water_heater','furnished','bed','wardrobe','kitchen','fridge','stove','dining_table','washing_machine','parking','pool','gym','security','cctv','pets_allowed','balcony','rooftop','solar','generator','bbq','garden'])
  ],

  apartment: [
    _bedrooms(), _bathrooms(), _sqm({en:'Unit Size (sqm)',lo:'ຂະໜາດຫ້ອງ (ຕາລາງແມັດ)',zh:'单元面积(平方米)'}),
    _yearBuilt(), _parkingSpaces(), _furnished(),
    _featuresRef(['pool','security','smart_home','gym','ac','walk_in_closet','storage_room','covered_parking']),
    _amenitiesRef(['ac','fan','water_heater','furnished','elevator','pool','gym','security','cctv','parking','washing_machine'])
  ],

  condo: [
    _bedrooms(), _bathrooms(), _sqm({en:'Unit Size (sqm)',lo:'ຂະໜາດຫ້ອງ (ຕາລາງແມັດ)',zh:'单元面积(平方米)'}),
    _yearBuilt(), _parkingSpaces(), _furnished(),
    _featuresRef(['pool','security','smart_home','gym','ac','walk_in_closet','storage_room','covered_parking']),
    _amenitiesRef(['ac','fan','water_heater','furnished','elevator','pool','gym','security','cctv','parking','washing_machine'])
  ],

  commercial: [
    _sqm({en:'Floor Area (sqm)',lo:'ເນື້ອທີ່ (ຕາລາງແມັດ)',zh:'建筑面积(平方米)'}),
    _floors(), _parkingSpaces(), _yearBuilt(),
    _featuresRef(['security','office_room','covered_parking','storage_room']),
    _amenitiesRef(['parking','security','cctv','elevator'])
  ],

  // Land: deliberately no bedrooms/bathrooms/floors/furnished/year_built
  // and no features/amenities checkboxes — a land listing has no
  // building to describe. Requires the Phase 2 migration
  // (20260709000000_land_specific_fields.sql) applied first — see the
  // file-level comment above.
  land: [
    _sqmLand(), _landWidth(), _landLength(), _roadFrontage(), _roadWidth(),
    _roadSurface(), _landCategory(), _landShape(), _landTerrain(),
    _existingStructure(), _bestUse()
  ]
};

// ── Customer-facing presentation schema ─────────────────────────────────
// PROPERTY_TYPE_DISPLAY drives what buyers see on the listing card and the
// listing detail page — reusing PROPERTY_TYPE_FIELDS above as the single
// source of truth for column/kind/label/options. Each entry only adds
// presentation metadata:
//   field:    id of an entry in this type's PROPERTY_TYPE_FIELDS array
//   icon:     emoji icon, same convention as AMENITIES in amenities.js
//   card:     shown on compact cards (search results, homepage, similar
//             listings) — array order is display order
//   priority: shown in the detail page's main spec grid; non-priority
//             fields still appear, lower down, in a secondary details list
//   pairWith/pairTemplate: combines this field with another into one
//             display item (e.g. Land's Width × Length)
//
// A field with no PROPERTY_TYPE_FIELDS entry for a type (e.g. Land has no
// "bedrooms") is already omitted structurally — nothing needed here for
// that. A field that exists in PROPERTY_TYPE_FIELDS but isn't listed here
// simply isn't customer-facing yet.
var PROPERTY_TYPE_DISPLAY = {

  house: [
    {field:'f-bedrooms',       icon:'🛏️', card:true,  priority:true},
    {field:'f-bathrooms',      icon:'🛁', card:true,  priority:true},
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-sqm-land',       icon:'⬛', card:false, priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:true},
    {field:'f-furnished',      icon:'🛋️', card:false, priority:true},
    {field:'f-floors',         icon:'🏢', card:false, priority:false},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  townhouse: [
    {field:'f-bedrooms',       icon:'🛏️', card:true,  priority:true},
    {field:'f-bathrooms',      icon:'🛁', card:true,  priority:true},
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-sqm-land',       icon:'⬛', card:false, priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:true},
    {field:'f-furnished',      icon:'🛋️', card:false, priority:true},
    {field:'f-floors',         icon:'🏢', card:false, priority:false},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  villa: [
    {field:'f-bedrooms',       icon:'🛏️', card:true,  priority:true},
    {field:'f-bathrooms',      icon:'🛁', card:true,  priority:true},
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-sqm-land',       icon:'⬛', card:false, priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:true},
    {field:'f-furnished',      icon:'🛋️', card:false, priority:true},
    {field:'f-floors',         icon:'🏢', card:false, priority:false},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  // Floor Number / Maintenance Fee / Building Amenities intentionally not
  // listed — no floor_number/maintenance_fee/building_facilities columns
  // exist yet (see file-level comment). Add entries here once that
  // migration ships.
  apartment: [
    {field:'f-bedrooms',       icon:'🛏️', card:true,  priority:true},
    {field:'f-bathrooms',      icon:'🛁', card:true,  priority:true},
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-furnished',      icon:'🛋️', card:false, priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:false},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  condo: [
    {field:'f-bedrooms',       icon:'🛏️', card:true,  priority:true},
    {field:'f-bathrooms',      icon:'🛁', card:true,  priority:true},
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-furnished',      icon:'🛋️', card:false, priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:false},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  // Shopfront Width / Suitable For intentionally not listed — no matching
  // columns exist yet (see file-level comment).
  commercial: [
    {field:'f-sqm',            icon:'📐', card:true,  priority:true},
    {field:'f-floors',         icon:'🏢', card:true,  priority:true},
    {field:'f-parking-spaces', icon:'🚗', card:false, priority:true},
    {field:'f-year-built',     icon:'📅', card:false, priority:false}
  ],

  land: [
    {field:'f-land-width',         icon:'📐', card:true,  priority:true, pairWith:'f-land-length', pairTemplate:'{a} × {b} m'},
    {field:'f-sqm-land',           icon:'⬛', card:true,  priority:true},
    {field:'f-road-frontage',      icon:'🛣️', card:true,  priority:true},
    {field:'f-road-surface',       icon:'🧱', card:false, priority:true},
    {field:'f-land-category',      icon:'🏷️', card:false, priority:true},
    {field:'f-land-terrain',       icon:'⛰️', card:false, priority:true},
    {field:'f-existing-structure', icon:'🏚️', card:false, priority:true},
    {field:'f-best-use',           icon:'🎯', card:false, priority:true},
    {field:'f-road-width',         icon:'↔️', card:false, priority:false},
    {field:'f-land-shape',         icon:'◻️', card:false, priority:false}
  ]
};

function _findFieldDef(typeKey, fieldId) {
  var fields = PROPERTY_TYPE_FIELDS[typeKey] || [];
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].id === fieldId) return fields[i];
  }
  return null;
}

// Formats one field's current value per its kind. Returns null for
// empty/missing values so callers can drop the fact entirely, matching
// today's "just don't show it" behavior for absent data.
function resolveFieldDisplayValue(fieldDef, row, lang) {
  if (!fieldDef || !fieldDef.column) return null;
  var raw = row ? row[fieldDef.column] : null;
  if (raw === null || raw === undefined || raw === '') return null;

  if (fieldDef.kind === 'select') {
    var opts = fieldDef.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === raw) return opts[i].label[lang] || opts[i].label.en;
    }
    return raw;
  }

  if (fieldDef.kind === 'multi_checkbox') {
    if (!Array.isArray(raw) || !raw.length) return null;
    var opts2 = fieldDef.options || [];
    return raw.map(function(v){
      for (var j = 0; j < opts2.length; j++) {
        if (opts2[j].value === v) return opts2[j].label[lang] || opts2[j].label.en;
      }
      return v;
    }).join(', ');
  }

  return raw;
}

function _buildFactItem(typeKey, entry, row, lang) {
  var fieldDef = _findFieldDef(typeKey, entry.field);
  if (!fieldDef) return null;
  var value = resolveFieldDisplayValue(fieldDef, row, lang);
  if (value === null) return null;

  if (entry.pairWith) {
    var pairDef = _findFieldDef(typeKey, entry.pairWith);
    var pairValue = pairDef ? resolveFieldDisplayValue(pairDef, row, lang) : null;
    if (pairValue !== null) {
      value = (entry.pairTemplate || '{a} × {b}').replace('{a}', value).replace('{b}', pairValue);
    }
  }

  return {icon: entry.icon, label: fieldDef.label[lang] || fieldDef.label.en, value: value};
}

// Compact facts for cards (search results, homepage, similar listings).
function getCardFacts(typeKey, row, lang) {
  var entries = PROPERTY_TYPE_DISPLAY[typeKey] || [];
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].card) continue;
    var item = _buildFactItem(typeKey, entries[i], row, lang);
    if (item) out.push(item);
  }
  return out;
}

// Detail-page facts, split into the prominent main spec grid and a
// secondary "Property Details" list for everything else that's still
// relevant to this type.
function getDetailFacts(typeKey, row, lang) {
  var entries = PROPERTY_TYPE_DISPLAY[typeKey] || [];
  var priority = [], secondary = [];
  for (var i = 0; i < entries.length; i++) {
    var item = _buildFactItem(typeKey, entries[i], row, lang);
    if (!item) continue;
    (entries[i].priority ? priority : secondary).push(item);
  }
  return {priority: priority, secondary: secondary};
}

// ── Multi-Unit Buildings (Phase 1) ───────────────────────────────────────
// A `properties` row is a multi-unit building purely by having 1+
// `unit_types` rows -- no is_multi_unit flag anywhere in this schema. See
// supabase/migrations/20260720000000_unit_types.sql.
//
// IMPORTANT: a unit_types row is a unit TYPE (a floor plan / product, e.g.
// "Studio"), never one specific physical apartment. `total_units` already
// models "this type has N physical units" without assuming N=1 (see
// supabase/migrations/20260721010000_unit_availability.sql). Do not add a
// field here that only makes sense for one physical unit (a room number, a
// single lease, a single tenant) -- that belongs to the future Phase 3
// `units` child table (Property -> Unit Type -> Individual Unit), which
// FKs to unit_types.id without requiring any change to this resolver or
// any of unit_types' existing columns.
function isMultiUnitBuilding(unitTypes) {
  return Array.isArray(unitTypes) && unitTypes.length > 0;
}

// resolveUnitType(property, unitType) is the ONE resolver every consumer of
// unit-type data must call -- admin preview, the Phase 2 listing-page
// variant switcher, Phase 2 search, future APIs, a future mobile app. Never
// re-derive this fallback logic anywhere else; if inheritance rules ever
// change, this is the one place to update.
//
// Every unit_types column is nullable, and null means "use the building's
// own value" -- that's what `pick()` implements uniformly below. The one
// field with genuinely different logic is `images`, which follows the
// specific fallback hierarchy asked for: unit photos if the unit type has
// any, otherwise the building's own photos -- a visitor should never
// encounter an empty gallery just because a unit type doesn't yet have
// dedicated photos of its own.
//
// `is_available`/`available_count`/`sort_order` are NOT NULL on unit_types
// (every unit type always has its own value for these), so they're read
// directly rather than through `pick()`.
//
// floor_plan_url/virtual_tour_url/video_url/floor_number/orientation are
// unit-type-only concepts with no building-level column to inherit from
// (properties has none of these) -- read directly from unitType, not via
// pick(). `furnished` DOES have a building-level equivalent
// (properties.furnished, same FURNISHED_OPTIONS vocabulary), so it goes
// through pick() like every other genuinely-inheritable field.
function resolveUnitType(property, unitType) {
  function pick(col) {
    var v = unitType[col];
    return (v !== null && v !== undefined) ? v : property[col];
  }
  return {
    id: unitType.id,
    name: {en: unitType.name_en, lo: unitType.name_lo, zh: unitType.name_zh},
    priceDisplay: pick('price_display'),
    salePrice:    pick('sale_price'),
    rentPrice:    pick('rent_price'),
    rentPeriod:   pick('rent_period'),
    bedrooms:  pick('bedrooms'),
    bathrooms: pick('bathrooms'),
    sqm:       pick('sqm'),
    floors:    pick('floors'),
    descriptionEn: pick('description_en'), descriptionLo: pick('description_lo'), descriptionZh: pick('description_zh'),
    highlightEn:   pick('property_highlight_en'), highlightLo: pick('property_highlight_lo'), highlightZh: pick('property_highlight_zh'),
    features:  pick('features'),
    amenities: pick('amenities'),
    images: (Array.isArray(unitType.images) && unitType.images.length) ? unitType.images : (property.images || []),
    furnished:      pick('furnished'),
    floorPlanUrl:   unitType.floor_plan_url   || null,
    virtualTourUrl: unitType.virtual_tour_url || null,
    videoUrl:       unitType.video_url        || null,
    floorNumber:    (unitType.floor_number !== null && unitType.floor_number !== undefined) ? unitType.floor_number : null,
    orientation:    unitType.orientation || null,
    isAvailable:    unitType.is_available,
    availableCount: unitType.available_count,
    sortOrder:      unitType.sort_order
  };
}
