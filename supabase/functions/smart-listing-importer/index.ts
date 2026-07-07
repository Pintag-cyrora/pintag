const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_IMAGES = 10;

// Only fetch images from trusted Supabase Storage domains.
// Allowing arbitrary URLs would let an attacker probe internal metadata
// endpoints (SSRF) or trigger unbounded outbound connections.
const ALLOWED_IMAGE_HOSTS = /^[a-z0-9-]+\.supabase\.co$/i;

const DISTRICTS = ['Sisattanak','Saysettha','Chanthabouly','Sikhottabong','Xaythany','Hadxaifong','Naxaithong'];

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
  // `parties` is publicly readable, so this check works with just the
  // caller's own token — no service-role key needed. Replaces the old
  // auth.email() === 'admin@pintag.io' string match with real data, same as
  // the is_pintag_staff() Postgres function used by RLS.
  const staffCheck = await fetch(
    `${supabaseUrl}/rest/v1/parties?auth_user_id=eq.${user.id}&type=eq.staff&select=id&limit=1`,
    { headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey } },
  );
  if (!staffCheck.ok) return 'Server misconfigured';
  const staffRows = await staffCheck.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) return 'Admin only';
  return null;
}

async function urlToBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) return null;
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
The description may be in Lao (ລາວ script), English, Thai, or a mix. Extract structured fields.
Use null for any field that cannot be reliably determined.

LANGUAGE RULES — follow exactly:
1. Lao script (Unicode U+0E80–U+0EFF) and Khmer script (U+1780–U+17FF) look visually similar but are completely different languages. Khmer is used in Cambodia, NOT Laos. If the text contains Khmer characters, do NOT treat them as Lao — identify the input language correctly.
2. All _lo output fields MUST be written in authentic Lao script (ພາສາລາວ). Never substitute Thai script, Khmer script, or romanised transliteration for Lao. If you are unsure, produce a proper Lao translation from the English.
3. price_display: preserve the original currency and number as written (₭ or LAK for Lao Kip, ฿ for Thai Baht, $ for USD). Example: "450,000,000 ₭" or "$1,500/month". Do not convert currencies.
4. title_lo and title_zh are REQUIRED — never return null for these fields. Always translate the English title into authentic Lao script and Simplified Chinese.

Valid districts (use exact spelling or null): ${DISTRICTS.join(', ')}
Valid property_type values: house, villa, apartment, townhouse, land, commercial
Valid property_style values: modern, luxury, minimalist, family, colonial, resort, investment
Valid transaction_type values: for_sale, for_rent
Valid furnished values: fully, partially, unfurnished

TASK C — EXTRACT BUYER CONTACT (best-effort, never guess a phone number):
If the description mentions who to contact (e.g. "call Somchai 020XXXXXXXX", "contact reception", "sales office: 020..."), extract:
- contact_name: the person's name, if mentioned, else null
- contact_phone: a phone/WhatsApp number exactly as written, only if one is actually present in the text — never fabricate one
- contact_role: one of exactly: owner, agent, property_manager, reception, sales_office, developer, family_representative, other — best guess from context, or null if unclear
This is only ever a suggestion — Pintag staff always confirms it in the admin form before the listing can be published.

PROPERTY DESCRIPTION:
"""
${description || '(no description provided)'}
"""
${photoTaskSection}

Return ONLY valid JSON with no extra text or markdown.
title_lo and title_zh must always be non-null strings (translate from the English title if needed).
Example of correct title format:
  "title": "Modern 4BR Pool Villa Near That Luang",
  "title_lo": "ວິລລ່າ 4 ຫ້ອງນອນພ້ອມສະລອຍນໍ້າໃກ້ທາດຫລວງ",
  "title_zh": "现代4卧室泳池别墅近塔銮"

{
  "title": "concise English title, max 80 chars",
  "title_lo": "Lao script translation of the title — REQUIRED, never null",
  "title_zh": "Simplified Chinese translation of the title — REQUIRED, never null",
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
  "description_en": "2–4 paragraphs of professional English property description",
  "description_lo": "2–4 paragraphs in authentic Lao script (ພາສາລາວ)",
  "description_zh": "2–4 paragraphs in Simplified Chinese (中文)",
  "property_highlight_en": "One compelling sentence in English",
  "property_highlight_lo": "One compelling sentence in authentic Lao script",
  "property_highlight_zh": "One compelling sentence in Simplified Chinese",
  "neighborhood_insight_en": "One sentence about the neighbourhood in English",
  "neighborhood_insight_lo": "One sentence in authentic Lao script",
  "neighborhood_insight_zh": "One sentence in Simplified Chinese",
  "contact_name": null,
  "contact_phone": null,
  "contact_role": null,
  ${photoJsonSection}
}`;
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

    const RETRY_DELAYS = [2000, 5000, 10000];

    let response: Response;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [...imageParts, textPart] }],
            generationConfig: { maxOutputTokens: 4000, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
          }),
        }
      );

      if (response.ok) break;

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < RETRY_DELAYS.length
      ) {
        console.log(`Gemini ${response.status}, retry ${attempt + 1}/${RETRY_DELAYS.length}`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }

      const errText = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const geminiData = await response.json();
    const candidateCount = geminiData.candidates?.length ?? 0;
    const finishReason = geminiData.candidates?.[0]?.finishReason ?? 'unknown';
    console.log(`Gemini candidates: ${candidateCount}, finishReason: ${finishReason}`);

    const text = geminiData.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || '')
      .join('');
    if (!text) {
      throw new Error(`No text content in Gemini response (candidates: ${candidateCount}, finishReason: ${finishReason})`);
    }

    console.log(`Gemini response length: ${text.length} chars`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON object found in Gemini response. Response starts with: ${text.slice(0, 100)}`);
    }

    const extracted = jsonMatch[0];
    if (!extracted.trimEnd().endsWith('}')) {
      throw new Error(`Gemini returned incomplete JSON (likely token limit exceeded). Response length: ${text.length} chars, finishReason: ${finishReason}`);
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(extracted);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`JSON parse failed (${msg}). Response length: ${text.length} chars, finishReason: ${finishReason}`);
    }

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
