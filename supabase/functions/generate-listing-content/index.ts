const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// AAL2 (MFA) enforcement — L1 baseline. The claim is read from a token that
// /auth/v1/user has ALREADY validated server-side (same literal string), so
// decoding without re-verifying the signature is sound here. A session that
// has not completed TOTP carries aal='aal1'. Fail closed: parse failure = aal1.
function tokenAal(token: string): string {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload.aal === 'string' ? payload.aal : 'aal1';
  } catch {
    return 'aal1';
  }
}

async function requireAdmin(req: Request): Promise<{ error: string; status: number } | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return { error: 'Server misconfigured', status: 500 };
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { error: 'Missing auth token', status: 401 };
  const token = auth.slice(7);
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey },
  });
  if (!r.ok) return { error: 'Invalid token', status: 401 };
  const user = await r.json();
  if (!user?.id) return { error: 'Invalid token', status: 401 };
  // MFA gate (defense in depth: is_pintag_admin() below ALSO enforces
  // aal2 in the database since 20260806010000). 403 + structured security
  // log, never perform the operation.
  if (tokenAal(token) !== 'aal2') {
    console.error(JSON.stringify({ security_event: 'aal2_required', fn: 'generate-listing-content', user: user.id, at: new Date().toISOString() }));
    return { error: 'MFA required', status: 403 };
  }
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
  if (!adminCheck.ok) return { error: 'Server misconfigured', status: 500 };
  if ((await adminCheck.json()) !== true) {
    console.error(JSON.stringify({ security_event: 'admin_denied', fn: 'generate-listing-content', user: user.id, at: new Date().toISOString() }));
    return { error: 'Admin only', status: 403 };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authErr = await requireAdmin(req);
  if (authErr) {
    return new Response(JSON.stringify({ error: authErr.error }), {
      status: authErr.status,
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
- District: ${data.district || 'not specified'}
- City/Province: ${data.province || 'Vientiane'}, Laos
- Features: ${featuresList || 'not specified'}
- Furnished: ${data.furnished || 'not specified'}${depositLine}${rentalTermsLine}
- Nearby Landmarks: ${nearbyNames.join(', ') || 'not specified'}${existingTitleLine}

CONTENT RULES:

TITLES (max 80 characters each):
- Short and professional
- No excessive marketing language
- Lead with the key selling point (style, or a unique feature)
- LOCATION IS REQUIRED. End the title with " in <Village>, <District>, <City>",
  skipping any level that is "not specified" — village first when there is one,
  district and city otherwise. A reader must know WHERE the property is from
  the title alone, because the title is the only line that travels into a
  shared link's preview.
- A DISTRICT IS NOT A VILLAGE. Sisattanak, Saysettha, Chanthabouly,
  Sikhottabong, Xaythany, Hadxaifong and Naxaithong are DISTRICTS. Never
  present one as a village, and never invent a village from a district name.
- Do NOT repeat a location that is already in the title.
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

    // gemini-3.1-flash-lite, not gemini-2.5-flash: the Free-Tier Gemini project
    // behind GEMINI_API_KEY 404s on gemini-2.5-flash ("no longer available to
    // new users") — the same failure smart-listing-importer and
    // generate-intelligence-report hit and moved off of. Keep this in sync
    // with those two if the model ever changes again.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
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
