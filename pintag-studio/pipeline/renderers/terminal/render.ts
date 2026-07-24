// Terminal renderer — display only, zero business logic. Formalizes what
// used to be an inline template literal in daily-briefing.ts's
// generateDailyBriefing(). Writes brief.rawBriefingText verbatim (never a
// reconstruction from narrative), because pipeline/teach.ts's
// readTodaysRecommendation() reads daily-briefing/latest.md looking for
// the literal RECOMMENDED ACTION:/WHY THIS MATTERS: marker lines — that
// on-disk contract must not change.

import type { MorningBrief } from '../../services/morning/types.js';

export function renderMorningTerminal(brief: MorningBrief): string {
  return `# Daily Briefing — ${brief.dateISO}\n\n${brief.rawBriefingText}\n`;
}
