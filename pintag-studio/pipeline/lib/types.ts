// Shared types for the pipeline. Mirrors the Supabase control-plane schema
// in supabase/migrations/0001_init_control_plane.sql — keep these in sync.

export type ContentType =
  | 'educational_post'
  | 'neighborhood_guide'
  | 'market_update'
  | 'property_video'
  | 'carousel_graphic'
  | 'checklist'
  | 'buying_guide'
  | 'selling_guide'
  | 'investor_guide'
  | 'faq';

export type Language = 'lo' | 'en' | 'zh';

export type ContentStatus =
  | 'draft'
  | 'in_review'
  | 'revising'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'superseded';

export type FounderMode = 'normal' | 'busy' | 'campaign' | 'vacation' | 'manual';
export type ApprovalPhase = 'phase_1' | 'phase_2' | 'phase_3';

export interface ContentBrief {
  contentType: ContentType;
  topic: string;
  angle: string;
  language: Language;
  /** 'new' for from-scratch content, or a reference to an existing Vault item to update/repurpose. */
  origin: { kind: 'new' } | { kind: 'update' | 'repurpose'; vaultItemId: string };
  targetPlatforms: Array<'facebook' | 'instagram' | 'tiktok' | 'youtube'>;
}

export interface ResearchPacket {
  facts: Array<{ claim: string; source: string }>;
  relatedListings?: Array<{ listingId: string; summary: string }>;
  knowledgeGaps?: string[];
}

export interface Draft {
  contentItemId: string;
  title: string;
  bodyMarkdown: string;
  language: Language;
}

export interface QualityScoreResult {
  contentItemId: string;
  reviewPass: number;
  scores: {
    educationalValue: number;
    trustworthiness: number;
    brandVoice: number;
    originality: number;
    visualQuality: number | null;
    shareability: number;
    promotionLevel: number;
    confidence: number;
  };
  compositeScore: number;
  verdict: 'pass' | 'revise';
  revisionNotes?: string;
}

/**
 * Runtime config = static structural config (brain/org-config.json, reviewed
 * like code) merged with live state (org_settings table, Dashboard-editable).
 * See RuntimeConfig loader in pipeline/lib/config.ts.
 */
export interface RuntimeConfig {
  orgId: string;
  founderMode: FounderMode;
  approvalPhase: ApprovalPhase;
  pinnedCampaignId: string | null;
  autoPublishEligible: Record<
    string,
    { minConfidence: number | null; eligibleFromPhase: ApprovalPhase | 'never' }
  >;
  qualityScore: {
    weights: Record<string, number>;
    minThresholdPerDimension: number;
    maxRevisionCycles: number;
  };
}
