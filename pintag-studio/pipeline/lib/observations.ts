// Observation Sources — the generic framework any external system (TikTok,
// Facebook, Instagram, Gmail, Calendar, Google Analytics, Stripe, ...) plugs
// into to tell Marketing OS what happened in the real world. Mirrors a
// pattern already used twice in this codebase: retrieveKnowledge()'s source
// adapters (knowledge/ files + brain/lao/dictionary.md, merged
// transparently — see knowledge.ts) and gatherOperationalMemory()'s
// {available, ...} graceful-degradation shape. This is the third
// application of the same idea, not a new one.
//
// The Daily Briefing (pipeline/daily-briefing.ts) never knows or cares which
// source produced an Observation — it only ever consumes Observation[].
// Adding a second source is one new file under observation-sources/ plus one
// line in SOURCES below; nothing else in the pipeline changes.

/**
 * One real-world fact, in the shape every Observation Source must answer:
 * what happened, why it matters, what evidence supports it. This is the
 * shape the CMO consumes — never raw metrics directly.
 */
export interface Observation {
  /** Stable per real-world fact (e.g. the source platform's own video id) — so a future diff pass can tell "new" from "unchanged" without a redesign. Not used for deduping today; observations aren't persisted (see gatherAllObservations()'s header note). */
  id: string;
  /** Which Observation Source produced this — 'tiktok' today. */
  source: string;
  /** What kind of fact this is, e.g. 'account_snapshot' | 'video_performance'. Source-defined, not a closed union — the Daily Briefing never branches on it. */
  kind: string;
  /** When Marketing OS captured this observation. */
  observedAt: string;
  /** When the real-world event happened, if meaningfully different from observedAt. */
  occurredAt?: string;
  whatHappened: string;
  whyItMatters: string;
  /** Concrete, real numbers/facts backing whyItMatters — never invented, never left implicit. */
  evidence: string[];
  /** Raw structured payload, for anything a future consumer needs beyond the three fields above. */
  data: Record<string, unknown>;
}

export interface ObservationSourceResult {
  available: boolean;
  observations: Observation[];
  /** Set when available is false — why this source couldn't report right now (not configured, token expired, network error, ...). */
  error?: string;
}

export interface ObservationSource {
  name: string;
  /** Cheap, synchronous "is this source even set up" check (env vars present) — the real "do we have a valid token" check happens inside observe(), which degrades gracefully rather than throwing. */
  isConfigured(): boolean;
  observe(): Promise<ObservationSourceResult>;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.js';
import { tiktokObservationSource } from './observation-sources/tiktok.js';

const SOURCES: ObservationSource[] = [tiktokObservationSource];

export interface GatherAllObservationsResult {
  observations: Observation[];
  /** Sources that didn't contribute this run, and why — so the Daily Briefing can be honest about gaps instead of silently omitting them. */
  unavailable: Array<{ source: string; reason: string }>;
}

/**
 * The one entry point pipeline/daily-briefing.ts calls. Observations
 * themselves are Operational Memory (see MEMORY_MODEL.md): computed fresh
 * every run from a live API call, never persisted here or in Supabase — the
 * same choice gatherOperationalMemory() already makes for content_items/
 * approvals_queue rather than caching them. A real trend/diff view over time
 * is a deliberate future step (same "change-aware, not snapshot" direction
 * already flagged in daily-briefing.ts from M2), not built here.
 *
 * `unavailable` stays a simple, unclassified diagnostic list — the Founder
 * Workspace's /observations page reads it directly to answer "is this
 * connected at all," which should never depend on a routing decision. A
 * genuine failure of an already-configured source (not simply "never
 * connected yet") ALSO becomes a real `source_error` Observation, so
 * Observation Intelligence (M2.5) can route it like anything else — this is
 * what makes "Integration failure -> Platform" possible. "Not configured"
 * deliberately does NOT synthesize one: there's nothing broken to route,
 * just a one-time setup step (npm run tiktok:connect) nobody's done yet.
 */
export async function gatherAllObservations(): Promise<GatherAllObservationsResult> {
  const observations: Observation[] = [];
  const unavailable: Array<{ source: string; reason: string }> = [];

  for (const src of SOURCES) {
    if (!src.isConfigured()) {
      unavailable.push({ source: src.name, reason: 'not configured' });
      continue;
    }
    const result = await src.observe();
    if (result.available) {
      observations.push(...result.observations);
    } else {
      const reason = result.error ?? 'unavailable';
      unavailable.push({ source: src.name, reason });
      observations.push({
        id: `${src.name}-source-error-${new Date().toISOString().slice(0, 10)}`,
        source: src.name,
        kind: 'source_error',
        observedAt: new Date().toISOString(),
        whatHappened: `${src.name} stopped reporting: ${reason}.`,
        whyItMatters: 'A source that was working is no longer providing data — worth checking before it affects tomorrow\'s briefing too.',
        evidence: [reason],
        data: { reason },
      });
    }
  }

  return { observations, unavailable };
}

/** One Observation formatted in its three-question shape, for the CMO prompt. */
export function formatObservation(o: Observation): string {
  return [`### ${o.source} — ${o.kind}`, `What happened: ${o.whatHappened}`, `Why it matters: ${o.whyItMatters}`, `Evidence: ${o.evidence.join('; ')}`].join('\n');
}

export interface ObservationIntelligenceThresholds {
  outperformRatio: number;
  underperformRatio: number;
}

const DEFAULT_THRESHOLDS: ObservationIntelligenceThresholds = { outperformRatio: 1.3, underperformRatio: 0.7 };

/**
 * Read once, from one place, by both the TikTok source (which describes a
 * video's performance in prose) and observation-intelligence.ts (which
 * routes on the same comparison) — so the two can never disagree about
 * what counts as "significant." brain/org-config.json is the config-driven
 * home for this per CLAUDE.md's standing rule; a missing/malformed value
 * falls back to the documented defaults rather than crashing observation
 * gathering over a config typo.
 */
export function readObservationIntelligenceThresholds(): ObservationIntelligenceThresholds {
  try {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'brain', 'org-config.json'), 'utf-8'));
    const oi = config.observation_intelligence;
    return {
      outperformRatio: typeof oi?.video_performance_outperform_ratio === 'number' ? oi.video_performance_outperform_ratio : DEFAULT_THRESHOLDS.outperformRatio,
      underperformRatio: typeof oi?.video_performance_underperform_ratio === 'number' ? oi.video_performance_underperform_ratio : DEFAULT_THRESHOLDS.underperformRatio,
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}
