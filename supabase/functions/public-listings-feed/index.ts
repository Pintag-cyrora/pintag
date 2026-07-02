// Read-only, aggregated listings feed for the Pintag Marketing AI system
// (pintag-studio, a separate repo/system — see its ARCHITECTURE.md Section 1).
//
// This is the one intentional hybrid touchpoint between the two systems: it
// lets the marketing pipeline ground content in real listing data without
// ever holding direct database credentials for this (production) project.
//
// It exposes nothing that isn't already public via listings.html's own
// anon-key REST query (`status.neq.draft,status.is.null`) — this function
// just shapes the response to an explicit field allowlist so an unrelated
// future column addition to `properties` can't accidentally leak through.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Explicit allowlist — only fields that are already shown publicly on
// listings.html / listing.html. Never add agent contact details, internal
// notes, or anything not already customer-facing.
const PUBLIC_FIELDS = [
  'slug', 'title_en', 'title_lo', 'title_zh',
  'property_type', 'property_style', 'transaction_type',
  'sale_price', 'rent_price', 'rent_period',
  'district', 'district_en', 'district_lo', 'district_zh', 'village',
  'bedrooms', 'bathrooms', 'sqm', 'sqm_land', 'furnished',
  'property_highlight_en', 'property_highlight_lo', 'property_highlight_zh',
  'neighborhood_insight_en', 'neighborhood_insight_lo', 'neighborhood_insight_zh',
  'images', 'is_featured', 'created_at',
].join(',');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Server misconfigured');
    }

    const url = new URL(req.url);
    const district = url.searchParams.get('district');
    const propertyType = url.searchParams.get('property_type');
    const transactionType = url.searchParams.get('transaction_type');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);

    const params = new URLSearchParams();
    params.set('select', PUBLIC_FIELDS);
    params.set('or', '(status.neq.draft,status.is.null)');
    if (district) params.set('district', `eq.${district}`);
    if (propertyType) params.set('property_type', `eq.${propertyType}`);
    if (transactionType) params.set('transaction_type', `eq.${transactionType}`);
    params.set('order', 'created_at.desc');
    params.set('limit', String(limit));

    const res = await fetch(`${supabaseUrl}/rest/v1/properties?${params.toString()}`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Upstream query failed: ${res.status}`);
    }

    const listings = await res.json();

    return new Response(JSON.stringify({ listings }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
