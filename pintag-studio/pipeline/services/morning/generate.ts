// generateMorningBrief() — the one orchestration function that assembles a
// complete MorningBrief. All business logic (classification, thresholds,
// relative-time labels, risk/opportunity derivation, recommendation
// extraction) lives here and in the services it calls — never in a
// renderer. No file writes here; persistence is persist.ts's job, so this
// function is usable by both the CLI path and the web route.

import { runAgent } from '../../lib/agent.js';
import { readFounderName, readActiveCompanyName, readObservationIntelligenceThresholds } from '../../lib/config.js';
import { computeConfidence } from '../../lib/observation-intelligence.js';
import { matchExecutiveObservationsToPatterns, listCandidatePatterns } from '../../lib/patterns.js';
import { collectIntelligence, collectObservations, collectOperationalMemory, collectOrganizationalMemory, buildPrompt, loadAllSuggestions, SUGGESTION_KIND_LABELS } from './collect.js';
import { calculateKPIs, formatDepartmentHealthIssues } from './kpis.js';
import { extractRecommendedAction } from './recommended-action.js';
import { formatRelativeSpan, formatRecentActivityStat, classifyRecentActivity } from './format.js';
import type { MorningBrief, AttentionItem, RecentActivityItem, RiskItem, OpportunityItem, SupabaseCollectResult } from './types.js';
import type { CollectIntelligenceResult, CollectObservationsResult } from './collect.js';
import type { KpiResult } from './kpis.js';

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Capped, not exhaustive — protects a "quick to scan" goal as pending volume grows; overflow links to the real queue instead. */
const ATTENTION_LIMIT = 5;

function deriveAttentionItems(operational: SupabaseCollectResult, pendingSuggestions: CollectIntelligenceResult['pendingSuggestions']): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of operational.pendingApprovals ?? []) {
    items.push({ source: 'approval', title: row.title, badge: row.contentType, detail: 'Awaiting your approval', link: 'index.html' });
  }
  for (const s of pendingSuggestions) {
    const baseDetail = s.occurrences.length > 1 ? `Noticed ${s.occurrences.length} times — starting to look like a repeatable pattern.` : 'Worth a look before it gets lost.';
    const confidenceSuffix = s.kind === 'marketing-observation' ? ` Confidence: ${computeConfidence(s.occurrences).level}.` : '';
    items.push({ source: 'knowledge-suggestion', title: s.title, badge: SUGGESTION_KIND_LABELS[s.kind] ?? 'Knowledge Suggestion', detail: `${baseDetail}${confidenceSuffix}`, link: '/review' });
  }
  return items.slice(0, ATTENTION_LIMIT);
}

/** Only surfaces a win when a genuine positive signal exists in already-gathered data — never fabricated, omitted entirely on a quiet day. Priority order: human+AI collaboration (approved suggestions) > new intelligence > published content. */
function deriveWin(organizational: SupabaseCollectResult, recentlyVerifiedKnowledge: CollectIntelligenceResult['recentlyVerifiedKnowledge']): string | undefined {
  const cutoff = yesterday();

  const recentlyApprovedSuggestions = loadAllSuggestions().filter((s) => s.status === 'approved' && (s.reviewedAt ?? '') >= cutoff);
  if (recentlyApprovedSuggestions.length > 0) {
    return `${recentlyApprovedSuggestions.length} knowledge suggestion${recentlyApprovedSuggestions.length === 1 ? '' : 's'} reviewed and turned into real knowledge since yesterday.`;
  }

  if (recentlyVerifiedKnowledge.length > 0) {
    return `${recentlyVerifiedKnowledge.length} new piece${recentlyVerifiedKnowledge.length === 1 ? '' : 's'} of intelligence went live since yesterday.`;
  }

  if (organizational.available && (organizational.publishedCount ?? 0) > 0) {
    return `${organizational.publishedCount} piece${organizational.publishedCount === 1 ? '' : 's'} of content published since yesterday.`;
  }

  return undefined;
}

/** Down/degraded departments + underperforming/erroring observations — real data only, nothing fabricated. */
function deriveRisks(kpis: KpiResult, departmentObservations: CollectObservationsResult['departmentObservations']): RiskItem[] {
  const risks: RiskItem[] = [];
  for (const d of kpis.departmentUpdates) {
    if (d.status === 'down' || d.status === 'degraded') {
      risks.push({ kind: 'department-health', title: `${d.label} needs attention`, detail: `${d.status} — ${d.message ?? 'no message'}` });
    }
  }
  for (const d of departmentObservations) {
    if (d.department === 'platform') {
      risks.push({ kind: 'source-error', title: d.observation.whatHappened, detail: d.reason });
    } else {
      risks.push({ kind: 'underperforming-content', title: d.observation.whatHappened, detail: d.reason });
    }
  }
  return risks;
}

/** Outperforming content + Emerging Playbooks — real data only. */
function deriveOpportunities(executiveObservations: CollectObservationsResult['executiveObservations']): OpportunityItem[] {
  const opportunities: OpportunityItem[] = executiveObservations.map((o) => ({
    kind: 'outperforming-content',
    title: o.whatHappened,
    detail: o.whyItMatters,
    evidence: o.evidence,
    link: o.link,
  }));
  for (const p of listCandidatePatterns()) {
    opportunities.push({
      kind: 'emerging-playbook',
      title: p.name,
      detail: `Confidence: ${p.confidence.level} — ${p.confidence.reason}`,
      evidence: p.observedPattern,
      patternId: p.id,
    });
  }
  return opportunities;
}

function buildRecentActivity(recentActivity: CollectObservationsResult['recentActivity'], now: number): RecentActivityItem[] {
  const { recentActivityMinAgeHoursForComparison, outperformRatio, underperformRatio } = readObservationIntelligenceThresholds();
  return recentActivity.map((observation) => {
    const ageHours = (now - new Date(observation.occurredAt!).getTime()) / 3_600_000;
    const ageSpan = formatRelativeSpan(observation.occurredAt!, now);
    return {
      observation,
      stat: formatRecentActivityStat(observation.data, ageSpan),
      framing: classifyRecentActivity(observation.data, ageHours, recentActivityMinAgeHoursForComparison, outperformRatio, underperformRatio),
    };
  });
}

export async function generateMorningBrief(): Promise<MorningBrief> {
  const [operational, organizational, observationsResult, kpis] = await Promise.all([
    collectOperationalMemory(),
    collectOrganizationalMemory(),
    collectObservations(),
    calculateKPIs(),
  ]);
  const intelligence = collectIntelligence();

  await matchExecutiveObservationsToPatterns(
    observationsResult.executiveObservations,
    observationsResult.departmentObservations.map((d) => d.observation)
  );

  const userPrompt = buildPrompt({
    intelligence: intelligence.intelligenceSummary,
    suggestions: intelligence.suggestionsSummary,
    observations: observationsResult.promptText,
    operational,
    organizational,
    departmentHealth: formatDepartmentHealthIssues(kpis.departmentUpdates),
  });

  const rawBriefingText = await runAgent('cmo', { userPrompt, maxBudgetUsd: 0.3 });
  const { action: recommendedAction, reasoning: recommendedActionReasoning, narrativeOnly: narrative } = extractRecommendedAction(rawBriefingText);

  const generatedAt = new Date();
  const now = generatedAt.getTime();

  return {
    generatedAt: generatedAt.toISOString(),
    dateISO: generatedAt.toISOString().slice(0, 10),
    dateLabel: generatedAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    generatedLabel: generatedAt.toLocaleString(),
    founderName: readFounderName(),
    activeCompany: readActiveCompanyName(),
    win: deriveWin(organizational, intelligence.recentlyVerifiedKnowledge),

    rawBriefingText,
    narrative,
    recommendedAction,
    recommendedActionReasoning,

    recentlyVerifiedKnowledge: intelligence.recentlyVerifiedKnowledge,
    recentActivity: buildRecentActivity(observationsResult.recentActivity, now),

    todaysPriorities: deriveAttentionItems(operational, intelligence.pendingSuggestions),

    companyHealth: kpis.companyHealth,
    departmentUpdates: kpis.departmentUpdates,

    risks: deriveRisks(kpis, observationsResult.departmentObservations),
    opportunities: deriveOpportunities(observationsResult.executiveObservations),
  };
}
