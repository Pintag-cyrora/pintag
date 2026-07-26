// Budget enforcement (autonomy roadmap step 2 — EXECUTION_ARCHITECTURE.md
// §8.3). Until now `monthly_ceiling_usd` was documentation: nothing read it,
// and nothing could stop a runaway loop. This makes it real, because it is the
// hard prerequisite for letting departments run while nobody is watching.
//
// WHAT THIS PROTECTS AGAINST, concretely: a scheduled cycle that fails and
// retries at 3am, or an agent that loops, spending real money for hours with
// no human present. That risk barely exists when the founder taps Generate and
// watches; it is the defining risk of autonomy.
//
// THE CENTRAL DESIGN DECISION — fail-open or fail-closed? It depends on who
// asked for the work, and the asymmetry is real rather than a hedge:
//
//   trigger 'founder'  → degrade OPEN with a warning. The founder is present,
//                        watching a progress screen, and can stop it. Refusing
//                        their work because a spend query failed would break
//                        the tool for no safety gain.
//   trigger 'schedule' → degrade CLOSED. Nobody is watching. If we cannot
//   or 'department'      prove spend is under the ceiling, we must not spend.
//
// Anything that cannot be counted is treated as a hole in the ceiling, never
// as zero: an 'unpriced' call (real spend, no configured rate) is spend we
// know happened and cannot measure. Founder runs warn; scheduled runs refuse.
// Recording a fabricated $0 would be worse than admitting ignorance.

import { readBudgetConfig } from '../../lib/config.js';
import { supabase } from '../../lib/supabase.js';
import type { LlmUsage } from '../../lib/llm.js';
import type { RunTrigger } from '../runs/types.js';

/** Thrown before any spend happens. Callers let it propagate: a run that stops cleanly mid-way is better than one that silently produces truncated work. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// ---------------------------------------------------------------------------
// Execution context — who asked for the work currently running.
//
// Module-scoped rather than threaded through every call site. Deliberate: it
// mirrors the single-process, one-run-at-a-time model already documented in
// lib/cached-page.ts and services/runs/ledger.ts, and threading a context
// parameter through every department step would be a large change for a
// property that is currently always the same within a process.
//
// Defaults to 'founder', which is today's only trigger — so nothing changes
// until a scheduler explicitly says otherwise (step 5+), and the strict path
// can never be entered by accident.
// ---------------------------------------------------------------------------

let currentTrigger: RunTrigger = 'founder';

export function setExecutionTrigger(trigger: RunTrigger): void {
  currentTrigger = trigger;
}

export function getExecutionTrigger(): RunTrigger {
  return currentTrigger;
}

/** True when the current work is unattended, and therefore must fail closed. */
function mustFailClosed(): boolean {
  return currentTrigger !== 'founder';
}

// ---------------------------------------------------------------------------
// In-process spend accumulator.
//
// Tracks what THIS process has spent since the last reset. Used for the
// per-run ceiling and — importantly — added to ledger totals when checking the
// daily/monthly ceilings, because the current run's cost isn't written to the
// ledger until it finishes. Without that, a single long run could blow through
// the daily ceiling entirely unnoticed, since every check would see only
// already-completed runs.
// ---------------------------------------------------------------------------

interface SpendAccumulator {
  totalUsd: number;
  calls: number;
  /** Calls whose real cost could not be determined — a measured hole in the ceiling. */
  unpricedCalls: number;
}

let accumulator: SpendAccumulator = { totalUsd: 0, calls: 0, unpricedCalls: 0 };

/** Called by an orchestrator at the start of a run so per-run accounting starts from zero. */
export function resetSpendAccounting(): void {
  accumulator = { totalUsd: 0, calls: 0, unpricedCalls: 0 };
}

export function currentSpend(): Readonly<SpendAccumulator> {
  return { ...accumulator };
}

/** Records what a completed call actually cost. Called after every LLM call, from the one place calls happen (lib/agent.ts). */
export function recordUsage(usage: LlmUsage): void {
  accumulator.calls += 1;
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    accumulator.totalUsd += usage.costUsd;
  } else {
    accumulator.unpricedCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Ledger-backed windows.
// ---------------------------------------------------------------------------

/** UTC day/month starts. UTC rather than local so a deployed instance and the founder's laptop agree on which day it is. */
function startOfUtcDay(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
function startOfUtcMonth(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface WindowSpend {
  totalUsd: number;
  runs: number;
  /** False when the ledger couldn't be read — the number is not trustworthy and the caller must decide based on trigger. */
  known: boolean;
}

/** Sum of recorded run costs since `since`. `known: false` on any read failure — never a silent 0, which would read as "nothing spent". */
async function spendSince(since: string): Promise<WindowSpend> {
  try {
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('cost_usd')
      .eq('org_id', 'pintag')
      .gte('started_at', since);
    if (error) return { totalUsd: 0, runs: 0, known: false };
    const rows = data ?? [];
    const total = rows.reduce((sum, r) => {
      const c = (r as { cost_usd: string | number | null }).cost_usd;
      return sum + (c === null ? 0 : Number(c));
    }, 0);
    return { totalUsd: total, runs: rows.length, known: true };
  } catch {
    return { totalUsd: 0, runs: 0, known: false };
  }
}

export async function todaySpend(): Promise<WindowSpend> {
  return spendSince(startOfUtcDay());
}

export async function monthSpend(): Promise<WindowSpend> {
  return spendSince(startOfUtcMonth());
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  perRunUsd: number;
  perRunCeilingUsd: number;
  todayUsd: number;
  dailyCeilingUsd: number;
  monthUsd: number;
  monthlyCeilingUsd: number;
  /** Whether ledger-derived figures are trustworthy. */
  known: boolean;
  unpricedCalls: number;
}

/** Everything the gate knows, for display. Ledger totals include this process's in-flight spend, so the numbers match what the gate enforces. */
export async function budgetStatus(): Promise<BudgetStatus> {
  const config = readBudgetConfig();
  const [today, month] = await Promise.all([todaySpend(), monthSpend()]);
  const inFlight = accumulator.totalUsd;
  return {
    perRunUsd: inFlight,
    perRunCeilingUsd: config.perRunCeilingUsd,
    // The current run isn't in the ledger yet, so add it — otherwise a single
    // long run could exceed the daily ceiling without any check noticing.
    todayUsd: today.totalUsd + inFlight,
    dailyCeilingUsd: config.dailyCeilingUsd,
    monthUsd: month.totalUsd + inFlight,
    monthlyCeilingUsd: config.monthlyCeilingUsd,
    known: today.known && month.known,
    unpricedCalls: accumulator.unpricedCalls,
  };
}

/**
 * Checked BEFORE every LLM call. Throws BudgetExceededError rather than
 * returning a flag, so a caller cannot accidentally ignore it and spend
 * anyway — the failure mode of a forgotten `if` here is real money.
 *
 * Deliberately does not attempt to predict the next call's cost: that isn't
 * knowable, and pretending otherwise would be the same fabrication this
 * codebase avoids everywhere else. It enforces "we are already at/over the
 * line, stop," which bounds total spend to roughly one call beyond a ceiling.
 */
export async function assertWithinBudget(context: { agentName?: string } = {}): Promise<void> {
  const config = readBudgetConfig();
  const who = context.agentName ? ` (before calling ${context.agentName})` : '';
  const trigger = currentTrigger;

  // Per-run: purely in-process, so it works with no Supabase at all.
  if (accumulator.totalUsd >= config.perRunCeilingUsd) {
    throw new BudgetExceededError(
      `Per-run budget reached${who}: this run has spent $${accumulator.totalUsd.toFixed(4)} of its $${config.perRunCeilingUsd.toFixed(2)} ceiling. ` +
        `Raise budget.per_run_ceiling_usd in brain/org-config.json if this run genuinely needs more.`
    );
  }

  // Unpriced spend is unmeasurable spend, and knowing that needs no ledger —
  // so it's checked here, before anything that can fail. Order matters: if
  // this came after the ledger check, an unattended run with an unreachable
  // ledger would be refused with the less actionable "can't read spend"
  // message when the real, fixable problem is a missing price entry.
  if (accumulator.unpricedCalls > 0) {
    const detail = `${accumulator.unpricedCalls} call(s) in this run had no configured price, so their real cost is not counted against any ceiling. Add the model to budget.model_prices_usd_per_mtok in brain/org-config.json.`;
    if (mustFailClosed()) {
      throw new BudgetExceededError(`Refusing to continue an unattended "${trigger}" run${who}: ${detail}`);
    }
    console.warn(`[budget] ${detail}`);
  }

  const [today, month] = await Promise.all([todaySpend(), monthSpend()]);

  if (!today.known || !month.known) {
    if (mustFailClosed()) {
      throw new BudgetExceededError(
        `Refusing to spend${who}: this is an unattended "${trigger}" run and the spend ledger is unreadable, so there is no way to confirm we are under the daily ($${config.dailyCeilingUsd.toFixed(2)}) or monthly ($${config.monthlyCeilingUsd.toFixed(2)}) ceiling. ` +
          `Apply migration 0006_pipeline_runs.sql and confirm Supabase is reachable. A founder-triggered run would be allowed here, because you would be watching it.`
      );
    }
    console.warn(
      `[budget] Spend ledger unreadable — cannot verify the daily/monthly ceiling${who}. Allowing because this is a founder-triggered run and you can stop it. ` +
        `An unattended run would have been refused here.`
    );
    return;
  }

  const todayTotal = today.totalUsd + accumulator.totalUsd;
  if (todayTotal >= config.dailyCeilingUsd) {
    throw new BudgetExceededError(
      `Daily budget reached${who}: $${todayTotal.toFixed(4)} spent today (UTC) against a $${config.dailyCeilingUsd.toFixed(2)} ceiling. ` +
        `Raise budget.daily_ceiling_usd in brain/org-config.json, or wait for the next UTC day.`
    );
  }

  const monthTotal = month.totalUsd + accumulator.totalUsd;
  if (monthTotal >= config.monthlyCeilingUsd) {
    throw new BudgetExceededError(
      `Monthly budget reached${who}: $${monthTotal.toFixed(4)} spent this month (UTC) against a $${config.monthlyCeilingUsd.toFixed(2)} ceiling. ` +
        `Raise budget.monthly_ceiling_usd in brain/org-config.json if this is intended.`
    );
  }
}
