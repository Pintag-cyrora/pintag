// Stage 8 — Publish. Phase- and Founder-Mode-aware: decides auto-publish vs.
// hold-for-approval, then (once approved, whether automatically or by the
// founder) posts via Meta Graph API.
//
// Corresponding agent: .claude/agents/publisher.md
// Reads from: content_calendar, org_settings (via loadRuntimeConfig)
// Writes to: content_calendar (publish_status, post_id, post_url), approvals_queue

import { supabase } from '../lib/supabase.js';
import { loadRuntimeConfig, shouldAutoPublish } from '../lib/config.js';
import type { ContentType } from '../lib/types.js';

export async function processCalendarItem(
  calendarId: string,
  contentItemId: string,
  contentType: ContentType,
  guardianConfidence: number
): Promise<void> {
  const config = await loadRuntimeConfig();

  if (shouldAutoPublish(config, contentType, guardianConfidence)) {
    // TODO(M2): call the Facebook Pages API / Instagram Graph API, then:
    await supabase
      .from('content_calendar')
      .update({ publish_status: 'published', published_at: new Date().toISOString() })
      .eq('id', calendarId);
    return;
  }

  const reason =
    config.founderMode === 'manual'
      ? 'founder_mode_manual_override'
      : config.autoPublishEligible[contentType]?.eligibleFromPhase === 'never'
        ? 'content_type_always_manual'
        : 'low_confidence';

  await supabase.from('approvals_queue').insert({
    org_id: config.orgId,
    content_item_id: contentItemId,
    reason,
  });

  await supabase
    .from('content_calendar')
    .update({ publish_status: 'awaiting_approval' })
    .eq('id', calendarId);
}

/**
 * Called once the founder approves an item from the Dashboard's approvals
 * queue (approvals_queue.decision = 'approved'). A Supabase database webhook
 * or a short-interval GitHub Actions poll should invoke this — see
 * SETUP.md for wiring options.
 */
export async function publishApprovedItem(calendarId: string): Promise<void> {
  // TODO(M2): call the Facebook Pages API / Instagram Graph API, then
  // update content_calendar with publish_status='published', post_id, post_url.
  void calendarId;
}
