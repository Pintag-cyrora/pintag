// smart-listing-importer — the AI ENRICHMENT stage of Smart Import's
// ingestion pipeline: Source -> Adapter -> ImportResult -> AI Enrichment
// -> Validation -> Populate Form. This function never knows or cares which
// adapter produced its input (Facebook OG fetch, manual paste, and future
// PDF/OCR/portal/email adapters all call it the same way) — its only job
// is turning raw { description, image_urls } into the canonical,
// confidence-tagged ImportResult every adapter ultimately feeds:
//
//   interface FieldValue<T> { value: T | null; confidence: number }  // 0..1
//
//   interface ImportImage {
//     originalUrl?: string; storageUrl?: string;
//     width?: number; height?: number;   // reserved, not populated yet
//     primary?: boolean; source: string;
//     roomType?: string; qualityScore?: number;  // from this stage's own photo analysis
//   }
//
//   interface ImportResult {
//     source: string;  // the ORIGINATING adapter, passed through from the request
//     // Generated/translated prose — Gemini AUTHORS these; there's no
//     // single "correct" answer to be uncertain about, so no confidence.
//     title, title_lo, title_zh: string;
//     description_en, description_lo, description_zh: string;
//     property_highlight_en/lo/zh, neighborhood_insight_en/lo/zh: string;
//     // Factual/extracted fields — Gemini INFERS these, so its own
//     // uncertainty is exactly the signal staff should see. Each is a
//     // FieldValue so the UI can flag low-confidence values instead of
//     // blindly trusting them.
//     transaction_type, property_type, property_style, price_display,
//     bedrooms, bathrooms, sqm, sqm_land, furnished: FieldValue<...>;
//     location: { district: FieldValue<string>, village: FieldValue<string> };
//     contact: { name: FieldValue<string>, phone: FieldValue<string>, role: FieldValue<string> };
//     images: ImportImage[];       // merged from the request's image_urls + photo analysis
//     recommended_order: number[];
//     metadata: { source, enrichedAt };
//   }
//
// Type-specific sub-fields (e.g. Land's road_surface, House's floors) are
// deliberately NOT confidence-tagged in this pass — this covers the common,
// most decision-relevant fields across every property type; the same
// pattern extends to more fields later without changing this contract.

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

CONFIDENCE-TAGGED FIELDS — every field listed below under "CONFIDENCE-TAGGED SCHEMA" must be
returned as an object {"value": <the value, or null>, "confidence": <number 0.0-1.0>}, not a bare value.
Confidence guidance:
- 1.0 = explicitly and unambiguously stated in the text (or, for photo-derived fields, clearly visible)
- 0.5-0.8 = reasonably inferred but not explicitly stated (e.g. guessed from context or a photo)
- below 0.5 = a rough guess, or the source text was ambiguous or self-contradictory
- confidence 0 when value is null (nothing found) — do not return high confidence for a null value
Never inflate confidence to seem helpful — an honest low score is more useful to a human reviewer than false certainty.

Use null for any value that cannot be reliably determined — even inside a confidence-tagged object.

LANGUAGE RULES — follow exactly:
1. Lao script (Unicode U+0E80–U+0EFF) and Khmer script (U+1780–U+17FF) look visually similar but are completely different languages. Khmer is used in Cambodia, NOT Laos. If the text contains Khmer characters, do NOT treat them as Lao — identify the input language correctly.
2. All _lo output fields MUST be written in authentic Lao script (ພາສາລາວ). Never substitute Thai script, Khmer script, or romanised transliteration for Lao. If you are unsure, produce a proper Lao translation from the English.
3. price_display.value: preserve the original currency and number as written (₭ or LAK for Lao Kip, ฿ for Thai Baht, $ for USD). Example: "450,000,000 ₭" or "$1,500/month". Do not convert currencies.
4. title_lo and title_zh are REQUIRED — never return null for these fields. Always translate the English title into authentic Lao script and Simplified Chinese.

Valid districts (use exact spelling or null): ${DISTRICTS.join(', ')}
Valid property_type values: house, villa, apartment, townhouse, land, commercial
Valid property_style values: modern, luxury, minimalist, family, colonial, resort, investment
Valid transaction_type values: for_sale, for_rent
Valid furnished values: fully, partially, unfurnished

TASK C — EXTRACT BUYER CONTACT (best-effort, never guess a phone number):
If the description mentions who to contact (e.g. "call Somchai 020XXXXXXXX", "contact reception", "sales office: 020..."), extract into the confidence-tagged schema below:
- contact_name.value: the person's name, if mentioned, else null
- contact_phone.value: a phone/WhatsApp number exactly as written, only if one is actually present in the text — never fabricate one (confidence 0 if null)
- contact_role.value: one of exactly: owner, agent, property_manager, reception, sales_office, developer, family_representative, other — best guess from context, or null if unclear
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

Example of a correct confidence-tagged field:
  "bedrooms": {"value": 4, "confidence": 0.95}
  "village": {"value": null, "confidence": 0}

Every field from "transaction_type" through "contact_role" in the schema below is
confidence-tagged ({value, confidence}) — the title/description/highlight/insight
fields above them are plain strings, not confidence-tagged.

{
  "title": "concise English title, max 80 chars",
  "title_lo": "Lao script translation of the title — REQUIRED, never null",
  "title_zh": "Simplified Chinese translation of the title — REQUIRED, never null",
  "description_en": "2–4 paragraphs of professional English property description",
  "description_lo": "2–4 paragraphs in authentic Lao script (ພາສາລາວ)",
  "description_zh": "2–4 paragraphs in Simplified Chinese (中文)",
  "property_highlight_en": "One compelling sentence in English",
  "property_highlight_lo": "One compelling sentence in authentic Lao script",
  "property_highlight_zh": "One compelling sentence in Simplified Chinese",
  "neighborhood_insight_en": "One sentence about the neighbourhood in English",
  "neighborhood_insight_lo": "One sentence in authentic Lao script",
  "neighborhood_insight_zh": "One sentence in Simplified Chinese",

  "transaction_type": {"value": "for_sale", "confidence": 0},
  "property_type": {"value": "villa", "confidence": 0},
  "property_style": {"value": null, "confidence": 0},
  "price_display": {"value": null, "confidence": 0},
  "bedrooms": {"value": null, "confidence": 0},
  "bathrooms": {"value": null, "confidence": 0},
  "sqm": {"value": null, "confidence": 0},
  "sqm_land": {"value": null, "confidence": 0},
  "district": {"value": null, "confidence": 0},
  "village": {"value": null, "confidence": 0},
  "furnished": {"value": null, "confidence": 0},
  "contact_name": {"value": null, "confidence": 0},
  "contact_phone": {"value": null, "confidence": 0},
  "contact_role": {"value": null, "confidence": 0},

  ${photoJsonSection}
}`;
}

interface FieldValue<T> { value: T | null; confidence: number }

// Gemini is asked to return {value, confidence} for factual fields, but LLM
// output isn't a guaranteed contract — normalize defensively rather than
// letting one malformed field break the whole response. A bare value that
// slipped through ungrouped gets confidence 0.5 (present, but Gemini didn't
// self-report certainty) rather than being discarded.
function normalizeFieldValue<T>(raw: unknown): FieldValue<T> {
  if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    const obj = raw as { value: T | null; confidence?: unknown };
    const confidence = typeof obj.confidence === 'number'
      ? Math.max(0, Math.min(1, obj.confidence))
      : (obj.value == null ? 0 : 0.5);
    return { value: obj.value ?? null, confidence };
  }
  const value = (raw ?? null) as T | null;
  return { value, confidence: value == null ? 0 : 0.5 };
}

const CONFIDENCE_FIELDS = [
  'transaction_type', 'property_type', 'property_style', 'price_display',
  'bedrooms', 'bathrooms', 'sqm', 'sqm_land', 'furnished',
] as const;

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
    const { description, image_urls, source } = await req.json();
    const importSource: string = typeof source === 'string' && source ? source : 'manual';

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

    // Assemble the canonical ImportResult — see the file-level comment for
    // the full shape. Generated prose passes through as-is; factual fields
    // get normalized into {value, confidence}; location/contact are
    // nested; images are rebuilt from the request's image_urls merged with
    // this stage's own photo analysis (room type, quality, hero pick).
    const enriched: Record<string, unknown> = {
      source: importSource,
      title: result.title ?? null,
      title_lo: result.title_lo ?? null,
      title_zh: result.title_zh ?? null,
      description_en: result.description_en ?? null,
      description_lo: result.description_lo ?? null,
      description_zh: result.description_zh ?? null,
      property_highlight_en: result.property_highlight_en ?? null,
      property_highlight_lo: result.property_highlight_lo ?? null,
      property_highlight_zh: result.property_highlight_zh ?? null,
      neighborhood_insight_en: result.neighborhood_insight_en ?? null,
      neighborhood_insight_lo: result.neighborhood_insight_lo ?? null,
      neighborhood_insight_zh: result.neighborhood_insight_zh ?? null,
    };

    for (const field of CONFIDENCE_FIELDS) {
      enriched[field] = normalizeFieldValue(result[field]);
    }

    enriched.location = {
      district: normalizeFieldValue<string>(result.district),
      village: normalizeFieldValue<string>(result.village),
    };
    enriched.contact = {
      name: normalizeFieldValue<string>(result.contact_name),
      phone: normalizeFieldValue<string>(result.contact_phone),
      role: normalizeFieldValue<string>(result.contact_role),
    };

    const photoAnalysis = Array.isArray(result.photo_analysis)
      ? result.photo_analysis as Array<{ index: number; room_type?: string; quality_score?: number }>
      : [];
    const heroIndex = typeof result.hero_index === 'number' ? result.hero_index : 0;
    enriched.images = urlsToFetch.map((url, i) => {
      const analysis = photoAnalysis.find(p => p.index === i);
      return {
        storageUrl: url,
        primary: i === heroIndex,
        source: importSource,
        roomType: analysis?.room_type,
        qualityScore: analysis?.quality_score,
      };
    });
    enriched.recommended_order = Array.isArray(result.recommended_order) ? result.recommended_order : [];
    enriched.metadata = { source: importSource, enrichedAt: new Date().toISOString() };

    return new Response(JSON.stringify(enriched), {
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
