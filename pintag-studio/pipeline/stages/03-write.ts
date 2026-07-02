// Stage 3 — Write. Produces the actual copy for the brief, in brand voice.
//
// Corresponding agent: .claude/agents/writer.md
// Reads from: brief + research packet, brain/brand-voice.md, brain/style-guide.md,
// relevant templates/*.template.md
// Writes to: generated-content/{type}/{date}/{slug}/draft.md, content_items (status='in_review')

import type { ContentBrief, ResearchPacket, Draft } from '../lib/types.js';
import { withHealthReport } from '../lib/health.js';

export async function write(brief: ContentBrief, research: ResearchPacket): Promise<Draft> {
  return withHealthReport('writer', async () => {
    // TODO(M1): invoke the writer agent with brief + research packet +
    // brain/brand-voice.md + brain/style-guide.md + the matching template;
    // for origin.kind !== 'new', load the existing Vault item first and draft
    // an update/repurpose rather than starting blank.
    void brief;
    void research;
    throw new Error('Not implemented — see TODO(M1)');
  });
}

/** Re-invoked by Stage 6 when Brand Guardian returns a 'revise' verdict. */
export async function revise(draft: Draft, revisionNotes: string): Promise<Draft> {
  return withHealthReport('writer', async () => {
    // TODO(M1): re-run the writer agent with the previous draft + Guardian's
    // specific notes; bounded by org-config.json quality_score.max_revision_cycles.
    void revisionNotes;
    return draft;
  });
}
