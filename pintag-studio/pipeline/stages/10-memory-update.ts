// Stage 10 — Memory Update. Closes the loop: writes the finished item's
// embedding and eventual performance outcome back into the Memory layer so
// Stage 01 (Plan) can find it next time instead of duplicating it.
//
// Writes to: content_items.embedding, content_items.status

import { supabase } from '../lib/supabase.js';

export async function updateMemory(contentItemId: string, titleAndSummaryText: string): Promise<void> {
  // TODO(M2): generate an embedding for titleAndSummaryText (Claude or
  // Gemini embeddings API) and write it to content_items.embedding so
  // Stage 01's findSimilarExistingContent() can match against it. Left null
  // here deliberately — embeddings are explicitly M2 scope (see 01-plan.ts),
  // and a fake one would be worse than an honest gap.
  void titleAndSummaryText;

  const { error } = await supabase
    .from('content_items')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', contentItemId);
  if (error) throw new Error(`Failed to mark content_items as published: ${error.message}`);

  console.log(`[Stage 10 — Memory Update] content_items ${contentItemId} marked published (embedding: not yet generated, M2)`);
}
