// Campaign execution — CLI entry point, terminal twin of the Founder
// Workspace's campaign buttons. Same orchestrator, same persisted
// Campaign, same generation-only scope — see services/campaign/generate.ts.
//
// Single mode:
//   npm run campaign -- "Explain why listings display both rental and sale prices"
//   Optional second argument: supporting context for the strategist.
//   Scored first (deterministic), then executed regardless of priority —
//   a founder-typed topic is a decision, the score just informs.
//
// Top-N mode (M3 — the daily funnel):
//   npm run campaign -- --top
//   Scores EVERY opportunity on the latest Morning Brief, prints the full
//   scoreboard, generates campaigns for only the configured top N
//   (brain/org-config.json campaigns.top_n). Low priority is never
//   selected. Predictable spend by construction.
//
// Output: content-vault/campaigns/<id>/campaign.json per campaign; review
// on the Founder Workspace (npm run founder-ui → /campaigns).

import { createCampaign, executeCampaign } from './services/campaign/generate.js';
import { scoreOpportunity, scoreOpportunities, selectTopOpportunities } from './services/campaign/score.js';
import { readLatestMorningBrief } from './services/morning/persist.js';
import { readCampaignConfig } from './lib/config.js';
import type { Campaign, ScorableOpportunity } from './services/campaign/types.js';

function reportOutcome(result: Campaign): boolean {
  if (result.status === 'complete') {
    console.log(`[Campaign] Complete: ${result.title} → content-vault/campaigns/${result.id}/campaign.json`);
    if (result.qaReport && !result.qaReport.approved) {
      console.log(`[Campaign]   Brand Guardian flagged ${result.qaReport.issues.length} issue(s) — review before using this content.`);
    }
    return true;
  }
  const failed = result.steps.find((s) => s.status === 'failed');
  console.error(`[Campaign] Stopped at ${failed?.label ?? 'unknown step'}: ${failed?.detail ?? 'unknown error'}`);
  console.error(`[Campaign]   Partial results saved to content-vault/campaigns/${result.id}/campaign.json`);
  return false;
}

async function runSingle(title: string, detail: string): Promise<boolean> {
  const score = await scoreOpportunity({ title, detail, evidence: [], kind: 'manual' });
  console.log(`[Campaign] Scored ${score.total}/100 (${score.priority} priority, confidence ${score.confidencePercent}%)`);
  const campaign = createCampaign({ title, detail, source: 'manual' }, score);
  console.log(`[Campaign] Created ${campaign.id} — executing departments…`);
  return reportOutcome(await executeCampaign(campaign));
}

async function runTop(): Promise<boolean> {
  const brief = readLatestMorningBrief();
  const candidates: ScorableOpportunity[] = (brief?.opportunities ?? []).map((o) => ({
    title: o.title,
    detail: o.detail,
    evidence: o.evidence,
    kind: o.kind,
    confidenceLevel: o.confidenceLevel,
  }));
  if (brief?.recommendedAction) {
    candidates.push({ title: brief.recommendedAction, detail: brief.recommendedActionReasoning ?? '', evidence: [], kind: 'recommended-action' });
  }
  if (candidates.length === 0) {
    console.error('[Campaign] The latest Morning Brief has no opportunities to score — run `npm run daily-briefing` first.');
    return false;
  }

  const scored = await scoreOpportunities(candidates);
  const selected = selectTopOpportunities(scored);
  const selectedTitles = new Set(selected.map((s) => s.opportunity.title));

  console.log(`[Campaign] Scored ${scored.length} opportunit${scored.length === 1 ? 'y' : 'ies'} (top ${readCampaignConfig().topN} generate):`);
  for (const { opportunity, score } of [...scored].sort((a, b) => b.score.total - a.score.total)) {
    const mark = selectedTitles.has(opportunity.title) ? '→ GENERATE' : score.priority === 'low' ? '  (low priority, never selected)' : '  (below cutoff)';
    console.log(`  ${String(score.total).padStart(3)}/100  ${score.priority.padEnd(6)}  ${opportunity.title}  ${mark}`);
  }

  let allOk = true;
  for (const { opportunity, score } of selected) {
    const campaign = createCampaign({ title: opportunity.title, detail: opportunity.detail, source: opportunity.kind }, score);
    console.log(`\n[Campaign] Executing ${campaign.id}…`);
    if (!reportOutcome(await executeCampaign(campaign))) allOk = false;
  }
  return allOk;
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--top') {
    if (!(await runTop())) process.exit(1);
    return;
  }

  const [title, detail] = args;
  if (!title || !title.trim()) {
    console.error('Usage: npm run campaign -- "<opportunity title>" ["supporting context"]');
    console.error('       npm run campaign -- --top   (score all Morning Brief opportunities, generate the top N)');
    process.exit(1);
  }
  if (!(await runSingle(title.trim(), (detail ?? '').trim()))) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
