// Daily Briefing — the first proactive daily interaction between the
// founder and Marketing OS. Not a dashboard: a short, first-person
// narrative in the CMO's voice, gathering from everything already built —
// the Intelligence Layer, the Knowledge Suggestion System, and Operational/
// Organizational Memory (Supabase) — and writing it up the way a trusted
// junior strategist would report to their manager.
//
// Run: npm run daily-briefing
// Output: daily-briefing/YYYY-MM-DD.md and daily-briefing/latest.md
//
// Deliberately not wired into dashboard/index.html or a GitHub Actions
// schedule yet — "operate it manually first, then standardize" (see
// DEPARTMENTS.md's Department-Driven Development methodology). This is the
// generator; a review/display surface is a natural, separate next step.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { loadAllKnowledgeEntries } from './lib/knowledge.js';
import { listPendingSuggestions } from './lib/suggestions.js';
import { runAgent } from './lib/agent.js';
import { supabase } from './lib/supabase.js';

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Intelligence Layer — what it learned recently (entries promoted to
// verified/expert_reviewed since yesterday). Fully local, no credentials
// needed — knowledge.ts already merges knowledge/ and brain/lao/.
// ---------------------------------------------------------------------------
export function gatherIntelligence(): string {
  const cutoff = yesterday();
  const recentlyVerified = loadAllKnowledgeEntries().filter(
    (e) => (e.status === 'verified' || e.status === 'expert_reviewed') && e.updated >= cutoff
  );
  const byCategory = new Map<string, number>();
  for (const e of loadAllKnowledgeEntries()) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);

  if (recentlyVerified.length === 0) {
    return 'No knowledge entries were newly verified since yesterday.';
  }
  return recentlyVerified.map((e) => `- ${e.title} (${e.category}, confidence ${e.confidence})`).join('\n');
}

// ---------------------------------------------------------------------------
// Knowledge Suggestion System — the mailbox. What Marketing OS has noticed
// and is waiting on a human decision for. Fully local, no credentials needed.
// ---------------------------------------------------------------------------
export function gatherSuggestions(): string {
  const pending = listPendingSuggestions();
  if (pending.length === 0) return 'No knowledge suggestions are waiting for review.';
  return pending
    .map((s) => `- [${s.kind}] ${s.title} — confidence ${s.confidence}, observed ${s.occurrences.length}x, suggested category: ${s.suggestedCategory}`)
    .join('\n');
}

interface SupabaseGatherResult {
  available: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Operational Memory — what's actively in flight right now: drafts/in-review
// items, pending approvals. Degrades gracefully (not a crash) if Supabase
// isn't reachable, which is the honest condition in some environments —
// a best-effort daily summary should say "I couldn't check" rather than fail
// outright.
// ---------------------------------------------------------------------------
export async function gatherOperationalMemory(): Promise<SupabaseGatherResult> {
  try {
    const { data: inFlight, error: inFlightErr } = await supabase
      .from('content_items')
      .select('title, content_type, status')
      .eq('org_id', 'pintag')
      .in('status', ['draft', 'in_review', 'revising']);
    if (inFlightErr) throw inFlightErr;

    const { data: pendingApprovals, error: approvalsErr } = await supabase
      .from('approvals_queue')
      .select('reason, content_items(title, content_type)')
      .eq('org_id', 'pintag')
      .is('decided_at', null);
    if (approvalsErr) throw approvalsErr;

    const inFlightLines = (inFlight ?? []).length
      ? (inFlight ?? []).map((r: any) => `- ${r.title} (${r.content_type}) — ${r.status}`).join('\n')
      : 'Nothing is currently in draft, in review, or revising.';

    const approvalLines = (pendingApprovals ?? []).length
      ? (pendingApprovals ?? [])
          .map((r: any) => `- ${r.content_items?.title ?? 'Untitled'} — waiting on you (${r.reason})`)
          .join('\n')
      : 'Nothing is waiting on your approval right now.';

    return { available: true, summary: `In flight:\n${inFlightLines}\n\nAwaiting your approval:\n${approvalLines}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, summary: `Operational Memory unavailable — no live Supabase connection (${message}).` };
  }
}

// ---------------------------------------------------------------------------
// Organizational Memory — what changed: recently published content, and
// whether the department itself is healthy. Same graceful degradation.
// ---------------------------------------------------------------------------
export async function gatherOrganizationalMemory(): Promise<SupabaseGatherResult> {
  try {
    const cutoff = yesterday();
    const { data: published, error: publishedErr } = await supabase
      .from('content_items')
      .select('title, content_type, updated_at')
      .eq('org_id', 'pintag')
      .eq('status', 'published')
      .gte('updated_at', cutoff);
    if (publishedErr) throw publishedErr;

    const { data: health, error: healthErr } = await supabase
      .from('agent_health')
      .select('agent_name, status, message')
      .eq('org_id', 'pintag')
      .in('status', ['down', 'degraded']);
    if (healthErr) throw healthErr;

    const publishedLines = (published ?? []).length
      ? (published ?? []).map((r: any) => `- ${r.title} (${r.content_type}) published`).join('\n')
      : 'Nothing published since yesterday.';

    const healthLines = (health ?? []).length
      ? (health ?? []).map((r: any) => `- ${r.agent_name}: ${r.status} — ${r.message ?? 'no message'}`).join('\n')
      : 'Every AI employee is healthy.';

    return { available: true, summary: `Published since yesterday:\n${publishedLines}\n\nDepartment health issues:\n${healthLines}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, summary: `Organizational Memory unavailable — no live Supabase connection (${message}).` };
  }
}

export function buildPrompt(sections: { intelligence: string; suggestions: string; operational: SupabaseGatherResult; organizational: SupabaseGatherResult }): string {
  return [
    "Write today's daily briefing for the founder — a short, first-person report in the voice of a trusted junior marketing strategist checking in with their manager. Warm but plain-spoken, confident without overselling, proactive rather than waiting to be asked. This is a message Marketing OS is initiating, not a form being filled out.",
    '',
    'Structure it as:',
    '1. One-line headline capturing the single most important thing today.',
    '2. What I learned (from the Intelligence Layer).',
    '3. What\'s in flight (from Operational Memory) — if unavailable, say so plainly rather than guessing.',
    '4. What needs your attention (pending approvals + pending knowledge suggestions + any department health issues).',
    '5. What I recommend — one concrete, specific next action, not a generic platitude.',
    '',
    'Keep it under 200 words. No headers/bullet-heavy dashboard formatting inside the prose — write it as something a person would actually say out loud.',
    '',
    '## What I learned (Intelligence Layer — newly verified knowledge since yesterday)',
    sections.intelligence,
    '',
    '## Knowledge Suggestions pending review',
    sections.suggestions,
    '',
    '## Operational Memory (what\'s actively in flight)',
    sections.operational.summary,
    '',
    '## Organizational Memory (what changed, department health)',
    sections.organizational.summary,
  ].join('\n');
}

export async function generateDailyBriefing(): Promise<string> {
  const [operational, organizational] = await Promise.all([gatherOperationalMemory(), gatherOrganizationalMemory()]);
  const sections = {
    intelligence: gatherIntelligence(),
    suggestions: gatherSuggestions(),
    operational,
    organizational,
  };

  const userPrompt = buildPrompt(sections);
  const briefingText = await runAgent('cmo', { userPrompt, maxBudgetUsd: 0.3 });

  const today = new Date().toISOString().slice(0, 10);
  const dir = join(REPO_ROOT, 'daily-briefing');
  mkdirSync(dir, { recursive: true });
  const datedPath = join(dir, `${today}.md`);
  const latestPath = join(dir, 'latest.md');
  const fileContents = `# Daily Briefing — ${today}\n\n${briefingText}\n`;
  writeFileSync(datedPath, fileContents, 'utf-8');
  writeFileSync(latestPath, fileContents, 'utf-8');

  console.log(`[Daily Briefing] Written to daily-briefing/${today}.md`);
  return briefingText;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateDailyBriefing().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
