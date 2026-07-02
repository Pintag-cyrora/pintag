// CLI entry point, invoked headlessly by .github/workflows/daily-content-pipeline.yml.
// Wires the stages together per the architecture doc's pipeline diagram
// (Section 4): Sense -> Research -> Plan -> Write -> Design/Video ->
// Guardian Review (loop on 'revise') -> Schedule -> Publish -> Analyze -> Memory Update.
//
// M0 ships this as a real skeleton with every stage stubbed and typed
// (see pipeline/stages/*.ts) — filling in each TODO is the work of
// milestones M1-M5 in the roadmap, one content type/capability at a time.
// Deliberately not wired end-to-end yet: running this today would only
// exercise stubs. It exists so the shape of the orchestration is settled
// before any single stage is implemented for real.

import { runTrendHunter, runCompetitorWatch } from './stages/00-sense.js';
import { planNextBrief } from './stages/02-plan.js';
import { research } from './stages/01-research.js';
import { write } from './stages/03-write.js';
import { guardianReview, meetsThreshold } from './stages/06-guardian-review.js';
import { loadRuntimeConfig } from './lib/config.js';

async function main() {
  await runTrendHunter();
  await runCompetitorWatch();

  const config = await loadRuntimeConfig();
  if (config.founderMode === 'vacation') {
    console.log('Founder Mode: vacation — skipping new strategy generation this run.');
    return;
  }

  const brief = await planNextBrief();
  if (!brief) {
    console.log('Nothing due to plan this run.');
    return;
  }

  const researchPacket = await research(brief);
  const draft = await write(brief, researchPacket);

  let reviewPass = 1;
  let result = await guardianReview(draft, reviewPass);
  while (
    result.verdict === 'revise' &&
    reviewPass < config.qualityScore.maxRevisionCycles &&
    !meetsThreshold(result, config.qualityScore.minThresholdPerDimension)
  ) {
    reviewPass += 1;
    result = await guardianReview(draft, reviewPass);
  }

  console.log(`Pipeline run complete for "${draft.title}" — verdict: ${result.verdict}`);
  // TODO: Stage 4/5 (design/video), 7 (schedule), 8 (publish) wiring lands
  // in M1-M4 as each stage moves from stub to real implementation.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
