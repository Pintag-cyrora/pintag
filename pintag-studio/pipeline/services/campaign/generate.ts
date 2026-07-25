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
import { REPO_ROOT, readLanguageDefaults, readConfiguredLanguages, readActiveCompanyName } from '../../lib/config.js';
import { retrieveKnowledge, relativeKnowledgePath } from '../../lib/knowledge.js';
import { loadResearchReferenceMaterial } from '../../stages/02-research.js';
import { loadWritingContext } from '../../stages/03-write.js';
import { findSimilarByTitle } from '../../stages/01-plan.js';
import { writeCampaign, listCampaigns } from './persist.js';
import { scoreOpportunity } from './score.js';
import { readCachedResearch, writeCachedResearch } from './research-cache.js';
import { deriveFounderLearning, learningPromptLines } from '../learning/learn.js';
import {
  briefFormats,
  strategyLanguages,
  CAMPAIGN_FORMATS,
  WRITTEN_FORMATS,
  VIDEO_FORMATS,
  LANGUAGE_LABEL,
  type Language,
  type WrittenAssets,
  type VideoAssets,
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
  /**
   * Founder-learning lines (M4), each already carrying its own evidence —
   * derived deterministically from past reviews/edits (services/learning/).
   * Empty until real feedback exists: no observations, no behavior change.
   */
  learningLines: string[];
}

/**
 * Loaded once per run, after the Language Strategy exists (M5) — the
 * `languages` argument gates the writing-craft Knowledge Layer read: the
 * 'language' category is where brain/lao/dictionary.md and knowledge/
 * language/ live (via the lao-brain source adapter), which is a large,
 * Lao-specific payload. An English-only campaign has no use for canonical
 * Lao terminology, so it isn't loaded — a real token saving in the same
 * spirit as M3's demand-driven generation, not a behavior change.
 */
function loadSharedContext(languages: Language[], learningLines: string[]): SharedContext {
  const { brandVoice, styleGuide } = loadWritingContext();
  const postingRules = readFileSync(join(REPO_ROOT, 'brain', 'posting-rules.md'), 'utf-8');
  const categories = languages.includes('lo') ? ['language', 'marketing', 'psychology'] : ['marketing', 'psychology'];
  const craftEntries = retrieveKnowledge({ categories, minStatus: 'verified' });
  const craftKnowledgeSection = craftEntries.map((e) => `### knowledge/${relativeKnowledgePath(e)}\n${e.body}`).join('\n\n');
  return { brandVoice, styleGuide, postingRules, craftKnowledgeSection, learningLines };
}

/** Derived once per run and shared by the Strategist (which runs before any language is known) and every later step. */
function loadLearningLines(): string[] {
  return learningPromptLines(deriveFounderLearning(listCampaigns()));
}

/** The Strategist runs before a Language Strategy exists, so it gets a minimal context: founder learning only, no language-scoped craft knowledge. */
function strategistContext(learningLines: string[]): SharedContext {
  return { brandVoice: '', styleGuide: '', postingRules: '', craftKnowledgeSection: '', learningLines };
}

/** The Language Strategy as a prompt block — every generation department reads this and none re-decides language. */
function languageBlock(campaign: Campaign): string {
  const ls = campaign.brief?.languageStrategy;
  if (!ls) return '';
  const langs = strategyLanguages(ls);
  return [
    '## Language Strategy (decided by the Content Strategist — follow exactly, do not add or drop a language)',
    `Primary language: ${LANGUAGE_LABEL[ls.primaryLanguage]} (${ls.primaryLanguage})`,
    ls.secondaryLanguage ? `Secondary language: ${LANGUAGE_LABEL[ls.secondaryLanguage]} (${ls.secondaryLanguage})` : 'Secondary language: none — this is a deliberately single-language campaign.',
    `Reason: ${ls.reason}`,
    `Generate for exactly these languages: ${langs.map((l) => LANGUAGE_LABEL[l]).join(', ')}.`,
    langs.length > 1
      ? 'Each language must be written natively in that language for its own audience — never a translation of the other. Brand-voice restraint does not loosen in a second language (see the brand voice notes above).'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The learning block injected into a generation prompt. Each line states
 * the adjustment AND the observation behind it, so the model is never
 * following an unexplained rule and the founder can audit the same text on
 * campaign.learningNotes (M4 §11 — never make hidden adjustments).
 */
function learningBlock(learningLines: string[]): string {
  if (learningLines.length === 0) return '';
  return [
    '## What the founder has taught Marketing OS (from their own past reviews and edits — follow these, and note that each carries the evidence behind it)',
    ...learningLines.map((l) => `- ${l}`),
  ].join('\n');
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

async function runStrategyStep(campaign: Campaign, shared: SharedContext): Promise<CampaignBrief> {
  return withHealthReport('content_strategist', async () => {
    const brandDefault = readLanguageDefaults();
    const configuredLanguages = readConfiguredLanguages();

    const raw = await runAgent('content_strategist', {
      userPrompt: [
        'Create the Campaign Brief for the accepted opportunity below. This brief is the single source of campaign intent — every downstream department (Researcher, Writer, Graphic Designer, Video Producer, Brand Guardian) reads it and none of them may infer intent on their own, so it must be complete and specific.',
        '',
        `## Opportunity`,
        `Title: ${campaign.opportunity.title}`,
        campaign.opportunity.detail ? `Context: ${campaign.opportunity.detail}` : '',
        campaign.score ? `Priority: ${campaign.score.priority} (scored ${campaign.score.total}/100)\nWhy it scored that way:\n${campaign.score.reasons.map((r) => `- ${r}`).join('\n')}` : '',
        '',
        learningBlock(shared.learningLines),
        '',
        `## Brand language defaults for ${readActiveCompanyName()} (a starting point, not a rule)`,
        `Default primary: ${LANGUAGE_LABEL[brandDefault.primary]} (${brandDefault.primary})`,
        brandDefault.secondary ? `Default secondary: ${LANGUAGE_LABEL[brandDefault.secondary]} (${brandDefault.secondary})` : 'Default secondary: none',
        `Languages this business operates in (you may only choose from these): ${configuredLanguages.map((l) => `${LANGUAGE_LABEL[l]} (${l})`).join(', ')}`,
        '',
        'Produce: objective (what this campaign makes the audience understand or do — educational-first per the founder brief); businessGoal (the business outcome it serves, one line); audience (the specific segment, and why them); messaging (the single core message, stated plainly); cta (ONE call to action); primaryFormat (the one format this campaign leads with); secondaryFormats (ONLY formats this campaign genuinely needs — every format you list costs real generation work, so request the smallest set that serves the objective, and an empty list is a legitimate answer); successMetrics (2-4 observable signals of success, e.g. shares, saves, profile visits).',
        '',
        'ALSO decide this campaign\'s language, as a strategic call — the Writer, Designer, and Video Producer will follow it exactly and must never guess:',
        '- primaryLanguage: the language this campaign leads in. Base it on who the audience actually is (a Lao-speaking first-time buyer and a foreign investor are not the same reader), the objective, and the distribution channels. Start from the brand default above and depart from it when the audience genuinely calls for it.',
        '- secondaryLanguage: a second language ONLY if this campaign genuinely needs to reach a second audience. Use null for a single-language campaign — every extra language costs real generation work, so "none" is often the right answer.',
        '- languageReason: why these languages, in one or two plain sentences tied to the audience and objective. This is shown to the founder verbatim.',
        '- languageConfidencePercent: 0-100, how confident YOU are in this language call given what you know. Be honest — a genuinely ambiguous audience should not be reported as 95.',
        'You have no published-performance data about which languages perform better, so do not claim any. Reason from audience, objective, and channel only.',
        '',
        `Valid formats (use these exact strings): ${CAMPAIGN_FORMATS.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      jsonShapeHint:
        '{"objective": string, "businessGoal": string, "audience": string, "messaging": string, "cta": string, "primaryFormat": string, "secondaryFormats": string[], "successMetrics": string[], "primaryLanguage": string, "secondaryLanguage": string | null, "languageReason": string, "languageConfidencePercent": number}',
      maxBudgetUsd: STEP_BUDGET_USD,
      modelTier: 'fast',
    });
    interface StrategistOutput extends CampaignBrief {
      primaryLanguage?: unknown;
      secondaryLanguage?: unknown;
      languageReason?: unknown;
      languageConfidencePercent?: unknown;
    }
    const parsed = parseJsonResponse<StrategistOutput>(raw);
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

    // Language: accepted only if it's a language this business actually
    // operates in (org.languages). An unrecognized code falls back to the
    // brand default rather than generating in a language nobody configured
    // — and the fallback is stated in the reason, never hidden.
    const normalizeLanguage = (l: unknown): Language | null => {
      const lower = String(l ?? '').toLowerCase().trim();
      return (configuredLanguages as string[]).includes(lower) ? (lower as Language) : null;
    };
    const chosenPrimary = normalizeLanguage(parsed.primaryLanguage);
    const primaryLanguage = chosenPrimary ?? brandDefault.primary;
    const chosenSecondary = normalizeLanguage(parsed.secondaryLanguage);
    const secondaryLanguage = chosenSecondary && chosenSecondary !== primaryLanguage ? chosenSecondary : null;

    const strategistReason = typeof parsed.languageReason === 'string' && parsed.languageReason.trim() ? parsed.languageReason.trim() : '';
    const reason = chosenPrimary
      ? strategistReason || `No reason given by the Strategist — defaulted to the brand's configured languages for ${readActiveCompanyName()}.`
      : `The Strategist did not return a usable language${parsed.primaryLanguage ? ` (got ${JSON.stringify(parsed.primaryLanguage)}, which is not one of this business's configured languages)` : ''}, so this campaign fell back to the brand default.${strategistReason ? ` Its stated reasoning was: ${strategistReason}` : ''}`;

    const rawConfidence = Number(parsed.languageConfidencePercent);
    // A missing/garbage confidence becomes 0 with the reason above rather
    // than a flattering invented number — the UI shows it as the
    // Strategist's own claim, so it has to be the Strategist's own claim.
    const confidencePercent = Number.isFinite(rawConfidence) && chosenPrimary ? Math.max(0, Math.min(100, Math.round(rawConfidence))) : 0;

    return {
      objective: requireString(parsed.objective, 'objective', parsed),
      businessGoal: requireString(parsed.businessGoal, 'businessGoal', parsed),
      audience: requireString(parsed.audience, 'audience', parsed),
      messaging: requireString(parsed.messaging, 'messaging', parsed),
      cta: requireString(parsed.cta, 'cta', parsed),
      primaryFormat,
      secondaryFormats: [...new Set(secondaryFormats)],
      successMetrics: requireStringArray(parsed.successMetrics ?? [], 'successMetrics', parsed),
      languageStrategy: {
        primaryLanguage,
        secondaryLanguage,
        reason,
        confidencePercent,
        brandDefault: { primaryLanguage: brandDefault.primary, secondaryLanguage: brandDefault.secondary },
        overrodeBrandDefault: primaryLanguage !== brandDefault.primary || secondaryLanguage !== brandDefault.secondary,
      },
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

const WRITTEN_FIELD_BY_FORMAT: Record<string, { field: keyof WrittenAssets; instruction: string }> = {
  facebook: { field: 'facebookPost', instruction: 'facebookPost (complete, ready to post)' },
  instagram: { field: 'instagramCaption', instruction: 'instagramCaption (complete, with line breaks as it should appear)' },
  linkedin: { field: 'linkedinPost', instruction: 'linkedinPost (complete, slightly more professional register, same facts)' },
  blog: { field: 'blogArticleMarkdown', instruction: 'blogArticleMarkdown (a full article in Markdown, headline included)' },
};

/**
 * The Writer runs once PER LANGUAGE (M5) rather than once with a nested
 * multi-language response. Separate calls because each language needs its
 * own full native-writing attention and its own brand-voice check — asking
 * one call for "the Lao and English versions" is exactly the path that
 * produces a good primary and a translated-feeling secondary, which
 * knowledge/language/'s trilingual requirement explicitly warns against.
 * Only the languages the Language Strategy requested are generated.
 */
async function runWritingStep(campaign: Campaign, shared: SharedContext, revisionNotes?: string): Promise<CampaignContent> {
  return withHealthReport('writer', async () => {
    const requested = briefFormats(campaign.brief!).filter((f) => WRITTEN_FORMATS.includes(f));
    const specs = requested.map((f) => WRITTEN_FIELD_BY_FORMAT[f]);
    const languages = strategyLanguages(campaign.brief!.languageStrategy!);

    const content: CampaignContent = {};
    for (const language of languages) {
      const raw = await runAgent('writer', {
        userPrompt: [
          `Write the requested written formats of the campaign below in ${LANGUAGE_LABEL[language]} — ONLY these ${requested.length} format(s): ${requested.join(', ')}. No other format is wanted; do not produce extras.`,
          `Write natively in ${LANGUAGE_LABEL[language]} for a ${LANGUAGE_LABEL[language]}-speaking reader. This is not a translation exercise: do not translate from another language, and do not produce text that reads as translated. Brand-voice restraint is identical in every language — no loosening, no added promotional warmth, because a phrase didn't carry over cleanly.`,
          '',
          briefContextBlock(campaign),
          languageBlock(campaign),
          '',
          '## Brand voice (follow exactly)',
          shared.brandVoice,
          '## Style guide',
          shared.styleGuide,
          shared.craftKnowledgeSection
            ? `## Writing craft — verified knowledge (terminology, tone, hook patterns)${language === 'lo' ? '. This includes canonical Lao terminology — use these exact terms rather than improvising equivalents.' : ''}\n${shared.craftKnowledgeSection}`
            : '',
          learningBlock(shared.learningLines),
          '',
          '## Research brief',
          campaign.research!.researchBrief,
          '## Sourced facts to draw on (do not introduce claims beyond these)',
          JSON.stringify(campaign.research!.facts, null, 2),
          campaign.research!.knowledgeGaps.length > 0 ? `## Known gaps — do not state anything about these as fact:\n${campaign.research!.knowledgeGaps.join('\n')}` : '',
          revisionNotes ? `## Brand Guardian revision notes (address every point)\n${revisionNotes}` : '',
          '',
          `Produce, in ${LANGUAGE_LABEL[language]}: ${specs.map((s) => s.instruction).join('; ')}. Each format carries the same core message and CTA, adapted per platform — never one text pasted twice.`,
        ]
          .filter(Boolean)
          .join('\n'),
        jsonShapeHint: `{${specs.map((s) => `"${s.field}": string`).join(', ')}}`,
        maxBudgetUsd: STEP_BUDGET_USD,
        modelTier: 'reasoning',
      });
      const parsed = parseJsonResponse<WrittenAssets>(raw);
      const assets: WrittenAssets = {};
      for (const { field } of specs) {
        assets[field] = requireString(parsed[field], `${language}.${field}`, parsed);
      }
      content[language] = assets;
    }
    return content;
  });
}

async function runDesignStep(campaign: Campaign, revisionNotes?: string): Promise<CampaignDesign> {
  return withHealthReport('graphic_designer', async () => {
    const formats = briefFormats(campaign.brief!);
    const wantsCarousel = formats.includes('carousel');
    const wantsThumbnail = formats.some((f) => VIDEO_FORMATS.includes(f));

    const languages = strategyLanguages(campaign.brief!.languageStrategy!);
    const bilingual = languages.length > 1;

    // Image prompts, graphic concepts, and the thumbnail stay language-
    // neutral: the Designer is told not to bake text into images at all, so
    // there's nothing language-specific to duplicate. Only the on-slide
    // carousel TEXT is per-language.
    const outputs: string[] = [];
    const shapeFields: string[] = [];
    if (wantsCarousel) {
      for (const language of languages) {
        outputs.push(
          `carouselSlides_${language} (the on-slide text for a 5-8 slide educational carousel written natively in ${LANGUAGE_LABEL[language]}, one string per slide, slide 1 is the hook)`
        );
        shapeFields.push(`"carouselSlides_${language}": string[]`);
      }
      outputs.push(
        'graphicConcepts (2-3 distinct visual concepts, each described in one or two sentences)',
        'imagePrompts (one generation-ready prompt per concept, concrete about composition, mood, and setting — Vientiane, Laos context, no text baked into the image, so these serve every language)'
      );
      shapeFields.push('"graphicConcepts": string[]', '"imagePrompts": string[]');
    }
    if (wantsThumbnail) {
      outputs.push('thumbnailPrompt (one generation-ready prompt for the video thumbnail, no text baked in)');
      shapeFields.push('"thumbnailPrompt": string');
    }
    if (bilingual && wantsCarousel) {
      outputs.push(
        `bilingualLayoutNotes (how ${languages.map((l) => LANGUAGE_LABEL[l]).join(' and ')} text sit together cleanly — script height differences, line-length differences, whether to pair them on one slide or alternate slides, and where each language's text block belongs)`
      );
      shapeFields.push('"bilingualLayoutNotes": string');
    }

    const raw = await runAgent('graphic_designer', {
      userPrompt: [
        'Design the visual layer of the campaign below. Concepts and prompts only — rendering happens later through brand templates, so stay within a clean, on-brand, real-estate-appropriate visual language. Produce ONLY what is requested below; nothing else is wanted.',
        '',
        briefContextBlock(campaign),
        languageBlock(campaign),
        bilingual
          ? 'This campaign runs in more than one language: on-slide text is needed in each, and the layout has to hold both without either feeling like an afterthought.'
          : `All on-slide text must be in ${LANGUAGE_LABEL[languages[0]]}. Do not add text in any other language.`,
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
    const parsed = parseJsonResponse<Record<string, unknown>>(raw);
    const design: CampaignDesign = {};
    if (wantsCarousel) {
      design.carouselSlides = {};
      for (const language of languages) {
        design.carouselSlides[language] = requireStringArray(parsed[`carouselSlides_${language}`], `carouselSlides_${language}`, parsed);
      }
      design.graphicConcepts = requireStringArray(parsed.graphicConcepts, 'graphicConcepts', parsed);
      design.imagePrompts = requireStringArray(parsed.imagePrompts, 'imagePrompts', parsed);
      if (bilingual) design.bilingualLayoutNotes = requireString(parsed.bilingualLayoutNotes, 'bilingualLayoutNotes', parsed);
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

    const languages = strategyLanguages(campaign.brief!.languageStrategy!);

    // Scripts, voice-over, hooks, and captions are spoken/on-screen TEXT —
    // one set per language, each written natively (a voice-over read aloud
    // from a translation is exactly what "never machine-translated" rules
    // out). B-roll ideas are camera shots, so they're requested once, on
    // the first pass only, and shared across languages.
    const video: CampaignVideo = { byLanguage: {}, brollIdeas: [] };

    for (const [index, language] of languages.entries()) {
      const needsBroll = index === 0;
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
        'voiceover (the full voice-over text for the primary script, written the way it should actually be read aloud by a native speaker)',
        'captions (the on-screen caption lines for the primary script, in display order)'
      );
      shapeFields.push('"hooks": string[]', '"voiceover": string', '"captions": string[]');
      if (needsBroll) {
        outputs.push('brollIdeas (5-8 concrete b-roll shots — these are camera shots, so describe them in English for the person filming regardless of the script language)');
        shapeFields.push('"brollIdeas": string[]');
      }

      const raw = await runAgent('video_producer', {
        userPrompt: [
          `Produce the ${LANGUAGE_LABEL[language]} video layer of the campaign below: short-form scripts ready for a person (or template pipeline) to shoot and assemble. Scripts and plans only — no rendering in this step. Produce ONLY the requested platforms below.`,
          `Every spoken and on-screen line must be written natively in ${LANGUAGE_LABEL[language]} for a ${LANGUAGE_LABEL[language]}-speaking viewer — not translated from another language. A voice-over read from a translation sounds wrong out loud, which is the one thing this step must avoid.`,
          '',
          briefContextBlock(campaign),
          languageBlock(campaign),
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
      const parsed = parseJsonResponse<VideoAssets & { brollIdeas?: unknown }>(raw);
      const assets: VideoAssets = {
        hooks: requireStringArray(parsed.hooks, `${language}.hooks`, parsed),
        voiceover: requireString(parsed.voiceover, `${language}.voiceover`, parsed),
        captions: requireStringArray(parsed.captions, `${language}.captions`, parsed),
      };
      if (wantsTiktok) assets.tiktokScript = requireString(parsed.tiktokScript, `${language}.tiktokScript`, parsed);
      if (wantsReel) assets.reelScript = requireString(parsed.reelScript, `${language}.reelScript`, parsed);
      video.byLanguage[language] = assets;
      if (needsBroll) video.brollIdeas = requireStringArray(parsed.brollIdeas, 'brollIdeas', parsed);
    }
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
    // Grouped BY LANGUAGE (M5) so the Guardian judges each language's copy
    // as native writing in that language, rather than reviewing a mixed pile.
    const languages = strategyLanguages(campaign.brief!.languageStrategy!);
    const sections: string[] = [];
    for (const language of languages) {
      const langSections: string[] = [];
      const c = campaign.content?.[language];
      if (c?.facebookPost) langSections.push(`#### Facebook post\n${c.facebookPost}`);
      if (c?.instagramCaption) langSections.push(`#### Instagram caption\n${c.instagramCaption}`);
      if (c?.linkedinPost) langSections.push(`#### LinkedIn post\n${c.linkedinPost}`);
      if (c?.blogArticleMarkdown) langSections.push(`#### Blog article\n${c.blogArticleMarkdown}`);
      const slides = campaign.design?.carouselSlides?.[language];
      if (slides?.length) langSections.push(`#### Carousel slides\n${slides.join('\n---\n')}`);
      const v = campaign.video?.byLanguage?.[language];
      if (v?.tiktokScript) langSections.push(`#### TikTok script\n${v.tiktokScript}`);
      if (v?.reelScript) langSections.push(`#### Reel script\n${v.reelScript}`);
      if (v?.voiceover) langSections.push(`#### Voice-over\n${v.voiceover}`);
      if (v?.captions?.length) langSections.push(`#### On-screen captions\n${v.captions.join('\n')}`);
      if (langSections.length) sections.push(`### ${LANGUAGE_LABEL[language]} (${language})\n\n${langSections.join('\n\n')}`);
    }

    const hasLao = languages.includes('lo');
    // Lao terminology reference rides in the shared craft knowledge (the
    // lao-brain adapter surfaces brain/lao/dictionary.md through the
    // 'language' category) — loaded once for the whole run, and only when
    // this campaign actually involves Lao.
    const raw = await runAgent('brand_guardian', {
      userPrompt: [
        'Review the complete generated campaign below before it reaches the founder.',
        '',
        briefContextBlock(campaign),
        languageBlock(campaign),
        '',
        '## Sourced facts this campaign must stay within (flag any claim not traceable to these)',
        JSON.stringify(campaign.research!.facts, null, 2),
        '',
        '## Brand voice (verify consistency — restraint must be identical in every language; a second language that reads looser or more promotional is a brand-voice violation, not acceptable localization)',
        shared.brandVoice,
        '## Posting rules (verify compliance, including banned language)',
        shared.postingRules,
        shared.craftKnowledgeSection
          ? `## Verified language/craft knowledge${hasLao ? ' (includes canonical Lao terminology — verify every Lao term against it and flag improvised equivalents)' : ''}\n${shared.craftKnowledgeSection}`
          : '',
        '',
        '## Language-specific checks required for this campaign',
        ...languages.map((l) =>
          l === 'lo'
            ? '- Lao: spelling, grammar, natural wording a Lao speaker would actually use, and terminology consistent with the canonical Lao knowledge above. Flag anything that reads as machine-translated or as English phrasing forced into Lao — this content is expected to be written natively, and translated-sounding text should be reported as an issue.'
            : l === 'en'
              ? '- English: grammar, clarity, brand voice, and tone.'
              : `- ${LANGUAGE_LABEL[l]}: spelling, grammar, natural native wording, and tone. Flag anything that reads as machine-translated.`
        ),
        languages.length > 1 ? '- Across languages: both versions must carry the same facts, the same CTA family, and the same restraint. Neither may be a literal translation of the other.' : '',
        '',
        '## The campaign content under review',
        sections.join('\n\n'),
        '',
        `Produce: factCheck (one short paragraph — are all claims traceable to the sourced facts; name any that are not); brandVoice (one short paragraph on voice consistency${languages.length > 1 ? ', explicitly covering whether restraint holds equally in both languages' : ''}); grammar (one short paragraph on grammar/clarity across formats and languages); laoTerminology (${hasLao ? 'one short paragraph on Lao spelling, grammar, natural wording, and terminology consistency, naming any specific term that should change' : 'this campaign contains no Lao content — say exactly that rather than inventing an assessment'}); issues (each concrete problem as its own actionable line, prefixed with the language it applies to, empty if none); summary (2-3 sentences for the founder); approved (true ONLY if there are no factual traceability problems, no posting-rules violations, and no language that reads as machine-translated — style nitpicks alone do not block approval).`,
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
  const learningLines = loadLearningLines();

  // Transparency (M4 §11): whatever learning shapes this campaign is
  // recorded ON the campaign, with evidence, before generation starts —
  // so the founder can always see why it looks the way it does.
  campaign.learningNotes = learningLines;

  // Sequential prefix. The Strategist runs first with a learning-only
  // context, because it's what DECIDES the campaign's language (M5) — the
  // full brand/craft context can't be loaded until that decision exists,
  // since which knowledge to load depends on it.
  const prefix: Array<{ id: CampaignStepId; run: () => Promise<void>; doneDetail?: () => string | undefined }> = [
    { id: 'cmo', run: async () => runCmoStep(campaign), doneDetail: () => stepState(campaign, 'cmo').detail || undefined },
    {
      id: 'strategy',
      run: async () => void (campaign.brief = await runStrategyStep(campaign, strategistContext(learningLines))),
      doneDetail: () => {
        const ls = campaign.brief?.languageStrategy;
        if (!ls) return undefined;
        const langs = strategyLanguages(ls).map((l) => LANGUAGE_LABEL[l]).join(' + ');
        return `Campaign Planned — ${langs}${ls.overrodeBrandDefault ? ' (overrode brand default)' : ''}`;
      },
    },
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

  // Now the language is known, so the language-scoped context can load.
  const shared = loadSharedContext(strategyLanguages(campaign.brief!.languageStrategy!), learningLines);

  // Demand-driven gating — decided once, right after the Brief exists.
  const formats = briefFormats(campaign.brief!);
  const wantsWriting = formats.some((f) => WRITTEN_FORMATS.includes(f));
  const wantsDesign = formats.includes('carousel') || formats.some((f) => VIDEO_FORMATS.includes(f));
  const wantsVideo = formats.some((f) => VIDEO_FORMATS.includes(f));

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
  // Same language scoping as the original run — regeneration never silently
  // changes the campaign's language; the Strategist's decision stands.
  const shared = loadSharedContext(strategyLanguages(campaign.brief.languageStrategy!), loadLearningLines());

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
