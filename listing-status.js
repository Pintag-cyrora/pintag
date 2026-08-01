// listing-status.js — the canonical Listing Status model. Same loading
// convention as terminology.js/rental-terms.js/unit-availability.js (plain
// global-var <script> tag, no build step, no dependency on any other file
// here per unit-availability.js's own rule 1 -- this module owns its own
// registry/resolver/formatter and never imports another status module).
//
// Two independent axes, both stored on `properties` (see migration
// 20260729000000_listing_status_model.sql):
//
//   workflow_status: 'draft' | 'active' | 'archived'   -- internal, staff-only.
//   market_status:   'available' | 'reserved' | 'rented' | 'sold' |
//                     'fully_occupied' | 'coming_soon' | 'off_market'
//                     -- public-facing; drives the status badge, the price
//                     area, the primary CTA, search filters, and share
//                     previews.
//
// ARCHITECTURAL RULES (mirrors unit-availability.js):
// 1. resolveListingStatus() is the sole read API. No code outside this file
//    reads properties.workflow_status/market_status directly.
// 2. Pure, portable: no document/window references in any function here --
//    same browser-<script>-or-edge-function portability unit-availability.js
//    already relies on.
// 3. isPubliclyAvailable() is the ONE gate deciding "does this listing show
//    a normal price + Contact CTA, or the unavailable treatment" -- callers
//    branch on this, they never re-derive it from a market_status list of
//    their own.

var LISTING_UNAVAILABLE_MARKET_STATUSES = ['reserved','rented','sold','fully_occupied','off_market'];

function resolveListingStatus(property) {
  var workflow = property && property.workflow_status || 'active';
  var market = property && property.market_status || 'available';
  return {
    workflow: workflow,               // 'draft' | 'active' | 'archived'
    market: market,                   // see MARKET_STATUS_LABELS keys
    isPubliclyAvailable: LISTING_UNAVAILABLE_MARKET_STATUSES.indexOf(market) === -1
  };
}

var WORKFLOW_STATUS_LABELS = {
  draft:    { en:'Draft',    lo:'ຮ່າງ',        zh:'草稿'   },
  active:   { en:'Active',   lo:'ນຳໃຊ້ຢູ່',    zh:'已上线' },
  archived: { en:'Archived', lo:'ເກັບຖາວອນ',   zh:'已归档' }
};

var MARKET_STATUS_LABELS = {
  available:      { en:'Available',      lo:'ວ່າງ',              zh:'可预订'   },
  reserved:       { en:'Reserved',       lo:'ຖືກຈອງແລ້ວ',        zh:'已预订'   },
  rented:         { en:'Rented',         lo:'ເຊົ່າແລ້ວ',         zh:'已出租'   },
  sold:           { en:'Sold',           lo:'ຂາຍແລ້ວ',           zh:'已售出'   },
  fully_occupied: { en:'Fully Occupied', lo:'ເຕັມແລ້ວ',          zh:'已满租'   },
  coming_soon:    { en:'Coming Soon',    lo:'ກຳລັງຈະມາ',         zh:'即将推出' },
  off_market:     { en:'Off Market',     lo:'ຖອນອອກຈາກຕະຫຼາດ',   zh:'已下架'   }
};

// CSS class per market_status -- callers own the actual class definitions
// (each page already has its own badge stylesheet), this just names which
// bucket a status belongs to so every page uses the same 4 buckets instead
// of re-deciding "is sold red or grey" independently per file.
var MARKET_STATUS_BADGE_CLASS = {
  available:      'status-available',
  coming_soon:    'status-available',
  reserved:       'status-pending',
  fully_occupied: 'status-pending',
  sold:           'status-unavailable',
  rented:         'status-unavailable',
  off_market:     'status-unavailable'
};

function getMarketStatusLabel(marketStatus, lang) {
  lang = lang || 'en';
  var L = MARKET_STATUS_LABELS[marketStatus] || MARKET_STATUS_LABELS.available;
  return L[lang] || L.en;
}

function getWorkflowStatusLabel(workflowStatus, lang) {
  lang = lang || 'en';
  var L = WORKFLOW_STATUS_LABELS[workflowStatus] || WORKFLOW_STATUS_LABELS.active;
  return L[lang] || L.en;
}

function getMarketStatusBadgeClass(marketStatus) {
  return MARKET_STATUS_BADGE_CLASS[marketStatus] || MARKET_STATUS_BADGE_CLASS.available;
}

// Per-status "keep browsing" action for the unavailable-listing treatment.
// Intentionally distinct per status rather than one generic "Browse More" --
// the right next step differs (a sold house is gone for good; a fully
// occupied building might free up; a coming-soon listing just isn't live
// yet). 'available'/'coming_soon' never reach this map's callers because
// isPubliclyAvailable() gates them to the normal price+Contact flow instead
// (coming_soon still shows a real Notify Me action further below via
// getListingStatusCTA(), it just isn't in the "unavailable" family).
var MARKET_STATUS_CTA_ACTION = {
  reserved:       'find_similar',
  sold:           'find_similar',
  rented:         'find_similar',
  off_market:     'find_similar',
  fully_occupied: 'waiting_list',
  coming_soon:    'notify_me'
};

var CTA_ACTION_LABELS = {
  find_similar: { en:'Find Similar Properties', lo:'ຊອກຫາອະສັງຫາຄ້າຍຄືກັນ', zh:'查看类似房源' },
  waiting_list: { en:'Join Waiting List',        lo:'ເຂົ້າຮ່ວມລາຍຊື່ລໍຖ້າ', zh:'加入候补名单' },
  notify_me:    { en:'Notify Me When Available', lo:'ແຈ້ງເຕືອນເມື່ອວ່າງ',  zh:'有空位时通知我' }
};

// getListingStatusCTA(marketStatus, lang) -> {action, label} | null
// null means "no special CTA -- use the normal price/Contact flow" (i.e.
// isPubliclyAvailable() is true for this status and there is nothing to
// override).
function getListingStatusCTA(marketStatus, lang) {
  lang = lang || 'en';
  var action = MARKET_STATUS_CTA_ACTION[marketStatus];
  if (!action) return null;
  var L = CTA_ACTION_LABELS[action];
  return { action: action, label: L[lang] || L.en };
}

// getUnavailableMessage(marketStatus, lang) -- the sentence that replaces
// "Price on request" in the price area for an unavailable listing. Kept
// separate from the badge label (which is a single word/short phrase) --
// this is a full, buyer-facing sentence explaining what happened and that
// there's somewhere to go next.
var UNAVAILABLE_MESSAGE = {
  reserved:       { en:'This property is currently reserved.', lo:'ອະສັງຫາລາຍການນີ້ຖືກຈອງໄວ້ແລ້ວ.', zh:'该房源目前已被预订。' },
  sold:           { en:'This property has been sold.',         lo:'ອະສັງຫາລາຍການນີ້ຂາຍໄປແລ້ວ.',      zh:'该房源已售出。' },
  rented:         { en:'This property has been rented.',       lo:'ອະສັງຫາລາຍການນີ້ຖືກເຊົ່າໄປແລ້ວ.', zh:'该房源已出租。' },
  fully_occupied: { en:'This property is fully occupied.',     lo:'ອະສັງຫາລາຍການນີ້ເຕັມແລ້ວ.',       zh:'该房源目前已满租。' },
  off_market:     { en:'This listing is currently off market.', lo:'ລາຍການນີ້ຖືກຖອນອອກຈາກຕະຫຼາດຊົ່ວຄາວ.', zh:'该房源已暂时下架。' }
};
function getUnavailableMessage(marketStatus, lang) {
  lang = lang || 'en';
  var M = UNAVAILABLE_MESSAGE[marketStatus];
  if (!M) return null;
  return M[lang] || M.en;
}

// getUnavailableNoticeText(marketStatus, lang) -- the fuller "keep
// browsing" banner sentence shown near the top of an unavailable
// listing's detail page. Distinct from getUnavailableMessage() (the
// shorter phrase that sits in the price area): this is
// getUnavailableMessage()'s own sentence plus a shared trust-building
// trailer ("good properties don't stay available long, browse similar
// ones below") -- same status-specific lead for every caller, not a
// second, independently-maintained copy of UNAVAILABLE_MESSAGE.
var UNAVAILABLE_NOTICE_TRAILER = {
  en: "Good properties like this don't stay available for long. Browse similar available properties below.",
  lo: 'ຊັບສິນດີໆແບບນີ້ບໍ່ຄ່ອຍວ່າງດົນ. ຄົ້ນຫາຊັບສິນທີ່ຄ້າຍຄືກັນທີ່ຍັງວ່າງຢູ່ລຸ່ມນີ້.',
  zh: '像这样的优质房源通常很快就会被订走。请浏览下方类似的可预订房源。'
};
function getUnavailableNoticeText(marketStatus, lang) {
  lang = lang || 'en';
  var lead = getUnavailableMessage(marketStatus, lang);
  if (!lead) return null;
  var trailer = UNAVAILABLE_NOTICE_TRAILER[lang] || UNAVAILABLE_NOTICE_TRAILER.en;
  return lead + ' ' + trailer;
}

// ── Rented Listings UX v2, Priority 2 ("Rented Date") ───────────────────
// formatStatusChangeDate(dateStr, lang, nowMs) -- turns a REAL
// properties.market_status_changed_at timestamp (see migration
// 20260801000000_market_status_transition_tracking.sql) into either a
// short relative phrase ("12 days ago") for a recent transition, or an
// absolute "Month YYYY" for an older one. Returns null for a missing/
// invalid date -- callers MUST NOT fabricate a date when this returns
// null (e.g. a listing whose status changed before that migration shipped
// has no real value to show, and must fall back to the bare status badge
// with no date, per the "do not fabricate dates" requirement).
var STATUS_DATE_MONTH_NAMES = {
  en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
  lo: ['ມັງກອນ','ກຸມພາ','ມີນາ','ເມສາ','ພຶດສະພາ','ມິຖຸນາ','ກໍລະກົດ','ສິງຫາ','ກັນຍາ','ຕຸລາ','ພະຈິກ','ທັນວາ'],
  zh: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']
};
function formatStatusChangeDate(dateStr, lang, nowMs) {
  if (!dateStr) return null;
  var t = new Date(dateStr).getTime();
  if (!t || isNaN(t)) return null;
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var days = Math.floor((now - t) / 86400000);
  if (days < 0) days = 0;
  lang = lang || 'en';
  if (days <= 30) {
    if (days === 0) return { lo: 'ມື້ນີ້', en: 'today', zh: '今天' }[lang];
    if (days === 1) return { lo: 'ມື້ວານນີ້', en: 'yesterday', zh: '昨天' }[lang];
    return { lo: days + ' ມື້ກ່ອນ', en: days + ' days ago', zh: days + ' 天前' }[lang];
  }
  var d = new Date(t);
  var names = STATUS_DATE_MONTH_NAMES[lang] || STATUS_DATE_MONTH_NAMES.en;
  var month = names[d.getMonth()];
  var year = d.getFullYear();
  return lang === 'zh' ? (year + '年' + month) : (month + ' ' + year);
}
