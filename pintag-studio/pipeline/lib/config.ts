import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { supabase } from './supabase.js';
import type { RuntimeConfig, FounderMode, ApprovalPhase } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORG_CONFIG_PATH = join(__dirname, '..', '..', 'brain', 'org-config.json');

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
