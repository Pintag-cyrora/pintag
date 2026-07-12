// Stage 3 — Write. Produces the actual copy for the brief, in brand voice.
//
// Corresponding agent: .claude/agents/writer.md
// Reads from: brief + research packet, brain/brand-voice.md, brain/style-guide.md,
// relevant templates/*.template.md, knowledge/ (Knowledge Layer — language/
// marketing/psychology categories only; see knowledge/language/README.md)
// Writes to: generated-content/{type}/{date}/{slug}/draft.md, content_items (status='in_review')

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBrief, ResearchPacket, Draft } from '../lib/types.js';
import { withHealthReport } from '../lib/health.js';
import { runAgent, parseJsonResponse } from '../lib/agent.js';
import { supabase } from '../lib/supabase.js';
import { REPO_ROOT } from '../lib/config.js';
import { retrieveKnowledge, relativeKnowledgePath } from '../lib/knowledge.js';

interface WriterOutput {
  title: string;
  bodyMarkdown: string;
}

function loadWritingContext() {
  return {
    brandVoice: readFileSync(join(REPO_ROOT, 'brain', 'brand-voice.md'), 'utf-8'),
    styleGuide: readFileSync(join(REPO_ROOT, 'brain', 'style-guide.md'), 'utf-8'),
    template: readFileSync(join(REPO_ROOT, 'templates', 'educational-post.template.md'), 'utf-8'),
  };
}

export async function write(brief: ContentBrief, research: ResearchPacket): Promise<Draft> {
  return withHealthReport('writer', async () => {
    // KNOWN GAP (documented, not fixed in M1 — see plan discussion): when
    // brief.origin.kind is 'update' or 'repurpose', this still drafts from
    // scratch rather than loading and building on the referenced Vault item
    // at brief.origin.vaultItemId. 01-plan.ts's dedupe check correctly
    // detects near-duplicates and tags the brief accordingly, but nothing
    // downstream acts on that tag yet. Not exercised by M1's proof run (the
    // Vault starts empty), but real "update" behavior needs this closed
    // before the Content Vault's reuse-over-recreate principle actually holds.
    const { brandVoice, styleGuide, template } = loadWritingContext();

    // Knowledge Layer retrieval — writing-craft categories only (language,
    // marketing, psychology), deliberately narrower than Stage 02's set.
    // Stage 02 retrieves real-estate facts and brand-specific knowledge to
    // ground claims; this stage needs craft knowledge that improves *how*
    // the piece is written, not what it claims. Brand voice stays exclusive
    // to Organizational Memory (brain/brand-voice.md above) — never pulled
    // from this shared, cross-brand layer — per the three-layer separation
    // in MEMORY_MODEL.md. `categories: ['language']` also transparently
    // reaches brain/lao/dictionary.md's canonical terminology, since the
    // lao-brain source adapter tags those entries category: 'language' too
    // (see pipeline/lib/knowledge-sources/lao-brain.ts) — no separate call
    // needed to include it.
    const knowledgeEntries = retrieveKnowledge({
      categories: ['language', 'marketing', 'psychology'],
      minStatus: 'verified',
    });
    const knowledgeSection = knowledgeEntries
      .map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`)
      .join('\n\n');

    const userPrompt = [
      `Write an educational post for Pintag.`,
      `Topic: ${brief.topic}`,
      `Angle: ${brief.angle}`,
      `Language: ${brief.language}`,
      '',
      '## Brand voice (follow exactly)',
      brandVoice,
      '## Style guide',
      styleGuide,
      '## Structural template',
      template,
      knowledgeSection
        ? `\n## Writing craft — verified knowledge (terminology, tone, hook patterns, persona sensitivity)\n${knowledgeSection}`
        : '',
      '',
      '## Sourced facts to draw on (do not introduce claims beyond these)',
      JSON.stringify(research.facts, null, 2),
      research.knowledgeGaps && research.knowledgeGaps.length > 0
        ? `## Known gaps — do not state anything about these as fact:\n${research.knowledgeGaps.join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await runAgent('writer', {
      userPrompt,
      jsonShapeHint: '{"title": string, "bodyMarkdown": string}',
    });
    const output = parseJsonResponse<WriterOutput>(raw);
    if (!output.title || !output.bodyMarkdown) {
      throw new Error(`writer response missing required fields: ${JSON.stringify(output)}`);
    }

    writeFileSync(join(REPO_ROOT, brief.vaultPath, 'draft.md'), output.bodyMarkdown, 'utf-8');

    const { error: updateErr } = await supabase
      .from('content_items')
      .update({ title: output.title, status: 'in_review', updated_at: new Date().toISOString() })
      .eq('id', brief.contentItemId);
    if (updateErr) throw new Error(`Failed to update content_items after writing: ${updateErr.message}`);

    console.log(`[Stage 03 — Write] Draft written for ${brief.contentItemId} → ${brief.vaultPath}/draft.md`);

    return {
      contentItemId: brief.contentItemId,
      title: output.title,
      bodyMarkdown: output.bodyMarkdown,
      language: brief.language,
    };
  });
}

/** Re-invoked by Stage 6 when Brand Guardian returns a 'revise' verdict. */
export async function revise(draft: Draft, revisionNotes: string): Promise<Draft> {
  return withHealthReport('writer', async () => {
    const { data: item, error: fetchErr } = await supabase
      .from('content_items')
      .select('vault_path')
      .eq('id', draft.contentItemId)
      .single();
    if (fetchErr || !item) throw new Error(`Failed to load content_items for revision: ${fetchErr?.message}`);

    const { brandVoice, styleGuide } = loadWritingContext();

    const userPrompt = [
      'Revise this educational post draft based on Brand Guardian\'s notes below.',
      '',
      '## Current draft',
      `Title: ${draft.title}`,
      draft.bodyMarkdown,
      '',
      '## Brand Guardian revision notes (address every point)',
      revisionNotes,
      '',
      '## Brand voice (follow exactly)',
      brandVoice,
      '## Style guide',
      styleGuide,
    ].join('\n');

    const raw = await runAgent('writer', {
      userPrompt,
      jsonShapeHint: '{"title": string, "bodyMarkdown": string}',
    });
    const output = parseJsonResponse<WriterOutput>(raw);
    if (!output.title || !output.bodyMarkdown) {
      throw new Error(`writer revision response missing required fields: ${JSON.stringify(output)}`);
    }

    writeFileSync(join(REPO_ROOT, item.vault_path, 'draft.md'), output.bodyMarkdown, 'utf-8');

    const { error: statusErr } = await supabase
      .from('content_items')
      .update({ title: output.title, status: 'in_review', updated_at: new Date().toISOString() })
      .eq('id', draft.contentItemId);
    if (statusErr) throw new Error(`Failed to update content_items after revision: ${statusErr.message}`);

    console.log(`[Stage 03 — Write] Revision applied for ${draft.contentItemId}`);

    return {
      contentItemId: draft.contentItemId,
      title: output.title,
      bodyMarkdown: output.bodyMarkdown,
      language: draft.language,
    };
  });
}
