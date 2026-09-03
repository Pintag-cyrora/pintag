// Shared fixtures + REST fake for the listings-filters suite. Rows are shaped
// like real `properties` rows with the embeds listings.html / listing.html
// select, spanning two provinces, every transaction type, a null price, a LAK
// price, and both phone-number storage formats.
const PORT = 8979;
const IMG = (n) => `http://localhost:${PORT}/${n}`;

const CONTACT_LOCAL = { id: 'c-local', role: 'agent', name: 'Souksavanh', phone: '020 5551 2345', whatsapp: '020 5551 2345', is_verified: true, languages: ['lo', 'en'] };
const CONTACT_INTL  = { id: 'c-intl',  role: 'owner', name: 'Mr Li',      phone: '+856 20 7778 8899', whatsapp: null, is_verified: false, languages: ['zh'] };
const CONTACT_THAI  = { id: 'c-thai',  role: 'other', name: 'Khun Nok',   phone: '+66 81 234 5678', whatsapp: '+66 81 234 5678', is_verified: false, languages: ['th'] };
const PARTY = { id: 'p-1', name_en: 'Souksavanh', name_lo: 'ສຸກສະຫວັນ', photo_url: null, agency_name: 'Pintag Realty', slug: 'souksavanh', type: 'agent', bio_en: '', bio_lo: '', is_verified: true, is_active: true, whatsapp: '020 5551 2345' };

function row(o) {
  return Object.assign({
    id: 'id-' + o.slug, slug: o.slug, status: 'active', workflow_status: 'active', market_status: 'available', deleted_at: null,
    title_en: 'Listing ' + o.slug, title_lo: null, title_zh: null,
    property_type: 'house', property_style: null, transaction_type: 'for_rent',
    price_amount: null, price_currency: null, price_frequency: null, rent_price_amount: null, rent_price_currency: null, rent_price_frequency: null,
    price_display: null, sale_price: null, rent_price: null, rent_period: null, price_previous: null,
    bedrooms: 2, bathrooms: 1, sqm: 100, sqm_land: null, floors: null, furnished: null,
    description_en: 'desc', description_lo: null, description_zh: null, features: null, amenities: null, highlights: null,
    province_en: 'Vientiane Capital', province_lo: 'ນະຄອນຫຼວງວຽງຈັນ', province_zh: '万象首都',
    district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ', district_zh: '西沙塔纳克', village_en: null,
    map_embed_url: null, nearby_places: null, images: [IMG('pintag-hero.png')], is_featured: false, view_count: 0, created_at: '2026-08-01T00:00:00Z',
    contact_id: 'c-local', managed_by_party_id: 'p-1', rental_terms: { version: 1 }, available_from: null,
    contacts: CONTACT_LOCAL, parties: PARTY,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT_LOCAL }],
    unit_types: [],
  }, o);
}

const ROWS = [
  row({ slug: 'house-rent', transaction_type: 'for_rent', property_type: 'house', price_amount: 850, price_currency: 'USD', price_frequency: 'monthly', price_display: '$850/month',
        property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT_LOCAL }, { sort_order: 1, is_primary: false, contacts: CONTACT_INTL }, { sort_order: 2, is_primary: false, contacts: CONTACT_THAI }] }),
  row({ slug: 'apt-noprice', transaction_type: 'for_rent', property_type: 'apartment', district_en: 'Chanthabouly', district_lo: 'ຈັນທະບູລີ', district_zh: '占塔布里' }),
  row({ slug: 'condo-lak', transaction_type: 'for_rent', property_type: 'condo', price_amount: 3000000, price_currency: 'LAK', price_frequency: 'monthly', price_display: '₭3,000,000/month' }),
  row({ slug: 'land-sale', transaction_type: 'for_sale', property_type: 'land', price_amount: 95000, price_currency: 'USD', price_frequency: 'one_time', price_display: '$95,000', bedrooms: null, bathrooms: null, sqm: null, sqm_land: 800, district_en: 'Xaythany', district_lo: 'ໄຊທານີ', district_zh: '赛塔尼', contact_id: 'c-intl', contacts: CONTACT_INTL, property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT_INTL }] }),
  row({ slug: 'villa-both', transaction_type: 'sale_or_rent', property_type: 'villa', price_amount: 250000, price_currency: 'USD', price_frequency: 'one_time', rent_price_amount: 1200, rent_price_currency: 'USD', rent_price_frequency: 'monthly', price_display: '$250,000', sale_price: '$250,000', rent_price: '$1,200/month', rent_period: 'month',
        province_en: 'Luang Prabang', province_lo: 'ຫຼວງພະບາງ', province_zh: '琅勃拉邦', district_en: 'Luang Prabang', district_lo: null, district_zh: null }),
];

function mockRest(page, opts) {
  opts = opts || {};
  const state = { calls: [], fail: !!opts.fail };
  page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};' }));
  page.route('**/unpkg.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  page.route('**/rest/v1/**', (r) => {
    const u = new URL(r.request().url());
    const t = u.pathname.replace(/^.*\/rest\/v1\//, '');
    state.calls.push(r.request().method() + ' ' + t);
    if (state.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
    const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') {
      const slug = (u.searchParams.get('slug') || '').replace(/^eq\./, '');
      if (slug) return json(ROWS.filter((x) => x.slug === slug));
      return json(ROWS);
    }
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
  return state;
}

module.exports = { PORT, ROWS, PARTY, CONTACT_LOCAL, CONTACT_INTL, CONTACT_THAI, mockRest };
