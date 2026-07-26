// Daily Briefing — CLI entry point, and the one place generation and
// publication meet (see ARCHITECTURE.md §0). These are deliberately two
// different, separately-named steps, not one:
//
//   GENERATION — generateMorningBrief() — always local, always the Claude
//   Code CLI (pipeline/lib/llm.ts's default provider). This is Core
//   Marketing OS: it needs nothing beyond this machine and never runs
//   anywhere else.
//
//   PUBLICATION — writing the already-generated brief somewhere it can be
//   read. Two independent publication targets, both happening here, every
//   time: local files (writeMorningBrief(), renderMorningTerminal(),
//   renderMorningPage() — the terminal/dev artifacts, always succeed) and
//   Supabase (publishMorningBriefToSupabase() — lets marketing-os.html show
//   the latest brief on a phone, a read-only client, never a second
//   runtime). Publication never generates anything new; it only
//   synchronizes what generation already produced. If the Supabase sync
//   fails (network hiccup, etc.), that's logged and swallowed — it must
//   never take down local generation, which is the part that actually
//   matters day to day.
//
// Run: npm run daily-briefing
// Output: daily-briefing/YYYY-MM-DD.md, daily-briefing/latest.md,
//         daily-briefing/YYYY-MM-DD.json, daily-briefing/latest.json,
//         dashboard/morning.html (legacy static path, still generated),
//         and the morning_briefs Supabase row marketing-os.html reads.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { generateMorningBrief } from './services/morning/generate.js';
import { writeMorningBrief, readLatestMorningBrief } from './services/morning/persist.js';
import { setExecutionTrigger, resetSpendAccounting, currentSpend } from './services/budget/budget.js';
import { startRun, completeRun, failRun } from './services/runs/ledger.js';
import { publishMorningBriefToSupabase } from './services/morning/publish.js';
import { renderMorningTerminal } from './renderers/terminal/render.js';
import { renderMorningPage } from './renderers/web/render.js';

export { readFounderName, readActiveCompanyName } from './lib/config.js';
export { extractRecommendedAction } from './services/morning/recommended-action.js';
export { SUGGESTION_KIND_LABELS } from './services/morning/collect.js';

export async function generateDailyBriefing(): Promise<string> {
  // Generation — local, Claude Code CLI, the only runtime.
  const brief = await generateMorningBrief();

  // Publication (1/2) — local files. Always succeeds; this is the terminal
  // path's own long-standing contract and nothing here should ever
  // jeopardize it.
  writeMorningBrief(brief);

  const dir = join(REPO_ROOT, 'daily-briefing');
  mkdirSync(dir, { recursive: true });
  const markdown = renderMorningTerminal(brief);
  writeFileSync(join(dir, `${brief.dateISO}.md`), markdown, 'utf-8');
  writeFileSync(join(dir, 'latest.md'), markdown, 'utf-8');
  console.log(`[Daily Briefing] Written to daily-briefing/${brief.dateISO}.md`);

  const dashboardDir = join(REPO_ROOT, 'dashboard');
  mkdirSync(dashboardDir, { recursive: true });
  const html = renderMorningPage(brief);
  writeFileSync(join(dashboardDir, 'morning.html'), html, 'utf-8');
  console.log('[Daily Briefing] Executive Briefing Screen written to dashboard/morning.html (legacy path — primary interface is now GET /morning)');

  // Publication (2/2) — Supabase, so marketing-os.html (a private,
  // read-only phone client — not a second Marketing OS runtime) always has
  // the latest brief. Best-effort: a sync failure is logged, never thrown
  // — the founder's local artifacts above already succeeded, and that's
  // the part that must never depend on this optional adapter (§0).
  try {
    await publishMorningBriefToSupabase(brief, html);
    console.log('[Daily Briefing] Synced to Supabase for phone/marketing-os.html reading.');
  } catch (err) {
    console.warn('[Daily Briefing] Could not sync to Supabase (phone reading will show a stale brief until this succeeds):', err instanceof Error ? err.message : err);
  }

  return brief.rawBriefingText;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A terminal run is founder-triggered and spends against the same ceilings
  // as everything else (services/budget/), and it gets its own run record so
  // CLI spend isn't invisible to the daily/monthly budget — which it would be
  // if only the server recorded runs.
  setExecutionTrigger('founder');
  resetSpendAccounting();
  void (async () => {
    const run = await startRun({ department: 'morning-brief', trigger: 'founder' });
    try {
      await generateDailyBriefing();
      const spend = currentSpend();
      await completeRun(run?.id ?? null, {
        output: { generatedAt: readLatestMorningBrief()?.generatedAt },
        costUsd: spend.calls > 0 && !(spend.totalUsd === 0 && spend.unpricedCalls > 0) ? spend.totalUsd : undefined,
      });
      console.log(`[Daily Briefing] Spend: $${spend.totalUsd.toFixed(4)} over ${spend.calls} call(s).`);
    } catch (err) {
      const spend = currentSpend();
      await failRun(run?.id ?? null, err, { costUsd: spend.totalUsd > 0 ? spend.totalUsd : undefined });
      console.error(err);
      process.exit(1);
    }
  })();
}
