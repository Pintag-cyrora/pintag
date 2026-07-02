// Stage 6 — Brand Guardian Review & Score. The final editorial gate before
// Schedule/Publish. Loops back to Stage 3/4/5 on a 'revise' verdict, bounded
// by max_revision_cycles, before anything ever reaches the founder.
//
// Corresponding agent: .claude/agents/brand-guardian.md
// Reads from: brain/brand-voice.md, brain/posting-rules.md, knowledge-base/, Memory
// Writes to: quality_scores

import { supabase } from '../lib/supabase.js';
import { loadRuntimeConfig } from '../lib/config.js';
import { withHealthReport } from '../lib/health.js';
import type { Draft, QualityScoreResult } from '../lib/types.js';

export async function guardianReview(draft: Draft, reviewPass: number): Promise<QualityScoreResult> {
  return withHealthReport('brand_guardian', async () => {
    // TODO(M1): invoke the brand-guardian agent against brain/brand-voice.md,
    // brain/posting-rules.md, knowledge-base/ fact-checking, and the Memory
    // layer's repetition check; compute the weighted composite score using
    // brain/org-config.json quality_score.weights (educational_value highest).
    void draft;

    const config = await loadRuntimeConfig();
    const result: QualityScoreResult = {
      contentItemId: draft.contentItemId,
      reviewPass,
      scores: {
        educationalValue: 0,
        trustworthiness: 0,
        brandVoice: 0,
        originality: 0,
        visualQuality: null,
        shareability: 0,
        promotionLevel: 0,
        confidence: 0,
      },
      compositeScore: 0,
      verdict: 'revise',
      revisionNotes: 'Not implemented — see TODO(M1)',
    };

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

    return result;
  });
}

/** Any dimension below min_threshold_per_dimension forces a 'revise' verdict, regardless of composite score. */
export function meetsThreshold(result: QualityScoreResult, minThreshold: number): boolean {
  return Object.values(result.scores)
    .filter((v): v is number => v !== null)
    .every((v) => v >= minThreshold);
}
