// The Knowledge Review Queue — the Intelligence Department's Level 3
// software (see departments/intelligence/PLAYBOOK.md §16, §17). This is
// the workflow where draft knowledge becomes verified knowledge. No
// automatic promotion happens anywhere in this codebase — every status
// change beyond 'draft' goes through reviewKnowledgeEntry() here, which
// requires a reviewer name and records it on the entry.
//
// Run: npm run knowledge:review
// Works non-interactively too (piped stdin) — see the "usage" note this
// script prints on --help, and departments/intelligence/PLAYBOOK.md §17
// for the daily SOP this implements.

import { createInterface } from 'node:readline';
import {
  loadAllKnowledgeEntries,
  reviewKnowledgeEntry,
  isWritableEntry,
  relativeKnowledgePath,
  type KnowledgeEntry,
} from './lib/knowledge.js';

// Deliberately not readline/promises' rl.question() — with piped (non-TTY)
// stdin, multiple sequential question() calls race against how fast the
// stream emits 'line' events and can silently drop input. Pulling one line
// at a time from the interface's own async iterator serializes correctly
// under both interactive and piped/scripted use.
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? '' : value.trim();
}

function printEntry(entry: KnowledgeEntry, index: number, total: number): void {
  console.log('');
  console.log(`─── Draft ${index + 1} of ${total} ───────────────────────────────`);
  console.log(`  id:         ${entry.id}`);
  console.log(`  title:      ${entry.title}`);
  console.log(`  category:   ${entry.category}`);
  console.log(`  tags:       ${entry.tags.join(', ') || '(none)'}`);
  console.log(`  source:     ${entry.source.type} — ${entry.source.reference}`);
  console.log(`  confidence: ${entry.confidence}`);
  console.log(`  contributedBy: ${entry.contributedBy}`);
  console.log(`  created:    ${entry.created}`);
  console.log(`  path:       ${relativeKnowledgePath(entry)}`);
  console.log('');
  console.log(entry.body.length > 500 ? entry.body.slice(0, 500) + '…' : entry.body);
  console.log('');
}

async function reviewOne(entry: KnowledgeEntry, reviewer: string): Promise<'approved' | 'rejected' | 'merged' | 'skipped' | 'quit'> {
  const action = (
    await ask('  [a]pprove  [r]eject  [m]erge (duplicate)  [e]dit (print path, skip for now)  [s]kip  [q]uit\n  > ')
  ).toLowerCase();

  if (action === 'a') {
    reviewKnowledgeEntry({ id: entry.id, toStatus: 'verified', reviewedBy: reviewer });
    console.log(`  ✅ Approved → verified.`);
    return 'approved';
  }
  if (action === 'r') {
    const reason = await ask('  Reason for rejection (required): ');
    if (!reason) {
      console.log('  No reason given — skipping instead of rejecting without one.');
      return 'skipped';
    }
    reviewKnowledgeEntry({ id: entry.id, toStatus: 'deprecated', reviewedBy: reviewer, reviewNotes: reason });
    console.log(`  ❌ Rejected → deprecated (never deleted — see git history).`);
    return 'rejected';
  }
  if (action === 'm') {
    const canonicalId = await ask('  Canonical entry id this duplicates: ');
    if (!canonicalId) {
      console.log('  No canonical id given — skipping instead of merging without one.');
      return 'skipped';
    }
    reviewKnowledgeEntry({
      id: entry.id,
      toStatus: 'deprecated',
      reviewedBy: reviewer,
      reviewNotes: `Merged — duplicate of ${canonicalId}`,
      supersededBy: canonicalId,
    });
    console.log(`  🔀 Merged → deprecated, supersededBy ${canonicalId}.`);
    return 'merged';
  }
  if (action === 'e') {
    console.log(`  Edit this file directly, then re-run knowledge:review to pick up your changes: ${relativeKnowledgePath(entry)}`);
    return 'skipped';
  }
  if (action === 'q') return 'quit';
  return 'skipped';
}

async function main(): Promise<void> {
  const all = loadAllKnowledgeEntries();
  const drafts = all.filter((e) => e.status === 'draft').sort((a, b) => a.created.localeCompare(b.created));
  const writableDrafts = drafts.filter(isWritableEntry);
  const readOnlyDrafts = drafts.filter((e) => !isWritableEntry(e));

  console.log(`Knowledge Review Queue`);
  console.log(`${writableDrafts.length} draft entr${writableDrafts.length === 1 ? 'y' : 'ies'} awaiting review.`);
  if (readOnlyDrafts.length > 0) {
    console.log(
      `${readOnlyDrafts.length} additional draft entr${readOnlyDrafts.length === 1 ? 'y' : 'ies'} from brain/lao/ ` +
        `shown for reference only — this queue can't change their status (see knowledge/README.md). Edit brain/lao/dictionary.md directly if needed.`
    );
  }

  if (writableDrafts.length === 0) {
    console.log('Nothing to review right now.');
    rl.close();
    return;
  }

  const reviewer = await ask('\nReviewer name: ');
  if (!reviewer) {
    console.log('A reviewer name is required — every status change must have one on record. Exiting.');
    rl.close();
    return;
  }

  const counts = { approved: 0, rejected: 0, merged: 0, skipped: 0 };
  for (let i = 0; i < writableDrafts.length; i++) {
    printEntry(writableDrafts[i], i, writableDrafts.length);
    const result = await reviewOne(writableDrafts[i], reviewer);
    if (result === 'quit') break;
    counts[result]++;
  }

  console.log('');
  console.log('─── Summary ───────────────────────────────────────────');
  console.log(`  Approved: ${counts.approved}   Rejected: ${counts.rejected}   Merged: ${counts.merged}   Skipped: ${counts.skipped}`);
  if (counts.approved + counts.rejected + counts.merged > 0) {
    console.log('');
    console.log('  Changes were written to knowledge/*.md — nothing was committed automatically.');
    console.log('  Review with `git diff pintag-studio/knowledge` and commit when ready.');
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
