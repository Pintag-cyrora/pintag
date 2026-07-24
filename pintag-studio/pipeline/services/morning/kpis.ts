// Company Health + Department Updates — the sole reader of agent_health
// for the whole Morning Brief pipeline (M2.9 web migration). Previously,
// gatherOrganizationalMemory() queried this table filtered to
// down/degraded only, for one CMO-prompt paragraph; calculateKPIs() is now
// the one query, fetching every row, and formatDepartmentHealthIssues()
// derives that same prompt paragraph from these results — one query, one
// source of truth, nothing duplicated.

import { supabase } from '../../lib/supabase.js';
import { AGENT_LABELS, type AgentName, type HealthStatus } from '../../lib/health.js';
import { formatRelativeTime } from './format.js';
import type { CompanyHealth, DepartmentUpdate } from './types.js';

interface AgentHealthRow {
  agent_name: AgentName;
  status: HealthStatus;
  message: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
}

const HEALTH_DEFAULT_MESSAGE: Record<HealthStatus, string> = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down', idle: 'Not yet run' };

/** Every registered agent role, so a role with no agent_health row yet (never run) still gets a Department Updates entry — same "show it, don't omit it" discipline as /observations' connection-status list. */
const ALL_AGENT_NAMES = Object.keys(AGENT_LABELS) as AgentName[];

export interface KpiResult {
  companyHealth: CompanyHealth;
  departmentUpdates: DepartmentUpdate[];
}

export async function calculateKPIs(): Promise<KpiResult> {
  const now = Date.now();
  try {
    const { data, error } = await supabase.from('agent_health').select('agent_name, status, message, last_run_at, last_success_at').eq('org_id', 'pintag');
    if (error) throw error;

    const rowsByAgent = new Map<AgentName, AgentHealthRow>((data ?? []).map((r: AgentHealthRow) => [r.agent_name, r]));

    const departmentUpdates: DepartmentUpdate[] = ALL_AGENT_NAMES.map((agentName) => {
      const row = rowsByAgent.get(agentName);
      const status: HealthStatus = row?.status ?? 'idle';
      return {
        agentName,
        label: AGENT_LABELS[agentName],
        status,
        message: row?.message ?? HEALTH_DEFAULT_MESSAGE[status],
        lastRunLabel: row?.last_run_at ? formatRelativeTime(row.last_run_at, now) : null,
        lastSuccessLabel: row?.last_success_at ? formatRelativeTime(row.last_success_at, now) : null,
      };
    });

    const healthyCount = departmentUpdates.filter((d) => d.status === 'healthy').length;
    const degradedCount = departmentUpdates.filter((d) => d.status === 'degraded').length;
    const downCount = departmentUpdates.filter((d) => d.status === 'down').length;
    const idleCount = departmentUpdates.filter((d) => d.status === 'idle').length;
    const totalCount = departmentUpdates.length;

    const overallStatus: CompanyHealth['overallStatus'] = downCount > 0 ? 'down' : degradedCount > 0 ? 'attention' : 'healthy';

    const parts: string[] = [`${healthyCount} of ${totalCount} AI employees healthy`];
    if (degradedCount > 0) parts.push(`${degradedCount} degraded`);
    if (downCount > 0) parts.push(`${downCount} down`);
    if (idleCount > 0) parts.push(`${idleCount} not yet run`);
    const headline = `${parts[0]}${parts.length > 1 ? ` — ${parts.slice(1).join(', ')}.` : '.'}`;

    return {
      companyHealth: { available: true, healthyCount, degradedCount, downCount, idleCount, totalCount, overallStatus, headline },
      departmentUpdates,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      companyHealth: {
        available: false,
        healthyCount: 0,
        degradedCount: 0,
        downCount: 0,
        idleCount: 0,
        totalCount: 0,
        overallStatus: 'unavailable',
        headline: `Department health unavailable — no live Supabase connection (${message}).`,
      },
      departmentUpdates: [],
    };
  }
}

/** Pure formatter reused by generate.ts to build the CMO prompt's "Department health issues" paragraph from calculateKPIs()'s already-fetched rows, avoiding a second query. */
export function formatDepartmentHealthIssues(rows: DepartmentUpdate[]): string {
  const issues = rows.filter((r) => r.status === 'down' || r.status === 'degraded');
  if (issues.length === 0) return 'Every AI employee is healthy.';
  return issues.map((r) => `- ${r.label}: ${r.status} — ${r.message ?? 'no message'}`).join('\n');
}
