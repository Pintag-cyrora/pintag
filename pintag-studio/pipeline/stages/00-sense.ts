// Stage 0 — Sense. Runs continuously (own GitHub Actions schedule, not tied
// to the daily content pipeline run). Trend Hunter + Competitor Watch write
// directly to Supabase; this stage is their entry point.
//
// Corresponding agents: .claude/agents/trend-hunter.md, .claude/agents/competitor-watch.md
// Writes to: trend_signals, competitor_notes

import { supabase } from '../lib/supabase.js';
import { withHealthReport } from '../lib/health.js';

export interface TrendSignal {
  source: string;
  title: string;
  summary: string;
  rationale: string;
  relevanceScore: number;
}

export interface CompetitorNote {
  competitorName: string;
  url: string;
  observation: string;
  gapIdentified: string;
}

export async function runTrendHunter(): Promise<TrendSignal[]> {
  return withHealthReport('trend_hunter', async () => {
    // TODO(M3): fetch curated RSS feeds (Laos news, real-estate news,
    // infrastructure/government announcements) + scheduled web search queries;
    // have the trend-hunter agent rank and summarize findings.
    const signals: TrendSignal[] = [];

    if (signals.length > 0) {
      await supabase.from('trend_signals').insert(
        signals.map((s) => ({
          org_id: 'pintag',
          source: s.source,
          title: s.title,
          summary: s.summary,
          rationale: s.rationale,
          relevance_score: s.relevanceScore,
        }))
      );
    }
    return signals;
  });
}

export async function runCompetitorWatch(): Promise<CompetitorNote[]> {
  return withHealthReport('competitor_watch', async () => {
    // TODO(M3): fetch brain/org-config.json.competitor_watchlist public pages;
    // have the competitor-watch agent identify gaps, not copyable content.
    const notes: CompetitorNote[] = [];

    if (notes.length > 0) {
      await supabase.from('competitor_notes').insert(
        notes.map((n) => ({
          org_id: 'pintag',
          competitor_name: n.competitorName,
          url: n.url,
          observation: n.observation,
          gap_identified: n.gapIdentified,
        }))
      );
    }
    return notes;
  });
}
