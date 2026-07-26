// The run ledger service (autonomy roadmap step 1 — EXECUTION_ARCHITECTURE.md
// §8.1). Records every department execution in Supabase so run state survives
// the process that produced it.
//
// THE LOAD-BEARING DESIGN RULE: recording a run must never break the run.
//
// Every function here degrades to a no-op (logging once, returning null) when
// Supabase is unreachable or the migration hasn't been applied. That is
// deliberate and matches how `daily-briefing.ts` already treats Supabase
// publication — the founder's actual work is generation, and bookkeeping about
// that work must not be able to prevent it. The alternative (throwing) would
// mean a transient network blip stops the Morning Brief from being generated,
// which trades a real capability for an audit trail. Wrong trade.
//
// The consequence to be honest about: a ledger that can silently skip writes
// is not a reliable audit source *yet*. It becomes one when it's the scheduler
// itself reading these rows to decide what to run (step 5+), at which point a
// write failure needs to be loud. `isLedgerAvailable()` exists so that future
// caller can check rather than assume, and the degradation is logged once per
// process so it's visible rather than silent.

import { supabase } from '../../lib/supabase.js';
import type { RunRecord, RunStatus, RunDepartment, StartRunInput } from './types.js';

const ORG_ID = 'pintag';

/** Logged once per process, not per call — a broken ledger during a long run would otherwise flood the output and bury the real work's logs. */
let degradationLogged = false;
let ledgerAvailable = true;

function noteDegradation(operation: string, err: unknown): null {
  ledgerAvailable = false;
  if (!degradationLogged) {
    degradationLogged = true;
    console.warn(
      `[run-ledger] Unavailable (${operation}: ${err instanceof Error ? err.message : String(err)}). ` +
        `Runs will still execute normally, but this run's history will not be recorded. ` +
        `If migration 0006_pipeline_runs.sql has not been applied yet, that's the likely cause.`
    );
  }
  return null;
}

/** Whether ledger writes have succeeded so far in this process. A future scheduler that depends on these rows should check this rather than assuming success. */
export function isLedgerAvailable(): boolean {
  return ledgerAvailable;
}

interface RunRow {
  id: string;
  org_id: string;
  department: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  cost_usd: string | number | null;
  error: string | null;
  output: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  idempotency_key: string | null;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    department: row.department as RunDepartment,
    status: row.status as RunStatus,
    trigger: row.trigger as RunRecord['trigger'],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    // numeric(10,4) comes back as a string from postgres-js — coerce once,
    // here, so no caller has to remember.
    costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd),
    error: row.error ?? undefined,
    output: row.output ?? {},
    progress: row.progress ?? {},
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

/**
 * Opens a run. Returns null when the ledger is unavailable — callers proceed
 * with the actual work regardless and simply have nothing to update later.
 *
 * With an idempotencyKey, a unique-violation means an equivalent run already
 * exists; that existing run is returned instead of creating a duplicate, so a
 * scheduler that fires twice does the work once. Callers can detect this via
 * the returned record's `status` (an already-'complete' record means there is
 * nothing to do).
 */
export async function startRun(input: StartRunInput): Promise<RunRecord | null> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .insert({
        org_id: ORG_ID,
        department: input.department,
        status: 'running',
        trigger: input.trigger ?? 'founder',
        idempotency_key: input.idempotencyKey ?? null,
        progress: input.progress ?? {},
      })
      .select('*')
      .single();

    if (error) {
      // 23505 = unique_violation: the idempotency key already exists.
      if (error.code === '23505' && input.idempotencyKey) {
        return await findRunByIdempotencyKey(input.idempotencyKey);
      }
      return noteDegradation('startRun', new Error(error.message));
    }
    return toRecord(data as RunRow);
  } catch (err) {
    return noteDegradation('startRun', err);
  }
}

export async function findRunByIdempotencyKey(key: string): Promise<RunRecord | null> {
  try {
    const { data, error } = await supabase.from('pipeline_runs').select('*').eq('idempotency_key', key).maybeSingle();
    if (error) return noteDegradation('findRunByIdempotencyKey', new Error(error.message));
    return data ? toRecord(data as RunRow) : null;
  } catch (err) {
    return noteDegradation('findRunByIdempotencyKey', err);
  }
}

/** Updates a running run's progress detail. Cheap and frequent — safe to call per step. */
export async function updateRunProgress(runId: string | null, progress: Record<string, unknown>): Promise<void> {
  if (!runId) return;
  try {
    const { error } = await supabase
      .from('pipeline_runs')
      .update({ progress, updated_at: new Date().toISOString() })
      .eq('id', runId);
    if (error) noteDegradation('updateRunProgress', new Error(error.message));
  } catch (err) {
    noteDegradation('updateRunProgress', err);
  }
}

/** Closes a run as successful. `costUsd` should be omitted unless a real measured value exists — never estimated. */
export async function completeRun(
  runId: string | null,
  opts: { output?: Record<string, unknown>; costUsd?: number } = {}
): Promise<void> {
  await finishRun(runId, 'complete', { output: opts.output, costUsd: opts.costUsd });
}

/** Closes a run as failed, recording the message the founder will actually see. */
export async function failRun(runId: string | null, err: unknown, opts: { output?: Record<string, unknown> } = {}): Promise<void> {
  await finishRun(runId, 'failed', {
    error: err instanceof Error ? err.message : String(err),
    output: opts.output,
  });
}

async function finishRun(
  runId: string | null,
  status: Extract<RunStatus, 'complete' | 'failed' | 'interrupted'>,
  fields: { output?: Record<string, unknown>; costUsd?: number; error?: string }
): Promise<void> {
  if (!runId) return;
  try {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = { status, finished_at: now, updated_at: now };
    if (fields.output !== undefined) update.output = fields.output;
    if (fields.costUsd !== undefined) update.cost_usd = fields.costUsd;
    if (fields.error !== undefined) update.error = fields.error;

    const { error } = await supabase.from('pipeline_runs').update(update).eq('id', runId);
    if (error) noteDegradation('finishRun', new Error(error.message));
  } catch (err) {
    noteDegradation('finishRun', err);
  }
}

/**
 * Marks runs still flagged 'running' as 'interrupted'. Called at startup: any
 * run left 'running' belonged to a process that no longer exists, so it was
 * orphaned by a restart or crash, not by an agent failing.
 *
 * Kept distinct from 'failed' because the brief should say "the workspace
 * restarted mid-run" rather than blaming a department (§8.1). Returns how many
 * were reconciled.
 *
 * NOTE: correct today because exactly one process writes this table. When
 * multiple workers exist (step 5+), this must become a heartbeat/lease check —
 * otherwise one worker starting would mark another's live runs interrupted.
 * Flagged rather than pre-solved, per the roadmap's "build it when it's the
 * thing in the way" rule.
 */
export async function reconcileOrphanedRuns(): Promise<number> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('pipeline_runs')
      .update({ status: 'interrupted', finished_at: now, updated_at: now, error: 'Workspace restarted while this run was in progress.' })
      .eq('org_id', ORG_ID)
      .eq('status', 'running')
      .select('id');
    if (error) {
      noteDegradation('reconcileOrphanedRuns', new Error(error.message));
      return 0;
    }
    const count = (data ?? []).length;
    if (count > 0) console.log(`[run-ledger] Marked ${count} orphaned run(s) as interrupted (left running by a previous process).`);
    return count;
  } catch (err) {
    noteDegradation('reconcileOrphanedRuns', err);
    return 0;
  }
}

/** Most recent runs, newest first — the workspace's run-history view. */
export async function listRecentRuns(limit = 25): Promise<RunRecord[]> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('*')
      .eq('org_id', ORG_ID)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) {
      noteDegradation('listRecentRuns', new Error(error.message));
      return [];
    }
    return (data ?? []).map((row) => toRecord(row as RunRow));
  } catch (err) {
    noteDegradation('listRecentRuns', err);
    return [];
  }
}

/**
 * Runs that started at or after `since` — the query the Morning Brief will use
 * once it reports completed work instead of orchestrating it (§7). Exists now
 * so step 3 is a rewrite of the brief, not also a rewrite of this layer.
 */
export async function listRunsSince(since: string, limit = 200): Promise<RunRecord[]> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('*')
      .eq('org_id', ORG_ID)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) {
      noteDegradation('listRunsSince', new Error(error.message));
      return [];
    }
    return (data ?? []).map((row) => toRecord(row as RunRow));
  } catch (err) {
    noteDegradation('listRunsSince', err);
    return [];
  }
}

/** The currently-running run for a department, if any. Lets a status endpoint answer from durable state rather than an in-memory flag. */
export async function findRunningRun(department: RunDepartment): Promise<RunRecord | null> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('*')
      .eq('org_id', ORG_ID)
      .eq('department', department)
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) return noteDegradation('findRunningRun', new Error(error.message));
    return data && data.length > 0 ? toRecord(data[0] as RunRow) : null;
  } catch (err) {
    return noteDegradation('findRunningRun', err);
  }
}

/** The most recent run for a department regardless of status — what a client polls after a restart to learn how the last attempt ended. */
export async function findLatestRun(department: RunDepartment): Promise<RunRecord | null> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('*')
      .eq('org_id', ORG_ID)
      .eq('department', department)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) return noteDegradation('findLatestRun', new Error(error.message));
    return data && data.length > 0 ? toRecord(data[0] as RunRow) : null;
  } catch (err) {
    return noteDegradation('findLatestRun', err);
  }
}

/**
 * Consecutive failures for a department, most recent first — the circuit
 * breaker's input (§11). Counts back from the newest run and stops at the
 * first success, so an old failure doesn't keep a healthy department tripped.
 * Added now because the breaker is a prerequisite for scheduling, and this is
 * the query it needs.
 */
export async function countConsecutiveFailures(department: RunDepartment, lookback = 10): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('status')
      .eq('org_id', ORG_ID)
      .eq('department', department)
      .in('status', ['complete', 'failed'])
      .order('started_at', { ascending: false })
      .limit(lookback);
    if (error) {
      noteDegradation('countConsecutiveFailures', new Error(error.message));
      return 0;
    }
    let streak = 0;
    for (const row of data ?? []) {
      if ((row as { status: string }).status !== 'failed') break;
      streak += 1;
    }
    return streak;
  } catch (err) {
    noteDegradation('countConsecutiveFailures', err);
    return 0;
  }
}
