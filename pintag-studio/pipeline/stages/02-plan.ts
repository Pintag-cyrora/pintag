// Stage 2 — Plan. Content Strategist converts the CMO's monthly brief into
// dated content briefs, checking Memory first so nothing gets duplicated.
//
// Corresponding agent: .claude/agents/content-strategist.md
// Reads from: brain/content-pillars.md, trend_signals, content_items (Memory)
// Writes to: content_items (new draft row, status='draft')

import { supabase } from '../lib/supabase.js';
import { withHealthReport } from '../lib/health.js';
import type { ContentBrief, ContentType } from '../lib/types.js';

const SIMILARITY_MATCH_THRESHOLD = 0.85;

/**
 * Checks the Memory layer (pgvector index over the Content Vault) for
 * near-duplicate existing content before a new brief is created. Returns the
 * matching Vault item id if one is found close enough to warrant an
 * update/repurpose instead of a from-scratch piece.
 */
export async function findSimilarExistingContent(
  topicEmbedding: number[],
  contentType: ContentType
): Promise<{ vaultItemId: string; similarity: number } | null> {
  // TODO(M2): call a Postgres RPC (match_content_items) doing
  // `embedding <=> topicEmbedding` cosine distance ordering, filtered by
  // content_type and org_id, once embeddings are being written by Stage 3.
  void supabase;
  void topicEmbedding;
  void contentType;
  return null;
}

export async function planNextBrief(): Promise<ContentBrief | null> {
  return withHealthReport('content_strategist', async () => {
    // TODO(M1): read brain/content-pillars.md pacing vs brain/mission.md
    // targets to pick the next content type due; check trend_signals for
    // reactive opportunities; call findSimilarExistingContent() before
    // deciding brief.origin = 'new' | 'update' | 'repurpose'.
    return null;
  });
}

void SIMILARITY_MATCH_THRESHOLD;
