// Stage 9 — Analyze. Marketing Analyst pulls Meta Insights for published
// posts and writes structured outcomes (not just a markdown report) so
// performance is queryable, not just readable.
//
// Corresponding agent: .claude/agents/marketing-analyst.md
// Reads from: Meta Graph API Insights, content_calendar
// Writes to: performance_metrics, analytics/reports/{week}.md

import { supabase } from '../lib/supabase.js';
import { withHealthReport } from '../lib/health.js';
import type { Platform } from '../lib/types.js';

export async function collectPerformance(contentItemId: string, platform: Platform): Promise<void> {
  return withHealthReport('marketing_analyst', async () => {
    // TODO(M5): call the Meta Graph API Insights endpoint for the post's
    // post_id (from content_calendar), then insert the row below. Zeros are
    // the honest value today: a simulated post (see 08-publish.ts) has no
    // real engagement to report, not a placeholder standing in for one.
    const { error } = await supabase.from('performance_metrics').insert({
      org_id: 'pintag',
      content_item_id: contentItemId,
      platform,
      impressions: 0,
      reach: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      click_throughs: 0,
    });
    if (error) throw new Error(`Failed to insert performance_metrics: ${error.message}`);

    console.log(`[Stage 09 — Analyze] performance_metrics recorded for ${contentItemId} (${platform})`);
  });
}

export async function writeWeeklyReport(): Promise<string> {
  return withHealthReport('marketing_analyst', async () => {
    // TODO(M5): aggregate the past 7 days of performance_metrics by content
    // type/pillar, surface what over/under-performed, write to
    // analytics/reports/{iso-week}.md, and feed a summary back to the
    // Content Strategist for next week's planning (Stage 01).
    return '';
  });
}
