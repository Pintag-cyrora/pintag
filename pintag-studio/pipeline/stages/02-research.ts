// Stage 02 — Research. Grounds a brief (from Stage 01 — Plan) in real facts
// before any writing happens, so nothing downstream is hallucinated.
//
// Corresponding agent: .claude/agents/researcher.md
// Reads from: knowledge-base/, knowledge/ (Knowledge Layer — proof-of-concept
// integration, see knowledge/README.md), the read-only Pintag listings feed
// (see the main pintag repo's supabase/functions/public-listings-feed)

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBrief, ResearchPacket } from '../lib/types.js';
import { withHealthReport } from '../lib/health.js';
import { runAgent, parseJsonResponse } from '../lib/agent.js';
import { REPO_ROOT } from '../lib/config.js';
import { retrieveKnowledge, relativeKnowledgePath } from '../lib/knowledge.js';
import { proposeSuggestion } from '../lib/suggestions.js';

export async function research(brief: ContentBrief): Promise<ResearchPacket> {
  return withHealthReport('researcher', async () => {
    // Educational posts aren't listing-specific, so the read-only Pintag
    // listings feed doesn't apply here — it's the right call for
    // property_video / neighborhood_guide briefs, which aren't in M1's scope.
    const buyingGuide = readFileSync(join(REPO_ROOT, 'knowledge-base', 'guides', 'buying-guide.md'), 'utf-8');
    const rentingGuide = readFileSync(join(REPO_ROOT, 'knowledge-base', 'guides', 'renting-guide.md'), 'utf-8');
    const sellingGuide = readFileSync(join(REPO_ROOT, 'knowledge-base', 'guides', 'selling-guide.md'), 'utf-8');
    const foreignOwnership = readFileSync(
      join(REPO_ROOT, 'knowledge-base', 'guides', 'foreign-ownership-rules.md'),
      'utf-8'
    );
    const marketOverview = readFileSync(
      join(REPO_ROOT, 'knowledge-base', 'market', 'laos-real-estate-overview.md'),
      'utf-8'
    );

    // Knowledge Layer retrieval (proof-of-concept — see knowledge/README.md
    // "Where this plugs in today"). Scoped to verified+ entries only: a
    // 'draft' knowledge/ entry is by definition unreviewed, so it isn't
    // citable as fact here any more than an unreviewed knowledge-base note
    // would be — same "never state a fact not traceable to a verified
    // source" rule (CLAUDE.md) applies to this layer too.
    const knowledgeEntries = retrieveKnowledge({
      categories: ['industries/real-estate', 'brands/pintag', 'psychology', 'marketing', 'language'],
      minStatus: 'verified',
    });
    const knowledgeSection = knowledgeEntries
      .map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`)
      .join('\n\n');

    const userPrompt = [
      `Ground the following educational post brief in verifiable facts from the reference material below.`,
      `Topic: ${brief.topic}`,
      `Angle: ${brief.angle}`,
      '',
      '## Reference material (the ONLY sources you may cite)',
      '### knowledge-base/guides/buying-guide.md',
      buyingGuide,
      '### knowledge-base/guides/renting-guide.md',
      rentingGuide,
      '### knowledge-base/guides/selling-guide.md',
      sellingGuide,
      '### knowledge-base/guides/foreign-ownership-rules.md',
      foreignOwnership,
      '### knowledge-base/market/laos-real-estate-overview.md',
      marketOverview,
      ...(knowledgeSection ? ['', '## Additional verified knowledge (Knowledge Layer)', knowledgeSection] : []),
      '',
      'Extract 3-6 concrete facts relevant to the topic and angle, each citing the exact source file it came from.',
      'If the topic requires a fact not covered by the reference material above, list it under knowledgeGaps instead of inventing it.',
    ].join('\n');

    const raw = await runAgent('researcher', {
      userPrompt,
      jsonShapeHint:
        '{"facts": [{"claim": string, "source": string}], "knowledgeGaps": string[]}',
    });
    const packet = parseJsonResponse<ResearchPacket>(raw);
    if (
      !Array.isArray(packet.facts) ||
      packet.facts.some((f) => typeof f?.claim !== 'string' || typeof f?.source !== 'string')
    ) {
      throw new Error(`researcher response has a malformed facts array: ${JSON.stringify(packet)}`);
    }
    // knowledgeGaps is informational, not load-bearing — normalize rather
    // than crash the pipeline if the model returns something odd (e.g. a
    // string instead of an array) for an optional field.
    if (packet.knowledgeGaps !== undefined && !Array.isArray(packet.knowledgeGaps)) {
      console.warn(`[Stage 02 — Research] Ignoring non-array knowledgeGaps from researcher: ${JSON.stringify(packet.knowledgeGaps)}`);
      packet.knowledgeGaps = [];
    }

    const outDir = join(REPO_ROOT, brief.vaultPath);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'research.json'), JSON.stringify(packet, null, 2), 'utf-8');

    // Knowledge Suggestion System (Intelligence Department, curated-not-
    // autonomous capture — see departments/intelligence/PLAYBOOK.md §17).
    // A knowledge gap is exactly "a reusable insight that would otherwise
    // remain in a log line," but as of this change it no longer becomes a
    // real knowledge/ draft automatically — it's dropped in the mailbox
    // for a human to approve, edit, or reject first. Approval is what
    // creates the actual knowledge/ draft entry (pipeline/lib/suggestions.ts
    // approveSuggestion()), which then still goes through the existing
    // draft->verified Review Queue. Two human checkpoints, not one.
    for (const gap of packet.knowledgeGaps ?? []) {
      const suggestion = proposeSuggestion({
        kind: 'knowledge-gap',
        sourceAgent: 'researcher',
        title: gap.slice(0, 100),
        body: `Flagged by the Researcher while grounding brief "${brief.topic}" — the reference material did not cover this:\n\n${gap}`,
        suggestedCategory: 'research',
        suggestedTags: ['knowledge-gap', brief.contentType],
        context: `content_items ${brief.contentItemId} (${brief.vaultPath})`,
      });
      console.log(`[Stage 02 — Research] Knowledge gap suggested → knowledge-suggestions/${suggestion.id}.md`);
    }

    console.log(
      `[Stage 02 — Research] ${packet.facts.length} facts, ${packet.knowledgeGaps?.length ?? 0} knowledge gaps → ${brief.vaultPath}/research.json`
    );

    return packet;
  });
}
