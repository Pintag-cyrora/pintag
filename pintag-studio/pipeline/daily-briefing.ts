// Daily Briefing — CLI entry point (M2.9: the founder-facing surface moved
// to the web at GET /morning; this remains a thin wrapper around the same
// shared service for terminal/development use — see
// pipeline/services/morning/ and pipeline/renderers/.
//
// Run: npm run daily-briefing
// Output: daily-briefing/YYYY-MM-DD.md, daily-briefing/latest.md,
//         daily-briefing/YYYY-MM-DD.json, daily-briefing/latest.json,
//         dashboard/morning.html (legacy static path, still generated)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { generateMorningBrief } from './services/morning/generate.js';
import { writeMorningBrief } from './services/morning/persist.js';
import { renderMorningTerminal } from './renderers/terminal/render.js';
import { renderMorningPage } from './renderers/web/render.js';

export { readFounderName, readActiveCompanyName } from './lib/config.js';
export { extractRecommendedAction } from './services/morning/recommended-action.js';
export { SUGGESTION_KIND_LABELS } from './services/morning/collect.js';

export async function generateDailyBriefing(): Promise<string> {
  const brief = await generateMorningBrief();
  writeMorningBrief(brief);

  const dir = join(REPO_ROOT, 'daily-briefing');
  mkdirSync(dir, { recursive: true });
  const markdown = renderMorningTerminal(brief);
  writeFileSync(join(dir, `${brief.dateISO}.md`), markdown, 'utf-8');
  writeFileSync(join(dir, 'latest.md'), markdown, 'utf-8');
  console.log(`[Daily Briefing] Written to daily-briefing/${brief.dateISO}.md`);

  const dashboardDir = join(REPO_ROOT, 'dashboard');
  mkdirSync(dashboardDir, { recursive: true });
  writeFileSync(join(dashboardDir, 'morning.html'), renderMorningPage(brief), 'utf-8');
  console.log('[Daily Briefing] Executive Briefing Screen written to dashboard/morning.html (legacy path — primary interface is now GET /morning)');

  return brief.rawBriefingText;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateDailyBriefing().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
