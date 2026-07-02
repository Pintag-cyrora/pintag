// ══════════════════════════════════════════════════════════════════
// property-card.js — single shared "property card" renderer.
// Used by listings.html and saved-properties.html so a listing looks
// and behaves identically wherever it appears.
//
// Depends on (already defined globally by every page that includes
// this file): esc(str), and favorites.js's getSavedSet()/toggleSave().
// ══════════════════════════════════════════════════════════════════

function daysOld(p) {
  if (!p.created_at) return Infinity;
  var t = new Date(p.created_at).getTime();
  if (!t || t <= 0) return Infinity;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function isNewListing(p) { var age = daysOld(p); return isFinite(age) && age <= 7; }

// Extract a numeric price value from display strings like "$550,000" or "2.5M"
function parseNumericPrice(s) {
  if (!s) return null;
  var clean = String(s).replace(/[^\d.MmKk]/g, '');
  if (/[Mm]$/.test(clean)) return parseFloat(clean) * 1000000;
  if (/[Kk]$/.test(clean)) return parseFloat(clean) * 1000;
  return parseFloat(clean) || null;
}

function getBadgeHtml(p, lang, isFeaturedCard) {
  var L = {
    curated:   { lo: 'ຄັດເລືອກ',       en: 'Curated',      zh: '精选'   },
    available: { lo: 'ວ່າງ',             en: 'Available',    zh: '在售'   },
    sold:      { lo: 'ຂາຍແລ້ວ',        en: 'Sold',         zh: '已售'   },
    rented:    { lo: 'ເຊົ່າແລ້ວ',      en: 'Rented',       zh: '已租'   },
    offer:     { lo: 'ກຳລັງດຳເນີນ',   en: 'Under Offer',  zh: '洽谈中' },
    land:      { lo: 'ທີ່ດິນ',          en: 'Land',         zh: '土地'   }
  };
  if (isFeaturedCard)             return '<span class="status-badge badge-curated">'   + L.curated[lang]   + '</span>';
  if (p.status === 'sold')        return '<span class="status-badge badge-sold">'      + L.sold[lang]      + '</span>';
  if (p.status === 'rented')      return '<span class="status-badge badge-rented">'    + L.rented[lang]    + '</span>';
  if (p.status === 'under_offer') return '<span class="status-badge badge-offer">'     + L.offer[lang]     + '</span>';
  if (p.property_type === 'land') return '<span class="status-badge badge-land">'      + L.land[lang]      + '</span>';
  return                                 '<span class="status-badge badge-available">' + L.available[lang] + '</span>';
}

function getAgentHtml(p) {
  if (!p.agent_name) return '';
  var initial = esc(p.agent_name.trim().charAt(0) || 'P');
  var avatarInner = p.agent_photo
    ? '<img src="' + esc(p.agent_photo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
    : initial;
  return '<div class="card-divider"></div>' +
    '<div class="card-agent">' +
      '<div class="agent-avatar">' + avatarInner + '</div>' +
      '<div>' +
        '<div class="agent-name">' + esc(p.agent_name) + '</div>' +
        '<div class="agent-platform">ຕົວແທນ Pintag</div>' +
      '</div>' +
    '</div>';
}

// One primary badge per card (priority order) + optional Verified secondary.
// p._isBestValue and p.trending_score are optional — a page that hasn't
// computed cross-listing group averages simply won't show those two
// (relative) signals, which is correct: they're meaningless without a
// comparable peer set (e.g. on a small, arbitrary saved-properties list).
function getActivityBadgesHtml(p, lang) {
  var age = daysOld(p);
  if (!isFinite(age)) age = Infinity;
  var score = parseFloat(p.trending_score) || 0;
  var primary = '';

  if (p.price_previous && p.price_previous !== p.price_display) {
    primary = '<span class="act-badge act-badge-drop">📉 ' + {lo:'ຫຼຸດລາຄາ',en:'Price Reduced',zh:'降价'}[lang] + '</span>';
  } else if (age <= 7) {
    primary = '<span class="act-badge act-badge-new">🆕 ' + {lo:'ໃໝ່',en:'New',zh:'新房源'}[lang] + '</span>';
  } else if (score >= 200) {
    primary = '<span class="act-badge act-badge-hot">🔥 ' + {lo:'ນິຍົມສູງ',en:'Hot Property',zh:'热门房源'}[lang] + '</span>';
  } else if (p._isBestValue) {
    primary = '<span class="act-badge act-badge-val">💰 ' + {lo:'ຄຸ້ມຄ່າທີ່ສຸດ',en:'Best Value',zh:'超值房源'}[lang] + '</span>';
  } else if (p.is_featured) {
    primary = '<span class="act-badge act-badge-feat">⭐ ' + {lo:'ແນະນຳ',en:'Featured',zh:'精选'}[lang] + '</span>';
  }

  var secondary = p.is_verified ? '<span class="act-badge act-badge-vfy">' + {lo:'ຢັ້ງຢືນ',en:'Verified',zh:'认证'}[lang] + '</span>' : '';
  return primary + secondary;
}

function getActivityLine(p, lang) {
  var age = daysOld(p);
  if (!isFinite(age)) return '';
  var score = parseFloat(p.trending_score) || 0;
  var isSale = p.transaction_type === 'for_sale' || p.transaction_type === 'sale' || p.transaction_type === 'sale_or_rent';

  // District-trending context replaces age line for popular/hot listings
  // (only present when the caller computed trending_score from a peer set).
  if (score >= 100 && p.district_en) {
    var d = esc(p.district_en);
    return {
      lo: 'ຍອດນິຍົມ ' + (isSale ? 'ຊື້ຂາຍ' : 'ເຊົ່າ') + ' ໃນ ' + d,
      en: 'Popular ' + (isSale ? 'sale' : 'rental') + ' in ' + d,
      zh: d + '热门' + (isSale ? '售房' : '出租房')
    }[lang];
  }
  if (age < 1)   return {lo:'ລົງຂາຍວັນນີ້',  en:'Listed today',        zh:'今日上架'}[lang];
  if (age < 2)   return {lo:'ລົງຂາຍມື້ວານ', en:'Listed yesterday',     zh:'昨日上架'}[lang];
  if (age < 30)  return {lo:'ລົງຂາຍ '+Math.floor(age)+' ວັນກ່ອນ',   en:'Listed '+Math.floor(age)+' days ago',   zh:Math.floor(age)+'天前上架'}[lang];
  var mo = Math.floor(age / 30);
  if (mo < 24)   return {lo:'ລົງຂາຍ '+mo+' ເດືອນກ່ອນ',              en:'Listed '+mo+(mo===1?' month':' months')+' ago', zh:mo+'个月前上架'}[lang];
  var yr = Math.floor(age / 365);
  return           {lo:'ລົງຂາຍ '+yr+' ປີກ່ອນ',                       en:'Listed '+yr+(yr===1?' year':' years')+' ago',   zh:yr+'年前上架'}[lang];
}

// ── buildPropCard — the shared card, identical wherever it's used ──
// p: property row. lang: 'lo'|'en'|'zh'. savedSet: a Set of saved slugs
// (from getSavedSet()). isFeaturedCard: whether to render the wide
// editorial layout (listings.html only — a personal saved list doesn't
// use it). idx: position in the grid, used only to decide eager vs lazy
// image loading for the first few cards. compareSet: a Set of slugs
// currently selected for comparison (from getCompareSet()) — the
// compare toggle is on every card, on every surface, by design.
function buildPropCard(p, lang, savedSet, isFeaturedCard, idx, compareSet) {
  var card = document.createElement('a');
  card.href = 'listing.html?slug=' + encodeURIComponent(p.slug);
  card.className = isFeaturedCard ? 'prop-card is-featured' : 'prop-card';

  var title    = esc(p['title_'    + lang] || p.title_en    || '');
  var district = esc(p['district_' + lang] || p.district_en || '');

  var isSale = p.transaction_type === 'for_sale' || p.transaction_type === 'sale';
  var isSor  = p.transaction_type === 'sale_or_rent';

  var txLabel = {
    lo: isSor ? 'ຊື້ / ເຊົ່າ' : isSale ? 'ຂາຍ' : 'ໃຫ້ເຊົ່າ',
    en: isSor ? 'Sale or Rent' : isSale ? 'For Sale' : 'For Rent',
    zh: isSor ? '售/租'        : isSale ? '出售'     : '租房'
  };

  var typeDisplay = p.property_type
    ? esc(p.property_type.charAt(0).toUpperCase() + p.property_type.slice(1))
    : '';

  var imgHtml = (p.images && p.images.length)
    ? '<img src="' + esc(p.images[0]) + '" alt="" loading="' + ((idx||0) < 4 ? 'eager' : 'lazy') + '">'
    : '<div class="prop-card-no-img"></div>';

  var imgCount = (p.images && p.images.length > 1) ? p.images.length : 0;
  var photoHtml = imgCount
    ? '<div class="ov-br"><span class="photo-count">' +
        '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
        imgCount +
        '<span class="lo-i"> ຮູບ</span><span class="en-i"> photos</span><span class="zh-i"> 张</span>' +
      '</span></div>'
    : '';

  var aiHtml = p.video_url
    ? '<div class="ov-bl"><span class="ai-badge">▶ AI <span class="lo-i">ພາຊົມຮອບ</span><span class="en-i">Walkthrough</span><span class="zh-i">带看</span></span></div>'
    : '';

  var slugSafe = p.slug.replace(/'/g, '%27');
  var isSaved = savedSet.has(p.slug);
  var isCompared = !!(compareSet && compareSet.has(p.slug));

  var specsHtml = [
    p.bedrooms  ? '<span class="card-spec"><span>' + p.bedrooms  + '</span> <span class="lo-i">ຫ້ອງນອນ</span><span class="en-i">beds</span><span class="zh-i">卧</span></span>' : '',
    p.bathrooms ? '<span class="card-spec"><span>' + p.bathrooms + '</span> <span class="lo-i">ຫ້ອງນ້ຳ</span><span class="en-i">baths</span><span class="zh-i">浴</span></span>' : '',
    p.sqm       ? '<span class="card-spec"><span>' + p.sqm       + '</span> sqm</span>' : ''
  ].filter(Boolean).join('');

  var perMo = { lo: '/ ເດືອນ', en: '/ month', zh: '/ 月' };
  var rawPrice = esc((p.price_display || '').replace(/\s*\/\s*(ເດືອນ|mo|月|month)\s*/i, '').trim());
  var priceHtml;
  if (isSor && (p.sale_price || p.rent_price)) {
    priceHtml = '';
    if (p.sale_price) priceHtml += '<p class="card-price">' + esc(p.sale_price) + ' <span class="card-price-unit lo-i">ຂາຍ</span><span class="card-price-unit en-i">Sale</span><span class="card-price-unit zh-i">售</span></p>';
    if (p.rent_price) priceHtml += '<p class="card-price">' + esc(p.rent_price) + ' <span class="card-price-unit">' + perMo[lang] + '</span> <span class="card-price-unit lo-i">ເຊົ່າ</span><span class="card-price-unit en-i">Rent</span><span class="card-price-unit zh-i">租</span></p>';
  } else {
    priceHtml = rawPrice
      ? '<p class="card-price">' + rawPrice + (!isSale && !isSor ? ' <span class="card-price-unit">' + perMo[lang] + '</span>' : '') + '</p>'
      : '<p class="card-price-req"><span class="lo-i">ສອບຖາມລາຄາ</span><span class="en-i">Price on request</span><span class="zh-i">价格面议</span></p>';
  }

  var actBadgesHtml = getActivityBadgesHtml(p, lang);
  var actLineTxt    = getActivityLine(p, lang);
  var actLineHtml   = actLineTxt ? '<p class="card-activity-line">' + esc(actLineTxt) + '</p>' : '';

  var newBadgeHtml = isNewListing(p)
    ? '<div style="margin-top:4px;"><span class="badge-new-listing">' +
        (daysOld(p) < 1
          ? ({lo:'ໃໝ່ວັນນີ້',en:'New Today',zh:'今天上架'})[lang]
          : ({lo:'ໃໝ່ອາທິດນີ້',en:'New This Week',zh:'本周新上'})[lang])
        + '</span></div>'
    : '';

  card.innerHTML =
    '<div class="prop-card-img">' +
      imgHtml +
      '<div class="ov-tl">' + getBadgeHtml(p, lang, isFeaturedCard) + newBadgeHtml + '</div>' +
      '<div class="ov-tr">' +
        '<button class="heart-btn' + (isSaved ? ' saved' : '') + '" data-save="' + slugSafe + '" onclick="toggleSave(\'' + slugSafe + '\',event)" aria-label="Save listing" aria-pressed="' + (isSaved ? 'true' : 'false') + '">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1A2428" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>' +
        '</button>' +
        '<button class="compare-btn' + (isCompared ? ' comparing' : '') + '" data-compare="' + slugSafe + '" onclick="var r=toggleCompare(\'' + slugSafe + '\',event); if(r.limitReached) pintagCompareLimitNudge(this);" aria-label="Add to compare" aria-pressed="' + (isCompared ? 'true' : 'false') + '">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" stroke="#1A2428" stroke-width="2"/><polyline class="cm" points="7 12 10.5 15.5 17 8.5" stroke="#fff" stroke-width="2" stroke-opacity="0"/></svg>' +
        '</button>' +
      '</div>' +
      photoHtml +
      aiHtml +
    '</div>' +
    '<div class="prop-card-body">' +
      '<p class="card-tag">' +
        '<span class="lo-i">' + txLabel.lo + '</span>' +
        '<span class="en-i">' + txLabel.en + '</span>' +
        '<span class="zh-i">' + txLabel.zh + '</span>' +
        (typeDisplay ? ' · ' + typeDisplay : '') +
      '</p>' +
      (actBadgesHtml ? '<div class="act-badges">' + actBadgesHtml + '</div>' : '') +
      '<p class="card-title">' + esc(title) + '</p>' +
      '<p class="card-loc">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2D8C8C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>' +
        (district ? esc(district) + ', ' : '') +
        '<span class="lo-i">ວຽງຈັນ</span><span class="en-i">Vientiane</span><span class="zh-i">万象</span>' +
      '</p>' +
      (specsHtml ? '<div class="card-specs">' + specsHtml + '</div>' : '') +
      priceHtml +
      getAgentHtml(p) +
      actLineHtml +
    '</div>';

  return card;
}
