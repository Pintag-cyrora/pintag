var LABELS = {
  curated: { lo: 'ຄັດເລືອກ',     en: 'Curated',     zh: '精选'   },
  sale:    { lo: 'ຂາຍ',           en: 'For Sale',    zh: '出售'   },
  rent:    { lo: 'ເຊົ່າ',         en: 'For Rent',    zh: '租房'   },
  land:    { lo: 'ທີ່ດິນ',        en: 'Land',        zh: '土地'   },
  sold:    { lo: 'ຂາຍແລ້ວ',      en: 'Sold',        zh: '已售'   },
  rented:  { lo: 'ເຊົ່າແລ້ວ',    en: 'Rented',      zh: '已租'   },
  offer:   { lo: 'ກຳລັງດຳເນີນ', en: 'Under Offer', zh: '洽谈中' },
};

/**
 * Returns the HTML string for a property status badge.
 *
 * Priority chain (first match wins):
 *   1. isFeaturedCard === true         → badge-curated
 *   2. p.status === 'sold'             → badge-sold
 *   3. p.status === 'rented'           → badge-rented
 *   4. p.status === 'under_offer'      → badge-offer
 *   5. p.property_type === 'land'      → badge-land
 *   6. p.transaction_type is a rent    → badge-rent  (matches 'for_rent' and legacy 'rent')
 *   7. (default)                       → badge-sale
 *
 * @param {object}          p              Property row from Supabase
 * @param {'lo'|'en'|'zh'}  lang           Active language
 * @param {boolean}         isFeaturedCard Whether this card occupies the hero slot
 * @returns {string}  HTML <span> element
 */
export function getBadgeHtml(p, lang, isFeaturedCard) {
  if (isFeaturedCard) {
    return '<span class="status-badge badge-curated">' + LABELS.curated[lang] + '</span>';
  }
  if (p.status === 'sold') {
    return '<span class="status-badge badge-sold">' + LABELS.sold[lang] + '</span>';
  }
  if (p.status === 'rented') {
    return '<span class="status-badge badge-rented">' + LABELS.rented[lang] + '</span>';
  }
  if (p.status === 'under_offer') {
    return '<span class="status-badge badge-offer">' + LABELS.offer[lang] + '</span>';
  }
  if (p.property_type === 'land') {
    return '<span class="status-badge badge-land">' + LABELS.land[lang] + '</span>';
  }
  if (p.transaction_type === 'for_rent' || p.transaction_type === 'rent') {
    return '<span class="status-badge badge-rent">' + LABELS.rent[lang] + '</span>';
  }
  return '<span class="status-badge badge-sale">' + LABELS.sale[lang] + '</span>';
}
