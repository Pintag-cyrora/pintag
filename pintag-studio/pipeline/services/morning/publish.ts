// Publishes a generated MorningBrief to Supabase's morning_briefs table —
// the read surface marketing-os.html (repo root, the main pintag.io site)
// queries directly, gated by that project's own Supabase Auth + RLS
// (see supabase/migrations/0005_morning_brief_publish.sql). Distinct from
// persist.ts, which is the local-file cache for the CLI/dev path
// (daily-briefing/latest.json) — unrelated concern, not touched by this.
//
// Publication, not generation (see ARCHITECTURE.md §0): this function never
// calls an LLM or produces anything new — it only synchronizes an
// already-generated brief so it can be read elsewhere. Generation always
// happens locally, on the Claude Code CLI, in generateMorningBrief();
// daily-briefing.ts is the only caller, immediately after that generation
// step succeeds and local artifacts are already written — a Supabase sync
// failure here is the caller's problem to swallow, never a reason to fail
// generation itself. marketing-os.html reads what this writes; it is a
// read-only client, not a second place Marketing OS runs.
//
// `brief` is the permanent, canonical artifact stored here — see that
// migration's header comment. `renderedHtml` rides along as a v1-only
// convenience (this codebase's renderer is already pure/Node-free, so
// rendering once here avoids a second, hand-ported browser renderer to
// keep in sync) — a cache of `brief`, never a replacement for it, safe for
// a future consumer to ignore entirely.

import { supabase } from '../../lib/supabase.js';
import type { MorningBrief } from './types.js';

export async function publishMorningBriefToSupabase(brief: MorningBrief, renderedHtml: string): Promise<void> {
  const { error } = await supabase.from('morning_briefs').upsert(
    {
      org_id: 'pintag',
      brief,
      rendered_html: renderedHtml,
      generated_at: brief.generatedAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' }
  );
  if (error) throw new Error(`Failed to publish the Morning Brief to Supabase: ${error.message}`);
}
