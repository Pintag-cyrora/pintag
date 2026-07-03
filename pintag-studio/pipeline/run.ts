// CLI entry point, invoked headlessly by .github/workflows/daily-content-pipeline.yml.
// Wires the stages together per the architecture doc's pipeline diagram
// (Section 4): Sense -> Plan -> Research -> Write -> Design/Video ->
// Guardian Review (loop on 'revise') -> Schedule -> Publish (or queue for
// approval) -> [pipeline/publish-queue.ts picks up from here once the
// founder decides] -> Analyze -> Memory Update.
// Plan runs before Research: a brief has to exist before it can be researched.

import { runTrendHunter, runCompetitorWatch } from './stages/00-sense.js';
import { planNextBrief } from './stages/01-plan.js';
import { research } from './stages/02-research.js';
import { write, revise } from './stages/03-write.js';
import { design } from './stages/04-design.js';
import { guardianReview } from './stages/06-guardian-review.js';
import { schedule } from './stages/07-schedule.js';
import { processCalendarItem } from './stages/08-publish.js';
import { collectPerformance } from './stages/09-analyze.js';
import { updateMemory } from './stages/10-memory-update.js';
import { loadRuntimeConfig } from './lib/config.js';
import { reportHealth } from './lib/health.js';
import type { Draft } from './lib/types.js';

async function main() {
  await runTrendHunter();
  await runCompetitorWatch();

  // The CMO doesn't have its own pipeline stage file (its output is the
  // monthly brief the Content Strategist plans against, not a stage in the
  // daily run) — its health reflects whether orchestration itself, i.e. this
  // function, completes the run without error. See the outer .catch() below.
  const config = await loadRuntimeConfig();
  if (config.founderMode === 'vacation') {
    console.log('Founder Mode: vacation — skipping new strategy generation this run.');
    await reportHealth('cmo', 'healthy');
    return;
  }

  const brief = await planNextBrief();
  if (!brief) {
    console.log('Nothing due to plan this run.');
    await reportHealth('cmo', 'healthy');
    return;
  }

  const researchPacket = await research(brief);
  let draft: Draft = await write(brief, researchPacket);

  // Runs today too, even though Graphic Designer has nothing to produce yet
  // for text-only educational posts (M2 scope) — Brand Guardian is built to
  // treat visualQuality as "not applicable" rather than "failing" when no
  // assets exist, so calling this now costs nothing and keeps the pipeline's
  // shape identical to what a property_video or neighborhood_guide item will
  // exercise once Stage 04/05 are real.
  await design(draft);

  let reviewPass = 1;
  let result = await guardianReview(draft, reviewPass);
  while (result.verdict === 'revise' && reviewPass < config.qualityScore.maxRevisionCycles) {
    draft = await revise(draft, result.revisionNotes ?? 'No specific notes provided.');
    reviewPass += 1;
    result = await guardianReview(draft, reviewPass);
  }

  console.log(`[run.ts] Guardian verdict for "${draft.title}": ${result.verdict} (composite=${result.compositeScore.toFixed(3)}, pass ${reviewPass})`);

  if (result.verdict !== 'pass') {
    console.log(`[run.ts] Item ${draft.contentItemId} exhausted its revision budget without passing — leaving it in 'revising' for founder attention rather than scheduling it.`);
    await reportHealth('cmo', 'healthy');
    return;
  }

  // Schedules for the first target platform only. Scheduling the same
  // content item across multiple platforms under one shared approval
  // decision is a real design question (approvals_queue is keyed per
  // content item, not per platform) — deliberately not resolved here per
  // "don't redesign preemptively"; flagged for discussion after M1.
  const platform = brief.targetPlatforms[0];
  const calendarId = await schedule(brief.contentItemId, platform, new Date(), brief.contentType);
  const publishOutcome = await processCalendarItem(calendarId, brief.contentItemId, brief.contentType, result.scores.confidence);

  if (publishOutcome.outcome === 'published') {
    // Auto-publish happened synchronously right here — Stage 09/10 need to
    // run now, since there's no separate approval event to trigger them via
    // publish-queue.ts the way there is for the founder-approval path.
    if (publishOutcome.platform === 'facebook' || publishOutcome.platform === 'instagram') {
      await collectPerformance(brief.contentItemId, publishOutcome.platform);
    } else {
      console.log(`[run.ts] Skipping performance collection for "${publishOutcome.platform}" — not yet supported (see 09-analyze.ts).`);
    }
    await updateMemory(brief.contentItemId, draft.title);
    console.log(`[run.ts] Auto-published, analyzed, and updated memory for "${draft.title}" (content_item=${brief.contentItemId}).`);
  } else {
    console.log(`[run.ts] "${draft.title}" is awaiting founder approval (content_item=${brief.contentItemId}, calendar=${calendarId}).`);
  }

  await reportHealth('cmo', 'healthy');
}

main().catch(async (err) => {
  await reportHealth('cmo', 'down', err instanceof Error ? err.message : 'Unknown pipeline error');
  console.error(err);
  process.exit(1);
});
