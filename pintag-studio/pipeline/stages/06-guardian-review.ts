// Stage 6 — Brand Guardian Review & Score. The final editorial gate before
// Schedule/Publish. Loops back to Stage 3/4/5 on a 'revise' verdict, bounded
// by max_revision_cycles, before anything ever reaches the founder.
//
// Corresponding agent: .claude/agents/brand-guardian.md
// Reads from: brain/brand-voice.md, brain/posting-rules.md, knowledge-base/, Memory
// Writes to: quality_scores

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { supabase } from '../lib/supabase.js';
import { loadRuntimeConfig, REPO_ROOT } from '../lib/config.js';
import { withHealthReport } from '../lib/health.js';
import { runAgent, parseJsonResponse } from '../lib/agent.js';
import type { Draft, QualityScoreResult } from '../lib/types.js';

interface GuardianScores {
  educationalValue: number;
  trustworthiness: number;
  brandVoice: number;
  originality: number;
  visualQuality: number | null;
  shareability: number;
  promotionLevel: number;
  confidence: number;
}

interface GuardianOutput {
  scores: GuardianScores;
  revisionNotes: string;
}

// Maps camelCase score keys (TS/JSON) to the snake_case keys used in
// brain/org-config.json's quality_score.weights and the quality_scores table.
const DIMENSION_KEYS: Array<[keyof GuardianScores, string]> = [
  ['educationalValue', 'educational_value'],
  ['trustworthiness', 'trustworthiness'],
  ['brandVoice', 'brand_voice'],
  ['originality', 'originality'],
  ['visualQuality', 'visual_quality'],
  ['shareability', 'shareability'],
  ['promotionLevel', 'promotion_level'],
  ['confidence', 'confidence'],
];

const REQUIRED_NUMERIC_DIMENSIONS: Array<keyof GuardianScores> = [
  'educationalValue',
  'trustworthiness',
  'brandVoice',
  'originality',
  'shareability',
  'promotionLevel',
  'confidence',
];

/**
 * The model proposes scores as JSON text — nothing guarantees they're
 * actually numbers. An unvalidated non-number (e.g. "high" instead of 0.9,
 * or a missing field) would silently become NaN through computeCompositeScore
 * and corrupt the founder-facing composite score while meetsThreshold's `>=`
 * comparison against NaN quietly forces 'revise' with no real signal why.
 */
function assertValidScores(scores: GuardianScores): void {
  for (const key of REQUIRED_NUMERIC_DIMENSIONS) {
    const value = scores[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`brand-guardian returned a non-numeric score for "${key}": ${JSON.stringify(value)}`);
    }
  }
  if (scores.visualQuality !== null && (typeof scores.visualQuality !== 'number' || !Number.isFinite(scores.visualQuality))) {
    throw new Error(`brand-guardian returned an invalid visualQuality: ${JSON.stringify(scores.visualQuality)}`);
  }
}

function computeCompositeScore(scores: GuardianScores, weights: Record<string, number>): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [camelKey, snakeKey] of DIMENSION_KEYS) {
    const value = scores[camelKey];
    if (value === null || value === undefined) continue; // visualQuality: not applicable when no assets exist (M1 has no Graphic Designer output)
    const weight = weights[snakeKey] ?? 1;
    weightedSum += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

export async function guardianReview(draft: Draft, reviewPass: number): Promise<QualityScoreResult> {
  return withHealthReport('brand_guardian', async () => {
    const config = await loadRuntimeConfig();

    const brandVoice = readFileSync(join(REPO_ROOT, 'brain', 'brand-voice.md'), 'utf-8');
    const postingRules = readFileSync(join(REPO_ROOT, 'brain', 'posting-rules.md'), 'utf-8');

    const { data: item, error: fetchErr } = await supabase
      .from('content_items')
      .select('vault_path')
      .eq('id', draft.contentItemId)
      .single();
    if (fetchErr || !item) throw new Error(`Failed to load content_items for review: ${fetchErr?.message}`);

    const researchPath = join(REPO_ROOT, item.vault_path, 'research.json');
    const research = existsSync(researchPath) ? readFileSync(researchPath, 'utf-8') : '{"facts": []}';

    const userPrompt = [
      'Review this educational post draft and score it across 8 dimensions, each 0.0-1.0, where HIGHER IS ALWAYS BETTER on every dimension (e.g. promotionLevel: 1.0 means appropriately restrained/educational-first, 0.0 means overtly promotional/salesy — never the reverse).',
      '',
      `## Draft (review pass ${reviewPass})`,
      `Title: ${draft.title}`,
      draft.bodyMarkdown,
      '',
      '## Brand voice (verify consistency against this)',
      brandVoice,
      '## Posting rules (verify compliance, including banned language)',
      postingRules,
      '## Research packet this draft should be grounded in (cross-check facts against this — flag anything not traceable)',
      research,
      '',
      'Score: educationalValue, trustworthiness, brandVoice, originality, shareability, promotionLevel, confidence (all required, 0.0-1.0).',
      'visualQuality: use null — no visual assets exist for this item yet.',
      'revisionNotes: if any dimension is weak, give specific, actionable notes the writer can act on. If everything is strong, say so briefly.',
    ].join('\n');

    const raw = await runAgent('brand_guardian', {
      userPrompt,
      jsonShapeHint:
        '{"scores": {"educationalValue": number, "trustworthiness": number, "brandVoice": number, "originality": number, "visualQuality": null, "shareability": number, "promotionLevel": number, "confidence": number}, "revisionNotes": string}',
    });
    const output = parseJsonResponse<GuardianOutput>(raw);
    if (!output.scores) throw new Error(`brand-guardian response missing scores: ${JSON.stringify(output)}`);
    assertValidScores(output.scores);

    const revisionNotes =
      typeof output.revisionNotes === 'string' && output.revisionNotes.trim().length > 0
        ? output.revisionNotes
        : '(brand-guardian did not provide revision notes)';

    const compositeScore = computeCompositeScore(output.scores, config.qualityScore.weights);

    // The model proposes scores; the pass/revise decision itself is
    // deterministic (meetsThreshold, below) — never trusted from the
    // model's own judgment about whether it "passes."
    const result: QualityScoreResult = {
      contentItemId: draft.contentItemId,
      reviewPass,
      scores: output.scores,
      compositeScore,
      verdict: 'revise',
      revisionNotes,
    };
    result.verdict = meetsThreshold(result, config.qualityScore.minThresholdPerDimension) ? 'pass' : 'revise';

    await supabase.from('quality_scores').insert({
      org_id: config.orgId,
      content_item_id: result.contentItemId,
      review_pass: result.reviewPass,
      educational_value: result.scores.educationalValue,
      trustworthiness: result.scores.trustworthiness,
      brand_voice: result.scores.brandVoice,
      originality: result.scores.originality,
      visual_quality: result.scores.visualQuality,
      shareability: result.scores.shareability,
      promotion_level: result.scores.promotionLevel,
      confidence: result.scores.confidence,
      composite_score: result.compositeScore,
      verdict: result.verdict,
      revision_notes: result.revisionNotes,
    });

    const { error: statusErr } = await supabase
      .from('content_items')
      .update({ status: result.verdict === 'pass' ? 'approved' : 'revising', updated_at: new Date().toISOString() })
      .eq('id', draft.contentItemId);
    if (statusErr) throw new Error(`Failed to update content_items status after review: ${statusErr.message}`);

    console.log(
      `[Stage 06 — Guardian Review] pass ${reviewPass}: composite=${compositeScore.toFixed(3)} verdict=${result.verdict}`
    );

    return result;
  });
}

/** Any dimension below min_threshold_per_dimension forces a 'revise' verdict, regardless of composite score. */
export function meetsThreshold(result: QualityScoreResult, minThreshold: number): boolean {
  return Object.values(result.scores)
    .filter((v): v is number => v !== null)
    .every((v) => v >= minThreshold);
}
