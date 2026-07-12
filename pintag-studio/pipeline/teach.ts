// Founder Teaching Loop (M2.1) — the founder becomes another trusted source
// of Knowledge Suggestions, using the exact same curated pipeline as every
// other source (Research's knowledgeGaps, wording improvements, etc.):
//
//   Founder -> Knowledge Suggestion -> Review (npm run knowledge:review) -> Intelligence Layer
//
// Nothing here bypasses review, and nothing automatically becomes
// Intelligence. This just gives the founder a way to teach Marketing OS
// judgment, not just facts — starting from today's Recommended Action
// (dashboard/morning.html's "Teach Marketing OS" section points here).
//
// Deliberately a CLI, not a web form: dashboard/morning.html is static
// (no server, no write path) — see the M2.1 plan discussion. This is the
// same trade knowledge-review.ts already made successfully.
//
// Run: npm run teach:os

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { extractRecommendedAction } from './daily-briefing.js';
import { proposeSuggestion } from './lib/suggestions.js';

// Same readline-async-iterator pattern as knowledge-review.ts — plain
// readline/promises' rl.question() drops input under piped stdin when
// called sequentially multiple times; pulling one line at a time from the
// interface's own async iterator serializes correctly either way.
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? '' : value.trim();
}

function readTodaysRecommendation(): { action: string | undefined; date: string } {
  let raw: string;
  try {
    raw = readFileSync(join(REPO_ROOT, 'daily-briefing', 'latest.md'), 'utf-8');
  } catch {
    return { action: undefined, date: '' };
  }
  const dateMatch = raw.match(/^# Daily Briefing — (\d{4}-\d{2}-\d{2})/);
  const briefingText = raw.replace(/^# Daily Briefing.*\n\n/, '');
  const { action } = extractRecommendedAction(briefingText);
  return { action, date: dateMatch ? dateMatch[1] : '' };
}

function slugTitle(text: string): string {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

async function main(): Promise<void> {
  const { action: recommendedAction, date } = readTodaysRecommendation();

  if (!recommendedAction) {
    console.log("I don't have a Recommended Action on record yet — run `npm run daily-briefing` first, then come teach me.");
    rl.close();
    return;
  }

  console.log('Good morning.');
  console.log('');
  console.log(date ? `On ${date}, I recommended:` : "Today's recommendation was:");
  console.log('');
  console.log(`  "${recommendedAction}"`);
  console.log('');
  console.log("I'd like to understand how you think, not just whether you agree.");
  console.log('Would you have done something differently?');
  console.log('');

  const insteadAnswer = await ask('What would you have done instead? (leave blank to skip)\n> ');
  if (!insteadAnswer) {
    console.log('');
    console.log('No worries — nothing saved. I\'ll ask again next time.');
    rl.close();
    return;
  }

  const whyAnswer = await ask('\nWhy?\n> ');

  const save = (await ask('\nSave this as a Knowledge Suggestion for review? [Y/n]\n> ')).toLowerCase();
  if (save === 'n' || save === 'no') {
    console.log('');
    console.log("Understood — I'll keep listening, but I won't save this one.");
    rl.close();
    return;
  }

  const suggestion = proposeSuggestion({
    kind: 'founder-teaching',
    sourceAgent: 'founder',
    title: slugTitle(insteadAnswer),
    body: whyAnswer || '(no reason given)',
    diff: { current: recommendedAction, suggested: insteadAnswer },
    suggestedCategory: 'business/founder-judgment',
    suggestedTags: ['founder-teaching'],
    // Founder-sourced, not agent-inferred — a higher starting point than the
    // 0.5 default, but still just a draft pending the same review as
    // everything else (see reviewKnowledgeEntry() — no automatic promotion).
    confidence: 0.7,
    context: date ? `CEO Workspace Recommended Action, ${date}` : 'CEO Workspace Recommended Action',
  });

  console.log('');
  console.log(`Got it — thank you for teaching me. Saved as a Knowledge Suggestion (knowledge-suggestions/${suggestion.id}.md).`);
  console.log('It\'ll go through the same review as everything else — run `npm run knowledge:review` when you\'re ready.');
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
