// The run ledger's canonical types (autonomy roadmap step 1 — see
// EXECUTION_ARCHITECTURE.md §8.1). One RunRecord per department execution,
// whether the founder triggered it or a schedule did.
//
// This is the substrate the Morning Brief will eventually REPORT OVER
// (§7): once departments run unattended, "what happened overnight" is a
// query against these rows, not a re-derivation of current state.

/** Departments that can own a run. Superset of AgentName because a run can also be a whole campaign (several departments) or the brief itself. */
export type RunDepartment =
  | 'morning-brief'
  | 'campaign'
  | 'research'
  | 'strategy'
  | 'writing'
  | 'design'
  | 'video'
  | 'qa'
  | 'analytics'
  | 'publisher'
  | 'trend-hunter'
  | 'competitor-watch';

/**
 * 'interrupted' is distinct from 'failed' on purpose: it means the run was
 * 'running' in a process that no longer exists (a restart or crash orphaned
 * it), not that an agent misbehaved. Conflating the two would make
 * infrastructure problems look like agent problems in the brief.
 */
export type RunStatus = 'running' | 'complete' | 'failed' | 'interrupted';

/** Who initiated the run. 'department' is for department-to-department queueing (§10) — Research finishing enqueues Strategy. */
export type RunTrigger = 'founder' | 'schedule' | 'department';

export interface RunRecord {
  id: string;
  orgId: string;
  department: RunDepartment;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt?: string;
  /** Real measured spend only. Undefined means unknown — never an estimate. */
  costUsd?: number;
  error?: string;
  /** What the run produced, by reference: campaign ids, a brief's generatedAt, counts. */
  output: Record<string, unknown>;
  /** Live detail for a running job, so a polling client sees more than "running". */
  progress: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface StartRunInput {
  department: RunDepartment;
  trigger?: RunTrigger;
  /**
   * Natural key that makes a retrying scheduler safe — conventionally
   * `<org>:<department>:<cycle-date>`. Omit for ad hoc founder runs:
   * pressing Generate twice on purpose is legitimate, and shouldn't be
   * deduplicated.
   */
  idempotencyKey?: string;
  progress?: Record<string, unknown>;
}

/** Conventional idempotency key for one scheduled cycle. Keeps the format in one place so the scheduler and any manual backfill agree. */
export function cycleIdempotencyKey(department: RunDepartment, cycleDate: string, orgId = 'pintag'): string {
  return `${orgId}:${department}:${cycleDate}`;
}
