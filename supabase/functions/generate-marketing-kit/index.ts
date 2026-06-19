const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { listing } = await req.json();
    if (!listing) {
      return new Response(JSON.stringify({ error: 'Missing listing data' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Add it in Supabase Dashboard → Edge Functions → Manage secrets.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const title       = listing.title_en || listing.title_lo || 'Property';
    const district    = listing.district_en || listing.district || '';
    const village     = listing.village_en || listing.village || '';
    const propType    = listing.property_type || '';
    const listType    = listing.transaction_type === 'for_rent' ? 'For Rent' : 'For Sale';
    const price       = listing.price_display || 'Price on request';
    const bedrooms    = listing.bedrooms != null ? String(listing.bedrooms) : '';
    const bathrooms   = listing.bathrooms != null ? String(listing.bathrooms) : '';
    const buildSize   = listing.sqm != null ? listing.sqm + ' sqm' : (listing.building_size ? listing.building_size + ' sqm' : '');
    const landSize    = listing.sqm_land != null ? listing.sqm_land + ' sqm' : (listing.land_size ? listing.land_size + ' sqm' : '');
    const highlight   = listing.property_highlight_en || listing.property_highlight || '';
    const insight     = listing.neighborhood_insight_en || listing.neighborhood_insight || '';
    const slug        = listing.slug || '';
    const listingUrl  = `https://pintag.io/listing.html?slug=${slug}`;
    const location    = village ? `${village}, ${district}` : district;

    const specsLine = [
      bedrooms   ? `${bedrooms} Bedrooms`  : '',
      bathrooms  ? `${bathrooms} Bathrooms` : '',
      buildSize  ? `${buildSize} Building`  : '',
      landSize   ? `${landSize} Land`       : '',
    ].filter(Boolean).join(' · ');

    const prompt = `You are a professional real estate marketing copywriter for Pintag, a real estate platform in Vientiane, Laos.

Generate marketing content for the following property. Use ONLY the data provided — never invent or exaggerate facts. Draw from the Property Highlight and Neighborhood Insight as your primary source material.

PROPERTY DATA:
- Title: ${title}
- Type: ${propType} (${listType})
- Price: ${price}
- Location: ${location}, Vientiane, Laos
- Bedrooms: ${bedrooms || 'not specified'}
- Bathrooms: ${bathrooms || 'not specified'}
- Building Size: ${buildSize || 'not specified'}
- Land Size: ${landSize || 'not specified'}
- Property Highlight: ${highlight || 'not specified'}
- Neighborhood Insight: ${insight || 'not specified'}
- Listing URL: ${listingUrl}

TONE GUIDELINES:
- Professional but warm and conversational
- Emphasize lifestyle, comfort, and location advantages
- No exaggerated or unverifiable claims
- Optimized for the Laos real estate market

Generate ALL five marketing assets below.

Return ONLY valid JSON with no markdown fences and no extra text. Use this exact structure:

{
  "facebook_post": "🏡 ${title}\\n\\n[2-3 sentence property description based on the highlight]\\n\\n📍 Location: ${location}\\n🛏 ${bedrooms} Bedrooms\\n🛁 ${bathrooms} Bathrooms\\n\\n[1-2 sentence neighborhood insight]\\n\\nView full details:\\n${listingUrl}\\n\\n#Pintag #RealEstateLaos",
  "tiktok_caption": "🏡 ${title}\\n\\n📍 ${district}, Vientiane\\n\\n[1-2 short compelling sentences from the highlight]\\n\\nSee full details on Pintag.\\n\\n#vientianeproperty\\n#laosrealestate\\n#houseforrent\\n#pintag",
  "instagram_caption": "🏡 ${title}\\n\\n[2-3 sentence property description based on the highlight]\\n\\n📍 ${location}\\n🛏 ${bedrooms} Beds\\n🛁 ${bathrooms} Baths\\n\\n[1 sentence neighborhood insight]\\n\\nTap the link for full details.\\n\\n#pintag\\n#realestate\\n#laosproperty",
  "flyer": {
    "headline": "short punchy headline max 8 words",
    "subheadline": "one compelling sentence about this specific property",
    "property_highlight": "2-3 sentences describing the property for print use",
    "property_specifications": "${specsLine}",
    "neighborhood_insight": "1-2 sentences about the neighborhood and lifestyle",
    "call_to_action": "Contact us to schedule a viewing — pintag.io"
  },
  "video_script": {
    "slide_1": {"label": "Opening", "content": "${title}"},
    "slide_2": {"label": "Property Highlight", "content": "2-3 sentence highlight suitable for video text overlay"},
    "slide_3": {"label": "Property Details", "content": "${specsLine || 'See full details on Pintag'}"},
    "slide_4": {"label": "Neighborhood", "content": "1-2 sentences about the location and lifestyle for video"},
    "slide_5": {"label": "Price", "content": "${price}"},
    "slide_6": {"label": "Call To Action", "content": "Visit pintag.io to view full details and book a private viewing"}
  }
}

Replace the bracketed instructions with the actual generated content. Keep all emoji and formatting from the template.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.65 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const geminiData = await response.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No text content in Gemini response');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not extract JSON from Gemini response');

    const result = JSON.parse(jsonMatch[0]);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
