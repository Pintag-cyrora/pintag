/**
 * content-gen.js — Pintag automatic content generation
 *
 * Generates Overview, Property Highlights, and Neighborhood Insight
 * from structured property data already stored in Supabase.
 *
 * No DB writes. No API calls. Pure function — every function is
 * deterministic given the same input.
 *
 * Public API:
 *   ContentGen.generateOverview(property, lang)        → string
 *   ContentGen.generateHighlightItems(property, lang)  → [{kicker,value}, ...]
 *   ContentGen.generateNeighborhoodInsight(property, lang) → string
 *
 * lang: 'lo' | 'en' | 'zh'  (falls back to 'en')
 *
 * To customise templates: edit the OVERVIEW_TEMPLATES, DISTRICT_KNOWLEDGE,
 * or HIGHLIGHT_LABELS objects below. Each key maps to a trilingual object
 * {lo, en, zh}.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────
// 1. OVERVIEW TEMPLATES
//    Keyed by property_type → transaction_type → price tier (0=standard,1=luxury)
// ─────────────────────────────────────────────────────────────────
var OVERVIEW_TEMPLATES = {
  villa: {
    sale: [
      { en: 'An exceptional villa combining privacy, refined proportions, and premium living in one of Vientiane\'s most desirable settings.',
        lo: 'ວິລລ່າດີເດັ່ນ ທີ່ລວມເອົາຄວາມສ່ວນຕົວ, ສັດສ່ວນທີ່ສວຍງາມ ແລະ ການໃຊ້ຊີວິດລຳດັບສູງ ໃນທຳເລທີ່ໜ້ສົນໃຈທີ່ສຸດຂອງວຽງຈັນ.',
        zh: '一座卓越别墅，将私密性、精致空间与高端生活融为一体，坐落于万象最令人向往的地段。' },
      { en: 'A distinguished villa delivering an elevated standard of living — generous space, premium finishes, and a setting that few Vientiane addresses can rival.',
        lo: 'ວິລລ່າທີ່ໂດດເດັ່ນ ນຳສະເໜີລະດັບຄວາມເປັນຢູ່ທີ່ສູງ — ພື້ນທີ່ກ້ວາງ, ການຕົກແຕ່ງລະດັບ ແລະ ທຳເລທີ່ໜ້ອຍທີ່ຢູ່ອາໄສໃດໃນວຽງຈັນຈະສາມາດທຽບໄດ້.',
        zh: '这座卓然别墅提供卓越的居住品质——宽裕的空间、高档的装修以及万象难以超越的地段优势。' }
    ],
    rent: [
      { en: 'A private villa offering an elevated standard of living, blending comfort, space, and style for the discerning renter.',
        lo: 'ວິລລ່າສ່ວນຕົວ ນຳສະເໜີລະດັບຄຸນຄ່າທີ່ສູງ, ລວມຄວາມສະດວກ, ພື້ນທີ່ ແລະ ຄວາມງາມສຳລັບຜູ້ເຊົ່າທີ່ຈົງໃຈ.',
        zh: '这座私人别墅为挑剔的租客提供高水准居住体验，兼具舒适、空间与品味。' },
      { en: 'A rare villa rental delivering genuine privacy, premium amenities, and spacious living in a sought-after Vientiane location.',
        lo: 'ໂອກາດເຊົ່າວິລລ່າຊັ້ນດີ ໃຫ້ຄວາມສ່ວນຕົວທີ່ແທ້ຈິງ, ສິ່ງອຳນວຍຄວາມສະດວກລຳດັບສູງ ແລະ ຊີວິດທີ່ກ້ວາງ ໃນທຳເລ Vientiane ທີ່ຕ້ອງການ.',
        zh: '难得一见的高档别墅出租，提供真正的私密性、优质配套设施以及万象热门地段的宽敞生活空间。' }
    ]
  },
  house: {
    sale: [
      { en: 'A well-proportioned family home offering the right balance of comfort, functionality, and lasting value in a convenient Vientiane location.',
        lo: 'ເຮືອນຄອບຄົວທີ່ອອກແບບດີ ນຳສະເໜີຄວາມສົມດູນທີ່ຖືກຕ້ອງລະຫວ່າງຄວາມສະດວກ, ການໃຊ້ງານ ແລະ ຄຸນຄ່າທີ່ຍືນຍົງ ໃນທຳເລທີ່ສະດວກ.',
        zh: '这栋比例匀称的家庭住宅，在便利的万象地段提供舒适性、实用性与长远价值的完美平衡。' },
      { en: 'A thoughtfully designed family home positioned to deliver comfort, space, and strong everyday liveability.',
        lo: 'ເຮືອນຄອບຄົວທີ່ຄິດໄລ່ດີ, ສ້າງຂຶ້ນເພື່ອໃຫ້ຄວາມສະດວກ, ພື້ນທີ່ ແລະ ຄຸນຄ່າໃນຊີວິດປະຈຳວັນ.',
        zh: '这栋精心设计的家庭住宅，旨在提供舒适、空间与出色的日常居住品质。' }
    ],
    rent: [
      { en: 'A practical and comfortable family home available for rent, offering generous living space and strong connectivity in Vientiane.',
        lo: 'ເຮືອນຄອບຄົວທີ່ສະດວກ ແລະ ສະບາຍ, ສຳລັບເຊົ່າ, ສະເໜີພື້ນທີ່ກ້ວາງ ແລະ ການເຊື່ອມຕໍ່ທີ່ດີໃນວຽງຈັນ.',
        zh: '这栋实用舒适的家庭住宅现供出租，在万象提供宽敞的生活空间和便利的城市连接。' },
      { en: 'A well-maintained family home providing reliable comfort, good space, and easy access to Vientiane\'s daily essentials.',
        lo: 'ເຮືອນຄອບຄົວທີ່ດູແລດີ, ໃຫ້ຄວາມສະດວກທີ່ເຊື່ອຖືໄດ້, ພື້ນທີ່ດີ ແລະ ການເຂົ້າເຖິງງ່າຍດາຍ ຕໍ່ ຄວາມຈຳເປັນໃນຊີວິດ.',
        zh: '这栋保养良好的家庭住宅提供稳定的舒适性、良好空间以及便利的日常生活条件。' }
    ]
  },
  apartment: {
    sale: [
      { en: 'A smartly positioned apartment offering convenient access to Vientiane\'s urban amenities and an effortless, low-maintenance lifestyle.',
        lo: 'ອາພາດເມັ້ນທີ່ຕັ້ງຢູ່ດີ ສະເໜີການເຂົ້າເຖິງຄວາມສະດວກ ແລະ ວິຖີຊີວິດທີ່ງ່າຍ ໃນຕົວເມືອງ.',
        zh: '这套位置优越的公寓，便于享用万象的城市配套设施，生活轻松便利，无需繁琐维护。' },
      { en: 'An ideal urban residence combining practical living with a well-connected address in the heart of Vientiane.',
        lo: 'ທີ່ພັກໃນຕົວເມືອງທີ່ເໝາະສົມ, ລວມການໃຊ້ຊີວິດທີ່ສະດວກ ກັບ ທີ່ຢູ່ທີ່ເຊື່ອມຕໍ່ດີ ໃຈກາງວຽງຈັນ.',
        zh: '这套住宅是理想的城市居所，实用便利，地处万象中心，交通便捷。' }
    ],
    rent: [
      { en: 'A convenient apartment rental offering modern, low-maintenance urban living with easy access to daily essentials and city infrastructure.',
        lo: 'ອາພາດເມັ້ນໃຫ້ເຊົ່າ, ສຳລັບຊີວິດໃນຕົວເມືອງທີ່ທັນສະໄໝ ພ້ອມການເຂົ້າເຖິງຄວາມຕ້ອງການໃນຊີວິດ.',
        zh: '这套公寓提供便捷出租选项，享有现代、免维护的城市生活，轻松获取日常所需和城市基础设施。' },
      { en: 'A well-located city apartment delivering comfortable urban living at a sensible price in a convenient Vientiane address.',
        lo: 'ອາພາດເມັ້ນໃຈກາງຕົວເມືອງ ໃຫ້ຄວາມສະດວກ ໃນລາຄາທີ່ເໝາະສົມ ທຳເລທີ່ດີ.',
        zh: '这套位置优越的城市公寓以合理价格提供舒适的都市生活，地处万象便利地段。' }
    ]
  },
  condo: {
    sale: [
      { en: 'A modern condominium unit offering the ideal blend of urban convenience and community living, with access to shared amenities.',
        lo: 'ຄອນໂດທັນສະໄໝ ສຳລັບຊີວິດທີ່ສົມດູນ ລະຫວ່າງຄວາມສະດວກ ແລະ ຊຸມຊົນ ໃນວຽງຈັນ.',
        zh: '这套现代公寓单元，理想融合都市便利与社区生活，同时享有共用配套设施。' }
    ],
    rent: [
      { en: 'A well-appointed condominium available for rent, offering modern urban living and access to maintained shared facilities.',
        lo: 'ຄອນໂດທີ່ຕົກແຕ່ງດີ ສຳລັບເຊົ່າ, ໃຫ້ການໃຊ້ຊີວິດທີ່ທັນສະໄໝ ພ້ອມສິ່ງອຳນວຍຄວາມສະດວກ.',
        zh: '这套设施齐全的公寓现供出租，提供现代都市生活体验并享有维护良好的共用设施。' }
    ]
  },
  land: {
    sale: [
      { en: 'A well-positioned parcel of land presenting a compelling development or investment opportunity in Vientiane\'s growing property market.',
        lo: 'ທີ່ດິນທີ່ຕັ້ງຢູ່ດີ, ສະເໜີໂອກາດການພັດທະນາ ຫຼື ການລົງທຶນ ໃນຕະຫຼາດອະສັງຫາທີ່ເຕີບໂຕ.',
        zh: '这块位置优越的土地，为万象不断增长的房地产市场提供极具吸引力的开发或投资机会。' },
      { en: 'A strategically located land opportunity with strong fundamentals for residential or commercial development and solid long-term value.',
        lo: 'ທີ່ດິນທີ່ຕັ້ງຢູ່ທາງຍຸດທະສາດ ພ້ອມພື້ນຖານດີ ສຳລັບການພັດທະນາທີ່ຢູ່ອາໄສ ຫຼື ທຸລະກິດ ແລະ ມູນຄ່າໄລຍະຍາວ.',
        zh: '这块战略位置土地，具备坚实的住宅或商业开发基础，长期价值稳健。' }
    ]
  },
  commercial: {
    sale: [
      { en: 'A strategically positioned commercial property offering strong visibility, accessibility, and genuine business potential.',
        lo: 'ອາຄານທຸລະກິດທີ່ຕັ້ງຢູ່ໃນທຳເລດີ, ສະເໜີການເຫັນເດ່ນ, ການເຂົ້າເຖິງ ແລະ ທ່າແຮງທຸລະກິດ.',
        zh: '这处战略位置商业物业，能见度高、通达性强，具有真实的商业潜力。' }
    ],
    rent: [
      { en: 'A well-positioned commercial space for lease, offering high visibility and practical connectivity suited to a range of business operations.',
        lo: 'ພື້ນທີ່ທຸລະກິດທີ່ຕັ້ງຢູ່ດີ ສຳລັບເຊົ່າ, ມີການເຫັນເດ່ນ ແລະ ການເຊື່ອມຕໍ່ທີ່ດີ ສຳລັບທຸລະກິດ.',
        zh: '这处位置优越的商业空间现供租赁，能见度高，连接便利，适合各类业务运营。' }
    ]
  }
};

var OVERVIEW_FALLBACK = {
  sale: { en: 'A quality property presenting genuine value and a compelling lifestyle proposition in one of Vientiane\'s established residential areas.',
          lo: 'ອະສັງຫາທີ່ມີຄຸນຄ່າ, ສຳລັບຜູ້ທີ່ຕ້ອງການຊີວິດທີ່ດີ ໃນເຂດທີ່ຢູ່ອາໄສທີ່ໜ້ສົນໃຈຂອງວຽງຈັນ.',
          zh: '这处优质房产在万象成熟住宅区提供真实价值与出色的生活主张。' },
  rent:  { en: 'A well-located rental property offering comfortable living with convenient access to Vientiane\'s daily amenities and services.',
           lo: 'ທີ່ພັກເຊົ່າທີ່ຕັ້ງຢູ່ດີ, ສຳລັບຊີວິດທີ່ສະດວກ ພ້ອມການເຂົ້າເຖິງ ຄວາມຈຳເປັນ ໃນວຽງຈັນ.',
           zh: '这处出租物业位置优越，生活舒适，便于享用万象的日常设施和服务。' }
};

// ─────────────────────────────────────────────────────────────────
// 2. HIGHLIGHT LABELS  (trilingual, used by generateHighlightItems)
// ─────────────────────────────────────────────────────────────────
var HL = {
  location:    { en: 'Location',         lo: 'ສະຖານທີ່',           zh: '位置'     },
  bedsBaths:   { en: 'Bedrooms · Baths', lo: 'ຫ້ອງນອນ · ຫ້ອງນ້ຳ',  zh: '卧室 · 浴室' },
  bedrooms:    { en: 'Bedrooms',         lo: 'ຫ້ອງນອນ',            zh: '卧室'     },
  bathrooms:   { en: 'Bathrooms',        lo: 'ຫ້ອງນ້ຳ',            zh: '浴室'     },
  buildArea:   { en: 'Building Size',    lo: 'ຂະໜາດອາຄານ',         zh: '建筑面积'  },
  landArea:    { en: 'Land Size',        lo: 'ຂະໜາດທີ່ດິນ',        zh: '土地面积'  },
  parking:     { en: 'Parking',          lo: 'ບ່ອນຈອດລົດ',         zh: '停车位'   },
  yearBuilt:   { en: 'Year Built',       lo: 'ສ້າງປີ',              zh: '建造年份'  },
  type:        { en: 'Property Type',    lo: 'ປະເພດ',               zh: '物业类型'  },
  forSale:     { en: 'For Sale',         lo: 'ຂາຍ',                 zh: '出售'     },
  forRent:     { en: 'For Rent',         lo: 'ເຊົ່າ',               zh: '租房'     },
  sqm:         { en: 'sqm',             lo: 'ຕ.ມ',                 zh: '㎡'       },
  beds:        { en: 'beds',            lo: 'ຫ້ອງ',                zh: '间'       },
  baths:       { en: 'baths',           lo: 'ຫ້ອງ',                zh: '间'       },
  spaces:      { en: 'spaces',          lo: 'ບ່ອນ',                zh: '个'       }
};

var TYPE_LABELS = {
  villa:      { en: 'Villa',      lo: 'ວິລລ່າ',       zh: '别墅'  },
  house:      { en: 'House',      lo: 'ເຮືອນ',         zh: '住宅'  },
  apartment:  { en: 'Apartment',  lo: 'ອາພາດເມັ້ນ',   zh: '公寓'  },
  condo:      { en: 'Condo',      lo: 'ຄອນໂດ',         zh: '公寓'  },
  land:       { en: 'Land',       lo: 'ທີ່ດິນ',        zh: '土地'  },
  commercial: { en: 'Commercial', lo: 'ທຸລະກິດ',       zh: '商业'  }
};

// ─────────────────────────────────────────────────────────────────
// 3. DISTRICT KNOWLEDGE BASE  (Vientiane districts)
//    Add entries here to customise neighbourhood copy.
// ─────────────────────────────────────────────────────────────────
var DISTRICT_KNOWLEDGE = {
  chanthabouly: {
    en: 'Chanthabouly sits at the heart of Vientiane, placing residents within easy reach of the Mekong riverfront, the Presidential Palace, and the capital\'s most established commercial corridors. Government offices, cultural landmarks, and daily conveniences are all closely accessible.',
    lo: 'ຈັນທະບູລີ ຕັ້ງຢູ່ໃຈກາງວຽງຈັນ, ຢູ່ໃກ້ຮິມແມ່ນ້ຳຂອງ, ພະລາຊະວັງ ແລະ ບັນດາຖະໜົນການຄ້າທີ່ສຳຄັນ. ຫ້ອງການລັດ, ສະຖານທີ່ທາງວັດທະນະທຳ ແລະ ຄວາມຈຳເປັນໃນຊີວິດ ລ້ວນຢູ່ໃກ້ແຄ.',
    zh: '占丹布里位于万象市中心，居民可轻松到达湄公河岸、总统府及首都最重要的商业走廊。政府机关、文化地标和日常便利设施均触手可及。'
  },
  sisattanak: {
    en: 'Sisattanak is Vientiane\'s premier diplomatic and residential quarter, home to That Luang Stupa, international embassies, and a strong expat community. Reputable international schools, fine dining, and wide tree-lined roads position this as one of the city\'s most sought-after and prestigious addresses.',
    lo: 'ສີສັດຕະນາກ ແມ່ນເຂດທູດທາງ ແລະ ທີ່ຢູ່ອາໄສລຳດັບສູງຂອງວຽງຈັນ, ເປັນທີ່ຕັ້ງຂອງທາດຫຼວງ, ສະຖານທູດສາກົນ ແລະ ຊຸມຊົນຊາວຕ່າງຊາດ. ໂຮງຮຽນນາໆຊາດ, ຮ້ານອາຫານ ແລະ ຖະໜົນ ລ້ວນ ເຮັດໃຫ້ນີ້ ເປັນທີ່ຢູ່ທີ່ໜ້ສົນໃຈທີ່ສຸດ.',
    zh: '萨塔纳克是万象首屈一指的外交与高档住宅区，坐拥塔銮大佛塔、各国大使馆及强大的外籍社区。知名国际学校、精致餐厅和宽阔林荫大道，使其成为全市最受追捧的尊贵地址之一。'
  },
  xaysetha: {
    en: 'Xaysetha offers a balance of residential comfort and urban accessibility, with Watay International Airport and major shopping centres within a short drive. The area is popular with families and professionals seeking a quieter pace without sacrificing city convenience or connectivity.',
    lo: 'ໄຊເສດຖາ ສະເໜີຄວາມສົມດູນ ລະຫວ່າງຄວາມສະດວກສະບາຍ ໃນຊີວິດ ແລະ ຄວາມທັນສະໄໝ ໃນຕົວເມືອງ. ສະໜາມບິນສາກົນວັດໄທ ແລະ ສູນການຄ້າຂະໜາດໃຫຍ່ ຢູ່ໃກ້ໆ ເໝາະ ສຳລັບ ຄອບຄົວ ແລະ ຜູ້ທີ່ຕ້ອງການຄວາມງຽບ.',
    zh: '赛色塔区在住宅舒适性与城市便利性之间取得完美平衡，瓦岱国际机场及大型购物中心均在短驾车距离内。该区深受希望享有安静生活节奏、同时不牺牲城市便利的家庭和专业人士青睐。'
  },
  hadxayfong: {
    en: 'Hadxayfong is a rapidly developing district on Vientiane\'s eastern edge, benefiting from ongoing infrastructure investment, emerging commercial nodes, and improving road connectivity. It represents strong long-term value potential at competitive price points.',
    lo: 'ຫາດຊາຍຟອງ ແມ່ນເຂດທີ່ກຳລັງພັດທະນາໄວ ທາງທິດຕາເວັນອອກຂອງວຽງຈັນ, ໄດ້ຮັບຜົນປະໂຫຍດ ຈາກການລົງທຶນດ້ານໂຄງລ່າງ, ທຸລະກິດໃໝ່ ແລະ ເສັ້ນທາງທີ່ດີຂຶ້ນ. ສະເໜີທ່າແຮງຄຸນຄ່າໄລຍະຍາວ ໃນລາຄາທີ່ໜ້ສົນໃຈ.',
    zh: '哈赛丰是万象东部边缘快速发展的区域，受益于持续的基础设施投资、新兴商业节点和不断改善的道路连接。以具竞争力的价格，呈现出强劲的长期价值潜力。'
  },
  sikhottabong: {
    en: 'Sikhottabong stretches along the western Mekong riverbank, offering scenic views, riverside dining, and a relaxed residential atmosphere. The district balances urban accessibility with a more spacious, community-oriented lifestyle valued by long-term residents.',
    lo: 'ສີໂຄດຕະບອງ ທອດຕາມຝັ່ງແມ່ນ້ຳຂອງດ້ານຕາເວັນຕົກ, ສະເໜີທັດສະນີຍະພາບ, ຮ້ານອາຫານ ແລະ ບັດຍາກາດທີ່ງຽບ. ສ້າງ ຄວາມສົມດູນ ລະຫວ່າງ ຄວາມສະດວກ ໃນເມືອງ ແລະ ຊີວິດ ຊຸມຊົນ.',
    zh: '西科塔蓬区沿西部湄公河岸延伸，提供优美的河景、临河餐饮选择及轻松的住宅氛围。该区在城市便利性与宽敞社区生活方式之间取得了良好平衡，深受长期居民珍视。'
  },
  sangthong: {
    en: 'Sangthong is a growing peri-urban district on Vientiane\'s northern fringe, valued for its larger land parcels, lower density, and green surroundings. It presents a practical choice for those seeking more space and a quieter environment at accessible price points.',
    lo: 'ສ້າງທອງ ເປັນເຂດຊານເມືອງທາງທິດເໜືອຂອງວຽງຈັນ, ມີທີ່ດິນຂະໜາດໃຫຍ່, ຄວາມໜາແໜ້ນຕ່ຳ ແລະ ສິ່ງແວດລ້ອມທຽວທຳ. ເໝາະ ສຳລັບ ຜູ້ທີ່ຕ້ອງການ ພື້ນທີ່ ຫຼາຍ ໃນ ລາຄາ ທີ່ ເໝາະ ສົມ.',
    zh: '桑通是万象北部边缘一个不断发展的近郊区域，以较大地块、低密度和绿色环境著称。对于那些寻求更大空间和宁静环境、同时要求实惠价格的购房者而言，是一个务实的选择。'
  },
  naxaithong: {
    en: 'Naxaithong occupies Vientiane\'s western fringe, offering larger land parcels with improving road access and a quieter living environment. The area appeals to long-term investors and buyers seeking lower entry points relative to the central districts.',
    lo: 'ນາໄຊທອງ ຕັ້ງຢູ່ຊາຍຂອບດ້ານຕາເວັນຕົກຂອງວຽງຈັນ, ສະເໜີທີ່ດິນຂະໜາດໃຫຍ່ ແລະ ສິ່ງແວດລ້ອມທີ່ງຽບ. ເໝາະ ສຳລັບ ນັກລົງທຶນ ໄລຍະ ຍາວ ທີ່ ຕ້ອງການ ລາຄາ ຕ່ຳ ກວ່າ ເຂດ ໃຈກາງ.',
    zh: '纳赛通位于万象西部边缘，提供较大地块、持续改善的道路通达性和安静的生活环境。该区对寻求低于中心区域入市价格的长期投资者和购房者极具吸引力。'
  },
  pakngum: {
    en: 'Pakngum offers a relaxed, nature-adjacent setting northeast of central Vientiane, with easy access to the Nam Ngum River and surrounding landscapes. The area suits those seeking a slower pace and genuine separation from urban density.',
    lo: 'ປາກງື່ມ ສະເໜີ ສະພາບ ແວດລ້ອມ ທີ່ງຽບ ສະຫງົບ ທາງ ທິດ ຕາເວັນ ອອກ ສຽງ ເໜືອ ຂອງ ໃຈ ກາງ ວຽງ ຈັນ, ໃກ້ ຮ່ວງ ນ້ຳ ຂອງ ແລະ ທຳ ມະ ຊາດ. ເໝາະ ສຳລັບ ຜູ້ ທີ່ ຕ້ອງ ການ ຊີວິດ ທີ່ ສະ ຫງົບ.',
    zh: '巴贡区位于万象市中心东北方向，提供轻松、临近自然的生活环境，便于前往南俄河及周边风景区。该区非常适合那些追求慢节奏生活、渴望真正远离城市密度的居民。'
  }
};

var NEIGHBORHOOD_FALLBACK = {
  en: 'DISTRICT, Vientiane is a well-established residential area conveniently located with access to local markets, schools, and essential services. Properties in this area offer solid lifestyle fundamentals with reliable connectivity to the broader city.',
  lo: 'DISTRICT ເປັນ ເຂດ ທີ່ ຢູ່ ອາໄສ ທີ່ ດີ ໃນ ວຽງ ຈັນ, ຢູ່ ໃກ້ ກັບ ຕະ ຫຼາດ, ໂຮງ ຮຽນ ແລະ ການ ບໍ ລິ ການ ທີ່ ຈຳ ເປັນ.',
  zh: 'DISTRICT是万象的成熟住宅区，方便抵达本地市场、学校和基本服务设施，生活配套完善，与城市各区连接顺畅。',
  generic_en: 'Located in Vientiane, this property benefits from the capital\'s improving infrastructure, growing commercial activity, and convenient access to schools, markets, and daily services. Vientiane\'s steady development continues to support strong residential demand.',
  generic_lo: 'ຕັ້ງ ຢູ່ ໃນ ວຽງ ຈັນ, ອະ ສັງ ຫາ ນີ້ ໄດ້ ຮັບ ຜົນ ປະ ໂຫຍດ ຈາກ ໂຄງ ລ່າງ ທີ່ ດີ ຂຶ້ນ ຂອງ ນະ ຄອນ ຫຼວງ, ກິດ ຈະ ກຳ ທາງ ທຸ ລະ ກິດ ທີ່ ກຳ ລັງ ເຕີບ ໂຕ ແລະ ການ ເຂົ້າ ເຖິງ ໂຮງ ຮຽນ, ຕະ ຫຼາດ ແລະ ບໍ ລິ ການ ໃນ ຊີ ວິດ ປະ ຈຳ ວັນ ທີ່ ສະ ດວກ.',
  generic_zh: '该物业位于万象，受益于首都不断改善的基础设施、蓬勃的商业活动以及便利的学校、市场和日常服务。万象的持续发展继续为强劲的住宅需求提供有力支撑。'
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function l(obj, lang) {
  if (!obj) return '';
  return obj[lang] || obj.en || obj.lo || '';
}

function normDistrictKey(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z]/g, '')
    .replace('chanthabouri', 'chanthabouly')
    .replace('chanthabuly',  'chanthabouly')
    .replace('sisatanak',    'sisattanak')
    .replace('xaysettha',    'xaysetha')
    .replace('hadxaifong',   'hadxayfong')
    .replace('hadsaifong',   'hadxayfong');
}

function isLuxury(p) {
  var s = String(p.price_display || '').replace(/[^0-9.]/g, '');
  var v = parseFloat(s) || 0;
  return v >= 800000;
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC: generateOverview
// ─────────────────────────────────────────────────────────────────
function generateOverview(p, lang) {
  lang = lang || 'en';
  var tx   = (p.transaction_type || '').replace('for_', '');
  var type = (p.property_type   || '').toLowerCase();

  var typeGroup = OVERVIEW_TEMPLATES[type];
  if (!typeGroup) typeGroup = OVERVIEW_TEMPLATES.house;
  var txGroup = typeGroup[tx] || typeGroup.sale || typeGroup.rent;
  if (!txGroup) {
    var fb = OVERVIEW_FALLBACK[tx] || OVERVIEW_FALLBACK.sale;
    return l(fb, lang);
  }
  var idx = (isLuxury(p) && txGroup.length > 1) ? 1 : 0;
  return l(txGroup[idx], lang);
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC: generateHighlightItems
//   Returns [{kicker:string, value:string}, ...] (max 4)
// ─────────────────────────────────────────────────────────────────
function generateHighlightItems(p, lang) {
  lang = lang || 'en';
  var items = [];
  var pType = (p.property_type || '').toLowerCase();
  var tx    = (p.transaction_type || '').replace('for_', '');

  var village  = p['village_'  + lang] || p.village_en  || p.village_lo  || '';
  var district = p['district_' + lang] || p.district_en || p.district_lo || '';

  // 1. Location
  if (village && district) {
    items.push({ kicker: l(HL.location, lang), value: village + ', ' + district });
  } else if (district) {
    items.push({ kicker: l(HL.location, lang), value: district });
  }

  // 2. Beds + Baths (combined when both present)
  if (p.bedrooms && p.bathrooms) {
    items.push({
      kicker: l(HL.bedsBaths, lang),
      value: p.bedrooms + ' ' + l(HL.beds, lang) + ' · ' + p.bathrooms + ' ' + l(HL.baths, lang)
    });
  } else if (p.bedrooms) {
    items.push({ kicker: l(HL.bedrooms, lang), value: p.bedrooms + ' ' + l(HL.beds, lang) });
  }

  // 3. Building / land size
  if (p.sqm) {
    var areaKey = pType === 'land' ? HL.landArea : HL.buildArea;
    items.push({ kicker: l(areaKey, lang), value: p.sqm + ' ' + l(HL.sqm, lang) });
  }

  // 4. Parking
  if (p.parking_spaces && Number(p.parking_spaces) > 0) {
    items.push({ kicker: l(HL.parking, lang), value: p.parking_spaces + ' ' + l(HL.spaces, lang) });
  }

  // 5. Year built (fill slot 5 if needed)
  if (items.length < 4 && p.year_built && Number(p.year_built) > 1980) {
    items.push({ kicker: l(HL.yearBuilt, lang), value: String(p.year_built) });
  }

  // 6. Property type + transaction (always last, fills gaps)
  if (items.length < 4) {
    var tl  = TYPE_LABELS[pType];
    var txL = tx === 'rent' ? l(HL.forRent, lang) : l(HL.forSale, lang);
    if (tl) {
      items.push({ kicker: l(HL.type, lang), value: l(tl, lang) + ' · ' + txL });
    }
  }

  return items.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC: generateNeighborhoodInsight
// ─────────────────────────────────────────────────────────────────
function generateNeighborhoodInsight(p, lang) {
  lang = lang || 'en';
  var districtEn = p.district_en || '';
  var districtLo = p.district_lo || '';

  var key = normDistrictKey(districtEn) || normDistrictKey(districtLo);
  var know = DISTRICT_KNOWLEDGE[key];

  if (know) {
    return l(know, lang);
  }

  // Generic fallback with district name interpolated
  var distName = p['district_' + lang] || districtEn || districtLo || '';
  if (distName) {
    var tpl = lang === 'zh' ? NEIGHBORHOOD_FALLBACK.zh
            : lang === 'lo' ? NEIGHBORHOOD_FALLBACK.lo
            : NEIGHBORHOOD_FALLBACK.en;
    return tpl.replace('DISTRICT', distName);
  }

  // No district at all
  return lang === 'zh' ? NEIGHBORHOOD_FALLBACK.generic_zh
       : lang === 'lo' ? NEIGHBORHOOD_FALLBACK.generic_lo
       : NEIGHBORHOOD_FALLBACK.generic_en;
}

// ─────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────
export const ContentGen = {
  generateOverview,
  generateHighlightItems,
  generateNeighborhoodInsight
};

// Side-effect: expose as window.ContentGen for non-module browser scripts
if (typeof window !== 'undefined') {
  window.ContentGen = ContentGen;
}

export default ContentGen;
