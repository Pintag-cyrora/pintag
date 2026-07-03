// Stage 8 — Publish. Phase- and Founder-Mode-aware: decides auto-publish vs.
// hold-for-approval, then (once approved, whether automatically or by the
// founder) posts via Meta Graph API.
//
// Corresponding agent: .claude/agents/publisher.md
// Reads from: content_calendar, org_settings (via loadRuntimeConfig)
// Writes to: content_calendar (publish_status, post_id, post_url), approvals_queue

import { supabase } from '../lib/supabase.js';
import { loadRuntimeConfig, shouldAutoPublish } from '../lib/config.js';
import { reportHealth, classifyMetaPublishError } from '../lib/health.js';
import type { ContentType } from '../lib/types.js';

interface PublishResult {
  postId: string;
  postUrl: string | null;
  simulated: boolean;
}

/**
 * The single place Publisher actually "posts." META_PUBLISH_MODE defaults to
 * 'simulate' since no Meta credentials exist yet (see SETUP.md). Flipping to
 * 'live' later is a config change, not a code change — every caller above
 * this function is unaffected either way, same principle as Founder Mode.
 */
async function publishToMetaOrSimulate(
  platform: string,
  contentItemId: string
): Promise<PublishResult> {
  const mode = process.env.META_PUBLISH_MODE ?? 'simulate';

  if (mode === 'live') {
    // TODO(M2): call the Facebook Pages API / Instagram Graph API for real,
    // using credentials from SETUP.md step 2.
    throw new Error('META_PUBLISH_MODE=live is not implemented yet — see SETUP.md.');
  }

  const postId = `simulated-${contentItemId}-${Date.now()}`;
  console.log(`[Stage 08 — Publish] SIMULATED publish to ${platform} (post_id=${postId}) — no real Meta API call made.`);
  return { postId, postUrl: null, simulated: true };
}

async function recordPublished(calendarId: string, result: PublishResult): Promise<void> {
  const { error } = await supabase
    .from('content_calendar')
    .update({
      publish_status: 'published',
      published_at: new Date().toISOString(),
      post_id: result.postId,
      post_url: result.postUrl,
      simulated: result.simulated,
    })
    .eq('id', calendarId);
  if (error) throw new Error(`Failed to record publish on content_calendar ${calendarId}: ${error.message}`);
}

export interface ProcessCalendarResult {
  outcome: 'published' | 'awaiting_approval';
  platform: string;
}

/**
 * Publishes immediately if the item clears the auto-publish bar, otherwise
 * queues it for founder approval. Callers (pipeline/run.ts) must check
 * `outcome` — a 'published' result still needs Stage 09/10 (Analyze, Memory
 * Update) run afterward; that hand-off happens for the founder-approval path
 * automatically once approved (see publishApprovedItem below), so run.ts is
 * responsible for triggering it here too when publishing happens inline.
 */
export async function processCalendarItem(
  calendarId: string,
  contentItemId: string,
  contentType: ContentType,
  guardianConfidence: number
): Promise<ProcessCalendarResult> {
  const config = await loadRuntimeConfig();

  const { data: calRow, error: calErr } = await supabase
    .from('content_calendar')
    .select('platform')
    .eq('id', calendarId)
    .single();
  if (calErr || !calRow) throw new Error(`Failed to load content_calendar ${calendarId}: ${calErr?.message}`);

  if (shouldAutoPublish(config, contentType, guardianConfidence)) {
    try {
      const result = await publishToMetaOrSimulate(calRow.platform, contentItemId);
      await recordPublished(calendarId, result);
      await reportHealth('publisher', 'healthy');
      return { outcome: 'published', platform: calRow.platform };
    } catch (err) {
      const { status, message } = classifyMetaPublishError(err);
      await reportHealth('publisher', status, message);
      throw err;
    }
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

  console.log(`[Stage 08 — Publish] ${calendarId} awaiting founder approval (reason: ${reason})`);

  await reportHealth('publisher', 'healthy');
  return { outcome: 'awaiting_approval', platform: calRow.platform };
}

/**
 * Every content_calendar row that has a founder-approved decision in
 * approvals_queue but hasn't been published yet. This is what
 * pipeline/publish-queue.ts polls.
 */
export async function getApprovedPendingItems(): Promise<Array<{ calendarId: string; contentItemId: string }>> {
  const { data: approvals, error: approvalsErr } = await supabase
    .from('approvals_queue')
    .select('content_item_id')
    .eq('decision', 'approved');
  if (approvalsErr) throw new Error(`Failed to query approvals_queue: ${approvalsErr.message}`);

  const approvedIds = (approvals ?? []).map((a) => a.content_item_id);
  if (approvedIds.length === 0) return [];

  const { data: calendarRows, error: calErr } = await supabase
    .from('content_calendar')
    .select('id, content_item_id')
    .in('content_item_id', approvedIds)
    .eq('publish_status', 'awaiting_approval');
  if (calErr) throw new Error(`Failed to query content_calendar: ${calErr.message}`);

  return (calendarRows ?? []).map((r) => ({ calendarId: r.id, contentItemId: r.content_item_id }));
}

/**
 * Called once the founder approves an item from the Dashboard's (or, until
 * it's hosted, Supabase Studio's) approvals queue. Invoked by
 * pipeline/publish-queue.ts, which backs .github/workflows/publish-queue.yml.
 */
export async function publishApprovedItem(calendarId: string): Promise<{ platform: string }> {
  try {
    const { data: calRow, error } = await supabase
      .from('content_calendar')
      .select('id, content_item_id, platform')
      .eq('id', calendarId)
      .single();
    if (error || !calRow) throw new Error(`Failed to load content_calendar ${calendarId}: ${error?.message}`);

    const result = await publishToMetaOrSimulate(calRow.platform, calRow.content_item_id);
    await recordPublished(calendarId, result);

    await reportHealth('publisher', 'healthy');
    console.log(`[Stage 08 — Publish] ${calendarId} published (simulated=${result.simulated})`);
    return { platform: calRow.platform };
  } catch (err) {
    const { status, message } = classifyMetaPublishError(err);
    await reportHealth('publisher', status, message);
    throw err;
  }
}
