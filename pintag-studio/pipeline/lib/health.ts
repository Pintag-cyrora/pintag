import { supabase } from './supabase.js';

// AI Department Health — every stage reports its own status here so the
// Dashboard can answer "is the department working?" separately from "what's
// scheduled today?". See supabase/migrations/0002_agent_health.sql.

export type AgentName =
  | 'cmo'
  | 'content_strategist'
  | 'researcher'
  | 'writer'
  | 'graphic_designer'
  | 'video_producer'
  | 'brand_guardian'
  | 'trend_hunter'
  | 'competitor_watch'
  | 'publisher'
  | 'marketing_analyst';

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'idle';

/** Founder-facing label per agent role — the server-side copy of the same constant dashboard/index.html already hardcodes client-side (no bundler/shared-module path between browser and Node exists in this repo, so the values are kept identical by convention, same as this file's other duplicated-by-necessity constants elsewhere in the codebase). Used by services/morning/kpis.ts's Department Updates section. */
export const AGENT_LABELS: Record<AgentName, string> = {
  cmo: 'CMO',
  content_strategist: 'Content Strategist',
  researcher: 'Researcher',
  writer: 'Writer',
  graphic_designer: 'Designer',
  video_producer: 'Video Producer',
  brand_guardian: 'Brand Guardian',
  trend_hunter: 'Trend Hunter',
  competitor_watch: 'Competitor Watch',
  publisher: 'Publisher',
  marketing_analyst: 'Analyst',
};

export async function reportHealth(agentName: AgentName, status: HealthStatus, message?: string): Promise<void> {
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    org_id: 'pintag',
    agent_name: agentName,
    status,
    message: message ?? null,
    last_run_at: now,
    updated_at: now,
  };
  if (status === 'healthy') payload.last_success_at = now;

  await supabase.from('agent_health').upsert(payload, { onConflict: 'org_id,agent_name' });
}

/**
 * Wraps a stage's main function so any uncaught error automatically reports
 * 'down' with the error message, instead of every stage hand-rolling its own
 * try/catch. Use this once a stage's real logic (not just its stub) is in
 * place — an intentional "Not implemented" throw during M0 will correctly
 * report as 'down' with that message, which is an honest signal, not noise.
 */
export async function withHealthReport<T>(agentName: AgentName, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await reportHealth(agentName, 'healthy');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await reportHealth(agentName, 'down', message);
    throw err;
  }
}

/**
 * Maps a Meta Graph API error response to a health status + founder-readable
 * message, per the specific examples given for Publisher: an expired token
 * is 'down' (needs founder action), a rate limit is 'degraded' (self-resolves).
 */
export function classifyMetaPublishError(error: unknown): { status: HealthStatus; message: string } {
  const httpStatus = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;

  if (httpStatus === 401 || httpStatus === 190) {
    return { status: 'down', message: 'Facebook authentication expired.' };
  }
  if (httpStatus === 429) {
    return { status: 'degraded', message: 'Posts delayed — Meta is rate limiting publishing.' };
  }

  const message = error instanceof Error ? error.message : 'Unknown publishing error';
  return { status: 'down', message };
}
