// Run history renderer (autonomy roadmap step 1). Pure and
// presentation-only, same contract as the other renderers: every value comes
// straight off RunRecord.
//
// This is the first place the run ledger becomes visible, and it's a preview
// of the Morning Brief's future shape (§7): once departments run unattended,
// "what happened overnight" is exactly this list — which is why the ledger is
// worth building before any scheduling exists.

import { escapeHtml, pageShell } from './shell.js';
import type { RunRecord, RunStatus, RunDepartment } from '../../services/runs/types.js';
import type { BudgetStatus } from '../../services/budget/budget.js';

const STATUS_ICON: Record<RunStatus, string> = { running: '◌', complete: '✓', failed: '✕', interrupted: '⚠' };

const DEPARTMENT_LABEL: Record<RunDepartment, string> = {
  'morning-brief': 'Morning Brief',
  campaign: 'Campaign',
  research: 'Researcher',
  strategy: 'Content Strategist',
  writing: 'Writer',
  design: 'Graphic Designer',
  video: 'Video Producer',
  qa: 'Brand Guardian',
  analytics: 'Marketing Analyst',
  publisher: 'Publisher',
  'trend-hunter': 'Trend Hunter',
  'competitor-watch': 'Competitor Watch',
};

const TRIGGER_LABEL: Record<RunRecord['trigger'], string> = {
  founder: 'you asked',
  schedule: 'scheduled',
  department: 'another department asked',
};

const RUNS_STYLE = `<style>
.run-row{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);align-items:flex-start;}
.run-row:last-child{border-bottom:none;}
.run-icon{font-size:17px;width:22px;flex-shrink:0;text-align:center;line-height:1.4;}
.run-complete .run-icon{color:var(--green);}
.run-failed .run-icon{color:var(--red);}
.run-interrupted .run-icon{color:var(--gold);}
.run-running .run-icon{color:var(--teal);animation:pulse 1.2s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.35;}}
.run-body{flex:1;min-width:0;}
.run-title{font-weight:600;font-size:15px;}
.run-meta{font-size:13px;color:var(--ink-muted);margin-top:2px;}
.run-error{font-size:13px;color:var(--red);margin-top:4px;word-break:break-word;}
.run-output{font-size:13px;color:var(--ink-soft);margin-top:3px;}
.run-cost{font-size:12px;color:var(--ink-muted);}
.runs-summary{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;}
.runs-stat{flex:1 1 90px;background:var(--warm-deep);border-radius:10px;padding:12px 14px;text-align:center;}
.runs-stat-value{font-size:20px;font-weight:700;}
.runs-stat-label{font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);margin-top:2px;}
.ledger-warning{background:rgba(184,134,11,0.1);border:1px solid rgba(184,134,11,0.3);color:var(--gold);border-radius:10px;padding:12px 16px;font-size:14px;margin-bottom:16px;}
.budget-row{margin-bottom:14px;}
.budget-label{font-size:14px;font-weight:600;display:flex;justify-content:space-between;gap:12px;margin-bottom:5px;}
.budget-figures{font-weight:400;color:var(--ink-muted);font-variant-numeric:tabular-nums;}
.budget-track{height:8px;background:var(--warm-deep);border-radius:5px;overflow:hidden;}
.budget-fill{height:100%;border-radius:5px;}
.budget-note{font-size:12px;color:var(--ink-muted);margin-top:8px;line-height:1.5;}
.budget-warn{color:var(--gold);}
</style>`;

/** "3m 12s", or "running for 40s" when unfinished. Computed here because it's pure presentation over two timestamps the record already carries. */
function duration(run: RunRecord, now: number): string {
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return run.finishedAt ? text : `running for ${text}`;
}

/** Renders the output jsonb as one readable line. Shows what a run produced without needing per-department renderers. */
function outputLine(run: RunRecord): string {
  const entries = Object.entries(run.output).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
}

/**
 * Spend against the enforced ceilings (step 2). Shown here rather than on a
 * separate page because spend and runs are the same story: this is where the
 * founder finds out what last night cost, which the roadmap calls for from day
 * one (§11). Bars fill toward the configured limits so approaching one is
 * visible before a run gets refused.
 */
function budgetCard(budget: BudgetStatus): string {
  const bar = (label: string, spent: number, ceiling: number) => {
    const pct = ceiling > 0 ? Math.min(100, (spent / ceiling) * 100) : 0;
    // Colour tracks proximity to refusal, not an arbitrary scale: at 100% the
    // next call is rejected, so 90%+ genuinely warrants red.
    const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--gold)' : 'var(--teal)';
    return `<div class="budget-row">
      <div class="budget-label">${escapeHtml(label)}<span class="budget-figures">$${spent.toFixed(2)} / $${ceiling.toFixed(2)}</span></div>
      <div class="budget-track"><div class="budget-fill" style="width:${pct.toFixed(1)}%;background:${color};"></div></div>
    </div>`;
  };

  const unknownWarning = budget.known
    ? ''
    : `<p class="budget-note budget-warn">Spend history couldn't be read, so these totals cover only this session. A founder-triggered run is still allowed in this state (you're watching it); an unattended run would be refused.</p>`;
  const unpricedWarning =
    budget.unpricedCalls > 0
      ? `<p class="budget-note budget-warn">${budget.unpricedCalls} call(s) this session had no configured price, so their real cost isn't counted against any ceiling. Add the model to <code>budget.model_prices_usd_per_mtok</code>.</p>`
      : '';

  return `<div class="card"><div class="card-title">💵 Budget</div>
    ${bar('Today', budget.todayUsd, budget.dailyCeilingUsd)}
    ${bar('This month', budget.monthUsd, budget.monthlyCeilingUsd)}
    ${budget.perRunUsd > 0 ? bar('Current run', budget.perRunUsd, budget.perRunCeilingUsd) : ''}
    ${unknownWarning}
    ${unpricedWarning}
    <p class="budget-note">Ceilings are enforced before every LLM call — reaching one stops work rather than truncating it. Change them in <code>brain/org-config.json</code>.</p>
  </div>`;
}

export function renderRunsPage(runs: RunRecord[], opts: { ledgerAvailable: boolean; budget?: BudgetStatus } = { ledgerAvailable: true }): string {
  const now = Date.now();
  const completed = runs.filter((r) => r.status === 'complete').length;
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'interrupted').length;
  // Only sums real recorded costs. A run whose provider didn't report cost
  // contributes nothing rather than a guess — so this is a floor, and it says so.
  const knownCosts = runs.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
  const totalCost = knownCosts.reduce((sum, c) => sum + c, 0);

  const rows = runs
    .map((run) => {
      const link = typeof run.output.campaignId === 'string' ? `<div class="run-output"><a href="/campaign/${encodeURIComponent(run.output.campaignId)}">Open campaign →</a></div>` : '';
      const output = outputLine(run);
      return `
  <div class="run-row run-${run.status}">
    <div class="run-icon">${STATUS_ICON[run.status]}</div>
    <div class="run-body">
      <div class="run-title">${escapeHtml(DEPARTMENT_LABEL[run.department] ?? run.department)}</div>
      <div class="run-meta">${escapeHtml(new Date(run.startedAt).toLocaleString())} · ${escapeHtml(duration(run, now))} · ${escapeHtml(TRIGGER_LABEL[run.trigger] ?? run.trigger)}${
        typeof run.costUsd === 'number' ? ` · <span class="run-cost">$${run.costUsd.toFixed(4)}</span>` : ''
      }</div>
      ${output ? `<div class="run-output">${escapeHtml(output)}</div>` : ''}
      ${run.error ? `<div class="run-error">${escapeHtml(run.error)}</div>` : ''}
      ${link}
    </div>
  </div>`;
    })
    .join('');

  const warning = opts.ledgerAvailable
    ? ''
    : `<div class="ledger-warning">The run ledger isn't reachable right now, so this history may be incomplete. Runs still execute normally — only their record is affected. If migration <code>0006_pipeline_runs.sql</code> hasn't been applied yet, that's the likely cause.</div>`;

  const bodyHtml = `
  <h1 style="font-size:22px;font-weight:600;margin-bottom:4px;">🗂 Run History</h1>
  <div class="run-meta" style="margin-bottom:20px;">Every department execution, newest first — whether you asked for it or it ran on its own.</div>
  ${warning}
  ${opts.budget ? budgetCard(opts.budget) : ''}
  ${
    runs.length
      ? `<div class="runs-summary">
      <div class="runs-stat"><div class="runs-stat-value">${runs.length}</div><div class="runs-stat-label">Runs</div></div>
      <div class="runs-stat"><div class="runs-stat-value">${completed}</div><div class="runs-stat-label">Completed</div></div>
      <div class="runs-stat"><div class="runs-stat-value">${failed}</div><div class="runs-stat-label">Failed</div></div>
      ${knownCosts.length ? `<div class="runs-stat"><div class="runs-stat-value">$${totalCost.toFixed(2)}</div><div class="runs-stat-label">Recorded cost</div></div>` : ''}
    </div>
    ${knownCosts.length && knownCosts.length < runs.length ? `<p class="run-meta" style="margin:-8px 0 16px;">Cost shown covers the ${knownCosts.length} of ${runs.length} run(s) whose spend was actually reported — treat it as a floor, not a total.</p>` : ''}
    <div class="card">${rows}</div>`
      : `<p class="empty">No runs recorded yet. Generate a Morning Brief or execute a campaign and it will appear here.</p>`
  }
  `;

  return pageShell({ title: 'Run History', bodyHtml, activeHref: '/runs', extraHeadHtml: RUNS_STYLE });
}
