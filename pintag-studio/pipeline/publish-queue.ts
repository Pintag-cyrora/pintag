// CLI entry point, invoked by .github/workflows/publish-queue.yml on a short
// interval. Picks up content_calendar items whose founder-approval decision
// is in — from the Dashboard once it's hosted, or from Supabase Studio in
// the meantime (see M1 verification notes) — and runs Publish -> Analyze ->
// Memory Update to completion.
//
// This is deliberately a separate entry point from run.ts (which produces
// drafts up to the approval gate), matching the two real GitHub Actions
// workflows: content generation and publishing run on different schedules
// because a human decision sits between them.

import { getApprovedPendingItems, publishApprovedItem } from './stages/08-publish.js';
import { collectPerformance } from './stages/09-analyze.js';
import { updateMemory } from './stages/10-memory-update.js';
import { supabase } from './lib/supabase.js';

async function main() {
  const pending = await getApprovedPendingItems();
  if (pending.length === 0) {
    console.log('[publish-queue] Nothing approved and awaiting publish.');
    return;
  }

  let failures = 0;

  // Each item is independent — one failure shouldn't block the rest of a
  // batch waiting in the queue; it just gets picked up again next run.
  for (const { calendarId, contentItemId } of pending) {
    try {
      const { data: item, error: itemErr } = await supabase
        .from('content_items')
        .select('title')
        .eq('id', contentItemId)
        .single();
      if (itemErr || !item) throw new Error(`Failed to load content_items ${contentItemId}: ${itemErr?.message}`);

      console.log(`[publish-queue] Publishing "${item.title}" (content_item=${contentItemId}, calendar=${calendarId})`);

      const { platform } = await publishApprovedItem(calendarId);

      if (platform === 'facebook' || platform === 'instagram') {
        await collectPerformance(contentItemId, platform);
      } else {
        console.log(`[publish-queue] Skipping performance collection for "${platform}" — not yet supported (see 09-analyze.ts).`);
      }

      await updateMemory(contentItemId, item.title);

      console.log(`[publish-queue] Complete: "${item.title}" published, analyzed, and memory updated.`);
    } catch (err) {
      failures += 1;
      console.error(`[publish-queue] Failed to process calendar item ${calendarId}:`, err);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${pending.length} approved item(s) failed to publish this run.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
