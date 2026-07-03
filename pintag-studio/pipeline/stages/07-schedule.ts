// Stage 7 — Schedule. Places a Guardian-approved item onto the calendar.
// Ownership: Content Strategist / CMO (per the monthly->weekly->daily
// planning hierarchy — see brain/ceo.md).
//
// Writes to: content_calendar (status='queued' or 'awaiting_approval')

import { supabase } from '../lib/supabase.js';
import type { ContentType, Platform } from '../lib/types.js';

/** Returns the new content_calendar row's id, which Stage 08 (Publish) needs. */
export async function schedule(
  contentItemId: string,
  platform: Platform,
  scheduledAt: Date,
  contentType: ContentType
): Promise<string> {
  // TODO(M2): pick scheduledAt based on brain/posting-rules.md cadence rules
  // and the current calendar's gaps across the 4 content pillars
  // (brain/content-pillars.md balancing rule). M1 schedules for "now" —
  // correct minimal behavior for exactly one item.
  void contentType;

  const { data, error } = await supabase
    .from('content_calendar')
    .insert({
      org_id: 'pintag',
      content_item_id: contentItemId,
      platform,
      scheduled_at: scheduledAt.toISOString(),
      publish_status: 'queued',
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert content_calendar row: ${error.message}`);

  const { error: statusErr } = await supabase
    .from('content_items')
    .update({ status: 'scheduled', updated_at: new Date().toISOString() })
    .eq('id', contentItemId);
  if (statusErr) throw new Error(`Failed to update content_items status after scheduling: ${statusErr.message}`);

  console.log(`[Stage 07 — Schedule] content_calendar ${data.id} queued for ${platform} at ${scheduledAt.toISOString()}`);

  return data.id;
}
