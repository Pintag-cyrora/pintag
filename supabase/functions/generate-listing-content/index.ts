import Anthropic from 'npm:@anthropic-ai/sdk';

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
    const data = await req.json();

    const client = new Anthropic({
      apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    });

    const nearbyNames = Array.isArray(data.nearby_places)
      ? data.nearby_places.map((p: { name_en?: string; name?: string }) => p.name_en || p.name || '').filter(Boolean)
      : [];

    const featuresList = Array.isArray(data.features) ? data.features.join(', ') : '';

    const prompt = `You are a professional real estate copywriter for Pintag, a premium real estate platform in Vientiane, Laos.

Generate listing content in THREE languages: Lao (lo), English (en), and Chinese (zh).

PROPERTY DETAILS:
- Type: ${data.property_type || 'not specified'}
- Style: ${data.property_style || 'not specified'}
- Transaction: ${data.transaction_type === 'for_rent' ? 'For Rent' : 'For Sale'}
- Bedrooms: ${data.bedrooms || 'not specified'}
- Bathrooms: ${data.bathrooms || 'not specified'}
- Building Size: ${data.sqm ? data.sqm + ' sqm' : 'not specified'}
- Land Size: ${data.sqm_land ? data.sqm_land + ' sqm' : 'not specified'}
- Price: ${data.price_display || 'on request'}
- Village: ${data.village || 'not specified'}
- District: ${data.district || 'not specified'}, Vientiane, Laos
- Features: ${featuresList || 'not specified'}
- Furnished: ${data.furnished || 'not specified'}
- Nearby Landmarks: ${nearbyNames.join(', ') || 'not specified'}

CONTENT RULES:

TITLES (max 80 characters each):
- Short and professional
- No excessive marketing language
- Mention the key selling point (location, style, or unique feature)

PROPERTY HIGHLIGHTS (exactly 1 sentence each):
- Emotional positioning
- Professional real estate tone
- No emojis, no exaggerated claims

NEIGHBORHOOD INSIGHTS (exactly 1 sentence each):
- Focus on: convenience, lifestyle, accessibility, schools, shopping, business districts, or transportation
- No marketing hype

DESCRIPTIONS (2–4 short paragraphs each):
- Professional real estate tone
- Natural flowing language
- No repetitive phrases
- Each paragraph separated by a newline

NEARBY LANDMARKS:
- Translate each landmark to official/common names in all 3 languages
- Use well-known local names for Lao, standard names for Chinese
- Return as separate arrays, one name per entry matching the input order

Return ONLY valid JSON in this exact format with no additional text:
{
  "title_lo": "",
  "title_en": "",
  "title_zh": "",
  "property_highlight_lo": "",
  "property_highlight_en": "",
  "property_highlight_zh": "",
  "neighborhood_insight_lo": "",
  "neighborhood_insight_en": "",
  "neighborhood_insight_zh": "",
  "description_lo": "",
  "description_en": "",
  "description_zh": "",
  "nearby_lo": [],
  "nearby_en": [],
  "nearby_zh": []
}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const textContent = message.content.find((c) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in AI response');
    }

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from AI response');
    }

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
