// Stage 10 — Memory Update. Closes the loop: writes the finished item's
// embedding and eventual performance outcome back into the Memory layer so
// Stage 2 (Plan) can find it next time instead of duplicating it.
//
// Writes to: content_items.embedding, content_items.status

import { supabase } from '../lib/supabase.js';

export async function updateMemory(contentItemId: string, titleAndSummaryText: string): Promise<void> {
  // TODO(M2): generate an embedding for titleAndSummaryText (Claude or
  // Gemini embeddings API) and write it to content_items.embedding so
  // Stage 2's findSimilarExistingContent() can match against it.
  void titleAndSummaryText;

  await supabase.from('content_items').update({ updated_at: new Date().toISOString() }).eq('id', contentItemId);
}
