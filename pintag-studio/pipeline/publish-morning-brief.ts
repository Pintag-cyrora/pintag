// Morning Brief production publish — CLI entry point (M2.10). Distinct
// from daily-briefing.ts (which stays local-file-only, for the founder's
// own machine/dev use): this generates the same MorningBrief, renders it
// with the same renderer, and pushes the result to Supabase so
// marketing-os.html (the main pintag.io site) has something to display.
// Meant to be run from .github/workflows/marketing-os-morning-brief.yml,
// not interactively — see that file and SETUP.md for the secrets it needs.
//
// Run: npm run morning:publish

import { generateMorningBrief } from './services/morning/generate.js';
import { publishMorningBriefToSupabase } from './services/morning/publish.js';
import { renderMorningPage } from './renderers/web/render.js';

async function publishMorningBrief(): Promise<void> {
  const brief = await generateMorningBrief();
  const html = renderMorningPage(brief);
  await publishMorningBriefToSupabase(brief, html);
  console.log(`[Morning Brief] Published to Supabase (generated ${brief.generatedAt}).`);
}

publishMorningBrief().catch((err) => {
  console.error(err);
  process.exit(1);
});
