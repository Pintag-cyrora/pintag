// Stage 9 — Analyze. Marketing Analyst pulls Meta Insights for published
// posts and writes structured outcomes (not just a markdown report) so
// performance is queryable, not just readable.
//
// Corresponding agent: .claude/agents/marketing-analyst.md
// Reads from: Meta Graph API Insights, content_calendar
// Writes to: performance_metrics, analytics/reports/{week}.md

import { supabase } from '../lib/supabase.js';

export async function collectPerformance(contentItemId: string, platform: 'facebook' | 'instagram'): Promise<void> {
  // TODO(M5): call the Meta Graph API Insights endpoint for the post's
  // post_id (from content_calendar), then insert the row below.
  await supabase.from('performance_metrics').insert({
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
}

export async function writeWeeklyReport(): Promise<string> {
  // TODO(M5): aggregate the past 7 days of performance_metrics by content
  // type/pillar, surface what over/under-performed, write to
  // analytics/reports/{iso-week}.md, and feed a summary back to the
  // Content Strategist for next week's planning (Stage 2).
  return '';
}
