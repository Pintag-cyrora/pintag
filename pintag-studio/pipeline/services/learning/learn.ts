// The Learning Layer (M4) — teaches Marketing OS about Pintag and its
// founder, the way the Knowledge Layer (knowledge/) teaches it about the
// world. Deliberately separate layers, deliberately different mechanics:
// knowledge/ is curated prose; learning is DERIVED — a set of pure,
// deterministic functions over the structured feedback records that live
// on the campaigns themselves (review, edits, outcome). No fine-tuning,
// no hidden prompts, no LLM in the loop: every preference this module
// reports carries its observation count and can be traced back to the
// exact campaigns that produced it.
//
// The campaigns ARE the learning database — single source of truth, no
// aggregate to drift out of sync. deriveFounderLearning() recomputes from
// them on every read (campaign volume is founder-scale, not web-scale),
// and writeLearningSnapshot() mirrors the current derivation to
// learning/founder-preferences.json purely so the founder can open one
// file and see everything Marketing OS currently believes about them.
//
// Evidence thresholds: nothing is treated as a preference until observed
// at least MIN_OBSERVATIONS times — one edit is an incident, two is the
// start of a pattern. Same discipline as computeConfidence() elsewhere.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../lib/config.js';
import { listCampaigns } from '../campaign/persist.js';
import { RATEABLE_DEPARTMENTS, LANGUAGE_LABEL, type Campaign, type FeedbackReason, type RateableDepartment, type Language } from '../campaign/types.js';

const MIN_OBSERVATIONS = 2;
/** Average shortening beyond this fraction (with enough observations) counts as a real "prefers shorter" signal. */
const SHORTENING_THRESHOLD = 0.1;

export interface LearnedPreference {
  /** The preference, stated plainly — "Prefers shorter content". */
  statement: string;
  /** Its provenance — "founder edits shortened content in 3 of 4 edited campaigns (avg -24%)". Always shown next to the statement; never a hidden adjustment. */
  evidence: string;
  /** How many observations back this up. */
  observations: number;
}

export interface DepartmentFeedbackSummary {
  department: RateableDepartment;
  averageRating: number;
  ratingCount: number;
}

export interface KindTrackRecord {
  kind: string;
  reviewedCount: number;
  approvedCount: number;
  /** approved + approved-with-edits over all reviewed. */
  approvalRate: number;
}

export interface FounderLearning {
  /** Statements strong enough to influence generation (each with evidence attached). */
  preferences: LearnedPreference[];
  /** Reasons the founder keeps flagging — the "Avoid" list, with counts. */
  avoid: LearnedPreference[];
  departmentFeedback: DepartmentFeedbackSummary[];
  trackRecordByKind: KindTrackRecord[];
  /** Every lesson from every reviewed campaign, newest first — the searchable record. */
  allLessons: Array<{ campaignId: string; campaignTitle: string; lesson: string }>;
  reviewedCampaignCount: number;
}

/** The one derivation — pure over the supplied campaigns (callers pass listCampaigns() in production; tests pass fixtures). */
export function deriveFounderLearning(campaigns: Campaign[]): FounderLearning {
  const reviewed = campaigns.filter((c) => c.review);

  // "Avoid" list — reasons flagged repeatedly across reviews AND edits.
  const reasonCounts = new Map<FeedbackReason, number>();
  for (const c of campaigns) {
    const reasons = [...(c.review?.reasons ?? []), ...(c.edits ?? []).flatMap((e) => e.reasons)];
    for (const r of new Set(reasons)) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  const avoid: LearnedPreference[] = [...reasonCounts.entries()]
    .filter(([, count]) => count >= MIN_OBSERVATIONS)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      statement: `Avoid: ${reason}`,
      evidence: `flagged "${reason}" on ${count} campaigns`,
      observations: count,
    }));

  // Length preference — from real edit deltas, campaigns as the unit (many
  // edits to one campaign still count once, so one heavy session can't
  // masquerade as a long-term pattern).
  const preferences: LearnedPreference[] = [];
  const editedCampaigns = campaigns.filter((c) => (c.edits ?? []).length > 0);
  const campaignDeltas = editedCampaigns.map((c) => {
    const totalOriginal = c.edits!.reduce((sum, e) => sum + e.original.length, 0);
    const totalDelta = c.edits!.reduce((sum, e) => sum + e.deltaChars, 0);
    return {
      fraction: totalOriginal > 0 ? totalDelta / totalOriginal : 0,
      languages: c.edits!.map((e) => e.language).filter((l): l is Language => Boolean(l)),
    };
  });

  /**
   * Names the language a signal was observed in when it was observed in
   * only one (M5) — a preference derived entirely from Lao edits must not
   * read as a claim about English too. Silent when edits span several
   * languages or predate M5 (no language recorded): nothing to qualify.
   */
  const languageQualifier = (group: typeof campaignDeltas): string => {
    const langs = new Set(group.flatMap((d) => d.languages));
    if (langs.size !== 1) return '';
    return `, observed only in ${LANGUAGE_LABEL[[...langs][0]]} content`;
  };

  const shortened = campaignDeltas.filter((d) => d.fraction < -SHORTENING_THRESHOLD);
  const lengthened = campaignDeltas.filter((d) => d.fraction > SHORTENING_THRESHOLD);
  if (shortened.length >= MIN_OBSERVATIONS && shortened.length > lengthened.length) {
    const avgPct = Math.round((shortened.reduce((a, b) => a + b.fraction, 0) / shortened.length) * 100);
    preferences.push({
      statement: 'Prefers shorter content than generated',
      evidence: `founder edits shortened content in ${shortened.length} of ${editedCampaigns.length} edited campaigns (avg ${avgPct}%)${languageQualifier(shortened)}`,
      observations: shortened.length,
    });
  } else if (lengthened.length >= MIN_OBSERVATIONS && lengthened.length > shortened.length) {
    const avgPct = Math.round((lengthened.reduce((a, b) => a + b.fraction, 0) / lengthened.length) * 100);
    preferences.push({
      statement: 'Prefers more thorough content than generated',
      evidence: `founder edits lengthened content in ${lengthened.length} of ${editedCampaigns.length} edited campaigns (avg +${avgPct}%)${languageQualifier(lengthened)}`,
      observations: lengthened.length,
    });
  }

  // Department feedback — averages over explicit founder ratings only.
  const departmentFeedback: DepartmentFeedbackSummary[] = RATEABLE_DEPARTMENTS.map((department) => {
    const ratings = reviewed.map((c) => c.review!.departmentRatings[department]).filter((r): r is NonNullable<typeof r> => r !== undefined);
    return {
      department,
      averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : 0,
      ratingCount: ratings.length,
    };
  }).filter((d) => d.ratingCount > 0);

  // Approval track record by opportunity kind — real founder decisions
  // only, the signal scoring's Founder Track Record dimension reads.
  const byKind = new Map<string, { reviewedCount: number; approvedCount: number }>();
  for (const c of reviewed) {
    const kind = c.opportunity.source;
    const entry = byKind.get(kind) ?? { reviewedCount: 0, approvedCount: 0 };
    entry.reviewedCount += 1;
    if (c.review!.outcome === 'approved' || c.review!.outcome === 'approved-with-edits') entry.approvedCount += 1;
    byKind.set(kind, entry);
  }
  const trackRecordByKind: KindTrackRecord[] = [...byKind.entries()].map(([kind, { reviewedCount, approvedCount }]) => ({
    kind,
    reviewedCount,
    approvedCount,
    approvalRate: approvedCount / reviewedCount,
  }));

  const allLessons = campaigns
    .flatMap((c) => (c.lessons ?? []).map((lesson) => ({ campaignId: c.id, campaignTitle: c.title, lesson })))
    .reverse();

  return { preferences, avoid, departmentFeedback, trackRecordByKind, allLessons, reviewedCampaignCount: reviewed.length };
}

/**
 * Lessons Learned — deterministic statements of what the founder's review
 * and edits actually did, one per observed fact. Never LLM-generated:
 * these are records, not interpretations.
 */
export function generateLessons(campaign: Campaign): string[] {
  const lessons: string[] = [];
  const review = campaign.review;
  if (review) {
    const outcomeLabel: Record<string, string> = {
      approved: 'Founder approved the campaign as generated.',
      'approved-with-edits': 'Founder approved the campaign after making edits.',
      'needs-regeneration': 'Founder sent the campaign back for regeneration.',
      rejected: 'Founder rejected the campaign.',
    };
    lessons.push(outcomeLabel[review.outcome]);
    for (const reason of review.reasons) {
      lessons.push(`Founder flagged: ${reason}.`);
    }
    for (const [department, rating] of Object.entries(review.departmentRatings)) {
      if (rating <= 2) lessons.push(`Founder rated ${department} ${rating}/5 — its output needs attention.`);
    }
  }
  for (const edit of campaign.edits ?? []) {
    const pct = edit.original.length > 0 ? Math.round((edit.deltaChars / edit.original.length) * 100) : 0;
    // Language is named (M5) because editing Lao copy and editing English
    // copy are genuinely different signals — a lesson that omits it would be
    // ambiguous the moment a campaign runs bilingually.
    const what = edit.language ? `${LANGUAGE_LABEL[edit.language]} ${edit.field}` : edit.field;
    if (pct <= -10) lessons.push(`Founder shortened ${what} by ${Math.abs(pct)}% (${edit.original.length} → ${edit.edited.length} chars).`);
    else if (pct >= 10) lessons.push(`Founder lengthened ${what} by ${pct}% (${edit.original.length} → ${edit.edited.length} chars).`);
    else lessons.push(`Founder revised ${what} (length roughly unchanged).`);
  }
  return lessons;
}

/**
 * The generation-time bridge (M4 §11): the learning lines strong enough to
 * shape a new campaign, each WITH its evidence — these go verbatim into
 * the strategist/writer prompts AND onto campaign.learningNotes, so the
 * campaign can always explain exactly why it looks the way it does.
 * Returns [] until real observations exist — no data, no behavior change.
 */
export function learningPromptLines(learning: FounderLearning): string[] {
  const lines: string[] = [];
  for (const p of learning.preferences) lines.push(`${p.statement} — ${p.evidence}.`);
  for (const a of learning.avoid) lines.push(`${a.statement} — ${a.evidence}.`);
  return lines;
}

const LEARNING_DIR = join(REPO_ROOT, 'learning');

/** Mirrors the current derivation to learning/founder-preferences.json — a human-readable window into the Learning Layer, refreshed after every review. The campaigns stay the source of truth. */
export function writeLearningSnapshot(learning: FounderLearning = deriveFounderLearning(listCampaigns())): void {
  mkdirSync(LEARNING_DIR, { recursive: true });
  writeFileSync(
    join(LEARNING_DIR, 'founder-preferences.json'),
    JSON.stringify({ derivedAt: new Date().toISOString(), note: 'Derived snapshot — regenerated after every campaign review. Source of truth is the campaigns themselves (content-vault/campaigns/*/campaign.json).', ...learning }, null, 2),
    'utf-8'
  );
}
