const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function requireAdmin(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return 'Server misconfigured';
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return 'Missing auth token';
  const token = auth.slice(7);
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey },
  });
  if (!r.ok) return 'Invalid token';
  const user = await r.json();
  if (!user?.id) return 'Invalid token';
  // Authorization boundary: the is_pintag_admin() Postgres function (the single
  // admin allowlist, admin_accounts — cyrora.trading@gmail.com today). It is
  // SECURITY DEFINER and granted to authenticated, so the caller's own token
  // resolves it. Replaces the legacy hardcoded-admin-email check; fails CLOSED
  // (denies) on any error.
  const adminCheck = await fetch(`${supabaseUrl}/rest/v1/rpc/is_pintag_admin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_uid: user.id }),
  });
  if (!adminCheck.ok) return 'Server misconfigured';
  if ((await adminCheck.json()) !== true) return 'Admin only';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authErr = await requireAdmin(req);
  if (authErr) {
    return new Response(JSON.stringify({ error: authErr }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const data = await req.json();

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Add it in Supabase Dashboard → Edge Functions → Manage secrets.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nearbyNames = Array.isArray(data.nearby_places)
      ? data.nearby_places.map((p: { name_en?: string; name?: string }) => p.name_en || p.name || '').filter(Boolean)
      : [];

    const featuresList = Array.isArray(data.features) ? data.features.join(', ') : '';

    // Only ever present for a rental listing with a deposit actually
    // entered (admin.html sends null otherwise) — the prompt below only
    // instructs mentioning it when this line exists at all, matching
    // "included when appropriate" rather than forcing it into every
    // description regardless of transaction type.
    const depositLine = data.deposit_text ? `\n- Deposit: ${data.deposit_text}` : '';

    // Every other Rental Term (cleaning deposit, electricity, water,
    // internet, cleaning/sheet-changing frequency, laundry, included
    // services, additional fees, lease length, pet policy, smoking policy,
    // parking) — admin.html sends one pre-formatted "key: value; key: value"
    // string built from whichever fields are actually set (rental-terms.js's
    // own formatter), never null-padded. Same "only mention if present"
    // rule as deposit below.
    const rentalTermsLine = data.rental_terms_summary ? `\n- Other Rental Terms: ${data.rental_terms_summary}` : '';

    // Recovery use: a surviving title (e.g. the Lao title from the removal log)
    // to base the new Pintag-quality titles on — improve it, keep the meaning,
    // do not copy verbatim. Optional; absent for normal Smart Import.
    const existingTitleLine = data.existing_title ? `\n- Existing/source title (base the NEW titles on this — keep its meaning, upgrade it to Pintag quality, do not copy verbatim): ${data.existing_title}` : '';

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
- Furnished: ${data.furnished || 'not specified'}${depositLine}${rentalTermsLine}
- Nearby Landmarks: ${nearbyNames.join(', ') || 'not specified'}${existingTitleLine}

CONTENT RULES:

TITLES (max 80 characters each):
- Short and professional
- No excessive marketing language
- Mention the key selling point (location, style, or unique feature)
- If an Existing/source title is provided above, produce polished Pintag-quality
  titles consistent with its meaning in all three languages (do not copy it verbatim)

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
- If a Deposit is listed in PROPERTY DETAILS above, mention it naturally
  in the description (e.g. as part of the rental terms), in all three
  languages. If no Deposit line is present, do not mention a deposit at
  all — never invent or estimate one.
- If "Other Rental Terms" is listed above, naturally weave in whichever of
  those are most relevant (e.g. pet policy, included utilities, parking) as
  part of describing the rental terms, in all three languages — do not
  simply list every field verbatim, and never mention a rental term that
  isn't present in PROPERTY DETAILS.

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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1500, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
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
