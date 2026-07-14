// Observation Intelligence (M2.5) — the routing stage between Observation
// Sources and the Daily Briefing. Design approved and recorded at
// departments/intelligence/OBSERVATION_INTELLIGENCE_DESIGN.md before being
// deliberately paused for the Founder Workspace milestones; this is that
// design, implemented as-is, not redesigned.
//
// Deterministic only — no LLM, no ML, no scoring model. Every Observation
// gets exactly one outcome: Ignore (nothing meaningful, don't spend tokens,
// don't show the founder), Department (meaningful, but not the founder's
// problem right now — routed to an existing system, not a new inbox), or
// Executive (reaches the CEO Workspace). "Who should care?" is answered by
// which outcome an observation gets, not a separate field.
//
// Same "ordered list of small independent handlers behind one aggregator"
// pattern already used for Knowledge Layer source adapters and Observation
// Sources themselves — a third application, not a new one.

import { proposeSuggestion } from './suggestions.js';
import { readObservationIntelligenceThresholds } from './config.js';
import type { Observation } from './observations.js';

export type RoutingOutcome =
  | { decision: 'ignore'; reason: string }
  | { decision: 'department'; department: string; reason: string }
  | { decision: 'executive'; reason: string };

export type RoutingRule = (observation: Observation) => RoutingOutcome | undefined;

const tiktokRules: RoutingRule[] = [
  // Already explicitly non-comparative context (no persisted baseline to
  // claim a trend from — see tiktok.ts's buildObservations()) — nothing
  // meaningful to notice yet.
  (o) => (o.source === 'tiktok' && o.kind === 'account_snapshot' ? { decision: 'ignore', reason: 'Account snapshot is context, not a comparison — no trend claimed.' } : undefined),

  (o) => {
    if (o.source !== 'tiktok' || o.kind !== 'video_performance') return undefined;
    const ratio = typeof o.data.ratio === 'number' ? o.data.ratio : undefined;
    if (ratio === undefined) return undefined;
    const { outperformRatio, underperformRatio } = readObservationIntelligenceThresholds();
    if (ratio >= outperformRatio) {
      return { decision: 'executive', reason: `Video performance ratio ${ratio.toFixed(2)} >= outperform threshold ${outperformRatio}.` };
    }
    if (ratio <= underperformRatio) {
      return { decision: 'department', department: 'writer', reason: `Video performance ratio ${ratio.toFixed(2)} <= underperform threshold ${underperformRatio} — real signal, not founder-urgent.` };
    }
    return { decision: 'ignore', reason: `Video performance ratio ${ratio.toFixed(2)} is within the routine range.` };
  },
];

const genericRules: RoutingRule[] = [
  // "Integration failure -> Platform" / "Authentication failure -> Platform"
  // — matches any source's source_error kind, not just TikTok's, so a
  // future second source gets this for free.
  (o) => (o.kind === 'source_error' ? { decision: 'department', department: 'platform', reason: 'A configured source stopped reporting.' } : undefined),
];

/**
 * Required, always-matching catch-all — so no observation is ever silently
 * "unmatched" in a way nobody could discover. Defaults to ignore (matches
 * "notice only meaningful change": the safe default when a rule genuinely
 * doesn't exist yet is silence, not noise) but warns, so a real operator
 * notices a genuinely new/unhandled observation kind exists — visible
 * during real use, same "real usage creates the backlog" discipline as the
 * Intelligence Department's own operating log.
 */
const catchAllRule: RoutingRule = (o) => {
  console.warn(`[Observation Intelligence] No rule matched ${o.source}/${o.kind} — defaulting to ignore. Consider adding a rule.`);
  return { decision: 'ignore', reason: 'No matching rule (see console warning) — defaulted to ignore.' };
};

/**
 * New sources/departments register rules by appending to this array (or,
 * once genuinely large, splitting into observation-intelligence/rules/
 * <source>.ts files aggregated here — the same scaling path
 * knowledge-sources/ and observation-sources/ already established, not
 * pre-built now for a single-digit rule count).
 */
export const ROUTING_RULES: RoutingRule[] = [...tiktokRules, ...genericRules, catchAllRule];

export function classifyObservation(observation: Observation): RoutingOutcome {
  for (const rule of ROUTING_RULES) {
    const outcome = rule(observation);
    if (outcome) return outcome;
  }
  // Unreachable — catchAllRule always matches — but keeps the return type
  // total rather than possibly-undefined.
  return { decision: 'ignore', reason: 'No rule matched.' };
}

export interface RoutedObservations {
  executive: Observation[];
  department: Array<{ observation: Observation; outcome: Extract<RoutingOutcome, { decision: 'department' }> }>;
  ignored: Array<{ observation: Observation; outcome: Extract<RoutingOutcome, { decision: 'ignore' }> }>;
}

export function routeObservations(observations: Observation[]): RoutedObservations {
  const result: RoutedObservations = { executive: [], department: [], ignored: [] };
  for (const observation of observations) {
    const outcome = classifyObservation(observation);
    if (outcome.decision === 'executive') result.executive.push(observation);
    else if (outcome.decision === 'department') result.department.push({ observation, outcome });
    else result.ignored.push({ observation, outcome });
  }
  return result;
}

/**
 * Dispatches Department-routed observations to whichever existing system
 * already fits that department's shape — not a new inbox. Writer/research-
 * shaped observations are knowledge candidates (proposeSuggestion(),
 * already built); Platform-shaped ones (source_error) are operational
 * alerts, not knowledge — forcing them into the Knowledge Suggestion
 * System would repeat the exact category error already flagged once for
 * knowledge/brands/pintag/. No real Platform inbox exists yet — console.warn
 * is the honest placeholder until one does.
 */
export function dispatchDepartmentObservations(routed: RoutedObservations['department']): void {
  for (const { observation, outcome } of routed) {
    if (outcome.department === 'platform') {
      console.warn(`[Observation Intelligence -> Platform] ${observation.source}: ${observation.whatHappened} (${outcome.reason})`);
      continue;
    }

    // Writer, research, analytics, ... — knowledge-shaped department
    // observations all go through the same mailbox every other source
    // already uses.
    proposeSuggestion({
      kind: 'marketing-observation',
      sourceAgent: 'observation-intelligence',
      title: observation.whatHappened.length > 100 ? `${observation.whatHappened.slice(0, 97)}...` : observation.whatHappened,
      body: `${observation.whyItMatters}\n\nEvidence: ${observation.evidence.join('; ')}\n\nRouted to: ${outcome.department} — ${outcome.reason}`,
      suggestedCategory: 'marketing',
      suggestedTags: ['observation-intelligence', outcome.department],
      confidence: 0.6,
      context: `Observation Intelligence, ${observation.source}/${observation.kind}, ${observation.observedAt}`,
    });
  }
}
