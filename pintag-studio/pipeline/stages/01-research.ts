// Stage 1 — Research. Grounds a brief in real facts before any writing
// happens, so nothing downstream is hallucinated.
//
// Corresponding agent: .claude/agents/researcher.md
// Reads from: knowledge-base/, the read-only Pintag listings feed
// (see the main pintag repo's supabase/functions/public-listings-feed)

import type { ContentBrief, ResearchPacket } from '../lib/types.js';

export async function research(brief: ContentBrief): Promise<ResearchPacket> {
  // TODO(M1): load relevant knowledge-base/ files for the brief's topic;
  // for property_video / neighborhood_guide briefs, query the Pintag
  // public-listings-feed edge function for grounding data; flag any fact
  // the brief needs that isn't traceable to a source (knowledgeGaps).
  void brief;
  return { facts: [], knowledgeGaps: [] };
}
