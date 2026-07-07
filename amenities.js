// amenities.js — shared amenity registry, used by admin.html (data entry),
// listing.html (full detail page), and listings.html (search cards).
// Previously duplicated separately in admin.html and listing.html; this is
// the single edit point going forward.
//
// Categories match the standardized set: Climate, Furniture, Kitchen,
// Laundry, Building, Pets. Wi-Fi is deliberately NOT a standard amenity —
// not consistently included with rentals in this market — but is kept in
// AMENITIES (unlisted in AMENITY_PRIORITY, no longer offered as an admin
// checkbox) so any listing with legacy "wifi" data still renders correctly
// instead of falling through to the generic ✨ fallback.
//
// Legacy keys not in the standardized set (balcony, rooftop, smart, solar,
// generator, bbq, tennis, garden) are kept for the same reason — existing
// listings may already reference them — but are deprioritized, appearing
// only after every standardized amenity in AMENITY_PRIORITY.
var AMENITIES = {
  // Climate
  ac:            {en:'Air Conditioning', lo:'ແອຄອນດິຊັນ',    zh:'空调',     icon:'❄️'},
  fan:           {en:'Fan',              lo:'ພັດລົມ',         zh:'风扇',     icon:'🌀'},
  water_heater:  {en:'Water Heater',     lo:'ເຄື່ອງອຸ່ນນ້ຳ',  zh:'热水器',   icon:'🌡️'},
  // Furniture
  furnished:     {en:'Furnished',        lo:'ເຄື່ອງເຟີນີຈ',   zh:'带家具',   icon:'🛋️'},
  bed:           {en:'Bed Included',     lo:'ມີຕຽງ',          zh:'含床',     icon:'🛏️'},
  wardrobe:      {en:'Wardrobe',         lo:'ຕູ້ເສື້ອຜ້າ',     zh:'衣柜',     icon:'👕'},
  // Kitchen
  kitchen:       {en:'Kitchen',          lo:'ຫ້ອງຄົວ',        zh:'厨房',     icon:'🍳'},
  fridge:        {en:'Refrigerator',     lo:'ຕູ້ເຢັນ',         zh:'冰箱',     icon:'🧊'},
  stove:         {en:'Stove',            lo:'ເຕົາໄຟ',         zh:'炉灶',     icon:'🔥'},
  dining_table:  {en:'Dining Table',     lo:'ໂຕະກິນເຂົ້າ',    zh:'餐桌',     icon:'🍽️'},
  // Laundry
  washing_machine: {en:'Washing Machine', lo:'ເຄື່ອງຊັກຜ້າ',  zh:'洗衣机',   icon:'🧺'},
  // Building
  parking:       {en:'Parking',          lo:'ທີ່ຈອດລົດ',      zh:'停车位',   icon:'🚗'},
  elevator:      {en:'Elevator',         lo:'ລິຟ',            zh:'电梯',     icon:'🛗'},
  pool:          {en:'Swimming Pool',    lo:'ສະລອຍນ້ຳ',      zh:'游泳池',   icon:'🏊'},
  gym:           {en:'Gym',              lo:'ຫ້ອງຟິດເນສ',     zh:'健身房',   icon:'🏋️'},
  security:      {en:'Security',         lo:'ລະບົບຮັກສາຄວາມປອດໄພ', zh:'安保', icon:'🔐'},
  cctv:          {en:'CCTV',             lo:'ກ້ອງວົງຈອນປິດ',  zh:'监控摄像', icon:'🎥'},
  // Pets
  pets_allowed:  {en:'Pets Allowed',     lo:'ລ້ຽງສັດໄດ້',     zh:'允许宠物', icon:'🐶'},

  // Legacy / not part of the standardized set — kept for existing data,
  // deprioritized in AMENITY_PRIORITY below.
  wifi:      {en:'Wi-Fi',         lo:'ອິນເຕີເນັດ',   zh:'无线网络',icon:'📶'},
  balcony:   {en:'Balcony',       lo:'ລະບຽງ',       zh:'阳台',    icon:'🌅'},
  rooftop:   {en:'Rooftop',       lo:'ດາດຟ້າ',      zh:'屋顶',    icon:'🌆'},
  smart:     {en:'Smart Home',    lo:'ສະມາດໂຮມ',    zh:'智能家居',icon:'🏡'},
  solar:     {en:'Solar',         lo:'ໂຊລາ',        zh:'太阳能',  icon:'☀️'},
  generator: {en:'Generator',     lo:'ເຄື່ອງສຳຮອງ', zh:'发电机',  icon:'⚡'},
  bbq:       {en:'BBQ Area',      lo:'ບ່ອນ BBQ',    zh:'烧烤区',  icon:'🔥'},
  tennis:    {en:'Tennis',        lo:'ເທັນນິດ',      zh:'网球场',  icon:'🎾'},
  garden:    {en:'Garden',        lo:'ສວນ',          zh:'花园',    icon:'🌳'}
};

// Category groupings for the admin checkbox grid (initGroupedCheckGrid in
// admin.html). Wi-Fi is deliberately omitted from every category here —
// per the standard-amenity decision, it's not offered as a new selection,
// though it stays in AMENITIES above so legacy data still renders. Other
// pre-existing, non-standardized amenities (balcony, rooftop, etc.) remain
// selectable under "Other" since only Wi-Fi was called out for removal.
var AMENITY_CATEGORIES = [
  {label: 'Climate',   keys: ['ac', 'fan', 'water_heater']},
  {label: 'Furniture', keys: ['furnished', 'bed', 'wardrobe']},
  {label: 'Kitchen',   keys: ['kitchen', 'fridge', 'stove', 'dining_table']},
  {label: 'Laundry',   keys: ['washing_machine']},
  {label: 'Building',  keys: ['parking', 'elevator', 'pool', 'gym', 'security', 'cctv']},
  {label: 'Pets',      keys: ['pets_allowed']},
  {label: 'Other',     keys: ['balcony', 'rooftop', 'smart', 'solar', 'generator', 'bbq', 'tennis', 'garden']}
];

// Fixed display priority — cards always show the same amenities first,
// regardless of the order they happen to be stored in on a given listing.
// Standardized-set amenities first (roughly most-to-least decision-relevant
// in this market), then legacy/unlisted amenities last.
var AMENITY_PRIORITY = [
  'ac', 'furnished', 'parking', 'pool', 'security', 'elevator', 'gym',
  'water_heater', 'kitchen', 'fridge', 'washing_machine', 'cctv',
  'wardrobe', 'bed', 'stove', 'dining_table', 'fan', 'pets_allowed',
  'balcony', 'rooftop', 'smart', 'solar', 'generator', 'bbq', 'tennis',
  'garden', 'wifi'
];

// resolveAmenityData — handles normalized keys ("pool"), legacy strings
// ("Private Pool"), and partial matches. Backward compatible with all
// existing data.
function resolveAmenityData(key, lang) {
  var clean = String(key).trim();
  if (AMENITIES[clean]) return {icon: AMENITIES[clean].icon, label: AMENITIES[clean][lang] || AMENITIES[clean].en};
  var norm = clean.toLowerCase().replace(/[\s&\/\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (AMENITIES[norm]) return {icon: AMENITIES[norm].icon, label: AMENITIES[norm][lang] || AMENITIES[norm].en};
  for (var k in AMENITIES) {
    if (AMENITIES[k].en && AMENITIES[k].en.toLowerCase() === clean.toLowerCase())
      return {icon: AMENITIES[k].icon, label: AMENITIES[k][lang] || AMENITIES[k].en};
  }
  var lower = clean.toLowerCase();
  for (var k in AMENITIES) { if (lower.indexOf(k) > -1 || k.indexOf(lower) > -1) return {icon: AMENITIES[k].icon, label: AMENITIES[k][lang] || AMENITIES[k].en}; }
  return {icon: '✨', label: String(key)};
}

// topAmenities — returns up to `max` amenities from a listing's amenities
// array, ordered by AMENITY_PRIORITY, for compact card display. Full lists
// (unordered-by-priority, as stored) are still used as-is on the full
// listing page — this helper is only for the truncated card view.
function topAmenities(list, max) {
  if (!Array.isArray(list)) return [];
  var valid = list.filter(Boolean);
  valid.sort(function (a, b) {
    var ia = AMENITY_PRIORITY.indexOf(String(a).trim());
    var ib = AMENITY_PRIORITY.indexOf(String(b).trim());
    if (ia === -1) ia = AMENITY_PRIORITY.length;
    if (ib === -1) ib = AMENITY_PRIORITY.length;
    return ia - ib;
  });
  return valid.slice(0, max || 4);
}
