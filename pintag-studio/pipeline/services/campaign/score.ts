// Opportunity scoring (M3) — deterministic, rule-based, zero LLM calls.
// Runs BEFORE any expensive generation so Marketing OS prioritizes the way
// a real marketing team does: score everything, execute only what's worth
// executing. Every dimension is computed from a signal the system actually
// has, and every number carries its reason — the founder can audit any
// score line by line.
//
// Deliberately ABSENT dimensions: Search Demand and Seasonal Relevance.
// Marketing OS has no search-volume or seasonality data source today, and
// inventing those numbers would violate the evidence-driven rule
// (brain/ceo.md — never state a fact not traceable to a real source; the
// same discipline the Daily Briefing narrative follows). They join this
// scorer the day a real data source exists, as data, not guesses.

import { readCampaignConfig } from '../../lib/config.js';
import { findSimilarByTitle } from '../../stages/01-plan.js';
import { listCampaigns } from './persist.js';
import { deriveFounderLearning, type FounderLearning } from '../learning/learn.js';
import type { ScorableOpportunity, OpportunityScore, ScoreDimension } from './types.js';

const CONFIDENCE_PERCENT: Record<'high' | 'medium' | 'low', number> = { high: 95, medium: 70, low: 45 };
/** An opportunity with no confidence signal at all (e.g. a manually typed topic) is neither trusted nor punished. */
const NEUTRAL_CONFIDENCE_PERCENT = 60;
/** Below this many reviewed campaigns of a kind, its approval rate isn't evidence yet — same "one incident isn't a pattern" discipline as the Learning Layer's own threshold. */
const MIN_TRACK_RECORD_REVIEWS = 3;

/**
 * Scores one opportunity. Async only because the duplicate-risk dimension
 * reuses Stage 01's content_items near-duplicate check — when Supabase is
 * unreachable that dimension degrades to a neutral score with an honest
 * reason, never a fabricated verdict.
 *
 * `learning` is optional purely so batch callers derive it once instead of
 * per opportunity; omitted, it's derived from the campaigns on disk.
 */
export async function scoreOpportunity(opp: ScorableOpportunity, learning?: FounderLearning): Promise<OpportunityScore> {
  const dimensions: ScoreDimension[] = [];
  const founderLearning = learning ?? deriveFounderLearning(listCampaigns());

  // Business impact — the strongest single signal is where the opportunity
  // came from: observed outperformance is proven audience demand; an
  // emerging playbook is a pattern still being confirmed; a founder-typed
  // topic is directed work with no performance data either way.
  if (opp.kind === 'outperforming-content') {
    dimensions.push({ name: 'Business Impact', score: 85, weight: 2, reason: 'Backed by observed content outperformance — proven audience demand, not a hypothesis.' });
  } else if (opp.kind === 'emerging-playbook') {
    dimensions.push({ name: 'Business Impact', score: 75, weight: 2, reason: 'Backed by a repeating pattern Observation Intelligence has flagged as an emerging playbook.' });
  } else if (opp.kind === 'recommended-action') {
    dimensions.push({ name: 'Business Impact', score: 70, weight: 2, reason: "Today's single recommended action — the CMO briefing already judged it the highest-leverage move." });
  } else {
    dimensions.push({ name: 'Business Impact', score: 60, weight: 2, reason: 'Founder-directed topic — no performance signal either way yet.' });
  }

  // Evidence strength — count of independent evidence lines attached
  // upstream (observation stats, pattern occurrences). Capped at 3: beyond
  // that, more lines stop meaning more signal.
  const evidenceCount = opp.evidence.length;
  dimensions.push({
    name: 'Evidence Strength',
    score: Math.round(Math.min(evidenceCount / 3, 1) * 100),
    weight: 1.5,
    reason:
      evidenceCount === 0
        ? 'No supporting evidence attached — the opportunity rests on its source signal alone.'
        : `${evidenceCount} piece${evidenceCount === 1 ? '' : 's'} of supporting evidence attached.`,
  });

  // Confidence — the deterministic computeConfidence() level carried on the
  // opportunity (playbooks), mapped to a percent. Never recomputed here.
  const confidencePercent = opp.confidenceLevel ? CONFIDENCE_PERCENT[opp.confidenceLevel] : NEUTRAL_CONFIDENCE_PERCENT;
  dimensions.push({
    name: 'Confidence',
    score: confidencePercent,
    weight: 1.5,
    reason: opp.confidenceLevel
      ? `Pattern confidence is ${opp.confidenceLevel} (occurrences + time span, computed by Observation Intelligence).`
      : 'No pattern-confidence signal on this opportunity — treated as neutral.',
  });

  // Duplicate risk / existing coverage — Stage 01's real near-duplicate
  // title check against content_items, reused not reimplemented.
  let duplicate: ScoreDimension;
  try {
    const found = await findSimilarByTitle(opp.title, 'educational_post');
    duplicate = found
      ? { name: 'Duplicate Risk', score: 20, weight: 1.5, reason: `Similar content already exists ("${found.title}") — a new campaign risks duplicating it; prefer updating instead.` }
      : { name: 'Duplicate Risk', score: 100, weight: 1.5, reason: 'No similar campaign or content item exists yet.' };
  } catch (err) {
    duplicate = { name: 'Duplicate Risk', score: 50, weight: 1.5, reason: `Duplicate check unavailable (${err instanceof Error ? err.message : 'unknown error'}) — treated as neutral, verify manually.` };
  }
  dimensions.push(duplicate);

  // Founder Track Record (M4 — strategy learning). Real founder decisions
  // only: how often campaigns from this same kind of opportunity were
  // actually approved. Neutral, with an honest reason, until enough
  // reviewed campaigns exist — an unproven kind is never penalized for
  // lack of history, and nothing here is inferred from unpublished or
  // unmeasured work. Once publishing exists, real performance metrics
  // (CampaignPerformance) join this dimension the same way: as data.
  const record = founderLearning.trackRecordByKind.find((r) => r.kind === opp.kind);
  if (record && record.reviewedCount >= MIN_TRACK_RECORD_REVIEWS) {
    dimensions.push({
      name: 'Founder Track Record',
      score: Math.round(record.approvalRate * 100),
      weight: 1.5,
      reason: `You approved ${record.approvedCount} of ${record.reviewedCount} reviewed "${opp.kind}" campaigns.`,
    });
  } else {
    // weight: 0 — shown for transparency, deliberately EXCLUDED from the
    // composite. Same "not applicable ≠ average" discipline as Stage 06's
    // computeCompositeScore skipping a null visualQuality: folding in a
    // neutral 60 would quietly drag every genuinely strong opportunity
    // toward the middle and, on a fresh install with no reviews at all,
    // stop anything from ever reaching high priority.
    dimensions.push({
      name: 'Founder Track Record',
      score: 60,
      weight: 0,
      reason: record
        ? `Only ${record.reviewedCount} reviewed "${opp.kind}" campaign${record.reviewedCount === 1 ? '' : 's'} so far — not enough history to score yet, so this isn't counted.`
        : `No reviewed "${opp.kind}" campaigns yet — no track record to learn from, so this isn't counted.`,
    });
  }

  const weightedSum = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const total = Math.round(weightedSum / totalWeight);

  const { priorityHighThreshold, priorityMediumThreshold } = readCampaignConfig();
  const priority: OpportunityScore['priority'] = total >= priorityHighThreshold ? 'high' : total >= priorityMediumThreshold ? 'medium' : 'low';

  return {
    total,
    confidencePercent,
    priority,
    dimensions,
    reasons: [...dimensions].sort((a, b) => b.score * b.weight - a.score * a.weight).map((d) => d.reason),
  };
}

export interface ScoredOpportunity<T extends ScorableOpportunity = ScorableOpportunity> {
  opportunity: T;
  score: OpportunityScore;
}

/** Scores every opportunity (sequentially — each may hit the duplicate-check query). Derives founder learning once for the whole batch rather than per opportunity. */
export async function scoreOpportunities<T extends ScorableOpportunity>(opportunities: T[]): Promise<Array<ScoredOpportunity<T>>> {
  const learning = deriveFounderLearning(listCampaigns());
  const scored: Array<ScoredOpportunity<T>> = [];
  for (const opportunity of opportunities) {
    scored.push({ opportunity, score: await scoreOpportunity(opportunity, learning) });
  }
  return scored;
}

/**
 * The selection rule of the daily funnel: drop low-priority outright (a
 * low-scoring opportunity is never worth LLM spend just because the list
 * was short), sort by score, keep the configured top N.
 */
export function selectTopOpportunities<T extends ScorableOpportunity>(scored: Array<ScoredOpportunity<T>>, topN = readCampaignConfig().topN): Array<ScoredOpportunity<T>> {
  return scored
    .filter((s) => s.score.priority !== 'low')
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, topN);
}
