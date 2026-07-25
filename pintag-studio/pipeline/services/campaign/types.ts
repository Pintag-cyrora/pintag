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
}

/** All formats the brief requests (primary + secondary, deduplicated) — the one place "what should be generated" is derived. */
export function briefFormats(brief: CampaignBrief): CampaignFormat[] {
  return [...new Set([brief.primaryFormat, ...brief.secondaryFormats])];
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

/** Writer step output — only the formats the brief requested exist; nothing else is generated. */
export interface CampaignContent {
  facebookPost?: string;
  instagramCaption?: string;
  linkedinPost?: string;
  blogArticleMarkdown?: string;
}

/** Graphic Designer step output — concepts and prompts, not rendered images (real asset rendering stays with Stage 04's Canva integration, TODO(M2)). Carousel fields exist only when the brief requests a carousel; the thumbnail only when it requests video. */
export interface CampaignDesign {
  carouselSlides?: string[];
  graphicConcepts?: string[];
  imagePrompts?: string[];
  thumbnailPrompt?: string;
}

/** Video Producer step output — scripts and plans, not rendered video (real rendering stays with Stage 05's FFmpeg assembly, TODO(M4)). Per-platform scripts exist only when requested. */
export interface CampaignVideo {
  tiktokScript?: string;
  reelScript?: string;
  hooks: string[];
  voiceover: string;
  brollIdeas: string[];
  captions: string[];
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
}
