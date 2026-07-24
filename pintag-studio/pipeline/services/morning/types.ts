// The Morning Brief's canonical structured output (see the "Services →
// Canonical Structured Data → Renderers" principle in the architecture
// plan). One MorningBrief is produced once per generation by
// generateMorningBrief() and persisted (persist.ts); every renderer —
// terminal, web, and any future one — is a pure, presentation-only
// function of this object. All business logic (classification, scoring,
// thresholds, relative-time labels) is computed once, here, at generation
// time — never re-derived by a renderer.

import type { Observation } from '../../lib/observations.js';
import type { KnowledgeEntry } from '../../lib/knowledge.js';
import type { AgentName, HealthStatus } from '../../lib/health.js';

/** One real, pending item the founder needs to act on — moved from daily-briefing.ts unchanged. */
export interface AttentionItem {
  source: string;
  title: string;
  badge: string;
  detail: string;
  link: string;
}

export interface SupabaseCollectResult {
  available: boolean;
  summary: string;
  pendingApprovalsCount?: number;
  publishedCount?: number;
  pendingApprovals?: Array<{ title: string; contentType: string }>;
}

/** A Recent Activity item — the raw Observation plus display strings already computed at generation time. */
export interface RecentActivityItem {
  observation: Observation;
  /** "5,000 views in 20 hours" (or a generic age-only fallback for a non-video source) — computed once, in generate.ts. */
  stat: string;
  /** "Early performance is above your recent baseline" | "Too early to judge" | ... — computed once. */
  framing: string;
}

/** One agent_health row, direct and unmodified — no fabricated metrics. */
export interface DepartmentUpdate {
  agentName: AgentName;
  label: string;
  status: HealthStatus;
  message: string | null;
  /** "3 hours ago", or null if the agent has never run — computed once, in kpis.ts. */
  lastRunLabel: string | null;
  /** "3 hours ago", or null if the agent has never succeeded — computed once. */
  lastSuccessLabel: string | null;
}

/** Deterministic aggregate over all DepartmentUpdate rows — counts only, nothing invented. */
export interface CompanyHealth {
  available: boolean;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  idleCount: number;
  totalCount: number;
  overallStatus: 'healthy' | 'attention' | 'down' | 'unavailable';
  headline: string;
}

export interface RiskItem {
  kind: 'department-health' | 'underperforming-content' | 'source-error';
  title: string;
  detail: string;
}

export interface OpportunityItem {
  kind: 'outperforming-content' | 'emerging-playbook';
  title: string;
  detail: string;
  evidence: string[];
  link?: string;
  /** Set only for kind: 'emerging-playbook' — lets the web renderer emit the existing, unchanged /review/patterns/:id/approve|ignore|keep-observing action forms without any decision logic of its own (it only knows the id, not what it means). */
  patternId?: string;
}

export interface MorningBrief {
  generatedAt: string;
  /** generatedAt.slice(0, 10) — kept as its own field so renderers never re-derive it. */
  dateISO: string;
  /** Locale-formatted "Friday, July 24, 2026" — computed once, in generate.ts, so no renderer ever calls `new Date(...)` itself. */
  dateLabel: string;
  /** Locale-formatted full date+time, for the page footnote — computed once. */
  generatedLabel: string;
  founderName: string;
  activeCompany: string;
  win: string | undefined;

  /** Raw CMO output, RECOMMENDED ACTION:/WHY THIS MATTERS: markers intact — source of daily-briefing/*.md, byte-compatible with today's on-disk contract (pipeline/teach.ts reads this). */
  rawBriefingText: string;
  /** Same text with the marker lines stripped — the Executive Summary card's prose. */
  narrative: string;
  recommendedAction: string | undefined;
  recommendedActionReasoning: string | undefined;

  /** Market Intelligence section. */
  recentlyVerifiedKnowledge: KnowledgeEntry[];
  recentActivity: RecentActivityItem[];

  /** Today's Priorities section (renamed from "Needs Your Attention"). */
  todaysPriorities: AttentionItem[];

  /** Company Health + Department Updates sections. */
  companyHealth: CompanyHealth;
  departmentUpdates: DepartmentUpdate[];

  risks: RiskItem[];
  opportunities: OpportunityItem[];
}
