// Campaign orchestration — the layer that turns one accepted opportunity
// into a complete generated campaign by coordinating the existing AI
// departments. M3 shape (production-ready): score first, plan second,
// generate selectively, reuse research, and parallelize what's independent:
//
//   CMO (deterministic accept + score, zero LLM)
//     → Content Strategist (Campaign Brief — the structured intent every
//       downstream department reads; nobody infers intent independently)
//     → Researcher (once, cached in research/<slug>.json — a valid cache
//       hit skips the LLM call entirely, with provenance recorded)
//     → Writer ∥ Graphic Designer ∥ Video Producer (parallel, and only the
//       formats the Brief actually requests — generation is demand-driven)
//     → Brand Guardian (reviews only what exists).
//
// Model allocation (see LlmModelTier in pipeline/lib/llm.ts): Researcher
// and Writer run on the reasoning tier — their output quality gates
// everything downstream. Strategy, Design, Video, and Guardian run on the
// fast tier. Scoring, routing, persistence, duplicate detection, and
// campaign management are deterministic code — AI thinks only where
// reasoning adds value.
//
// Departments never pass raw text to each other — each step reads the
// Campaign sections upstream steps wrote and writes exactly one section of
// its own; the Campaign is persisted after every step. Incremental
// regeneration (regenerateCampaignStep) reruns ONE department plus a fresh
// Guardian review — never the whole pipeline.
//
// Generation only: no publishing, no scheduling (Stage 07/08 remain the
// only publishing machinery). Runs locally, founder-triggered — Core
// Marketing OS per ARCHITECTURE.md §0.

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
import { scoreOpportunity } from './score.js';
import { readCachedResearch, writeCachedResearch } from './research-cache.js';
import {
  briefFormats,
  CAMPAIGN_FORMATS,
  WRITTEN_FORMATS,
  VIDEO_FORMATS,
  type Campaign,
  type CampaignOpportunity,
  type CampaignStepId,
  type CampaignStepState,
  type CampaignBrief,
  type CampaignFormat,
  type CampaignResearch,
  type CampaignContent,
  type CampaignDesign,
  type CampaignVideo,
  type CampaignQaReport,
  type OpportunityScore,
} from './types.js';

/** Same per-call ceiling as the Daily Briefing's runAgent call. */
const STEP_BUDGET_USD = 0.3;

const STEP_ORDER: Array<{ id: CampaignStepId; label: string; doneDetail: string }> = [
  { id: 'cmo', label: 'CMO', doneDetail: 'Accepted Opportunity' },
  { id: 'strategy', label: 'Content Strategist', doneDetail: 'Campaign Planned' },
  { id: 'research', label: 'Researcher', doneDetail: 'Research Complete' },
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

/** Creates (and persists) a new Campaign with every step pending. Deterministic — no LLM call. The score, when already computed (batch selection, execute handler), rides in so it's never recomputed. */
export function createCampaign(opportunity: CampaignOpportunity, score?: OpportunityScore): Campaign {
  const createdAt = new Date();
  const campaign: Campaign = {
    id: `${createdAt.toISOString().slice(0, 10)}-${createdAt.getTime().toString(36)}-${slugify(opportunity.title)}`.slice(0, 100),
    title: opportunity.title,
    createdAt: createdAt.toISOString(),
    status: 'running',
    opportunity,
    score,
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

/** The shared craft/brand context — loaded ONCE per campaign run and passed to every step that needs it, instead of each step re-reading the same files and re-scanning the Knowledge Layer. */
interface SharedContext {
  brandVoice: string;
  styleGuide: string;
  postingRules: string;
  /** Writing-craft Knowledge Layer entries (language/marketing/psychology) — Stage 03's exact categories. */
  craftKnowledgeSection: string;
}

function loadSharedContext(): SharedContext {
  const { brandVoice, styleGuide } = loadWritingContext();
  const postingRules = readFileSync(join(REPO_ROOT, 'brain', 'posting-rules.md'), 'utf-8');
  const craftEntries = retrieveKnowledge({ categories: ['language', 'marketing', 'psychology'], minStatus: 'verified' });
  const craftKnowledgeSection = craftEntries.map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`).join('\n\n');
  return { brandVoice, styleGuide, postingRules, craftKnowledgeSection };
}

/** The Campaign Brief as a prompt block — the one framing every generation step receives. */
function briefContextBlock(campaign: Campaign): string {
  const b = campaign.brief!;
  return [
    `Campaign: ${campaign.title}`,
    `Objective: ${b.objective}`,
    `Business goal: ${b.businessGoal}`,
    `Audience: ${b.audience}`,
    `Core message: ${b.messaging}`,
    `Call to action: ${b.cta}`,
    `Requested formats: ${briefFormats(b).join(', ')}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Department steps.
// ---------------------------------------------------------------------------

/** CMO — deterministic accept + score (rule-based, zero LLM — see score.ts). The score normally arrives precomputed from the selection funnel; computed here only for a direct single execute that skipped it. */
async function runCmoStep(campaign: Campaign): Promise<void> {
  await withHealthReport('cmo', async () => {
    if (!campaign.score) {
      campaign.score = await scoreOpportunity({
        title: campaign.opportunity.title,
        detail: campaign.opportunity.detail,
        evidence: [],
        kind: campaign.opportunity.source === 'opportunity' ? 'outperforming-content' : campaign.opportunity.source,
      });
    }
    const step = stepState(campaign, 'cmo');
    step.detail = `Accepted — scored ${campaign.score.total}/100, ${campaign.score.priority} priority`;
  });
}

async function runStrategyStep(campaign: Campaign): Promise<CampaignBrief> {
  return withHealthReport('content_strategist', async () => {
    const raw = await runAgent('content_strategist', {
      userPrompt: [
        'Create the Campaign Brief for the accepted opportunity below. This brief is the single source of campaign intent — every downstream department (Researcher, Writer, Graphic Designer, Video Producer, Brand Guardian) reads it and none of them may infer intent on their own, so it must be complete and specific.',
        '',
        `## Opportunity`,
        `Title: ${campaign.opportunity.title}`,
        campaign.opportunity.detail ? `Context: ${campaign.opportunity.detail}` : '',
        campaign.score ? `Priority: ${campaign.score.priority} (scored ${campaign.score.total}/100)\nWhy it scored that way:\n${campaign.score.reasons.map((r) => `- ${r}`).join('\n')}` : '',
        '',
        'Produce: objective (what this campaign makes the audience understand or do — educational-first per the founder brief); businessGoal (the business outcome it serves, one line); audience (the specific segment, and why them); messaging (the single core message, stated plainly); cta (ONE call to action); primaryFormat (the one format this campaign leads with); secondaryFormats (ONLY formats this campaign genuinely needs — every format you list costs real generation work, so request the smallest set that serves the objective, and an empty list is a legitimate answer); successMetrics (2-4 observable signals of success, e.g. shares, saves, profile visits).',
        '',
        `Valid formats (use these exact strings): ${CAMPAIGN_FORMATS.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint:
        '{"objective": string, "businessGoal": string, "audience": string, "messaging": string, "cta": string, "primaryFormat": string, "secondaryFormats": string[], "successMetrics": string[]}',
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'fast',
    });
    const parsed = parseJsonResponse<CampaignBrief>(raw);
    const normalizeFormat = (f: unknown): CampaignFormat | null => {
      const lower = String(f ?? '').toLowerCase().trim();
      return (CAMPAIGN_FORMATS as readonly string[]).includes(lower) ? (lower as CampaignFormat) : null;
    };
    const primaryFormat = normalizeFormat(parsed.primaryFormat);
    if (!primaryFormat) {
      throw new Error(`content_strategist returned an unknown primaryFormat: ${JSON.stringify(parsed.primaryFormat)}`);
    }
    const secondaryFormats = requireStringArray(parsed.secondaryFormats ?? [], 'secondaryFormats', parsed)
      .map(normalizeFormat)
      .filter((f): f is CampaignFormat => f !== null && f !== primaryFormat);
    return {
      objective: requireString(parsed.objective, 'objective', parsed),
      businessGoal: requireString(parsed.businessGoal, 'businessGoal', parsed),
      audience: requireString(parsed.audience, 'audience', parsed),
      messaging: requireString(parsed.messaging, 'messaging', parsed),
      cta: requireString(parsed.cta, 'cta', parsed),
      primaryFormat,
      secondaryFormats: [...new Set(secondaryFormats)],
      successMetrics: requireStringArray(parsed.successMetrics ?? [], 'successMetrics', parsed),
    };
  });
}

/** Research once: a valid cache hit skips the Researcher's LLM call entirely (provenance recorded); a miss runs the reasoning-tier call and stores the result for the next near-identical topic. */
async function runResearchStep(campaign: Campaign): Promise<CampaignResearch> {
  return withHealthReport('researcher', async () => {
    const cached = readCachedResearch(campaign.title);
    if (cached) {
      return { ...cached.research, reusedFromCache: cached.cacheFile };
    }

    const { referenceSection, knowledgeSection } = loadResearchReferenceMaterial();
    const raw = await runAgent('researcher', {
      userPrompt: [
        'Research the campaign below to ground every downstream format in verifiable facts. This is the ONLY research pass — every department reads your output, so cover the full objective.',
        '',
        briefContextBlock(campaign),
        '',
        '## Reference material (the ONLY sources you may cite)',
        referenceSection,
        ...(knowledgeSection ? ['', '## Additional verified knowledge (Knowledge Layer)', knowledgeSection] : []),
        '',
        'Produce: (1) researchBrief — a short prose brief (3-6 sentences) summarizing what the campaign content should be grounded in; (2) facts — 3-8 concrete facts relevant to the objective, each citing the exact source file it came from; (3) knowledgeGaps — anything the objective needs that the reference material does not cover. Never invent a fact to fill a gap.',
      ].join('\n'),
      jsonShapeHint: '{"researchBrief": string, "facts": [{"claim": string, "source": string}], "knowledgeGaps": string[]}',
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'reasoning',
    });
    const parsed = parseJsonResponse<CampaignResearch>(raw);
    if (!Array.isArray(parsed.facts) || parsed.facts.some((f) => typeof f?.claim !== 'string' || typeof f?.source !== 'string')) {
      throw new Error(`researcher step returned a malformed facts array: ${JSON.stringify(parsed).slice(0, 500)}`);
    }
    const research: CampaignResearch = {
      researchBrief: requireString(parsed.researchBrief, 'researchBrief', parsed),
      facts: parsed.facts,
      knowledgeGaps: Array.isArray(parsed.knowledgeGaps) ? parsed.knowledgeGaps.filter((g): g is string => typeof g === 'string') : [],
    };
    writeCachedResearch(campaign.title, research);
    return research;
  });
}

const WRITTEN_FIELD_BY_FORMAT: Record<string, { field: keyof CampaignContent; instruction: string }> = {
  facebook: { field: 'facebookPost', instruction: 'facebookPost (complete, ready to post)' },
  instagram: { field: 'instagramCaption', instruction: 'instagramCaption (complete, with line breaks as it should appear)' },
  linkedin: { field: 'linkedinPost', instruction: 'linkedinPost (complete, slightly more professional register, same facts)' },
  blog: { field: 'blogArticleMarkdown', instruction: 'blogArticleMarkdown (a full article in Markdown, headline included)' },
};

async function runWritingStep(campaign: Campaign, shared: SharedContext, revisionNotes?: string): Promise<CampaignContent> {
  return withHealthReport('writer', async () => {
    const requested = briefFormats(campaign.brief!).filter((f) => WRITTEN_FORMATS.includes(f));
    const specs = requested.map((f) => WRITTEN_FIELD_BY_FORMAT[f]);

    const raw = await runAgent('writer', {
      userPrompt: [
        `Write the requested written formats of the campaign below — ONLY these ${requested.length}: ${requested.join(', ')}. No other format is wanted; do not produce extras.`,
        '',
        briefContextBlock(campaign),
        '',
        '## Brand voice (follow exactly)',
        shared.brandVoice,
        '## Style guide',
        shared.styleGuide,
        shared.craftKnowledgeSection ? `## Writing craft — verified knowledge (terminology, tone, hook patterns)\n${shared.craftKnowledgeSection}` : '',
        '',
        '## Research brief',
        campaign.research!.researchBrief,
        '## Sourced facts to draw on (do not introduce claims beyond these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        campaign.research!.knowledgeGaps.length > 0 ? `## Known gaps — do not state anything about these as fact:\n${campaign.research!.knowledgeGaps.join('\n')}` : '',
        revisionNotes ? `## Brand Guardian revision notes (address every point)\n${revisionNotes}` : '',
        '',
        `Produce: ${specs.map((s) => s.instruction).join('; ')}. Each format carries the same core message and CTA, adapted per platform — never one text pasted twice.`,
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint: `{${specs.map((s) => `"${s.field}": string`).join(', ')}}`,
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'reasoning',
    });
    const parsed = parseJsonResponse<CampaignContent>(raw);
    const content: CampaignContent = {};
    for (const { field } of specs) {
      content[field] = requireString(parsed[field], field, parsed);
    }
    return content;
  });
}

async function runDesignStep(campaign: Campaign, revisionNotes?: string): Promise<CampaignDesign> {
  return withHealthReport('graphic_designer', async () => {
    const formats = briefFormats(campaign.brief!);
    const wantsCarousel = formats.includes('carousel');
    const wantsThumbnail = formats.some((f) => VIDEO_FORMATS.includes(f));

    const outputs: string[] = [];
    const shapeFields: string[] = [];
    if (wantsCarousel) {
      outputs.push(
        'carouselSlides (the on-slide text for a 5-8 slide educational carousel, one string per slide, slide 1 is the hook)',
        'graphicConcepts (2-3 distinct visual concepts, each described in one or two sentences)',
        'imagePrompts (one generation-ready prompt per concept, concrete about composition, mood, and setting — Vientiane, Laos context, no text baked into the image)'
      );
      shapeFields.push('"carouselSlides": string[]', '"graphicConcepts": string[]', '"imagePrompts": string[]');
    }
    if (wantsThumbnail) {
      outputs.push('thumbnailPrompt (one generation-ready prompt for the video thumbnail)');
      shapeFields.push('"thumbnailPrompt": string');
    }

    const raw = await runAgent('graphic_designer', {
      userPrompt: [
        'Design the visual layer of the campaign below. Concepts and prompts only — rendering happens later through brand templates, so stay within a clean, on-brand, real-estate-appropriate visual language. Produce ONLY what is requested below; nothing else is wanted.',
        '',
        briefContextBlock(campaign),
        '',
        '## The written content these visuals accompany',
        JSON.stringify(campaign.content ?? {}, null, 2),
        revisionNotes ? `## Brand Guardian revision notes (address every point)\n${revisionNotes}` : '',
        '',
        `Produce: ${outputs.join('; ')}.`,
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint: `{${shapeFields.join(', ')}}`,
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'fast',
    });
    const parsed = parseJsonResponse<CampaignDesign>(raw);
    const design: CampaignDesign = {};
    if (wantsCarousel) {
      design.carouselSlides = requireStringArray(parsed.carouselSlides, 'carouselSlides', parsed);
      design.graphicConcepts = requireStringArray(parsed.graphicConcepts, 'graphicConcepts', parsed);
      design.imagePrompts = requireStringArray(parsed.imagePrompts, 'imagePrompts', parsed);
    }
    if (wantsThumbnail) {
      design.thumbnailPrompt = requireString(parsed.thumbnailPrompt, 'thumbnailPrompt', parsed);
    }
    return design;
  });
}

async function runVideoStep(campaign: Campaign, revisionNotes?: string): Promise<CampaignVideo> {
  return withHealthReport('video_producer', async () => {
    const formats = briefFormats(campaign.brief!);
    const wantsTiktok = formats.includes('tiktok');
    const wantsReel = formats.includes('reel');

    const outputs: string[] = [];
    const shapeFields: string[] = [];
    if (wantsTiktok) {
      outputs.push('tiktokScript (a complete 30-45s script with timing beats)');
      shapeFields.push('"tiktokScript": string');
    }
    if (wantsReel) {
      outputs.push(`reelScript (a complete Instagram Reel script${wantsTiktok ? ' — same message, distinct pacing, not a copy of the TikTok script' : ''})`);
      shapeFields.push('"reelScript": string');
    }
    outputs.push(
      'hooks (3-5 alternative opening hooks, one sentence each)',
      'voiceover (the full voice-over text for the primary script, as it should be read aloud)',
      'brollIdeas (5-8 concrete b-roll shots)',
      'captions (the on-screen caption lines for the primary script, in display order)'
    );
    shapeFields.push('"hooks": string[]', '"voiceover": string', '"brollIdeas": string[]', '"captions": string[]');

    const raw = await runAgent('video_producer', {
      userPrompt: [
        'Produce the video layer of the campaign below: short-form scripts ready for a person (or template pipeline) to shoot and assemble. Scripts and plans only — no rendering in this step. Produce ONLY the requested platforms below.',
        '',
        briefContextBlock(campaign),
        '',
        '## Sourced facts (the scripts may not claim anything beyond these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        revisionNotes ? `## Brand Guardian revision notes (address every point)\n${revisionNotes}` : '',
        '',
        `Produce: ${outputs.join('; ')}.`,
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint: `{${shapeFields.join(', ')}}`,
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'fast',
    });
    const parsed = parseJsonResponse<CampaignVideo>(raw);
    const video: CampaignVideo = {
      hooks: requireStringArray(parsed.hooks, 'hooks', parsed),
      voiceover: requireString(parsed.voiceover, 'voiceover', parsed),
      brollIdeas: requireStringArray(parsed.brollIdeas, 'brollIdeas', parsed),
      captions: requireStringArray(parsed.captions, 'captions', parsed),
    };
    if (wantsTiktok) video.tiktokScript = requireString(parsed.tiktokScript, 'tiktokScript', parsed);
    if (wantsReel) video.reelScript = requireString(parsed.reelScript, 'reelScript', parsed);
    return video;
  });
}

async function runQaStep(campaign: Campaign, shared: SharedContext): Promise<CampaignQaReport> {
  return withHealthReport('brand_guardian', async () => {
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

    // Only the sections that actually exist get reviewed — a skipped
    // department contributes nothing to the bundle, so nothing to check.
    const sections: string[] = [];
    const c = campaign.content;
    if (c?.facebookPost) sections.push(`### Facebook post\n${c.facebookPost}`);
    if (c?.instagramCaption) sections.push(`### Instagram caption\n${c.instagramCaption}`);
    if (c?.linkedinPost) sections.push(`### LinkedIn post\n${c.linkedinPost}`);
    if (c?.blogArticleMarkdown) sections.push(`### Blog article\n${c.blogArticleMarkdown}`);
    if (campaign.design?.carouselSlides?.length) sections.push(`### Carousel slides\n${campaign.design.carouselSlides.join('\n---\n')}`);
    if (campaign.video?.tiktokScript) sections.push(`### TikTok script\n${campaign.video.tiktokScript}`);
    if (campaign.video?.reelScript) sections.push(`### Reel script\n${campaign.video.reelScript}`);
    if (campaign.video?.voiceover) sections.push(`### Voice-over\n${campaign.video.voiceover}`);

    // Lao terminology reference rides in the shared craft knowledge (the
    // lao-brain adapter tags brain/lao/dictionary.md entries 'language') —
    // already loaded once for the whole run, not re-fetched here.
    const raw = await runAgent('brand_guardian', {
      userPrompt: [
        'Review the complete generated campaign below before it reaches the founder.',
        '',
        briefContextBlock(campaign),
        '',
        '## Sourced facts this campaign must stay within (flag any claim not traceable to these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        '',
        '## Brand voice (verify consistency)',
        shared.brandVoice,
        '## Posting rules (verify compliance, including banned language)',
        shared.postingRules,
        shared.craftKnowledgeSection ? `## Verified language/craft knowledge (includes canonical Lao terminology — verify any Lao text against it)\n${shared.craftKnowledgeSection}` : '',
        '',
        '## The campaign content under review',
        sections.join('\n\n'),
        '',
        'Produce: factCheck (one short paragraph — are all claims traceable to the sourced facts; name any that are not); brandVoice (one short paragraph on voice consistency); grammar (one short paragraph on grammar/clarity across formats); laoTerminology (one short paragraph — if no Lao text is present, say exactly that rather than inventing an assessment); issues (each concrete problem as its own actionable line, empty if none); summary (2-3 sentences for the founder); approved (true ONLY if there are no factual traceability problems and no posting-rules violations — style nitpicks alone do not block approval).',
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint:
        '{"approved": boolean, "factCheck": string, "brandVoice": string, "grammar": string, "laoTerminology": string, "issues": string[], "summary": string}',
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'fast',
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
// Step lifecycle helpers.
// ---------------------------------------------------------------------------

function markRunning(campaign: Campaign, id: CampaignStepId): CampaignStepState {
  const step = stepState(campaign, id);
  step.status = 'running';
  step.startedAt = new Date().toISOString();
  writeCampaign(campaign);
  return step;
}

function markComplete(campaign: Campaign, id: CampaignStepId, detailOverride?: string): void {
  const step = stepState(campaign, id);
  step.status = 'complete';
  step.completedAt = new Date().toISOString();
  step.detail = detailOverride ?? (step.detail || STEP_ORDER.find((s) => s.id === id)!.doneDetail);
  writeCampaign(campaign);
  console.log(`[Campaign ${campaign.id}] ${step.label}: ${step.detail}`);
}

function markFailed(campaign: Campaign, id: CampaignStepId, err: unknown): void {
  const step = stepState(campaign, id);
  step.status = 'failed';
  step.detail = err instanceof Error ? err.message : 'Unknown error';
  step.completedAt = new Date().toISOString();
  campaign.status = 'failed';
  writeCampaign(campaign);
  console.error(`[Campaign ${campaign.id}] ${step.label} failed: ${step.detail}`);
}

function markSkipped(campaign: Campaign, id: CampaignStepId, reason: string): void {
  const step = stepState(campaign, id);
  step.status = 'skipped';
  step.detail = reason;
  writeCampaign(campaign);
}

/** The Guardian's checkmark tells the truth: "Approved" only if it actually approved. */
function qaDoneDetail(campaign: Campaign): string | undefined {
  if (campaign.qaReport && !campaign.qaReport.approved) {
    return `Reviewed — ${campaign.qaReport.issues.length} issue${campaign.qaReport.issues.length === 1 ? '' : 's'} for your attention`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

/**
 * Runs the full pipeline against the campaign, mutating and persisting it
 * as each step completes. Sequential through CMO → Strategy → Research
 * (each depends on the last), then Writer/Designer/Video in PARALLEL (all
 * three read the same Campaign, write disjoint sections), then Guardian.
 * A failure stops what depends on it — but parallel siblings finish their
 * own work, and everything generated is already persisted and visible.
 */
export async function executeCampaign(campaign: Campaign): Promise<Campaign> {
  // Sequential prefix.
  const prefix: Array<{ id: CampaignStepId; run: () => Promise<void>; doneDetail?: () => string | undefined }> = [
    { id: 'cmo', run: async () => runCmoStep(campaign), doneDetail: () => stepState(campaign, 'cmo').detail || undefined },
    { id: 'strategy', run: async () => void (campaign.brief = await runStrategyStep(campaign)) },
    {
      id: 'research',
      run: async () => void (campaign.research = await runResearchStep(campaign)),
      doneDetail: () => (campaign.research?.reusedFromCache ? `Reused recent research (${campaign.research.reusedFromCache}) — no new tokens spent` : undefined),
    },
  ];

  for (const { id, run, doneDetail } of prefix) {
    markRunning(campaign, id);
    try {
      await run();
    } catch (err) {
      markFailed(campaign, id, err);
      return campaign;
    }
    markComplete(campaign, id, doneDetail?.());
  }

  // Demand-driven gating — decided once, right after the Brief exists.
  const formats = briefFormats(campaign.brief!);
  const wantsWriting = formats.some((f) => WRITTEN_FORMATS.includes(f));
  const wantsDesign = formats.includes('carousel') || formats.some((f) => VIDEO_FORMATS.includes(f));
  const wantsVideo = formats.some((f) => VIDEO_FORMATS.includes(f));

  const shared = loadSharedContext();

  // Parallel generation phase. Each branch manages its own step state so
  // the progress page shows all running departments at once; allSettled so
  // one failure never cancels a sibling's already-paid-for work.
  const branches: Array<{ id: CampaignStepId; wanted: boolean; run: () => Promise<void> }> = [
    { id: 'writing', wanted: wantsWriting, run: async () => void (campaign.content = await runWritingStep(campaign, shared)) },
    { id: 'design', wanted: wantsDesign, run: async () => void (campaign.design = await runDesignStep(campaign)) },
    { id: 'video', wanted: wantsVideo, run: async () => void (campaign.video = await runVideoStep(campaign)) },
  ];

  const active = branches.filter((b) => {
    if (!b.wanted) {
      markSkipped(campaign, b.id, 'Not requested by Strategy');
      return false;
    }
    return true;
  });

  const results = await Promise.allSettled(
    active.map(async ({ id, run }) => {
      markRunning(campaign, id);
      try {
        await run();
      } catch (err) {
        markFailed(campaign, id, err);
        throw err;
      }
      markComplete(campaign, id);
    })
  );

  if (results.some((r) => r.status === 'rejected')) {
    // markFailed already set campaign.status = 'failed' and skipped work is
    // persisted; the Guardian can't meaningfully review a bundle a
    // requested department failed to produce.
    markSkipped(campaign, 'qa', 'Skipped — a generation step failed');
    campaign.status = 'failed';
    writeCampaign(campaign);
    return campaign;
  }

  markRunning(campaign, 'qa');
  try {
    campaign.qaReport = await runQaStep(campaign, shared);
  } catch (err) {
    markFailed(campaign, 'qa', err);
    return campaign;
  }
  markComplete(campaign, 'qa', qaDoneDetail(campaign));

  campaign.status = 'complete';
  campaign.completedAt = new Date().toISOString();
  writeCampaign(campaign);
  console.log(`[Campaign ${campaign.id}] Campaign complete.`);
  return campaign;
}

/** The department steps incremental regeneration can target. */
export const REGENERABLE_STEPS: CampaignStepId[] = ['writing', 'design', 'video'];

/**
 * Incremental regeneration (M3): reruns ONE department — with the
 * Guardian's previous notes as revision input — then a fresh Guardian
 * review. Everything else stays exactly as generated. Never reruns the
 * whole pipeline.
 */
export async function regenerateCampaignStep(campaign: Campaign, stepId: CampaignStepId): Promise<Campaign> {
  if (!REGENERABLE_STEPS.includes(stepId)) {
    throw new Error(`Step "${stepId}" cannot be regenerated — only ${REGENERABLE_STEPS.join(', ')}.`);
  }
  const step = stepState(campaign, stepId);
  if (step.status === 'skipped') {
    throw new Error(`Step "${stepId}" was not requested by Strategy for this campaign — nothing to regenerate.`);
  }
  if (!campaign.brief || !campaign.research) {
    throw new Error(`Campaign ${campaign.id} has no brief/research yet — run the full pipeline first.`);
  }

  const notes = campaign.qaReport ? [campaign.qaReport.summary, ...campaign.qaReport.issues].join('\n') : undefined;
  const shared = loadSharedContext();

  campaign.status = 'running';
  markRunning(campaign, stepId);
  try {
    if (stepId === 'writing') campaign.content = await runWritingStep(campaign, shared, notes);
    else if (stepId === 'design') campaign.design = await runDesignStep(campaign, notes);
    else campaign.video = await runVideoStep(campaign, notes);
  } catch (err) {
    markFailed(campaign, stepId, err);
    return campaign;
  }
  markComplete(campaign, stepId, `Regenerated${notes ? ' with Brand Guardian notes' : ''}`);

  markRunning(campaign, 'qa');
  try {
    campaign.qaReport = await runQaStep(campaign, shared);
  } catch (err) {
    markFailed(campaign, 'qa', err);
    return campaign;
  }
  markComplete(campaign, 'qa', qaDoneDetail(campaign));

  campaign.status = 'complete';
  campaign.completedAt = new Date().toISOString();
  writeCampaign(campaign);
  return campaign;
}
