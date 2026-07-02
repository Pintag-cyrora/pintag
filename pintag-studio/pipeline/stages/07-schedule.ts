// Stage 7 — Schedule. Places a Guardian-approved item onto the calendar.
// Ownership: Content Strategist / CMO (per the monthly->weekly->daily
// planning hierarchy — see brain/ceo.md).
//
// Writes to: content_calendar (status='queued' or 'awaiting_approval')

import { supabase } from '../lib/supabase.js';
import type { ContentType } from '../lib/types.js';

export async function schedule(
  contentItemId: string,
  platform: 'facebook' | 'instagram' | 'tiktok' | 'youtube',
  scheduledAt: Date,
  contentType: ContentType
): Promise<void> {
  // TODO(M2): pick scheduledAt based on brain/posting-rules.md cadence rules
  // and the current calendar's gaps across the 4 content pillars
  // (brain/content-pillars.md balancing rule).
  void contentType;

  await supabase.from('content_calendar').insert({
    org_id: 'pintag',
    content_item_id: contentItemId,
    platform,
    scheduled_at: scheduledAt.toISOString(),
    publish_status: 'queued',
  });
}
