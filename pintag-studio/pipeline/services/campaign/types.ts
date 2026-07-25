// The Campaign's canonical structured output — same "Services → Canonical
// Structured Data → Renderers" principle as services/morning/types.ts. One
// Campaign is created when the founder accepts an opportunity (the Execute
// Campaign button, `npm run campaign`, or the scored top-N batch), each
// department step fills in exactly one section of it, and every renderer —
// the live progress/detail page, the campaigns dashboard, the /research,
// /content, /video, /publish tabs — is a pure, presentation-only function
// of this object. Departments never pass raw text to each other: a step
// reads the sections upstream steps already wrote onto the Campaign, and
// writes only its own.
//
// Generation-only by design (M2/M3): a completed Campaign is a reviewable
// bundle of drafts, scripts, and prompts. Publishing and scheduling stay
// with the existing Stage 07/08 machinery and are deliberately NOT
// reachable from here.

import type { Language } from '../../lib/types.js';

/** Where the accepted opportunity came from, for the campaign's own record. */
export interface CampaignOpportunity {
  title: string;
  /** Supporting context shown to the strategist — the recommendation reasoning, or an opportunity's detail line. */
  detail: string;
  /** 'recommended-action' | 'opportunity' | 'manual' — informational, never branched on. */
  source: string;
}

// ---------------------------------------------------------------------------
// Opportunity scoring (M3) — deterministic, computed BEFORE any LLM spend.
// ---------------------------------------------------------------------------

/**
 * One scored dimension, with the reason stated so the founder can audit the
 * number. Every dimension is computed from a real signal the system
 * actually has (opportunity kind, evidence count, pattern confidence, the
 * content_items duplicate check). Search demand and seasonal relevance are
 * deliberately ABSENT: no search-volume or seasonality data source exists
 * in Marketing OS today, and fabricating those numbers would violate the
 * evidence-driven rule (brain/ceo.md). They join the scorer when a real
 * data source does.
 */
export interface ScoreDimension {
  name: string;
  /** 0-100. */
  score: number;
  weight: number;
  reason: string;
}

export interface OpportunityScore {
  /** Weighted 0-100 composite of the dimensions below. */
  total: number;
  /** Deterministic mapping of the evidence-confidence signal — 95/70/45, neutral 60 when the opportunity carries no confidence signal. */
  confidencePercent: number;
  priority: 'high' | 'medium' | 'low';
  dimensions: ScoreDimension[];
  /** The dimension reasons, strongest-signal first — the "why this score" lines the UI shows. */
  reasons: string[];
}

/** The scorer's input — the fields of a morning-brief OpportunityItem (or an execute-form submission) that carry real signal. */
export interface ScorableOpportunity {
  title: string;
  detail: string;
  evidence: string[];
  /** 'outperforming-content' | 'emerging-playbook' | 'recommended-action' | 'manual' — the strongest single signal (proven performance vs. pattern vs. founder-directed). */
  kind: string;
  /** Pattern confidence (emerging playbooks) — computed upstream by computeConfidence(), never re-derived here. */
  confidenceLevel?: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Campaign Brief (M3) — the structured intent every downstream department
// reads. No department infers campaign intent independently.
// ---------------------------------------------------------------------------

export const CAMPAIGN_FORMATS = ['facebook', 'instagram', 'linkedin', 'blog', 'carousel', 'tiktok', 'reel'] as const;
export type CampaignFormat = (typeof CAMPAIGN_FORMATS)[number];

export const WRITTEN_FORMATS: CampaignFormat[] = ['facebook', 'instagram', 'linkedin', 'blog'];
export const VIDEO_FORMATS: CampaignFormat[] = ['tiktok', 'reel'];

// ---------------------------------------------------------------------------
// Language Strategy (M5) — language is a strategic decision the Content
// Strategist makes and explains, never a hardcoded setting and never
// something the Writer guesses. Brand defaults (brain/org-config.json →
// language_strategy.brand_defaults) are the starting point; the Strategist
// may override them, but only with a stated reason.
// ---------------------------------------------------------------------------

/** Re-exported so campaign consumers have a single import site for the language vocabulary. */
export type { Language };

export interface LanguageStrategy {
  primaryLanguage: Language;
  /** null for a deliberately single-language campaign — absence is a decision here, not a missing value. */
  secondaryLanguage: Language | null;
  /** Why these languages, in the Strategist's own words. Always present: never silently choose a language. */
  reason: string;
  /**
   * The Strategist's own stated confidence (0-100) in this language call.
   * Deliberately NOT the same thing as OpportunityScore.confidencePercent,
   * which is derived deterministically from observation counts — this is a
   * self-reported judgment, and the UI labels it as such rather than
   * presenting it as a measured value.
   */
  confidencePercent: number;
  /** The brand default this decision started from, for provenance. */
  brandDefault: { primaryLanguage: Language; secondaryLanguage: Language | null };
  /** True when the Strategist departed from the brand default — surfaced in the UI alongside the reason, so an override is never invisible. */
  overrodeBrandDefault: boolean;
}

/** Every language this campaign generates (primary + secondary, deduplicated). The ONE place "which languages" is derived — no department re-decides it. */
export function strategyLanguages(strategy: LanguageStrategy): Language[] {
  return strategy.secondaryLanguage && strategy.secondaryLanguage !== strategy.primaryLanguage
    ? [strategy.primaryLanguage, strategy.secondaryLanguage]
    : [strategy.primaryLanguage];
}

export const LANGUAGE_LABEL: Record<Language, string> = { lo: 'Lao', en: 'English', zh: 'Chinese' };

export interface CampaignBrief {
  objective: string;
  businessGoal: string;
  audience: string;
  messaging: string;
  cta: string;
  /** The one format this campaign leads with. */
  primaryFormat: CampaignFormat;
  /** Additional formats Strategy explicitly requested — generation is demand-driven, nothing outside primary+secondary is produced. */
  secondaryFormats: CampaignFormat[];
  successMetrics: string[];
  /** Which language(s) this campaign is written in, and why (M5). Absent only on campaigns generated before M5. */
  languageStrategy?: LanguageStrategy;
}

/** All formats the brief requests (primary + secondary, deduplicated) — the one place "what should be generated" is derived. */
export function briefFormats(brief: CampaignBrief): CampaignFormat[] {
  return [...new Set([brief.primaryFormat, ...brief.secondaryFormats])];
}

/** The brief's languages, defaulting to the org's own primary for pre-M5 campaigns that have no strategy recorded. */
export function briefLanguages(brief: CampaignBrief, fallback: Language): Language[] {
  return brief.languageStrategy ? strategyLanguages(brief.languageStrategy) : [fallback];
}

// ---------------------------------------------------------------------------
// Department steps.
// ---------------------------------------------------------------------------

export type CampaignStepId =
  | 'cmo'
  | 'strategy'
  | 'research'
  | 'writing'
  | 'design'
  | 'video'
  | 'qa';

export type CampaignStepStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export interface CampaignStepState {
  id: CampaignStepId;
  /** Department label shown in the UI — "CMO", "Researcher", ... Set once at creation, never re-derived by a renderer. */
  label: string;
  status: CampaignStepStatus;
  /** One line of progress detail — "Research Complete", "Not requested by Strategy", or the error message when failed. */
  detail: string;
  startedAt?: string;
  completedAt?: string;
}

/** Researcher step output. Facts follow the exact ResearchPacket shape (claim + source file) so the "never state a fact not traceable to knowledge-base/" rule stays checkable. */
export interface CampaignResearch {
  researchBrief: string;
  facts: Array<{ claim: string; source: string }>;
  knowledgeGaps: string[];
  /** Set when this research was reused from the research/ cache instead of a fresh Researcher run — the honest provenance line the UI shows. */
  reusedFromCache?: string;
}

/** The written assets for ONE language — only the formats the brief requested exist; nothing else is generated. */
export interface WrittenAssets {
  facebookPost?: string;
  instagramCaption?: string;
  linkedinPost?: string;
  blogArticleMarkdown?: string;
}

export const WRITTEN_ASSET_FIELDS: Array<keyof WrittenAssets> = ['facebookPost', 'instagramCaption', 'linkedinPost', 'blogArticleMarkdown'];

/**
 * Writer step output, keyed by language (M5) — one entry per language the
 * Language Strategy requested, each written natively in that language
 * rather than translated from another (see brain/brand-voice.md's
 * Multilingual Note and knowledge/language/'s trilingual requirement).
 */
export type CampaignContent = Partial<Record<Language, WrittenAssets>>;

/**
 * Graphic Designer step output — concepts and prompts, not rendered images
 * (real asset rendering stays with Stage 04's Canva integration, TODO(M2)).
 *
 * Split deliberately by whether an asset carries language: image prompts,
 * graphic concepts, and the thumbnail prompt are VISUAL (the Designer is
 * instructed not to bake text into images at all), so they're generated
 * once regardless of how many languages the campaign runs in. Carousel copy
 * is on-slide TEXT, so it's per-language.
 */
export interface CampaignDesign {
  /** On-slide carousel text, per language. */
  carouselSlides?: Partial<Record<Language, string[]>>;
  graphicConcepts?: string[];
  imagePrompts?: string[];
  thumbnailPrompt?: string;
  /** Layout guidance when the campaign runs bilingually — how both languages sit together cleanly. Absent for single-language campaigns. */
  bilingualLayoutNotes?: string;
}

/** The video assets for ONE language — scripts, voice-over, on-screen text. */
export interface VideoAssets {
  tiktokScript?: string;
  reelScript?: string;
  hooks: string[];
  voiceover: string;
  captions: string[];
}

/**
 * Video Producer step output — scripts and plans, not rendered video (real
 * rendering stays with Stage 05's FFmpeg assembly, TODO(M4)). Scripts,
 * voice-over, and captions are per-language; b-roll ideas are camera shots,
 * so they're language-neutral and generated once.
 */
export interface CampaignVideo {
  byLanguage: Partial<Record<Language, VideoAssets>>;
  brollIdeas: string[];
}

/** Brand Guardian step output — validation over the whole bundle. `approved: false` never blocks saving; the founder sees the issues and decides. */
export interface CampaignQaReport {
  approved: boolean;
  factCheck: string;
  brandVoice: string;
  grammar: string;
  laoTerminology: string;
  /** Result of the content_items near-duplicate title check (reused from Stage 01), or a plain note that the check was unavailable. */
  duplication: string;
  issues: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Founder feedback & learning (M4). These are the structured records the
// Learning Layer derives from — explicit, queryable, permanent. The
// Knowledge Layer (knowledge/) teaches Marketing OS about the world; these
// records teach it about Pintag and its founder. Kept separate by design.
// ---------------------------------------------------------------------------

export type CampaignOutcome = 'approved' | 'approved-with-edits' | 'needs-regeneration' | 'rejected';

/** The one-click "why" chips — never a forced long explanation. */
export const FEEDBACK_REASONS = [
  'Too Salesy',
  'Too Long',
  'Too Short',
  'Wrong Tone',
  'Wrong Audience',
  'Weak Hook',
  'Weak CTA',
  'Grammar',
  'Fact Issue',
  'Brand Voice',
  'Other',
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** 1-5 stars. */
export type Rating = 1 | 2 | 3 | 4 | 5;

/** The departments a founder can rate individually — so a weak video never counts as a failure of the whole campaign. */
export const RATEABLE_DEPARTMENTS = ['research', 'strategy', 'writing', 'design', 'video', 'brandVoice'] as const;
export type RateableDepartment = (typeof RATEABLE_DEPARTMENTS)[number];

export interface CampaignReview {
  outcome: CampaignOutcome;
  overallRating: Rating;
  /** Only the departments that actually produced something get rated. */
  departmentRatings: Partial<Record<RateableDepartment, Rating>>;
  reasons: FeedbackReason[];
  note?: string;
  reviewedAt: string;
}

/** One founder edit to a generated asset. The AI original is never discarded — original + founder version + delta are the learning data. */
export interface CampaignEdit {
  /** Which written-asset field was edited. */
  field: keyof WrittenAssets;
  /** Which language's copy of that field (M5). Absent on edits recorded before M5. */
  language?: Language;
  original: string;
  edited: string;
  /** edited.length - original.length — the cheap, deterministic "difference" signal preference derivation reads. */
  deltaChars: number;
  reasons: FeedbackReason[];
  editedAt: string;
}

/**
 * Post-publish performance metrics (M4 §8) — the storage slot exists now so
 * the schema is settled; NOTHING writes it yet because publishing isn't
 * built. Only real published-campaign metrics may ever land here — never
 * estimated or invented numbers.
 */
export interface CampaignPerformance {
  source: string;
  recordedAt: string;
  metrics: Record<string, number>;
}

export type CampaignStatus = 'running' | 'complete' | 'failed' | 'interrupted';

export interface Campaign {
  /** `${dateISO}-${base36 time}-${slug}` — stable, path-safe, human-readable. */
  id: string;
  title: string;
  createdAt: string;
  completedAt?: string;
  status: CampaignStatus;
  opportunity: CampaignOpportunity;
  /** Computed before any LLM spend — deterministic, auditable (see ScoreDimension). Absent only on campaigns created before M3. */
  score?: OpportunityScore;

  /** The execution checklist, in run order — what the progress page renders. */
  steps: CampaignStepState[];

  // One section per department, filled in as its step completes. All
  // optional: a running/failed campaign legitimately has only a prefix of
  // them, skipped departments never write theirs, and renderers show what
  // exists rather than guessing.
  brief?: CampaignBrief;
  research?: CampaignResearch;
  content?: CampaignContent;
  design?: CampaignDesign;
  video?: CampaignVideo;
  qaReport?: CampaignQaReport;

  // Feedback & learning records (M4) — the campaign no longer ends at
  // "complete"; these accumulate after generation.
  /** Structured founder review — outcome, ratings, one-click reasons. Permanent. */
  review?: CampaignReview;
  /** Every founder edit, AI original preserved. */
  edits?: CampaignEdit[];
  /** Deterministic Lessons Learned, generated from the review + edits at review time — never LLM-invented. */
  lessons?: string[];
  /** Set at generation time: every behavior change prior learning caused, with its provenance ("shorter intro — founder edits shortened content in 3 of 4 reviewed campaigns"). Empty/absent when no learning applied — behavior never changes silently. */
  learningNotes?: string[];
  /** Real post-publish metrics only — see CampaignPerformance. */
  performance?: CampaignPerformance[];
}
