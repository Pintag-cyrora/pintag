// Learning Layer — CLI view (M4). Prints everything Marketing OS currently
// believes about the founder, with the evidence behind each line, and
// refreshes learning/founder-preferences.json.
//
// Read-only over the campaigns (content-vault/campaigns/*/campaign.json),
// which are the source of truth. Reviews and edits themselves happen on the
// Founder Workspace (npm run founder-ui → a completed campaign), because
// they're per-asset judgments with one-click reason chips — a form, not a
// flag.
//
// Run: npm run learning

import { listCampaigns } from './services/campaign/persist.js';
import { deriveFounderLearning, writeLearningSnapshot } from './services/learning/learn.js';

function stars(n: number): string {
  return '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
}

function main() {
  const learning = deriveFounderLearning(listCampaigns());
  writeLearningSnapshot(learning);

  console.log(`\nWhat Marketing OS has learned — from ${learning.reviewedCampaignCount} reviewed campaign(s)\n`);

  if (learning.preferences.length === 0 && learning.avoid.length === 0 && learning.departmentFeedback.length === 0) {
    console.log('  Nothing yet. Review a completed campaign in the Founder Workspace (npm run founder-ui) and this fills in.');
    console.log('  Marketing OS needs at least two consistent observations before treating anything as a preference.\n');
    return;
  }

  if (learning.preferences.length) {
    console.log('Preferences');
    for (const p of learning.preferences) console.log(`  • ${p.statement}\n      ${p.evidence}`);
    console.log('');
  }
  if (learning.avoid.length) {
    console.log('Avoid');
    for (const a of learning.avoid) console.log(`  • ${a.statement}\n      ${a.evidence}`);
    console.log('');
  }
  if (learning.departmentFeedback.length) {
    console.log('Department feedback');
    for (const d of learning.departmentFeedback) console.log(`  ${d.department.padEnd(12)} ${stars(d.averageRating)}  ${d.averageRating}/5 over ${d.ratingCount} review(s)`);
    console.log('');
  }
  if (learning.trackRecordByKind.length) {
    console.log('Approval track record by opportunity kind (feeds scoring at 3+ reviews)');
    for (const t of learning.trackRecordByKind) console.log(`  ${t.kind.padEnd(22)} ${t.approvedCount}/${t.reviewedCount} approved (${Math.round(t.approvalRate * 100)}%)`);
    console.log('');
  }
  if (learning.allLessons.length) {
    console.log(`Recent campaign lessons (${learning.allLessons.length} total)`);
    for (const l of learning.allLessons.slice(0, 15)) console.log(`  • ${l.lesson}`);
    console.log('');
  }

  console.log('No published-campaign performance yet — that arrives once publishing exists and real metrics can be recorded.\n');
}

main();
