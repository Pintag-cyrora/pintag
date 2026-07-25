// Campaign execution — CLI entry point, terminal twin of the Founder
// Workspace's Execute Campaign button (founder-server.ts POST
// /campaign/execute). Same orchestrator, same persisted Campaign, same
// generation-only scope — see services/campaign/generate.ts.
//
// Run: npm run campaign -- "Explain why listings display both rental and sale prices"
// Optional second argument: supporting context for the CMO step.
// Output: content-vault/campaigns/<id>/campaign.json, progress logged per
// department as it runs. Review the result on the Founder Workspace's
// Research / Content / Video / Publish tabs (npm run founder-ui).

import { createCampaign, executeCampaign } from './services/campaign/generate.js';

async function main() {
  const [title, detail] = process.argv.slice(2);
  if (!title || !title.trim()) {
    console.error('Usage: npm run campaign -- "<opportunity title>" ["supporting context"]');
    process.exit(1);
  }

  const campaign = createCampaign({ title: title.trim(), detail: (detail ?? '').trim(), source: 'manual' });
  console.log(`[Campaign] Created ${campaign.id} — executing all departments…`);

  const result = await executeCampaign(campaign);

  if (result.status === 'complete') {
    console.log(`[Campaign] Complete. Saved to content-vault/campaigns/${result.id}/campaign.json`);
    if (result.qaReport && !result.qaReport.approved) {
      console.log(`[Campaign] Brand Guardian flagged ${result.qaReport.issues.length} issue(s) — review the Publish tab before using this content.`);
    }
  } else {
    const failed = result.steps.find((s) => s.status === 'failed');
    console.error(`[Campaign] Stopped at ${failed?.label ?? 'unknown step'}: ${failed?.detail ?? 'unknown error'}`);
    console.error(`[Campaign] Partial results saved to content-vault/campaigns/${result.id}/campaign.json`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
