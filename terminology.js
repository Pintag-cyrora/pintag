// terminology.js — shared terminology registry, used by admin.html,
// add-property.html, and edit-listing.html. Same convention as
// amenities.js: plain global vars, no build step, loaded via
// <script src="terminology.js"> before each page's own inline <script>.
//
// PROPERTY_TYPES is the single source of truth for property-type labels
// (English/Lao/Chinese) — do not hardcode these strings elsewhere.
//
// PROPERTY_TYPE_FIELDS drives the "Property Details" section of the
// listing form: which fields are relevant for a given property type, so
// the form can be rendered from this schema instead of showing every
// field for every type (e.g. Land never shows Bedrooms/Bathrooms).
//
// PHASE 1 SCOPE: every field below maps to a column that already exists
// and is already wired end-to-end (bedrooms, bathrooms, sqm, sqm_land,
// floors, year_built, parking_spaces, furnished), or references a
// filtered subset of the existing FEATURES/AMENITIES registries via
// kind:'checkbox_ref' (pool/garden/balcony/elevator etc. stay as
// checkboxes there — they are NOT duplicated as new columns here).
//
// PHASE 2 (not yet implemented): apartment/condo floor_number +
// maintenance_fee + building_facilities, commercial best_use +
// main_road_access, and land road_frontage/road_width/road_surface/
// land_shape/existing_structure/land_use_type all require new database
// columns that do not exist yet. Do not add newColumn:true fields to the
// arrays below until that migration has actually been applied to
// production — Supabase/PostgREST rejects save payloads that reference
// unknown columns, so adding a field here before its column exists would
// break saving every listing, not just that property type's.
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
  // building to describe.
  land: [
    _sqmLand()
  ]
};
