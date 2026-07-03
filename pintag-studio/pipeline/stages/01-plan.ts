// Stage 01 — Plan. Content Strategist converts the CMO's monthly brief into
// dated content briefs, checking Memory first so nothing gets duplicated.
// Runs before Research: a brief has to exist before it can be researched.
//
// Corresponding agent: .claude/agents/content-strategist.md
// Reads from: brain/content-pillars.md, trend_signals, content_items (Memory)
// Writes to: content_items (new draft row, status='draft')

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabase } from '../lib/supabase.js';
import { withHealthReport } from '../lib/health.js';
import { runAgent, parseJsonResponse } from '../lib/agent.js';
import { REPO_ROOT } from '../lib/config.js';
import type { ContentBrief, ContentType, Language } from '../lib/types.js';

/**
 * Vector-similarity dedupe over the Memory layer. Deliberately still a stub:
 * embeddings aren't written anywhere yet (Stage 10 — Memory Update — is
 * explicitly M2 scope for that), so there is nothing real to compare against.
 * M1 uses findSimilarByTitle() below instead — a plain-text check that's
 * honest about what's actually available right now.
 */
export async function findSimilarExistingContent(
  topicEmbedding: number[],
  contentType: ContentType
): Promise<{ vaultItemId: string; similarity: number } | null> {
  // TODO(M2): call a Postgres RPC (match_content_items) doing
  // `embedding <=> topicEmbedding` cosine distance ordering, filtered by
  // content_type and org_id, once embeddings are being written by Stage 10
  // (Memory Update).
  void supabase;
  void topicEmbedding;
  void contentType;
  return null;
}

/** Escapes Postgres ILIKE wildcards so a topic like "20% down payment" doesn't turn into a pattern match. */
function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** M1's real (non-vector) dedupe check: does an item with a near-identical title already exist? */
export async function findSimilarByTitle(
  topic: string,
  contentType: ContentType
): Promise<{ vaultItemId: string; title: string } | null> {
  const { data, error } = await supabase
    .from('content_items')
    .select('id, title')
    .eq('org_id', 'pintag')
    .eq('content_type', contentType)
    .ilike('title', `%${escapeIlikePattern(topic)}%`)
    .limit(1);

  if (error) throw new Error(`findSimilarByTitle query failed: ${error.message}`);
  return data && data.length > 0 ? { vaultItemId: data[0].id, title: data[0].title } : null;
}

const VALID_LANGUAGES: Language[] = ['lo', 'en', 'zh'];

interface StrategistProposal {
  topic: string;
  angle: string;
  language: Language;
}

function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function planNextBrief(): Promise<ContentBrief | null> {
  return withHealthReport('content_strategist', async () => {
    // M1 is scoped to educational posts only (see ARCHITECTURE.md Section 11
    // roadmap) — neighborhood guides / market updates / property videos come
    // online in later milestones once their downstream stages are real.
    const contentType: ContentType = 'educational_post';

    const { data: existing, error: existingErr } = await supabase
      .from('content_items')
      .select('title')
      .eq('org_id', 'pintag')
      .eq('content_type', contentType)
      .order('created_at', { ascending: false })
      .limit(20);
    if (existingErr) throw new Error(`Failed to load existing content_items: ${existingErr.message}`);
    const existingTitles = (existing ?? []).map((r) => r.title);

    const contentPillars = readFileSync(join(REPO_ROOT, 'brain', 'content-pillars.md'), 'utf-8');
    const buyingGuide = readFileSync(join(REPO_ROOT, 'knowledge-base', 'guides', 'buying-guide.md'), 'utf-8');
    const rentingGuide = readFileSync(join(REPO_ROOT, 'knowledge-base', 'guides', 'renting-guide.md'), 'utf-8');
    const marketOverview = readFileSync(
      join(REPO_ROOT, 'knowledge-base', 'market', 'laos-real-estate-overview.md'),
      'utf-8'
    );

    const userPrompt = [
      'Propose exactly ONE educational post topic for Pintag, per the Educational Posts pillar below.',
      '',
      '## Content Pillars (Educational Posts section applies)',
      contentPillars,
      '',
      '## Reference material available to ground this topic',
      '### Buying guide',
      buyingGuide,
      '### Renting guide',
      rentingGuide,
      '### Market overview',
      marketOverview,
      '',
      existingTitles.length > 0
        ? `## Existing educational post titles — do not propose a near-duplicate of these:\n${existingTitles.map((t) => `- ${t}`).join('\n')}`
        : '## No educational posts exist yet — this will be the first.',
      '',
      'Pick a specific, concrete angle (not a generic "tips" list) that the reference material above can actually substantiate.',
    ].join('\n');

    const raw = await runAgent('content_strategist', {
      userPrompt,
      jsonShapeHint: '{"topic": string, "angle": string, "language": "lo" | "en" | "zh"}',
    });
    const proposal = parseJsonResponse<StrategistProposal>(raw);
    if (!proposal.topic || !proposal.angle || !proposal.language) {
      throw new Error(`content-strategist response missing required fields: ${JSON.stringify(proposal)}`);
    }
    if (!VALID_LANGUAGES.includes(proposal.language)) {
      throw new Error(
        `content-strategist returned an invalid language "${proposal.language}" — expected one of ${VALID_LANGUAGES.join(', ')}. This would otherwise violate the content_items.language check constraint.`
      );
    }

    const duplicate = await findSimilarByTitle(proposal.topic, contentType);
    const origin: ContentBrief['origin'] = duplicate
      ? { kind: 'update', vaultItemId: duplicate.vaultItemId }
      : { kind: 'new' };

    const today = new Date().toISOString().slice(0, 10);
    const slug = slugify(proposal.topic);
    const vaultPath = `generated-content/educational-posts/${today}/${slug}`;

    const { data: inserted, error: insertErr } = await supabase
      .from('content_items')
      .insert({
        org_id: 'pintag',
        content_type: contentType,
        title: proposal.topic,
        language: proposal.language,
        vault_path: vaultPath,
        status: 'draft',
        derived_from: duplicate?.vaultItemId ?? null,
      })
      .select('id')
      .single();
    if (insertErr) throw new Error(`Failed to insert content_items row: ${insertErr.message}`);

    console.log(`[Stage 01 — Plan] Created content_items ${inserted.id}: "${proposal.topic}" (${origin.kind})`);

    return {
      contentItemId: inserted.id,
      vaultPath,
      contentType,
      topic: proposal.topic,
      angle: proposal.angle,
      language: proposal.language,
      origin,
      targetPlatforms: ['facebook', 'instagram'],
    };
  });
}
