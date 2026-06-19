const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_IMAGES = 10;

const DISTRICTS = ['Sisattanak','Saysettha','Chanthabouly','Sikhottabong','Xaythany','Hadxaifong','Naxaithong'];

async function urlToBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const binary = bytes.reduce((acc, b) => acc + String.fromCharCode(b), '');
    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return { mimeType, data: btoa(binary) };
  } catch {
    return null;
  }
}

function buildPrompt(description: string, imageCount: number): string {
  const photoSection = imageCount > 0
    ? `\nYou have also received ${imageCount} property photo(s) numbered by their position in the request (index 0 through ${imageCount - 1}).`
    : '\nNo photos were provided.';

  const photoTaskSection = imageCount > 0
    ? `
TASK B — ANALYZE PHOTOS:
For each photo (index 0 through ${imageCount - 1}), determine:
- room_type: one of exactly: exterior, living_room, kitchen, dining_room, bedroom, bathroom, pool, garden, balcony, other
- quality_score: 1–5 (5 = best composition, lighting, and clarity)

Then determine:
- hero_index: the single best cover photo index (prefer bright exterior with pool or garden, or impressive living room)
- recommended_order: array of ALL image indices in professional gallery sequence
  Rule: hero first, then remaining exteriors, living/dining areas, kitchen, bedrooms, bathrooms, pool/garden/balcony, other`
    : `
TASK B — PHOTOS:
No photos provided. Return empty arrays.`;

  const photoJsonSection = imageCount > 0
    ? `  "photo_analysis": [{ "index": 0, "room_type": "exterior", "quality_score": 4 }],
  "hero_index": 0,
  "recommended_order": [0, 1, 2]`
    : `  "photo_analysis": [],
  "hero_index": 0,
  "recommended_order": []`;

  return `You are a real estate data extraction AI for Pintag, a premium real estate platform in Vientiane, Laos.${photoSection}

TASK A — EXTRACT from the property description below.
The description may be in Lao, English, Thai, or a mix. Extract structured fields.
Use null for any field that cannot be reliably determined.

Valid districts (use exact spelling or null): ${DISTRICTS.join(', ')}
Valid property_type values: house, villa, apartment, townhouse, land, commercial
Valid property_style values: modern, luxury, minimalist, family, colonial, resort, investment
Valid transaction_type values: for_sale, for_rent
Valid furnished values: fully, partially, unfurnished

PROPERTY DESCRIPTION:
"""
${description || '(no description provided)'}
"""
${photoTaskSection}

Return ONLY valid JSON with no extra text or markdown:
{
  "title": "concise English title max 80 chars",
  "transaction_type": "for_sale",
  "property_type": "villa",
  "property_style": null,
  "price_display": null,
  "bedrooms": null,
  "bathrooms": null,
  "sqm": null,
  "sqm_land": null,
  "district": null,
  "village": null,
  "furnished": null,
  "description_en": "2–4 paragraph professional English description",
  "description_lo": "Lao translation",
  "description_zh": "Chinese translation",
  "property_highlight_en": "One emotional sentence in English",
  "property_highlight_lo": "One emotional sentence in Lao",
  "property_highlight_zh": "One emotional sentence in Chinese",
  "neighborhood_insight_en": "One sentence about the area in English",
  "neighborhood_insight_lo": "Lao translation",
  "neighborhood_insight_zh": "Chinese translation",
  ${photoJsonSection}
}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { description, image_urls } = await req.json();

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Add it in Supabase Dashboard → Edge Functions → Manage secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const urlsToFetch: string[] = Array.isArray(image_urls) ? image_urls.slice(0, MAX_IMAGES) : [];
    const imageResults = await Promise.all(urlsToFetch.map(url => urlToBase64(url)));
    const validImages = imageResults.filter((r): r is NonNullable<typeof r> => r !== null);

    const imageParts = validImages.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.data }
    }));
    const textPart = { text: buildPrompt(description || '', validImages.length) };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [...imageParts, textPart] }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.4 },
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
    if (!jsonMatch) throw new Error('Could not parse JSON from Gemini response');

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
