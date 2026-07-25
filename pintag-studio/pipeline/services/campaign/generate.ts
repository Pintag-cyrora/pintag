// Campaign orchestration — the layer that turns one accepted opportunity
// into a complete generated campaign by coordinating the existing AI
// departments, in order: CMO → Researcher → Content Strategist → Writer →
// Graphic Designer → Video Producer → Brand Guardian. Replaces the
// "one-click execution isn't built yet" placeholder behind the Morning
// Brief's Recommended Action button.
//
// Deliberately NOT one giant prompt: each step is its own runAgent() call
// against that department's own .claude/agents/*.md job description (the
// same mechanism Stages 02/03/06 already use), grounded in the same
// knowledge-base/brand-voice context those stages load. Departments never
// pass raw text to each other — each step reads the Campaign sections
// upstream steps wrote and writes exactly one section of its own, and the
// Campaign is persisted after every step so progress is durable and a
// crash loses at most the step in flight.
//
// Generation only (this milestone): no publishing, no scheduling. The
// completed Campaign is a reviewable bundle; Stage 07/08 remain the only
// publishing machinery. Runs locally, founder-triggered (the Execute
// button on the local Founder Workspace, or `npm run campaign`) — Core
// Marketing OS per ARCHITECTURE.md §0, no new cloud infrastructure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, parseJsonResponse } from '../../lib/agent.js';
import { withHealthReport } from '../../lib/health.js';
import { REPO_ROOT } from '../../lib/config.js';
import { retrieveKnowledge, relativeKnowledgePath } from '../../lib/knowledge.js';
import { loadResearchReferenceMaterial } from '../../stages/02-research.js';
import { loadWritingContext } from '../../stages/03-write.js';
import { findSimilarByTitle } from '../../stages/01-plan.js';
import { writeCampaign } from './persist.js';
import type {
  Campaign,
  CampaignOpportunity,
  CampaignStepId,
  CampaignStepState,
  CampaignObjective,
  CampaignResearch,
  CampaignStrategy,
  CampaignContent,
  CampaignDesign,
  CampaignVideo,
  CampaignQaReport,
} from './types.js';

/** Same per-call ceiling as the Daily Briefing's runAgent call — seven calls per campaign stays well inside the monthly budget ceiling (brain/org-config.json). */
const STEP_BUDGET_USD = 0.3;

const STEP_ORDER: Array<{ id: CampaignStepId; label: string; doneDetail: string }> = [
  { id: 'cmo', label: 'CMO', doneDetail: 'Accepted Opportunity' },
  { id: 'research', label: 'Researcher', doneDetail: 'Research Complete' },
  { id: 'strategy', label: 'Content Strategist', doneDetail: 'Campaign Planned' },
  { id: 'writing', label: 'Writer', doneDetail: 'Content Generated' },
  { id: 'design', label: 'Graphic Designer', doneDetail: 'Graphics Generated' },
  { id: 'video', label: 'Video Producer', doneDetail: 'Video Generated' },
  { id: 'qa', label: 'Brand Guardian', doneDetail: 'Approved' },
];

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'campaign';
}

/** Creates (and persists) a new Campaign with every step pending. Deterministic — no LLM call. */
export function createCampaign(opportunity: CampaignOpportunity): Campaign {
  const createdAt = new Date();
  const campaign: Campaign = {
    id: `${createdAt.toISOString().slice(0, 10)}-${createdAt.getTime().toString(36)}-${slugify(opportunity.title)}`.slice(0, 100),
    title: opportunity.title,
    createdAt: createdAt.toISOString(),
    status: 'running',
    opportunity,
    steps: STEP_ORDER.map(({ id, label }) => ({ id, label, status: 'pending', detail: '' })),
  };
  writeCampaign(campaign);
  return campaign;
}

function stepState(campaign: Campaign, id: CampaignStepId): CampaignStepState {
  const step = campaign.steps.find((s) => s.id === id);
  if (!step) throw new Error(`Campaign ${campaign.id} has no step "${id}"`);
  return step;
}

function requireStringArray(value: unknown, field: string, raw: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`campaign step returned a malformed "${field}": ${JSON.stringify(raw).slice(0, 500)}`);
  }
  return value;
}

function requireString(value: unknown, field: string, raw: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`campaign step returned a missing/empty "${field}": ${JSON.stringify(raw).slice(0, 500)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Department steps. Each: one runAgent() call, validated output, one
// Campaign section written. Health reporting mirrors the stages — the same
// agent doing the same kind of work reports through the same channel.
// ---------------------------------------------------------------------------

async function runCmoStep(campaign: Campaign): Promise<CampaignObjective> {
  return withHealthReport('cmo', async () => {
    const raw = await runAgent('cmo', {
      userPrompt: [
        'The founder has accepted the following opportunity and asked Marketing OS to execute a campaign on it. As CMO, accept the opportunity and define the campaign objective.',
        '',
        `## Opportunity`,
        `Title: ${campaign.opportunity.title}`,
        campaign.opportunity.detail ? `Context: ${campaign.opportunity.detail}` : '',
        '',
        'Define ONE clear campaign objective (what this campaign should make the audience understand or do), plus a short rationale for why this opportunity deserves a campaign now. Stay educational-first per the founder brief — the objective must lead with what the audience learns, not what Pintag sells.',
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint: '{"objective": string, "acceptanceRationale": string}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignObjective>(raw);
    return {
      objective: requireString(parsed.objective, 'objective', parsed),
      acceptanceRationale: requireString(parsed.acceptanceRationale, 'acceptanceRationale', parsed),
    };
  });
}

async function runResearchStep(campaign: Campaign): Promise<CampaignResearch> {
  return withHealthReport('researcher', async () => {
    const { referenceSection, knowledgeSection } = loadResearchReferenceMaterial();
    const raw = await runAgent('researcher', {
      userPrompt: [
        'Research the topic below to ground an upcoming multi-format campaign in verifiable facts.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        '',
        '## Reference material (the ONLY sources you may cite)',
        referenceSection,
        ...(knowledgeSection ? ['', '## Additional verified knowledge (Knowledge Layer)', knowledgeSection] : []),
        '',
        'Produce: (1) researchBrief — a short prose brief (3-6 sentences) summarizing what the campaign content should be grounded in; (2) facts — 3-8 concrete facts relevant to the objective, each citing the exact source file it came from; (3) knowledgeGaps — anything the objective needs that the reference material does not cover. Never invent a fact to fill a gap.',
      ].join('\n'),
      jsonShapeHint: '{"researchBrief": string, "facts": [{"claim": string, "source": string}], "knowledgeGaps": string[]}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignResearch>(raw);
    if (!Array.isArray(parsed.facts) || parsed.facts.some((f) => typeof f?.claim !== 'string' || typeof f?.source !== 'string')) {
      throw new Error(`researcher step returned a malformed facts array: ${JSON.stringify(parsed).slice(0, 500)}`);
    }
    return {
      researchBrief: requireString(parsed.researchBrief, 'researchBrief', parsed),
      facts: parsed.facts,
      knowledgeGaps: Array.isArray(parsed.knowledgeGaps) ? parsed.knowledgeGaps.filter((g): g is string => typeof g === 'string') : [],
    };
  });
}

async function runStrategyStep(campaign: Campaign): Promise<CampaignStrategy> {
  return withHealthReport('content_strategist', async () => {
    const raw = await runAgent('content_strategist', {
      userPrompt: [
        'Plan the campaign below: who it is for, the core message, and the one call to action.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        '',
        '## Research brief',
        campaign.research!.researchBrief,
        '## Sourced facts the campaign will be grounded in',
        JSON.stringify(campaign.research!.facts, null, 2),
        '',
        'Produce: audience (the specific segment this campaign serves, and why them); messaging (the single core message, stated plainly); cta (ONE call to action, educational-first per posting rules); formats (which of Facebook post / Instagram caption / LinkedIn post / blog article / carousel / TikTok / Reel this campaign uses and why — list format names).',
      ].join('\n'),
      jsonShapeHint: '{"audience": string, "messaging": string, "cta": string, "formats": string[]}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignStrategy>(raw);
    return {
      audience: requireString(parsed.audience, 'audience', parsed),
      messaging: requireString(parsed.messaging, 'messaging', parsed),
      cta: requireString(parsed.cta, 'cta', parsed),
      formats: requireStringArray(parsed.formats, 'formats', parsed),
    };
  });
}

async function runWritingStep(campaign: Campaign): Promise<CampaignContent> {
  return withHealthReport('writer', async () => {
    const { brandVoice, styleGuide } = loadWritingContext();
    // Same writing-craft Knowledge Layer categories as Stage 03 — how to
    // write, not what to claim (facts come only from the research section).
    const knowledgeEntries = retrieveKnowledge({ categories: ['language', 'marketing', 'psychology'], minStatus: 'verified' });
    const knowledgeSection = knowledgeEntries.map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`).join('\n\n');

    const raw = await runAgent('writer', {
      userPrompt: [
        'Write every written format of the campaign below.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        `Audience: ${campaign.strategy!.audience}`,
        `Core message: ${campaign.strategy!.messaging}`,
        `Call to action: ${campaign.strategy!.cta}`,
        '',
        '## Brand voice (follow exactly)',
        brandVoice,
        '## Style guide',
        styleGuide,
        knowledgeSection ? `## Writing craft — verified knowledge (terminology, tone, hook patterns)\n${knowledgeSection}` : '',
        '',
        '## Sourced facts to draw on (do not introduce claims beyond these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        campaign.research!.knowledgeGaps.length > 0
          ? `## Known gaps — do not state anything about these as fact:\n${campaign.research!.knowledgeGaps.join('\n')}`
          : '',
        '',
        'Produce all four: facebookPost (complete, ready to post); instagramCaption (complete, with line breaks as it should appear); linkedinPost (complete, slightly more professional register, same facts); blogArticleMarkdown (a full article in Markdown, headline included). All four carry the same core message and CTA, adapted per platform — never one text pasted four times.',
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint: '{"facebookPost": string, "instagramCaption": string, "linkedinPost": string, "blogArticleMarkdown": string}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignContent>(raw);
    return {
      facebookPost: requireString(parsed.facebookPost, 'facebookPost', parsed),
      instagramCaption: requireString(parsed.instagramCaption, 'instagramCaption', parsed),
      linkedinPost: requireString(parsed.linkedinPost, 'linkedinPost', parsed),
      blogArticleMarkdown: requireString(parsed.blogArticleMarkdown, 'blogArticleMarkdown', parsed),
    };
  });
}

async function runDesignStep(campaign: Campaign): Promise<CampaignDesign> {
  return withHealthReport('graphic_designer', async () => {
    const raw = await runAgent('graphic_designer', {
      userPrompt: [
        'Design the visual layer of the campaign below: carousel copy, graphic concepts, and generation-ready image prompts. Concepts and prompts only — rendering happens later through brand templates, so stay within a clean, on-brand, real-estate-appropriate visual language.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        `Audience: ${campaign.strategy!.audience}`,
        `Core message: ${campaign.strategy!.messaging}`,
        '',
        '## The written content these visuals accompany',
        `Facebook post:\n${campaign.content!.facebookPost}`,
        `Instagram caption:\n${campaign.content!.instagramCaption}`,
        '',
        'Produce: carouselSlides (the on-slide text for a 5-8 slide educational carousel, one string per slide, slide 1 is the hook); graphicConcepts (2-3 distinct visual concepts, each described in one or two sentences); imagePrompts (one generation-ready prompt per concept, concrete about composition, mood, and setting — Vientiane, Laos context, no text baked into the image); thumbnailPrompt (one prompt for the video thumbnail).',
      ].join('\n'),
      jsonShapeHint: '{"carouselSlides": string[], "graphicConcepts": string[], "imagePrompts": string[], "thumbnailPrompt": string}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignDesign>(raw);
    return {
      carouselSlides: requireStringArray(parsed.carouselSlides, 'carouselSlides', parsed),
      graphicConcepts: requireStringArray(parsed.graphicConcepts, 'graphicConcepts', parsed),
      imagePrompts: requireStringArray(parsed.imagePrompts, 'imagePrompts', parsed),
      thumbnailPrompt: requireString(parsed.thumbnailPrompt, 'thumbnailPrompt', parsed),
    };
  });
}

async function runVideoStep(campaign: Campaign): Promise<CampaignVideo> {
  return withHealthReport('video_producer', async () => {
    const raw = await runAgent('video_producer', {
      userPrompt: [
        'Produce the video layer of the campaign below: short-form scripts ready for a person (or template pipeline) to shoot and assemble. Scripts and plans only — no rendering in this step.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        `Audience: ${campaign.strategy!.audience}`,
        `Core message: ${campaign.strategy!.messaging}`,
        `Call to action: ${campaign.strategy!.cta}`,
        '',
        '## Sourced facts (the scripts may not claim anything beyond these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        '',
        'Produce: tiktokScript (a complete 30-45s script with timing beats); reelScript (a complete Instagram Reel script — same message, distinct pacing, not a copy of the TikTok script); hooks (3-5 alternative opening hooks, one sentence each); voiceover (the full voice-over text for the primary script, as it should be read aloud); brollIdeas (5-8 concrete b-roll shots); captions (the on-screen caption lines for the primary script, in display order).',
      ].join('\n'),
      jsonShapeHint:
        '{"tiktokScript": string, "reelScript": string, "hooks": string[], "voiceover": string, "brollIdeas": string[], "captions": string[]}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignVideo>(raw);
    return {
      tiktokScript: requireString(parsed.tiktokScript, 'tiktokScript', parsed),
      reelScript: requireString(parsed.reelScript, 'reelScript', parsed),
      hooks: requireStringArray(parsed.hooks, 'hooks', parsed),
      voiceover: requireString(parsed.voiceover, 'voiceover', parsed),
      brollIdeas: requireStringArray(parsed.brollIdeas, 'brollIdeas', parsed),
      captions: requireStringArray(parsed.captions, 'captions', parsed),
    };
  });
}

async function runQaStep(campaign: Campaign): Promise<CampaignQaReport> {
  return withHealthReport('brand_guardian', async () => {
    const brandVoice = readFileSync(join(REPO_ROOT, 'brain', 'brand-voice.md'), 'utf-8');
    const postingRules = readFileSync(join(REPO_ROOT, 'brain', 'posting-rules.md'), 'utf-8');
    // Canonical Lao terminology, via the same Knowledge Layer path the
    // Writer uses (the lao-brain source adapter tags brain/lao/dictionary.md
    // entries category: 'language').
    const laoEntries = retrieveKnowledge({ categories: ['language'], minStatus: 'verified' });
    const laoSection = laoEntries.map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`).join('\n\n');

    // Duplicate detection — the same content_items near-duplicate title
    // check Stage 01 runs (reused, not reimplemented). Degrades to an
    // honest "check unavailable" note rather than failing QA when Supabase
    // is unreachable: duplication is advisory here, factual review is not.
    let duplication: string;
    try {
      const duplicate = await findSimilarByTitle(campaign.title, 'educational_post');
      duplication = duplicate
        ? `Possible duplicate of existing content item "${duplicate.title}" (${duplicate.vaultItemId}) — review before publishing.`
        : 'No near-duplicate title found in existing content items.';
    } catch (err) {
      duplication = `Duplicate check unavailable (${err instanceof Error ? err.message : 'unknown error'}).`;
    }

    const raw = await runAgent('brand_guardian', {
      userPrompt: [
        'Review the complete generated campaign below before it reaches the founder.',
        '',
        `Campaign: ${campaign.title}`,
        `Objective: ${campaign.objective!.objective}`,
        '',
        '## Sourced facts this campaign must stay within (flag any claim not traceable to these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        '',
        '## Brand voice (verify consistency)',
        brandVoice,
        '## Posting rules (verify compliance, including banned language)',
        postingRules,
        laoSection ? `## Canonical Lao terminology (verify any Lao text against this)\n${laoSection}` : '',
        '',
        '## The campaign content under review',
        `### Facebook post\n${campaign.content!.facebookPost}`,
        `### Instagram caption\n${campaign.content!.instagramCaption}`,
        `### LinkedIn post\n${campaign.content!.linkedinPost}`,
        `### Blog article\n${campaign.content!.blogArticleMarkdown}`,
        `### Carousel slides\n${campaign.design!.carouselSlides.join('\n---\n')}`,
        `### TikTok script\n${campaign.video!.tiktokScript}`,
        `### Reel script\n${campaign.video!.reelScript}`,
        `### Voice-over\n${campaign.video!.voiceover}`,
        '',
        'Produce: factCheck (one short paragraph — are all claims traceable to the sourced facts; name any that are not); brandVoice (one short paragraph on voice consistency); grammar (one short paragraph on grammar/clarity across formats); laoTerminology (one short paragraph — if no Lao text is present, say exactly that rather than inventing an assessment); issues (each concrete problem as its own actionable line, empty if none); summary (2-3 sentences for the founder); approved (true ONLY if there are no factual traceability problems and no posting-rules violations — style nitpicks alone do not block approval).',
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint:
        '{"approved": boolean, "factCheck": string, "brandVoice": string, "grammar": string, "laoTerminology": string, "issues": string[], "summary": string}',
      maxBudgetUsd: STEP_BUDGET_USD,
    });
    const parsed = parseJsonResponse<CampaignQaReport>(raw);
    return {
      // Fails closed, same as Stage 06's resolvePolicyCompliant(): only an
      // explicit true approves — a missing/ambiguous answer means review.
      approved: parsed.approved === true,
      factCheck: requireString(parsed.factCheck, 'factCheck', parsed),
      brandVoice: requireString(parsed.brandVoice, 'brandVoice', parsed),
      grammar: requireString(parsed.grammar, 'grammar', parsed),
      laoTerminology: requireString(parsed.laoTerminology, 'laoTerminology', parsed),
      issues: requireStringArray(parsed.issues ?? [], 'issues', parsed),
      duplication,
      summary: requireString(parsed.summary, 'summary', parsed),
    };
  });
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

/**
 * Runs every department step against the campaign, in order, mutating and
 * persisting it as each completes. Returns the same (now complete or
 * failed) Campaign object. A step failure stops the run — downstream steps
 * depend on the failed section, so continuing would generate ungrounded
 * work — but everything generated before the failure is already persisted
 * and visible.
 */
export async function executeCampaign(campaign: Campaign): Promise<Campaign> {
  const runners: Array<{ id: CampaignStepId; run: () => Promise<void> }> = [
    { id: 'cmo', run: async () => void (campaign.objective = await runCmoStep(campaign)) },
    { id: 'research', run: async () => void (campaign.research = await runResearchStep(campaign)) },
    { id: 'strategy', run: async () => void (campaign.strategy = await runStrategyStep(campaign)) },
    { id: 'writing', run: async () => void (campaign.content = await runWritingStep(campaign)) },
    { id: 'design', run: async () => void (campaign.design = await runDesignStep(campaign)) },
    { id: 'video', run: async () => void (campaign.video = await runVideoStep(campaign)) },
    { id: 'qa', run: async () => void (campaign.qaReport = await runQaStep(campaign)) },
  ];

  for (const { id, run } of runners) {
    const step = stepState(campaign, id);
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    writeCampaign(campaign);

    try {
      await run();
    } catch (err) {
      step.status = 'failed';
      step.detail = err instanceof Error ? err.message : 'Unknown error';
      step.completedAt = new Date().toISOString();
      campaign.status = 'failed';
      writeCampaign(campaign);
      console.error(`[Campaign ${campaign.id}] ${step.label} failed: ${step.detail}`);
      return campaign;
    }

    step.status = 'complete';
    step.completedAt = new Date().toISOString();
    step.detail = STEP_ORDER.find((s) => s.id === id)!.doneDetail;
    // The Brand Guardian's checkmark tells the truth: "Approved" only if it
    // actually approved — otherwise the founder sees there's something to read.
    if (id === 'qa' && campaign.qaReport && !campaign.qaReport.approved) {
      step.detail = `Reviewed — ${campaign.qaReport.issues.length} issue${campaign.qaReport.issues.length === 1 ? '' : 's'} for your attention`;
    }
    writeCampaign(campaign);
    console.log(`[Campaign ${campaign.id}] ${step.label}: ${step.detail}`);
  }

  campaign.status = 'complete';
  campaign.completedAt = new Date().toISOString();
  writeCampaign(campaign);
  console.log(`[Campaign ${campaign.id}] Campaign complete.`);
  return campaign;
}
