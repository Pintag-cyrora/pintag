// Shared harness for the contacts suite: boots the REAL listing.html against
// a stubbed supabase-js and a route-level REST fake for one property row.

const LISTING_STUB = `
window.supabase = { createClient: function() { return { auth: {
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
} }; } };
`;

const contact = (o) => Object.assign(
  { id: 'c1', role: 'agent', name: null, phone: '02011111111', whatsapp: null, is_verified: false, languages: null }, o);

const BASE = {
  id: 'p1', slug: 'multi', status: 'active', workflow_status: 'active', market_status: 'available',
  transaction_type: 'for_rent', property_type: 'apartment',
  title_en: 'Riverside', title_lo: 'Riverside', title_zh: 'Riverside',
  description_en: 'A place.', district_en: 'Sisattanak', village_en: 'Thongkang',
  images: [], features: [], amenities: [], parties: null, unit_types: [],
  price_amount: 500, price_currency: 'USD', price_frequency: 'monthly'
};

async function openListing(page, property, lang) {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: LISTING_STUB }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?slug=eq\./.test(u.toString()),
    r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([property]) }));
  await page.goto('/listing.html?slug=' + property.slug + '&lang=' + (lang || 'en'));
  await page.waitForSelector('.section-label', { timeout: 15000 });
  return errors;
}


module.exports = { LISTING_STUB, contact, BASE, openListing };
