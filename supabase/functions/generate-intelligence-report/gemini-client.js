// Gemini client — the only place that talks to the Gemini API. Writes
// prose only; never decides what to say (see INTELLIGENCE_ARCHITECTURE.md).
// Same retry-with-backoff convention as smart-listing-importer.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js / metrics-utils.js / report-composer.js.

const RETRY_DELAYS = [2000, 5000, 10000];
// A hang (not an HTTP error) can otherwise outlive the edge function's own
// platform execution ceiling, which kills the function before any catch
// block runs — silently, with no status='failed' row ever written. This
// timeout turns a hang into an explicit, retryable, loggable failure.
const REQUEST_TIMEOUT_MS = 25000;

export async function callGemini(apiKey, prompt) {
  let response;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 4000, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
          }),
          signal: controller.signal,
        }
      );
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err && err.name === 'AbortError';
      if (isTimeout && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      throw new Error(isTimeout
        ? `Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1})`
        : `Gemini request failed: ${err && err.message ? err.message : err}`);
    }
    clearTimeout(timeoutId);

    if (response.ok) break;
    if ((response.status === 429 || response.status === 503) && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    const errText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const geminiData = await response.json();
  const text = geminiData.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) throw new Error('No text content in Gemini response');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from Gemini response');
  return JSON.parse(jsonMatch[0]);
}
