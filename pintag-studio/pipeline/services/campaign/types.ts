// The Campaign's canonical structured output — same "Services → Canonical
// Structured Data → Renderers" principle as services/morning/types.ts. One
// Campaign is created when the founder accepts an opportunity (the Execute
// Campaign button, or `npm run campaign`), each department step fills in
// exactly one section of it, and every renderer — the live progress page,
// the /research, /content, /video, /publish tabs — is a pure,
// presentation-only function of this object. Departments never pass raw
// text to each other: a step reads the sections upstream steps already
// wrote onto the Campaign, and writes only its own.
//
// Generation-only by design (this milestone): a completed Campaign is a
// reviewable bundle of drafts, scripts, and prompts. Publishing and
// scheduling stay with the existing Stage 07/08 machinery and are
// deliberately NOT reachable from here.

/** Where the accepted opportunity came from, for the campaign's own record. */
export interface CampaignOpportunity {
  title: string;
  /** Supporting context shown to the CMO step — the recommendation reasoning, or an opportunity's detail line. */
  detail: string;
  /** 'recommended-action' | 'opportunity' | 'manual' — informational, never branched on. */
  source: string;
}

/** One department's slot in the execution checklist, in run order. */
export type CampaignStepId =
  | 'cmo'
  | 'research'
  | 'strategy'
  | 'writing'
  | 'design'
  | 'video'
  | 'qa';

export type CampaignStepStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface CampaignStepState {
  id: CampaignStepId;
  /** Department label shown in the UI — "CMO", "Researcher", ... Set once at creation, never re-derived by a renderer. */
  label: string;
  status: CampaignStepStatus;
  /** One line of progress detail — "Research Complete", or the error message when failed. */
  detail: string;
  startedAt?: string;
  completedAt?: string;
}

/** CMO step output — the opportunity turned into a directed objective. */
export interface CampaignObjective {
  objective: string;
  /** Why this opportunity is worth a campaign, in the CMO's words. */
  acceptanceRationale: string;
}

/** Researcher step output. Facts follow the exact ResearchPacket shape (claim + source file) so the "never state a fact not traceable to knowledge-base/" rule stays checkable. */
export interface CampaignResearch {
  researchBrief: string;
  facts: Array<{ claim: string; source: string }>;
  knowledgeGaps: string[];
}

/** Content Strategist step output. */
export interface CampaignStrategy {
  audience: string;
  messaging: string;
  cta: string;
  formats: string[];
}

/** Writer step output — every written format of the campaign. */
export interface CampaignContent {
  facebookPost: string;
  instagramCaption: string;
  linkedinPost: string;
  blogArticleMarkdown: string;
}

/** Graphic Designer step output — concepts and prompts, not rendered images (real asset rendering stays with Stage 04's Canva integration, TODO(M2)). */
export interface CampaignDesign {
  carouselSlides: string[];
  graphicConcepts: string[];
  imagePrompts: string[];
  thumbnailPrompt: string;
}

/** Video Producer step output — scripts and plans, not rendered video (real rendering stays with Stage 05's FFmpeg assembly, TODO(M4)). */
export interface CampaignVideo {
  tiktokScript: string;
  reelScript: string;
  hooks: string[];
  voiceover: string;
  brollIdeas: string[];
  captions: string[];
}

/** Brand Guardian step output — validation over the whole bundle. `approved: false` never blocks saving; the founder sees the issues on the Publish tab and decides. */
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
  /** `${dateISO}-${slug}` — stable, path-safe, human-readable. */
  id: string;
  title: string;
  createdAt: string;
  completedAt?: string;
  status: CampaignStatus;
  opportunity: CampaignOpportunity;

  /** The execution checklist, in run order — what the progress page renders. */
  steps: CampaignStepState[];

  // One section per department, filled in as its step completes. All
  // optional: a running/failed campaign legitimately has only a prefix of
  // them, and renderers show what exists rather than guessing.
  objective?: CampaignObjective;
  research?: CampaignResearch;
  strategy?: CampaignStrategy;
  content?: CampaignContent;
  design?: CampaignDesign;
  video?: CampaignVideo;
  qaReport?: CampaignQaReport;
}
