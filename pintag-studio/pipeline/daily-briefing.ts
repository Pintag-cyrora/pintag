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

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { loadAllKnowledgeEntries } from './lib/knowledge.js';
import { listPendingSuggestions, loadAllSuggestions } from './lib/suggestions.js';
import { gatherAllObservations, formatObservation } from './lib/observations.js';
import { runAgent } from './lib/agent.js';
import { supabase } from './lib/supabase.js';

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Everything gathered below, and the CEO Workspace rendered from it, is a
// SNAPSHOT of current state at generation time — not change-aware. The
// founder's stated long-term direction is for this to eventually surface
// what changed since the last visit (new/completed/newly-blocked/resolved)
// rather than just today's static state. Not built yet — no diffing, no
// "since last visit" tracking, no persisted prior snapshots. Kept in mind
// here: AttentionItem (below) carries a stable title per source item
// specifically so a future diff pass can compare two runs' item lists
// without another data-model change.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Observation Sources (M2.2) — what happened in the real world (TikTok
// today; Facebook/Instagram/etc. later, same interface — see
// pipeline/lib/observations.ts). Each Observation already answers what
// happened / why it matters / evidence, so this just formats and reports
// gaps honestly, the same graceful-degradation discipline as the Supabase
// gatherers below.
// ---------------------------------------------------------------------------
export async function gatherObservations(): Promise<string> {
  const { observations, unavailable } = await gatherAllObservations();

  const parts: string[] = [];
  if (observations.length > 0) {
    parts.push(observations.map(formatObservation).join('\n\n'));
  }
  for (const u of unavailable) {
    parts.push(`### ${u.source}\n${u.source} isn't reporting right now (${u.reason}).`);
  }
  return parts.length > 0 ? parts.join('\n\n') : 'No Observation Sources are connected yet.';
}

interface SupabaseGatherResult {
  available: boolean;
  summary: string;
  /** Structured counts, populated only when available: true — used by renderMorningScreen(), not the LLM prompt. */
  pendingApprovalsCount?: number;
  publishedCount?: number;
  /** Same rows the count above is derived from, kept for real per-item rendering (Needs Your Attention) rather than just a number. */
  pendingApprovals?: Array<{ title: string; contentType: string }>;
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

    return {
      available: true,
      summary: `In flight:\n${inFlightLines}\n\nAwaiting your approval:\n${approvalLines}`,
      pendingApprovalsCount: (pendingApprovals ?? []).length,
      pendingApprovals: (pendingApprovals ?? []).map((r: any) => ({
        title: r.content_items?.title ?? 'Untitled item',
        contentType: r.content_items?.content_type ?? 'content',
      })),
    };
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

    return {
      available: true,
      summary: `Published since yesterday:\n${publishedLines}\n\nDepartment health issues:\n${healthLines}`,
      publishedCount: (published ?? []).length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, summary: `Organizational Memory unavailable — no live Supabase connection (${message}).` };
  }
}

export function buildPrompt(sections: { intelligence: string; suggestions: string; observations: string; operational: SupabaseGatherResult; organizational: SupabaseGatherResult }): string {
  return [
    "Write today's daily briefing for the founder — a short, first-person report in the voice of a trusted junior marketing strategist checking in with their manager. Warm but plain-spoken, confident without overselling, proactive rather than waiting to be asked. This is a message Marketing OS is initiating, not a form being filled out.",
    '',
    "Customers care about business outcomes, not about the machinery that produced them — never mention \"the Intelligence Layer\", \"Observation Sources\", \"TikTok's Display API\", or any other internal system/platform-API name in the prose itself. Translate what was learned (including what happened on TikTok) into what it means for the business: trends, what customers are asking, what content works, what to do about it.",
    '',
    'Structure it as:',
    '1. One-line headline capturing the single most important thing today.',
    '2. What I learned — framed as business implications (trends, what customers ask, what content performs, how recent content actually performed), grounded in the reference material below but never naming it as a system, layer, or platform API.',
    '3. What\'s in flight — if unavailable, say so plainly rather than guessing.',
    '4. What needs your attention (pending approvals + pending knowledge suggestions + any department health issues).',
    '5. A short closing narrative sentence on what to do next.',
    '',
    'Keep it under 200 words. No headers/bullet-heavy dashboard formatting inside the prose — write it as something a person would actually say out loud.',
    '',
    'Then, on its own final line, after the narrative, output exactly one line in this precise form (no other text on that line):',
    'RECOMMENDED ACTION: <a short, imperative, one-click-shaped action>',
    'This is the single most important thing to do today if only one thing gets done — written the way a button label would read, e.g. "Generate Today\'s Educational Post", "Create a Financing FAQ", "Schedule Today\'s Content", "Restore the Supabase Connection". Exactly one action, never zero, never a list.',
    '',
    '## What I learned (Intelligence Layer — newly verified knowledge since yesterday)',
    sections.intelligence,
    '',
    '## Knowledge Suggestions pending review',
    sections.suggestions,
    '',
    '## What happened in the real world (Observation Sources — already analyzed, each already answers what happened / why it matters / evidence; weave the substance into "What I learned" without naming the source platform\'s API)',
    sections.observations,
    '',
    '## Operational Memory (what\'s actively in flight)',
    sections.operational.summary,
    '',
    '## Organizational Memory (what changed, department health)',
    sections.organizational.summary,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CEO Workspace (dashboard/morning.html, M2) — the screen the founder opens
// every morning, answering five questions in order: what happened
// (Executive Briefing), what needs a decision (Needs Your Attention), what's
// the one thing to do (Recommended Action), which business (Active
// Companies), which department (Start My Day). Guiding principle (see
// FOUNDING_PRINCIPLES.md, "CEO Workspace Philosophy"): every section should
// help answer "what should I do next" — nothing here is an analytics widget.
// Built from the exact same data already gathered above for the markdown
// briefing -- zero additional LLM calls. Self-contained static HTML, same
// pattern as dashboard/intelligence.html: no live backend, no Supabase Auth,
// regenerate on demand. Not a dashboard -- a workspace.
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Exported for reuse by pipeline/founder-server.ts (review actions need a reviewedBy name). */
export function readFounderName(): string {
  try {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'brain', 'org-config.json'), 'utf-8'));
    return config.org?.founder ?? 'there';
  } catch {
    return 'there';
  }
}

/**
 * Extracts the CMO's structured "RECOMMENDED ACTION:" line — the product
 * pattern from FOUNDING_PRINCIPLES.md's "Observe -> Think -> Recommend ->
 * Execute": every briefing ends with exactly one clear, imperative,
 * one-click-shaped action. This marker is the primary contract (the prompt
 * explicitly requires it); the older loose "what I recommend" match is kept
 * only as a fallback for briefings generated before this change, since LLM
 * output structure isn't 100% guaranteed run to run.
 *
 * Returns the stripped narrative alongside the action, from whichever
 * pattern actually matched — computing these separately previously let a
 * fallback-matched line stay in the narrative *and* appear in the action
 * card, duplicating it on the page.
 *
 * Exported so pipeline/teach.ts (M2.1) can restate the same recommendation
 * it's asking about, without re-deriving the extraction logic.
 */
export function extractRecommendedAction(briefingText: string): { action: string | undefined; narrativeOnly: string } {
  const strict = briefingText.match(/^RECOMMENDED ACTION:\s*(.+)$/im);
  if (strict) {
    return {
      action: strict[1].trim(),
      narrativeOnly: briefingText.replace(/\n*^RECOMMENDED ACTION:.*$/im, '').trim(),
    };
  }
  const fallback = briefingText.match(/^.*(?:\*\*)?what i recommend(?:\*\*)?:?\s*[^\n]+$/im);
  if (fallback) {
    return {
      action: fallback[0].replace(/^.*(?:\*\*)?what i recommend(?:\*\*)?:?\s*/i, '').trim(),
      narrativeOnly: briefingText.replace(fallback[0], '').replace(/\n{3,}/g, '\n\n').trim(),
    };
  }
  return { action: undefined, narrativeOnly: briefingText.trim() };
}

/**
 * One real, pending item the founder needs to act on. Deliberately generic
 * ("source" is a free string, not a closed union of today's two cases) so
 * approvals, knowledge reviews, blocked work, infra issues, billing, or
 * legal items can all become attention items later without a redesign —
 * see FOUNDING_PRINCIPLES.md's CEO Workspace Philosophy: this section
 * exists to answer "what should I do next," for any source that qualifies.
 */
interface AttentionItem {
  source: string;
  title: string;
  /** Short tag shown next to the title, e.g. a content type or suggestion kind. */
  badge: string;
  detail: string;
  link?: string;
  cliHint?: string;
}

/**
 * Derived, not LLM-synthesized — real rows already gathered, nothing
 * invented. Distinct from the one Recommended Action ("if you only did one
 * thing"): can legitimately be empty on a quiet day, same "don't pad with
 * filler" standard as elsewhere. Today's two real sources: pending content
 * approvals (a real, already-working Approve/Reject click lives at
 * dashboard/index.html) and pending knowledge suggestions (no UI yet, so a
 * CLI hint instead of a link — same honest-not-fake-button discipline used
 * for the Recommended Action card).
 */
function deriveAttentionItems(
  operational: SupabaseGatherResult,
  pendingSuggestions: ReturnType<typeof listPendingSuggestions>
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of operational.pendingApprovals ?? []) {
    items.push({
      source: 'approval',
      title: row.title,
      badge: row.contentType,
      detail: 'Awaiting your approval',
      link: 'index.html',
    });
  }
  for (const s of pendingSuggestions) {
    items.push({
      source: 'knowledge-suggestion',
      title: s.title,
      badge: s.kind,
      detail: `Observed ${s.occurrences.length}x`,
      cliHint: 'npm run knowledge:review',
    });
  }
  return items;
}

/** Reads today's single active company (org.name) from org-config.json. Not a switcher — no second company exists yet (Houluebor/Mamieii/Tien are Phase 5, not started); structured so a second org.name later is a data change, not a redesign. */
function deriveActiveCompany(): string {
  try {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'brain', 'org-config.json'), 'utf-8'));
    return config.org?.name ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

/** Only surfaces a win when a genuine positive signal exists in already-gathered data — never fabricated, omitted entirely on a quiet day. Priority order: human+AI collaboration (approved suggestions) > new intelligence > published content. */
function deriveWin(organizational: SupabaseGatherResult): string | undefined {
  const cutoff = yesterday();

  const recentlyApprovedSuggestions = loadAllSuggestions().filter((s) => s.status === 'approved' && (s.reviewedAt ?? '') >= cutoff);
  if (recentlyApprovedSuggestions.length > 0) {
    return `${recentlyApprovedSuggestions.length} knowledge suggestion${recentlyApprovedSuggestions.length === 1 ? '' : 's'} reviewed and turned into real knowledge since yesterday.`;
  }

  const recentlyVerified = loadAllKnowledgeEntries().filter(
    (e) => (e.status === 'verified' || e.status === 'expert_reviewed') && e.updated >= cutoff
  );
  if (recentlyVerified.length > 0) {
    return `${recentlyVerified.length} new piece${recentlyVerified.length === 1 ? '' : 's'} of intelligence went live since yesterday.`;
  }

  if (organizational.available && (organizational.publishedCount ?? 0) > 0) {
    return `${organizational.publishedCount} piece${organizational.publishedCount === 1 ? '' : 's'} of content published since yesterday.`;
  }

  return undefined;
}

export function renderMorningScreen(input: {
  founderName: string;
  briefingText: string;
  pendingSuggestions: ReturnType<typeof listPendingSuggestions>;
  operational: SupabaseGatherResult;
  organizational: SupabaseGatherResult;
  generatedAt: Date;
}): string {
  // The recommendation line (whichever pattern matched) is a machine-
  // parseable marker, not customer prose — it gets its own prominent card
  // below, so it's stripped from the narrative to avoid showing the same
  // thing twice (once raw, once formatted).
  const { action: recommendedAction, narrativeOnly } = extractRecommendedAction(input.briefingText);
  const attentionItems = deriveAttentionItems(input.operational, input.pendingSuggestions);
  const activeCompany = deriveActiveCompany();
  const win = deriveWin(input.organizational);
  const dateLabel = input.generatedAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Capped, not exhaustive — protects the "under five minutes" goal as
  // pending volume grows; overflow links to the real queue instead.
  const ATTENTION_LIMIT = 5;
  const visibleAttentionItems = attentionItems.slice(0, ATTENTION_LIMIT);
  const overflowCount = attentionItems.length - visibleAttentionItems.length;

  const attentionListItems = attentionItems.length
    ? visibleAttentionItems
        .map((item) => {
          const action = item.link
            ? `<a href="${escapeHtml(item.link)}">Review →</a>`
            : `<span class="cli-hint">${escapeHtml(item.cliHint ?? '')}</span>`;
          return `<li><div class="attn-title">${escapeHtml(item.title)} <span class="tag">${escapeHtml(item.badge)}</span></div><div class="attn-detail">${escapeHtml(item.detail)} ${action}</div></li>`;
        })
        .join('') +
      (overflowCount > 0 ? `<li class="empty"><a href="index.html">+${overflowCount} more — open the queue →</a></li>` : '')
    : '<li class="empty">Nothing needs your attention right now.</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CEO Workspace — Marketing OS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--teal:#2D8C8C;--teal-light:#38A8A8;--teal-dim:rgba(45,140,140,0.08);--teal-border:rgba(45,140,140,0.22);
  --ink:#1A2428;--ink-soft:#3D5058;--ink-muted:#7A9098;--warm:#F7F3EC;--warm-deep:#EDE8E0;--white:#fff;
  --border:rgba(26,36,40,0.1);--gold:#B8860B;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;background:var(--warm);color:var(--ink);line-height:1.65;}
.wrap{max-width:640px;margin:0 auto;padding:48px 20px 80px;}
.workspace-label{font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--teal);margin-bottom:8px;}
.greeting h1{font-size:28px;font-weight:600;margin-bottom:2px;}
.greeting .date{font-size:13px;color:var(--ink-muted);margin-bottom:20px;}
.intro{font-size:16px;color:var(--ink-soft);margin-bottom:28px;}
.win{background:var(--teal-dim);border:1px solid var(--teal-border);border-radius:8px;padding:14px 18px;margin-bottom:28px;font-size:14px;color:var(--ink);}
.win .label{font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--teal);display:block;margin-bottom:4px;}
.section{margin-bottom:8px;}
.divider{border:none;border-top:1px solid var(--border);margin:28px 0;}
.section-title{font-size:13px;font-weight:700;letter-spacing:0.04em;color:var(--ink-muted);text-transform:uppercase;margin-bottom:10px;}
.briefing-text{white-space:pre-wrap;font-size:15px;color:var(--ink-soft);}
ul{list-style:none;}
ul li{padding:10px 0;border-bottom:1px solid var(--border);font-size:15px;}
ul li:last-child{border-bottom:none;}
ul li.empty{color:var(--ink-muted);font-style:italic;}
.attn-title{font-weight:600;}
.attn-detail{font-size:13px;color:var(--ink-muted);margin-top:2px;}
.attn-detail a{margin-left:6px;}
a{color:var(--teal);font-weight:600;text-decoration:none;}
a:hover{color:var(--teal-light);}
.tag{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-muted);background:var(--warm-deep);border-radius:10px;padding:2px 8px;margin-left:8px;}
.cli-hint{font-size:12px;color:var(--ink-muted);font-family:monospace;background:var(--warm-deep);padding:2px 8px;border-radius:4px;display:inline-block;}
.action-card{background:var(--white);border:1.5px solid var(--teal-border);border-radius:8px;padding:18px 20px;}
.action-label{font-size:12px;color:var(--ink-muted);margin-bottom:10px;}
.action-button{display:inline-block;background:var(--teal);color:#fff;font-size:15px;font-weight:600;border:none;border-radius:6px;padding:12px 22px;cursor:pointer;font-family:inherit;}
.action-button:hover{background:var(--teal-light);}
.company-chip{display:inline-block;background:var(--teal-dim);border:1px solid var(--teal-border);color:var(--ink);font-size:14px;font-weight:600;padding:8px 16px;border-radius:20px;}
.start{background:var(--ink);border-radius:8px;padding:22px 24px;margin-top:8px;}
.start a{color:#fff;font-size:15px;display:block;padding:6px 0;}
.start a:hover{color:var(--teal-light);}
.footnote{font-size:11px;color:var(--ink-muted);margin-top:40px;}
</style>
</head>
<body>
<div class="wrap">

  <!-- Static snapshot — this greeting reflects when the page was generated (npm run daily-briefing), not the viewer's local time. Regenerate to refresh, same as dashboard/intelligence.html. -->
  <div class="greeting">
    <div class="workspace-label">CEO Workspace</div>
    <h1>☀️ Good Morning, ${escapeHtml(input.founderName)}</h1>
    <div class="date">${escapeHtml(dateLabel)}</div>
  </div>

  <div class="intro">I've already reviewed everything that happened while you were away. Before we begin, here's what I think deserves your attention today.</div>

  ${win ? `<div class="win"><span class="label">Yesterday's Win</span>${escapeHtml(win)}</div>` : ''}

  <div class="section">
    <div class="section-title">🧠 Executive Briefing</div>
    <div class="briefing-text">${escapeHtml(narrativeOnly)}</div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">📋 Needs Your Attention${attentionItems.length ? ` — ${attentionItems.length}` : ''}</div>
    <ul>${attentionListItems}</ul>
  </div>

  <hr class="divider">

  ${recommendedAction ? `
  <div class="section">
    <div class="section-title">🎯 Recommended Action</div>
    <div class="action-card">
      <div class="action-label">If you only do one thing today</div>
      <button class="action-button" onclick="alert('One-click execution isn\\'t built yet — this is the recommended action Marketing OS would run for you.'); return false;">${escapeHtml(recommendedAction)}</button>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">🧑‍🏫 Teach Marketing OS</div>
    <div class="briefing-text">Would you have done something differently today? I'd like to understand how you think, not just whether you agree.</div>
    <div class="cli-hint" style="margin-top:10px;">npm run teach:os</div>
  </div>

  <hr class="divider">` : ''}

  <div class="section">
    <div class="section-title">🏢 Active Companies</div>
    <div class="company-chip">${escapeHtml(activeCompany)}</div>
  </div>

  <hr class="divider">

  <div class="start">
    <div class="section-title" style="color:rgba(255,255,255,0.5);">🚀 Start My Day</div>
    <a href="index.html">Open the approval queue →</a>
    <a href="#" onclick="alert('Run: npm run knowledge:review'); return false;">Review knowledge suggestions →</a>
    <a href="intelligence.html">Explore the Knowledge Layer →</a>
  </div>

  <div class="footnote">Generated ${input.generatedAt.toLocaleString()} — regenerate any time with <code>npm run daily-briefing</code>.</div>

</div>
</body>
</html>
`;
}

export async function generateDailyBriefing(): Promise<string> {
  const [operational, organizational, observations] = await Promise.all([
    gatherOperationalMemory(),
    gatherOrganizationalMemory(),
    gatherObservations(),
  ]);
  const sections = {
    intelligence: gatherIntelligence(),
    suggestions: gatherSuggestions(),
    observations,
    operational,
    organizational,
  };

  const userPrompt = buildPrompt(sections);
  const briefingText = await runAgent('cmo', { userPrompt, maxBudgetUsd: 0.3 });

  const generatedAt = new Date();
  const today = generatedAt.toISOString().slice(0, 10);
  const dir = join(REPO_ROOT, 'daily-briefing');
  mkdirSync(dir, { recursive: true });
  const datedPath = join(dir, `${today}.md`);
  const latestPath = join(dir, 'latest.md');
  const fileContents = `# Daily Briefing — ${today}\n\n${briefingText}\n`;
  writeFileSync(datedPath, fileContents, 'utf-8');
  writeFileSync(latestPath, fileContents, 'utf-8');
  console.log(`[Daily Briefing] Written to daily-briefing/${today}.md`);

  // Executive Briefing Screen — same generation pass, zero additional LLM calls.
  const morningHtml = renderMorningScreen({
    founderName: readFounderName(),
    briefingText,
    pendingSuggestions: listPendingSuggestions(),
    operational,
    organizational,
    generatedAt,
  });
  const dashboardDir = join(REPO_ROOT, 'dashboard');
  mkdirSync(dashboardDir, { recursive: true });
  writeFileSync(join(dashboardDir, 'morning.html'), morningHtml, 'utf-8');
  console.log('[Daily Briefing] Executive Briefing Screen written to dashboard/morning.html');

  return briefingText;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateDailyBriefing().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
