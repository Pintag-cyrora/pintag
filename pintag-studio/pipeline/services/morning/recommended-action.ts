// Moved verbatim from pipeline/daily-briefing.ts (M2.9 web migration).

/**
 * Extracts the CMO's structured "RECOMMENDED ACTION:" line — the product
 * pattern from FOUNDING_PRINCIPLES.md's "Observe -> Think -> Recommend ->
 * Execute": every briefing ends with exactly one clear, imperative,
 * one-click-shaped action. This marker is the primary contract (the prompt
 * explicitly requires it); the older loose "what I recommend" match is kept
 * only as a fallback for briefings generated before this change, since LLM
 * output structure isn't 100% guaranteed run to run.
 *
 * Returns the stripped narrative alongside the action, from whichever
 * pattern actually matched — computing these separately previously let a
 * fallback-matched line stay in the narrative *and* appear in the action
 * card, duplicating it on the page.
 *
 * Also extracts the sibling WHY THIS MATTERS: line the prompt now requires
 * right after RECOMMENDED ACTION — same "structured marker, not prose
 * parsing" contract, stripped from the narrative the same way. Only present
 * alongside a strict match; the older loose fallback predates this and
 * simply has no reasoning to show, which the Recommended Action card
 * already renders as optional.
 */
export function extractRecommendedAction(briefingText: string): { action: string | undefined; reasoning: string | undefined; narrativeOnly: string } {
  const strict = briefingText.match(/^RECOMMENDED ACTION:\s*(.+)$/im);
  if (strict) {
    const reasoning = briefingText.match(/^WHY THIS MATTERS:\s*(.+)$/im);
    const narrativeOnly = briefingText
      .replace(/\n*^RECOMMENDED ACTION:.*$/im, '')
      .replace(/\n*^WHY THIS MATTERS:.*$/im, '')
      .trim();
    return { action: strict[1].trim(), reasoning: reasoning ? reasoning[1].trim() : undefined, narrativeOnly };
  }
  const fallback = briefingText.match(/^.*(?:\*\*)?what i recommend(?:\*\*)?:?\s*[^\n]+$/im);
  if (fallback) {
    return {
      action: fallback[0].replace(/^.*(?:\*\*)?what i recommend(?:\*\*)?:?\s*/i, '').trim(),
      reasoning: undefined,
      narrativeOnly: briefingText.replace(fallback[0], '').replace(/\n{3,}/g, '\n\n').trim(),
    };
  }
  return { action: undefined, reasoning: undefined, narrativeOnly: briefingText.trim() };
}
