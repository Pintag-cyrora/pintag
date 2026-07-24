import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { supabase } from './supabase.js';
import type { RuntimeConfig, FounderMode, ApprovalPhase } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** pintag-studio/ — the one place this is computed; every other file needing file-system paths should import this instead of re-deriving it. */
export const REPO_ROOT = join(__dirname, '..', '..');

const ORG_CONFIG_PATH = join(REPO_ROOT, 'brain', 'org-config.json');

/**
 * Loads the merged runtime config: static structure from brain/org-config.json
 * (org identity, quality-score weights/thresholds, auto-publish eligibility
 * rules — reviewed like code, changes rarely) overlaid with live state from
 * the Supabase `org_settings` table (founder_mode, approval_phase, pinned
 * campaign — Dashboard-editable, changes with a click).
 *
 * This is the one place every pipeline stage should read config from, so
 * Founder Mode behavior stays data-driven rather than branching per-agent.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const staticConfig = JSON.parse(readFileSync(ORG_CONFIG_PATH, 'utf-8'));

  const { data: settings, error } = await supabase
    .from('org_settings')
    .select('*')
    .eq('org_id', staticConfig.org.name.toLowerCase())
    .single();

  if (error || !settings) {
    throw new Error(
      `Could not load org_settings from Supabase (${error?.message ?? 'no row'}). ` +
        `Has the pintag-studio Supabase project been provisioned and migrated? See SETUP.md.`
    );
  }

  const founderMode = settings.founder_mode as FounderMode;
  const modeOverrides = staticConfig.founder_modes[founderMode] ?? {};

  return {
    orgId: staticConfig.org.name.toLowerCase(),
    founderMode,
    approvalPhase: settings.approval_phase as ApprovalPhase,
    pinnedCampaignId: settings.pinned_campaign_id ?? modeOverrides.pinned_campaign_id ?? null,
    autoPublishEligible: Object.fromEntries(
      Object.entries(staticConfig.auto_publish_eligible).map(([type, cfg]: [string, any]) => [
        type,
        { minConfidence: cfg.min_confidence, eligibleFromPhase: cfg.eligible_from_phase },
      ])
    ),
    qualityScore: {
      weights: staticConfig.quality_score.weights,
      minThresholdPerDimension: staticConfig.quality_score.min_threshold_per_dimension,
      maxRevisionCycles: staticConfig.quality_score.max_revision_cycles,
    },
  };
}

export interface ObservationIntelligenceThresholds {
  outperformRatio: number;
  underperformRatio: number;
  /** Minimum occurrences for "medium" confidence (M2.6 — Emerging Playbooks). */
  confidenceMediumMinOccurrences: number;
  /** Minimum occurrences for "high" confidence. */
  confidenceHighMinOccurrences: number;
  /** Minimum days between the first and last occurrence for "high" confidence — a burst of same-day posts isn't the same evidence as a pattern proven over time. */
  confidenceHighMinSpanDays: number;
  /** How long an observation counts as "recent" for the Executive Brief's Recent Activity section (M2.8 — Recent Activity vs. Pattern Detection). Presentation-layer only — never read by Observation Intelligence or any Observation Source. */
  recentActivityWindowHours: number;
  /** Below this age, Recent Activity reports "too early to judge" rather than attempting a baseline comparison off a near-zero sample. */
  recentActivityMinAgeHoursForComparison: number;
}

const DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS: ObservationIntelligenceThresholds = {
  outperformRatio: 1.3,
  underperformRatio: 0.7,
  confidenceMediumMinOccurrences: 2,
  confidenceHighMinOccurrences: 5,
  confidenceHighMinSpanDays: 14,
  recentActivityWindowHours: 48,
  recentActivityMinAgeHoursForComparison: 3,
};

/**
 * Read once, from one place, by both the TikTok source (which describes a
 * video's performance in prose) and observation-intelligence.ts (which
 * routes on the same comparison) — so the two can never disagree about what
 * counts as "significant." Lives here rather than in observations.ts
 * because observation-sources/tiktok.ts needs it and is itself imported by
 * observations.ts — putting it there created a real circular import
 * (tiktok.ts -> observations.ts -> tiktok.ts), not just a type-only one.
 * config.ts sits below both, with no dependency on either, so nothing
 * importing this creates a cycle. A missing/malformed config value falls
 * back to the documented defaults rather than crashing observation
 * gathering over a config typo.
 */
export function readObservationIntelligenceThresholds(): ObservationIntelligenceThresholds {
  try {
    const config = JSON.parse(readFileSync(ORG_CONFIG_PATH, 'utf-8'));
    const oi = config.observation_intelligence;
    return {
      outperformRatio: typeof oi?.video_performance_outperform_ratio === 'number' ? oi.video_performance_outperform_ratio : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.outperformRatio,
      underperformRatio: typeof oi?.video_performance_underperform_ratio === 'number' ? oi.video_performance_underperform_ratio : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.underperformRatio,
      confidenceMediumMinOccurrences:
        typeof oi?.confidence_medium_min_occurrences === 'number' ? oi.confidence_medium_min_occurrences : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.confidenceMediumMinOccurrences,
      confidenceHighMinOccurrences:
        typeof oi?.confidence_high_min_occurrences === 'number' ? oi.confidence_high_min_occurrences : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.confidenceHighMinOccurrences,
      confidenceHighMinSpanDays:
        typeof oi?.confidence_high_min_span_days === 'number' ? oi.confidence_high_min_span_days : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.confidenceHighMinSpanDays,
      recentActivityWindowHours:
        typeof oi?.recent_activity_window_hours === 'number' ? oi.recent_activity_window_hours : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.recentActivityWindowHours,
      recentActivityMinAgeHoursForComparison:
        typeof oi?.recent_activity_min_age_hours_for_comparison === 'number'
          ? oi.recent_activity_min_age_hours_for_comparison
          : DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS.recentActivityMinAgeHoursForComparison,
    };
  } catch {
    return DEFAULT_OBSERVATION_INTELLIGENCE_THRESHOLDS;
  }
}

/** Reads brain/org-config.json's founder name — used by every founder-facing greeting (Founder Workspace routes, the Morning Brief). Falls back to a generic greeting on any read error rather than crashing a page over a config typo. */
export function readFounderName(): string {
  try {
    const config = JSON.parse(readFileSync(ORG_CONFIG_PATH, 'utf-8'));
    return config.org?.founder ?? 'there';
  } catch {
    return 'there';
  }
}

/** Reads today's single active company (org.name) from org-config.json. Not a switcher — no second company exists yet; structured so a second org.name later is a data change, not a redesign. */
export function readActiveCompanyName(): string {
  try {
    const config = JSON.parse(readFileSync(ORG_CONFIG_PATH, 'utf-8'));
    return config.org?.name ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

export interface MorningBriefConfig {
  /** How long a generated Morning Brief stays "fresh" before GET /morning triggers a background regeneration. */
  stalenessThresholdMinutes: number;
}

const DEFAULT_MORNING_BRIEF_CONFIG: MorningBriefConfig = {
  stalenessThresholdMinutes: 60,
};

/** Same read-once/fall-back-to-defaults discipline as readObservationIntelligenceThresholds() above. */
export function readMorningBriefConfig(): MorningBriefConfig {
  try {
    const config = JSON.parse(readFileSync(ORG_CONFIG_PATH, 'utf-8'));
    const mb = config.morning_brief;
    return {
      stalenessThresholdMinutes: typeof mb?.staleness_threshold_minutes === 'number' ? mb.staleness_threshold_minutes : DEFAULT_MORNING_BRIEF_CONFIG.stalenessThresholdMinutes,
    };
  } catch {
    return DEFAULT_MORNING_BRIEF_CONFIG;
  }
}

/**
 * Given the runtime config and a content item, decides whether Publisher
 * should auto-publish or hold for founder approval. Kept as one small pure
 * function (not branching scattered through Publisher) per the "configuration
 * over branching logic" principle in the architecture doc, Section 10.
 */
export function shouldAutoPublish(
  config: RuntimeConfig,
  contentType: string,
  guardianConfidence: number
): boolean {
  if (config.founderMode === 'manual') return false; // hard override, always gated

  const rule = config.autoPublishEligible[contentType];
  if (!rule || rule.eligibleFromPhase === 'never' || rule.minConfidence === null) return false;

  const phaseOrder: Record<string, number> = { phase_1: 1, phase_2: 2, phase_3: 3 };
  if (phaseOrder[config.approvalPhase] < phaseOrder[rule.eligibleFromPhase]) return false;

  let threshold = rule.minConfidence;
  if (config.founderMode === 'busy') threshold += -0.05; // matches founder_modes.busy.auto_publish_threshold_delta

  return guardianConfidence >= threshold;
}
