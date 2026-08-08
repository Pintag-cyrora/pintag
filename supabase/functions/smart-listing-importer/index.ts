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
//     images: ImportImage[];       // CANONICAL, already in recommended display
//                                  // order (hero first) — consumers read this
//                                  // directly and never need recommended_order
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
    console.error(JSON.stringify({ security_event: 'aal2_required', fn: 'smart-listing-importer', user: user.id, at: new Date().toISOString() }));
    return { error: 'MFA required', status: 403 };
  }
  // Authorization boundary: the is_pintag_admin() Postgres function (the single
  // admin allowlist, admin_accounts — cyrora.trading@gmail.com today). It is
  // SECURITY DEFINER and granted to authenticated, so the caller's own token
  // resolves it. Replaces the retired parties.type='staff' lookup (the staff
  // model is gone; is_pintag_admin() is now the one server boundary used by RLS,
  // storage, and every admin edge function). Fails CLOSED (denies) on any error.
  const adminCheck = await fetch(`${supabaseUrl}/rest/v1/rpc/is_pintag_admin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_uid: user.id }),
  });
  if (!adminCheck.ok) return { error: 'Server misconfigured', status: 500 };
  if ((await adminCheck.json()) !== true) {
    console.error(JSON.stringify({ security_event: 'admin_denied', fn: 'smart-listing-importer', user: user.id, at: new Date().toISOString() }));
    return { error: 'Admin only', status: 403 };
  }
  return null;
}

// Cap what a single "image" fetch may pull into memory. Storage images are
// a few MB; anything larger is not a listing photo.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

async function urlToBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    // Re-validate the FINAL host after any redirect, and require an image
    // content type + bounded size — the full SSRF checklist even though the
    // input allowlist is already our own storage domain.
    const finalUrl = new URL(res.url || url);
    if (finalUrl.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.test(finalUrl.hostname)) return null;
    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!mimeType.startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length') || '0');
    if (declared > MAX_IMAGE_BYTES) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(buffer);
    const binary = bytes.reduce((acc, b) => acc + String.fromCharCode(b), '');
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
TASK B — ANALYZE THE PHOTOS (you can see them; describe only what is actually visible).
First, OBSERVE the property across ALL photos and let it inform TASK A and the title/description — note what you can genuinely see:
- property-type cues (villa, house, apartment, townhouse, land, commercial)
- rooms visibly present, and how many of each (living, dining, kitchen, bedrooms, bathrooms) — count only what is actually shown
- kitchen and living areas, and built-in fixtures
- furniture and appliances actually pictured (e.g. sofa, dining set, bed, wardrobe, refrigerator, air-conditioning unit, water heater, stove)
- amenities and outdoor features (swimming pool, garden, parking/carport, balcony, gate, fence, rooftop)
- visible condition and finish (newly built, renovated, tiled/wood/polished floors, freshly painted, or bare/unfinished/needs work)
- any notable feature a buyer would care about (view, natural light, high ceilings, land plot)
Use these observations as evidence for the fields, title, highlight, and description. Do NOT list furniture/appliances mechanically — weave the genuinely notable ones in naturally.

Then, for each photo (index 0 through ${imageCount - 1}), determine:
- room_type: one of exactly: exterior, living_room, kitchen, dining_room, bedroom, bathroom, pool, garden, balcony, other
- quality_score: 1–5 (5 = best composition, lighting, and clarity)

Then determine:
- hero_index: the single best cover photo index (prefer bright exterior with pool or garden, or impressive living room)
- recommended_order: array of ALL image indices in professional gallery sequence
  Rule: hero first, then remaining exteriors, living/dining areas, kitchen, bedrooms, bathrooms, pool/garden/balcony, other`
    : `
TASK B — PHOTOS:
No photos provided. Base everything on the description text only; do not describe any visual detail. Return empty arrays.`;

  const photoJsonSection = imageCount > 0
    ? `  "photo_analysis": [{ "index": 0, "room_type": "exterior", "quality_score": 4 }],
  "hero_index": 0,
  "recommended_order": [0, 1, 2]`
    : `  "photo_analysis": [],
  "hero_index": 0,
  "recommended_order": []`;

  return `You are a real estate analyst for Pintag, a premium real estate platform in Vientiane, Laos. You can SEE the property photos included in this request — look at them and analyze what they actually show.${photoSection}

METHOD (applies to every field, title, and description you produce):
  photos + description + supplied structured data  →  visual analysis  →  evidence-grounded draft
Ground everything in ACTUAL EVIDENCE — what is visible in the photos, what the description states, and any values supplied in a "Known details:" line. Prefer concrete, verifiable detail over generic marketing language, and never assert anything the evidence does not support.

TASK A — DETERMINE the structured fields from ALL the evidence (the photos AND the description text below).
The description may be in Lao (ລາວ script), English, Thai, a mix, or empty. When the text is sparse or empty, rely on what is CLEARLY VISIBLE in the photos. Extract structured fields.

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

EVIDENCE & HONESTY RULES (do not violate):
- State ONLY what is supported by a photo or by the description text. NEVER invent rooms, bedrooms/bathrooms, amenities, a pool, a finish, sizes, or a price that are not visibly shown and not stated.
- A field MAY be filled from clearly-visible photo evidence when the text does not state it — set a confidence that reflects how certain the visual evidence is. If neither the photos nor the text support a value, return null with confidence 0. Do not guess numbers (bedrooms, bathrooms, sizes, price) beyond what the evidence supports.
- Absence is not evidence: if something simply is not photographed, that is NOT proof it is missing — do not claim its absence.
- LEASE-DURATION PRICING: the text may include a "Lease-duration pricing" line listing rates for specific commitments (e.g. 3 / 6 / 12 months), each marked as per-month or as a whole-lease total. You MAY state those exact rates in the description. You must NEVER invent, calculate, interpolate, or estimate a rate for a duration that is not listed, never convert a monthly rate into a total (or vice versa) yourself, and never present a discount/total you were not given. If no lease-duration pricing is provided, do not mention lease-duration rates at all.

CONFLICT DETECTION (flag, never silently "correct"):
- The description may include a "Known details:" line — values SUPPLIED by staff. If the photos CLEARLY contradict a supplied value (e.g. it says "5 bedroom" but the photos show a single studio room; or "with pool" but the photos positively show there is no pool where one would be), then:
  * KEEP the supplied value in the field (do NOT overwrite it from the photos), and
  * add an entry to "photo_conflicts" describing the discrepancy.
- Only flag a conflict when the photo evidence is CLEAR and positive — never on mere absence. "photo_conflicts" is an empty array [] when there is no clear contradiction.

DIFFERENTIATION & DISTINCT PURPOSES (read this BEFORE writing the title, highlight, and neighbourhood insight):
- FIRST, identify the strongest property-specific evidence actually supported by the photos or supplied data — e.g. high ceilings, a private pool, a large garden, multiple living areas, a modern kitchen, a panoramic view, distinctive architecture, fully furnished, newly renovated, unusually large bedrooms. Use ONLY features the evidence genuinely supports; never invent.
- The title, the property highlight, and the neighbourhood insight each have a DIFFERENT job and must NOT repeat the same sentence or concept:
  * TITLE = the property's recognizable identity (its 1–3 strongest differentiators).
  * PROPERTY HIGHLIGHT = a DISTINCT visual/functional selling strength or benefit — NOT a restatement of the title.
  * NEIGHBORHOOD INSIGHT = location ONLY (village, district, and verified nearby places) — never property features.
- Do NOT repeat the same concept across the title and the highlight. Do NOT put property features into the neighbourhood insight. Do NOT use the photos to invent neighbourhood facts.

TITLE — the single most important field. Make THIS property recognizable, not a template.
- The PHOTOS are your PRIMARY source for what makes this property distinctive. From the photos + any description + supplied fields, pick the 1–3 STRONGEST property-specific characteristics that are actually supported (e.g. modern furnished interior, private garden, swimming pool, 3 bedrooms, large living room, brand-new finish, river view).
- A "Current listing title" may be provided in the text above — treat it as a CLUE, not as truth:
  * If the photos reveal stronger, more specific characteristics, IMPROVE the title to reflect them.
  * If the current title is already specific and clearly accurate, PRESERVE its useful information — do NOT rewrite a good title just for variation.
  * Do NOT assume the current title is accurate beyond what it says, and do NOT invent anything to "beat" it.
  * Do NOT return it unchanged if it is generic (e.g. "House for Rent in <District>") — rebuild it from real, supported features.
- Location (district) is SUPPORTING context at most — never the whole title. A title that only names type + transaction + district is a FAILURE.
- Use only features the evidence supports. Never invent. Keep it natural (about 5–10 words); do NOT keyword-stuff — two well-chosen differentiators beat five.
- Two different properties must produce two different titles.
- Only if the photos show nothing distinctive AND the text is sparse: fall back to the clearest supported detail (type + one real field), still avoiding the bare district template.
Example — Current listing title "House for Rent in Sisattanak"; photos show a modern furnished interior, large living room, private garden, and 3 bedrooms → a strong title is "Modern 3-Bedroom Home with Private Garden" (the district moves into the description as supporting context, not the title).

PROPERTY HIGHLIGHT — sell ONE strong quality; do not echo the title.
- Its job is to sell the property's strongest VISUAL or FUNCTIONAL quality, or the concrete benefit it gives the resident, grounded ONLY in evidence from the photos or supplied data.
- It must NOT simply restate the title. If the title already uses the single strongest differentiator, the highlight leads with a DIFFERENT supported strength, or explains the benefit of that feature rather than naming it again.
- Maximum 160 characters. NEVER pad to reach the limit — prefer roughly 90–140 characters when that is enough; a shorter honest sentence beats a padded one.
- Only features the evidence supports; no filler, no invented qualities.
- Example — title "Modern 3-Bedroom Home with Private Garden" → a good highlight leads elsewhere, e.g. "Sunlit open-plan living flows onto a covered terrace, with a fully fitted kitchen and secure off-street parking." (it does NOT repeat "modern 3-bedroom home with private garden").

DESCRIPTIONS — generate from the ACTUAL photos plus the available data (the current-title clue, the structured fields, and any description text). When there is little or no description, WRITE the description from what the photos genuinely show plus the supported fields — never leave it thin, and never invent. Lead with the genuinely notable, verifiable features; weave in location and supported details naturally; state only what the evidence supports.

NEIGHBORHOOD INSIGHT — anchor on the VILLAGE, and ground it in facts, not filler.
- The VILLAGE is the primary geographic anchor; the district and city are only supporting context. If a "Neighbourhood" block with a village is provided in the text, build the insight around THAT village — never write something that could apply to any village in Vientiane.
- Use ONLY the location facts actually provided: the village, the district, the city, and the operator-provided nearby landmarks (and only the distances given). Do NOT manufacture schools, markets, hospitals, roads, cafes, businesses, landmarks, distances, or travel times that were not provided.
- SEPARATE property from neighbourhood: the PHOTOS describe the PROPERTY; the neighbourhood insight is driven by the VILLAGE / district / provided landmarks, NOT by the photos.
- Write what a real renter/buyer would actually want to know about THIS location — practical convenience, what is genuinely nearby (from the provided landmarks), residential-vs-commercial character IF supported. This is not SEO writing.
- Do NOT use generic filler such as "convenient location", "peaceful neighbourhood", "close to amenities", or "ideal for families" UNLESS a provided fact specifically supports it.
- Two listings in DIFFERENT villages MUST produce meaningfully DIFFERENT neighbourhood insights.
- If there are no reliable facts for the village (no landmarks provided and nothing else supported), keep it SHORT and honest — name the village and district and state only what is supported — rather than padding with generic claims.
- Trilingual: write the English insight from the facts, then TRANSLATE THE SAME FACTS into Lao and Chinese. Do NOT invent different local claims per language — the underlying facts must match across en/lo/zh.

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

  "photo_conflicts": [{"field": "bedrooms", "claimed": "5", "observed": "1 open-plan studio", "note": "Photos show a single studio space; supplied details claim 5 bedrooms."}],

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
    return new Response(JSON.stringify({ error: authErr.error }), {
      status: authErr.status,
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

    let response!: Response;
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
    const recommendedOrder = Array.isArray(result.recommended_order) ? result.recommended_order as number[] : [];

    const rawImages = urlsToFetch.map((url, i) => ({
      storageUrl: url,
      primary: i === heroIndex,
      source: importSource,
      roomType: photoAnalysis.find(p => p.index === i)?.room_type,
      qualityScore: photoAnalysis.find(p => p.index === i)?.quality_score,
    }));

    // images[] IS the canonical, already-ordered source of truth for
    // display sequence (hero first, per the prompt's own ordering rule) —
    // consumers should read images[] directly and never need to
    // cross-reference recommended_order for ordering. recommended_order is
    // still included below, purely as a fallback/compatibility signal for
    // any older or simpler consumer that only understands index arrays.
    const orderedIndexes = recommendedOrder.length
      ? [...recommendedOrder, ...rawImages.map((_, i) => i).filter(i => !recommendedOrder.includes(i))]
      : rawImages.map((_, i) => i);
    enriched.images = orderedIndexes.map(i => rawImages[i]).filter(Boolean);
    enriched.recommended_order = recommendedOrder;
    // Photo-vs-supplied-data conflicts the model flagged (never silent corrections).
    // Pass through as-is; consumers (Edit/Create) surface them for human review.
    enriched.photo_conflicts = Array.isArray(result.photo_conflicts)
      ? result.photo_conflicts.filter((c: unknown) => c && typeof c === 'object')
      : [];
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
