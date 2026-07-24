// Shared service — data collection. Moved from pipeline/daily-briefing.ts
// (M2.9 web migration), bodies unchanged except where noted. This is the
// "collectIntelligence()" + observation/operational/organizational gathering
// half of generateMorningBrief()'s orchestration — see generate.ts.

import { loadAllKnowledgeEntries, type KnowledgeEntry } from '../../lib/knowledge.js';
import { listPendingSuggestions, loadAllSuggestions, type SuggestionKind, type KnowledgeSuggestion } from '../../lib/suggestions.js';
import { gatherAllObservations, formatObservation, type Observation } from '../../lib/observations.js';
import { routeObservations, dispatchDepartmentObservations } from '../../lib/observation-intelligence.js';
import { supabase } from '../../lib/supabase.js';
import { readObservationIntelligenceThresholds } from '../../lib/config.js';
import type { SupabaseGatherResult } from './types.js';

export { loadAllSuggestions };

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const SUGGESTION_KIND_LABELS: Record<SuggestionKind, string> = {
  'knowledge-gap': 'Knowledge Gap',
  'recurring-question': 'Recurring Question',
  'wording-improvement': 'Wording Suggestion',
  'marketing-observation': 'Potential Knowledge Pattern',
  'founder-teaching': 'Founder Teaching Note',
  other: 'Knowledge Suggestion',
};

// ---------------------------------------------------------------------------
// Intelligence Layer + Knowledge Suggestion System — what it learned
// recently, and what's waiting on a human decision. Fully local, no
// credentials needed.
// ---------------------------------------------------------------------------
export interface CollectIntelligenceResult {
  /** Prompt text for the CMO's "What I learned" section. */
  intelligenceSummary: string;
  /** Structured, for Market Intelligence — previously computed and discarded. */
  recentlyVerifiedKnowledge: KnowledgeEntry[];
  /** Prompt text for the CMO's "Knowledge Suggestions pending review" section. */
  suggestionsSummary: string;
  pendingSuggestions: KnowledgeSuggestion[];
}

export function collectIntelligence(): CollectIntelligenceResult {
  const cutoff = yesterday();
  const recentlyVerifiedKnowledge = loadAllKnowledgeEntries().filter(
    (e) => (e.status === 'verified' || e.status === 'expert_reviewed') && e.updated >= cutoff
  );
  const intelligenceSummary =
    recentlyVerifiedKnowledge.length === 0
      ? 'No knowledge entries were newly verified since yesterday.'
      : recentlyVerifiedKnowledge.map((e) => `- ${e.title} (${e.category}, confidence ${e.confidence})`).join('\n');

  const pendingSuggestions = listPendingSuggestions();
  const suggestionsSummary =
    pendingSuggestions.length === 0
      ? 'No knowledge suggestions are waiting for review.'
      : pendingSuggestions
          .map((s) => `- [${s.kind}] ${s.title} — confidence ${s.confidence}, observed ${s.occurrences.length}x, suggested category: ${s.suggestedCategory}`)
          .join('\n');

  return { intelligenceSummary, recentlyVerifiedKnowledge, suggestionsSummary, pendingSuggestions };
}

// ---------------------------------------------------------------------------
// Observation Sources (M2.2) + Observation Intelligence (M2.5/M2.8) — what
// happened in the real world.
// ---------------------------------------------------------------------------
export interface GatherObservationsResult {
  /** Fed into the CMO prompt as reference material — prose, not rendered directly anywhere. */
  promptText: string;
  /** Executive-routed Observations, real and unmodified. */
  executiveObservations: Observation[];
  /** Every observation with a discrete occurredAt inside the recent window, most recent first. */
  recentActivity: Observation[];
  /** Department-routed observations — previously only dispatched as a side effect, now also returned so Risks can reuse them instead of re-deriving. */
  departmentObservations: Array<{ observation: Observation; department: string; reason: string }>;
}

function deriveRecentActivity(observations: Observation[], windowHours: number): Observation[] {
  const now = Date.now();
  return observations
    .filter((o) => {
      if (!o.occurredAt) return false;
      const ageHours = (now - new Date(o.occurredAt).getTime()) / 3_600_000;
      return ageHours >= 0 && ageHours <= windowHours;
    })
    .sort((a, b) => new Date(b.occurredAt!).getTime() - new Date(a.occurredAt!).getTime());
}

export async function gatherObservations(): Promise<GatherObservationsResult> {
  const { observations, unavailable } = await gatherAllObservations();

  const routed = routeObservations(observations);
  dispatchDepartmentObservations(routed.department);

  const { recentActivityWindowHours } = readObservationIntelligenceThresholds();
  const recentActivity = deriveRecentActivity(observations, recentActivityWindowHours);

  const parts: string[] = [];
  if (routed.executive.length > 0) {
    parts.push(routed.executive.map(formatObservation).join('\n\n'));
  }
  for (const u of unavailable) {
    parts.push(`### ${u.source}\n${u.source} isn't reporting right now (${u.reason}).`);
  }
  const promptText = parts.length > 0 ? parts.join('\n\n') : 'No Observation Sources have anything meaningful to report right now.';

  const departmentObservations = routed.department.map((d) => ({
    observation: d.observation,
    department: d.outcome.department,
    reason: d.outcome.reason,
  }));

  return { promptText, executiveObservations: routed.executive, recentActivity, departmentObservations };
}

// ---------------------------------------------------------------------------
// Operational Memory — what's actively in flight right now.
// ---------------------------------------------------------------------------
export async function gatherOperationalMemory(): Promise<SupabaseGatherResult> {
  try {
    const { data: inFlight, error: inFlightErr } = await supabase
      .from('content_items')
      .select('title, content_type, status')
      .eq('org_id', 'pintag')
      .in('status', ['draft', 'in_review', 'revising']);
    if (inFlightErr) throw inFlightErr;

    const { data: pendingApprovals, error: approvalsErr } = await supabase
      .from('approvals_queue')
      .select('reason, content_items(title, content_type)')
      .eq('org_id', 'pintag')
      .is('decided_at', null);
    if (approvalsErr) throw approvalsErr;

    const inFlightLines = (inFlight ?? []).length
      ? (inFlight ?? []).map((r: any) => `- ${r.title} (${r.content_type}) — ${r.status}`).join('\n')
      : 'Nothing is currently in draft, in review, or revising.';

    const approvalLines = (pendingApprovals ?? []).length
      ? (pendingApprovals ?? [])
          .map((r: any) => `- ${r.content_items?.title ?? 'Untitled'} — waiting on you (${r.reason})`)
          .join('\n')
      : 'Nothing is waiting on your approval right now.';

    return {
      available: true,
      summary: `In flight:\n${inFlightLines}\n\nAwaiting your approval:\n${approvalLines}`,
      pendingApprovalsCount: (pendingApprovals ?? []).length,
      pendingApprovals: (pendingApprovals ?? []).map((r: any) => ({
        title: r.content_items?.title ?? 'Untitled item',
        contentType: r.content_items?.content_type ?? 'content',
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, summary: `Operational Memory unavailable — no live Supabase connection (${message}).` };
  }
}

// ---------------------------------------------------------------------------
// Organizational Memory — what changed: recently published content.
// agent_health is now read exclusively by kpis.ts's calculateKPIs() (single
// source of truth for department health — see that file), so this no
// longer queries it.
// ---------------------------------------------------------------------------
export async function gatherOrganizationalMemory(): Promise<SupabaseGatherResult> {
  try {
    const cutoff = yesterday();
    const { data: published, error: publishedErr } = await supabase
      .from('content_items')
      .select('title, content_type, updated_at')
      .eq('org_id', 'pintag')
      .eq('status', 'published')
      .gte('updated_at', cutoff);
    if (publishedErr) throw publishedErr;

    const publishedLines = (published ?? []).length
      ? (published ?? []).map((r: any) => `- ${r.title} (${r.content_type}) published`).join('\n')
      : 'Nothing published since yesterday.';

    return {
      available: true,
      summary: `Published since yesterday:\n${publishedLines}`,
      publishedCount: (published ?? []).length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, summary: `Organizational Memory unavailable — no live Supabase connection (${message}).` };
  }
}

export function buildPrompt(sections: {
  intelligence: string;
  suggestions: string;
  observations: string;
  operational: SupabaseGatherResult;
  organizational: SupabaseGatherResult;
  departmentHealth: string;
}): string {
  return [
    "Write today's daily briefing for the founder — a short, first-person report in the voice of a trusted junior marketing strategist checking in with their manager. Warm but plain-spoken, confident without overselling, proactive rather than waiting to be asked. This is a message Marketing OS is initiating, not a form being filled out.",
    '',
    "Customers care about business outcomes, not about the machinery that produced them — never mention \"the Intelligence Layer\", \"Observation Sources\", \"TikTok's Display API\", or any other internal system/platform-API name in the prose itself. Translate what was learned (including what happened on TikTok) into what it means for the business: trends, what customers are asking, what content works, what to do about it.",
    '',
    'Structure it as:',
    '1. One-line headline capturing the single most important thing today.',
    '2. What I learned — framed as business implications (trends, what customers ask, what content performs, how recent content actually performed), grounded in the reference material below but never naming it as a system, layer, or platform API.',
    '3. What\'s in flight — if unavailable, say so plainly rather than guessing.',
    '4. What needs your attention (pending approvals + pending knowledge suggestions + any department health issues).',
    '5. A short closing narrative sentence on what to do next.',
    '',
    'Keep it under 200 words. No headers/bullet-heavy dashboard formatting inside the prose — write it as something a person would actually say out loud.',
    '',
    'Then, on their own final two lines, after the narrative, output exactly these two lines in this precise form (no other text on either line):',
    'RECOMMENDED ACTION: <a short, imperative, one-click-shaped action>',
    'WHY THIS MATTERS: <1-2 sentences explaining why this specific action is today\'s single highest-leverage move>',
    'The action is written the way a button label would read, e.g. "Generate Today\'s Educational Post", "Create a Financing FAQ", "Schedule Today\'s Content", "Restore the Supabase Connection". Exactly one action, never zero, never a list.',
    'The reasoning should teach the founder how Marketing OS is thinking — ground it in what actually happened (from the reference material below), not a generic justification. For example: "Two information-rich listing posts significantly outperformed the recent baseline while no other content format showed the same consistency. Repeating a winning format while audience demand is high is likely to produce the best return today."',
    '',
    '## What I learned (Intelligence Layer — newly verified knowledge since yesterday)',
    sections.intelligence,
    '',
    '## Knowledge Suggestions pending review',
    sections.suggestions,
    '',
    '## What happened in the real world (Observation Sources — already analyzed, each already answers what happened / why it matters / evidence; weave the substance into "What I learned" without naming the source platform\'s API)',
    sections.observations,
    '',
    '## Operational Memory (what\'s actively in flight)',
    sections.operational.summary,
    '',
    '## Organizational Memory (what changed, department health)',
    `${sections.organizational.summary}\n\nDepartment health issues:\n${sections.departmentHealth}`,
  ].join('\n');
}
