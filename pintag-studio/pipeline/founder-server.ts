// Founder Test Interface (M2.3) — lets the founder use everything already
// built (Daily Briefing, CEO Workspace, Founder Teaching Loop, Knowledge
// Review, Observation Sources) from a browser instead of a terminal.
//
// This is explicitly NOT a redesign or a production UI: no framework, no
// build step, no new dependencies (Node's built-in http module only) —
// every route is a thin wrapper calling the exact same functions the
// existing CLIs already call (generateDailyBriefing(), proposeSuggestion(),
// approveSuggestion()/rejectSuggestion(), reviewKnowledgeEntry(),
// gatherAllObservations()). The backend is unchanged; this is a second,
// browser-shaped front end for it, the same relationship dashboard/index.html
// already has to the Supabase-backed approvals queue.
//
// TWO DEPLOYMENT MODES (M2.11). This started as a local-only tool and that
// is still the default; it can now also run as a deployed, authenticated
// instance so the founder can trigger pipelines from their phone.
//
//   LOCAL (default): binds 127.0.0.1, no auth. The founder's own machine is
//   the same trust boundary as running a CLI command there. `npm run
//   founder-ui` behaves exactly as it always has.
//
//   DEPLOYED: HOST=0.0.0.0 plus MARKETING_OS_REQUIRE_AUTH=true, and EVERY
//   request must carry the founder's Supabase access token (lib/auth.ts).
//   assertSafeExposure() below refuses to start if a non-loopback address is
//   requested without auth configured — because most routes here MUTATE
//   state (approving knowledge suggestions and playbooks, saving campaign
//   reviews, regenerating departments, spending LLM budget), so an
//   unauthenticated public bind would be a serious hole, not a minor one.
//
// Plain HTML forms + redirects, no client-side JavaScript — except
// GET /morning's staleness poll (renderers/web/render.ts), the campaign
// progress poll (renderers/web/campaign.ts), and the JSON API below that
// marketing-os.html calls from the phone. Every other route stays JS-free.
//
// Run locally: npm run founder-ui  (defaults to http://127.0.0.1:4321; set
// PORT to change it, e.g. PORT=3000 npm run founder-ui)
// Run deployed: see SETUP.md §10 and the Dockerfile at the repo root.

// FIRST import, deliberately: this module refuses to start the process if
// HOST would expose the server without auth configured. ES modules evaluate
// imports before any code below, and lib/supabase.ts throws at import time
// when its credentials are missing — so the safety check has to be an import
// side effect to be guaranteed to run first. See lib/exposure-guard.ts.
import { assertSafeExposure, isLoopback, SERVER_HOST } from './lib/exposure-guard.js';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readMorningBriefConfig, readCampaignConfig, readConfiguredLanguages } from './lib/config.js';
import { generateDailyBriefing, SUGGESTION_KIND_LABELS } from './daily-briefing.js';
import { getFounderSession, authRequired, UnauthorizedError } from './lib/auth.js';
import { readTodaysRecommendation, buildFounderTeachingSuggestionInput } from './teach.js';
import { listPendingSuggestions, approveSuggestion, rejectSuggestion, proposeSuggestion, type KnowledgeSuggestion } from './lib/suggestions.js';
import { loadAllKnowledgeEntries, reviewKnowledgeEntry, isWritableEntry, type KnowledgeEntry } from './lib/knowledge.js';
import { gatherAllObservations } from './lib/observations.js';
import { classifyObservation, computeConfidence, type RoutingOutcome } from './lib/observation-intelligence.js';
import { listCandidatePatterns, approvePattern, ignorePattern, keepObservingPattern, type CandidatePattern } from './lib/patterns.js';
import { generateMorningBrief } from './services/morning/generate.js';
import { readLatestMorningBrief, writeMorningBrief, isMorningBriefStale } from './services/morning/persist.js';
import { renderMorningPage } from './renderers/web/render.js';
import { createCachedPage } from './lib/cached-page.js';
import type { MorningBrief } from './services/morning/types.js';
import { createCampaign, executeCampaign, regenerateCampaignStep, REGENERABLE_STEPS } from './services/campaign/generate.js';
import { readCampaign, readLatestCampaign, listCampaigns, writeCampaign } from './services/campaign/persist.js';
import { scoreOpportunity, scoreOpportunities, selectTopOpportunities } from './services/campaign/score.js';
import { renderCampaignPage, renderCampaignsPage, renderCampaignEditPage, renderLearningPage, renderResearchPage, renderContentPage, renderVideoPage, renderPublishPage } from './renderers/web/campaign.js';
import { deriveFounderLearning, generateLessons, writeLearningSnapshot } from './services/learning/learn.js';
import { startRun, completeRun, failRun, findRunningRun, findLatestRun, listRecentRuns, reconcileOrphanedRuns, isLedgerAvailable } from './services/runs/ledger.js';
import { renderRunsPage } from './renderers/web/runs.js';
import {
  FEEDBACK_REASONS,
  RATEABLE_DEPARTMENTS,
  WRITTEN_ASSET_FIELDS,
  type Campaign,
  type CampaignStepId,
  type ScorableOpportunity,
  type CampaignOutcome,
  type CampaignReview,
  type FeedbackReason,
  type Rating,
  type RateableDepartment,
  type Language,
  type WrittenAssets,
} from './services/campaign/types.js';

const PORT = Number(process.env.PORT ?? 4321);
const HOST = SERVER_HOST;

/**
 * Origins allowed to call the JSON API from a browser. The deployed page
 * lives on a different origin (pintag.io) than this server, so CORS is
 * required — but as an explicit allowlist, never `*`: a wildcard plus
 * Authorization headers would let any site the founder visits drive their
 * Marketing OS. Comma-separated, e.g.
 * MARKETING_OS_ALLOWED_ORIGINS=https://pintag.io,https://www.pintag.io
 */
function allowedOrigins(): string[] {
  return (process.env.MARKETING_OS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Echoes the request's origin only when it's on the allowlist. Returns false when the origin is present but not allowed, so the caller can reject preflights outright. */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin / non-browser caller
  if (!allowedOrigins().includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

// GET /morning's hybrid cache — fast reads from daily-briefing/latest.json,
// background regeneration when stale. See lib/cached-page.ts; this is the
// reusable primitive future pages (/research, /content, ...) should wire
// through the same way rather than re-deriving staleness/in-flight logic.
const morningCache = createCachedPage<MorningBrief>({
  read: readLatestMorningBrief,
  write: writeMorningBrief,
  generate: generateMorningBrief,
  isStale: (brief) => isMorningBriefStale(brief, readMorningBriefConfig().stalenessThresholdMinutes),
});

// ---------------------------------------------------------------------------
// Shared page shell — same color tokens as dashboard/morning.html /
// dashboard/intelligence.html, so this reads as the same product family
// rather than a bolted-on admin tool. No CSS framework.
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function pageShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Marketing OS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--teal:#2D8C8C;--teal-light:#38A8A8;--teal-dim:rgba(45,140,140,0.08);--teal-border:rgba(45,140,140,0.22);
  --ink:#1A2428;--ink-soft:#3D5058;--ink-muted:#7A9098;--warm:#F7F3EC;--warm-deep:#EDE8E0;--white:#fff;
  --border:rgba(26,36,40,0.1);--gold:#B8860B;--red:#C0392B;--green:#1E6B45;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;background:var(--warm);color:var(--ink);line-height:1.6;}
.wrap{max-width:680px;margin:0 auto;padding:40px 20px 80px;}
h1{font-size:24px;font-weight:600;margin-bottom:4px;}
.subtitle{font-size:13px;color:var(--ink-muted);margin-bottom:28px;}
.back{display:inline-block;font-size:13px;color:var(--teal);text-decoration:none;font-weight:600;margin-bottom:20px;}
.card{background:var(--white);border:1px solid var(--border);border-radius:8px;padding:20px 22px;margin-bottom:16px;}
.card h2{font-size:16px;font-weight:600;margin-bottom:6px;}
.card p{font-size:14px;color:var(--ink-soft);margin-bottom:14px;}
.nav-link{display:block;text-decoration:none;color:inherit;}
.nav-link:hover .card{border-color:var(--teal-border);}
.badge{display:inline-block;font-size:11px;font-weight:700;background:var(--teal-dim);color:var(--teal);border-radius:10px;padding:2px 9px;margin-left:8px;}
.btn{display:inline-block;background:var(--teal);color:#fff;font-size:14px;font-weight:600;border:none;border-radius:6px;padding:10px 18px;cursor:pointer;font-family:inherit;text-decoration:none;}
.btn:hover{background:var(--teal-light);}
.btn-reject{background:var(--white);color:var(--red);border:1.5px solid var(--red);}
.btn-reject:hover{background:rgba(192,57,43,0.06);}
.hint{font-size:12px;color:var(--ink-muted);margin-top:8px;}
.quote{background:var(--teal-dim);border:1px solid var(--teal-border);border-radius:8px;padding:16px 18px;font-size:15px;margin-bottom:20px;}
textarea,input[type=text]{width:100%;font-family:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--warm);color:var(--ink);margin-bottom:12px;}
textarea{min-height:70px;resize:vertical;}
label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin-bottom:4px;}
.banner{background:var(--teal-dim);border:1px solid var(--teal-border);border-radius:8px;padding:12px 16px;font-size:14px;margin-bottom:20px;}
.entry{border-bottom:1px solid var(--border);padding:16px 0;}
.entry:last-child{border-bottom:none;}
.entry-title{font-weight:600;font-size:15px;margin-bottom:4px;}
.entry-meta{font-size:12px;color:var(--ink-muted);margin-bottom:8px;}
.entry-body{font-size:14px;color:var(--ink-soft);white-space:pre-wrap;margin-bottom:10px;}
.diff{font-size:13px;background:var(--warm-deep);border-radius:6px;padding:10px 12px;margin-bottom:10px;}
.diff div{margin-bottom:4px;}
.actions{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;}
.reject-form{display:flex;gap:8px;align-items:center;}
.reject-form input{width:220px;margin-bottom:0;}
.empty{color:var(--ink-muted);font-style:italic;font-size:14px;}
.section-title{font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);margin:28px 0 12px;}
.evidence{font-size:13px;color:var(--ink-muted);}
</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>
`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

function readRequestBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function renderHome(founderName: string): string {
  const pendingSuggestions = listPendingSuggestions().length;
  const pendingDrafts = loadAllKnowledgeEntries().filter((e) => e.status === 'draft' && isWritableEntry(e)).length;
  const pendingPatterns = listCandidatePatterns().length;
  const pendingTotal = pendingSuggestions + pendingDrafts + pendingPatterns;

  return pageShell(
    'Founder Workspace',
    `
    <h1>Good morning, ${escapeHtml(founderName)}</h1>
    <div class="subtitle">Everything Marketing OS can do today, in one place — no terminal needed.</div>

    <form method="POST" action="/api/generate-briefing">
      <div class="card">
        <h2>☀️ Generate Morning Briefing</h2>
        <p>Runs today's Daily Briefing and regenerates the CEO Workspace. Uses a small amount of LLM budget (capped at $0.30).</p>
        <button class="btn" type="submit">Generate Today's Briefing</button>
      </div>
    </form>

    <a class="nav-link" href="/morning">
      <div class="card"><h2>🧭 Open the Morning Brief</h2><p>The primary daily screen — Executive Summary, Market Intelligence, Company Health, Recommended Action, and more.</p></div>
    </a>

    <form method="POST" action="/campaign/execute-top">
      <div class="card">
        <h2>🚀 Generate Top Campaigns</h2>
        <p>Scores every opportunity on the latest Morning Brief and generates campaigns for only the top ${readCampaignConfig().topN} — everything else is scored but not executed, keeping spend predictable.</p>
        <button class="btn" type="submit">Score &amp; Generate Top ${readCampaignConfig().topN}</button>
      </div>
    </form>

    <a class="nav-link" href="/campaigns">
      <div class="card"><h2>📦 Campaigns</h2><p>Every generated campaign — status, score, priority, and the full review bundle.</p></div>
    </a>

    <a class="nav-link" href="/runs">
      <div class="card"><h2>🗂 Run History</h2><p>Every department execution and what it produced — the record the Morning Brief will eventually report over.</p></div>
    </a>

    <a class="nav-link" href="/learning">
      <div class="card"><h2>🧠 What Marketing OS Has Learned</h2><p>Everything it believes about your preferences, derived from your own reviews and edits — with the evidence behind each line.</p></div>
    </a>

    <a class="nav-link" href="/teach">
      <div class="card"><h2>🧑‍🏫 Teach Marketing OS</h2><p>Tell it what you'd have done differently and why.</p></div>
    </a>

    <a class="nav-link" href="/review">
      <div class="card"><h2>📚 Review Knowledge${pendingTotal ? `<span class="badge">${pendingTotal} pending</span>` : ''}</h2><p>Approve or reject pending Knowledge Suggestions and draft Knowledge Layer entries.</p></div>
    </a>

    <a class="nav-link" href="/observations">
      <div class="card"><h2>📡 Observation Sources</h2><p>What Marketing OS is (and isn't) able to observe about the real world right now.</p></div>
    </a>
    `
  );
}

// ---------------------------------------------------------------------------
// Teach Marketing OS
// ---------------------------------------------------------------------------

function renderTeach(status?: string, savedId?: string): string {
  const { action: recommendedAction, date } = readTodaysRecommendation();

  let banner = '';
  if (status === 'saved') banner = `<div class="banner">Got it — thank you for teaching me. Saved as a Knowledge Suggestion${savedId ? ` (<code>${escapeHtml(savedId)}</code>)` : ''}. It'll go through the same review as everything else.</div>`;
  if (status === 'skipped') banner = `<div class="banner">No worries — nothing saved. I'll ask again next time.</div>`;

  if (!recommendedAction) {
    return pageShell(
      'Teach Marketing OS',
      `<a class="back" href="/">← Home</a><h1>🧑‍🏫 Teach Marketing OS</h1>${banner}<p class="empty">I don't have a Recommended Action on record yet — generate a briefing first.</p>`
    );
  }

  return pageShell(
    'Teach Marketing OS',
    `
    <a class="back" href="/">← Home</a>
    <h1>🧑‍🏫 Teach Marketing OS</h1>
    <div class="subtitle">I'd like to understand how you think, not just whether you agree.</div>
    ${banner}
    <div class="quote">${date ? `On ${escapeHtml(date)}, I recommended:` : "Today's recommendation was:"}<br><br>"${escapeHtml(recommendedAction)}"</div>
    <form method="POST" action="/teach">
      <label for="instead">What would you have done instead?</label>
      <textarea id="instead" name="instead" placeholder="Leave blank to skip"></textarea>
      <label for="why">Why?</label>
      <textarea id="why" name="why"></textarea>
      <button class="btn" type="submit">Save as Knowledge Suggestion</button>
    </form>
    `
  );
}

// ---------------------------------------------------------------------------
// Review Knowledge (Suggestions + Draft Knowledge Entries)
// ---------------------------------------------------------------------------

function renderSuggestion(s: KnowledgeSuggestion): string {
  const diffHtml = s.diff ? `<div class="diff"><div><strong>Current:</strong> ${escapeHtml(s.diff.current)}</div><div><strong>Suggested:</strong> ${escapeHtml(s.diff.suggested)}</div></div>` : '';
  // Confidence (M2.6) shown for marketing-observation items — same
  // deterministic computeConfidence() the Emerging Playbooks below use, so
  // the two surfaces never disagree about the same occurrences.
  const confidence = s.kind === 'marketing-observation' ? computeConfidence(s.occurrences) : undefined;
  const confidenceHtml = confidence ? `<div class="entry-meta">Confidence: ${escapeHtml(confidence.level)} — ${escapeHtml(confidence.reason)}</div>` : '';
  return `
  <div class="entry">
    <div class="entry-title">${escapeHtml(s.title)} <span class="badge">${escapeHtml(SUGGESTION_KIND_LABELS[s.kind] ?? s.kind)}</span></div>
    <div class="entry-meta">from ${escapeHtml(s.sourceAgent)} · observed ${s.occurrences.length}x · suggested category: ${escapeHtml(s.suggestedCategory)}</div>
    ${confidenceHtml}
    ${diffHtml}
    <div class="entry-body">${escapeHtml(s.body)}</div>
    <div class="actions">
      <form method="POST" action="/review/suggestions/${encodeURIComponent(s.id)}/approve"><button class="btn" type="submit">Approve</button></form>
      <form class="reject-form" method="POST" action="/review/suggestions/${encodeURIComponent(s.id)}/reject">
        <input type="text" name="reason" placeholder="Reason (required)" required>
        <button class="btn btn-reject" type="submit">Reject</button>
      </form>
    </div>
  </div>`;
}

function renderPlaybookCard(p: CandidatePattern): string {
  const bulletsHtml = p.observedPattern.map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  return `
  <div class="entry">
    <div class="entry-title">${escapeHtml(p.name)} <span class="badge">Emerging Playbook</span></div>
    <div class="entry-meta">observed ${p.occurrences.length}x · Confidence: ${escapeHtml(p.confidence.level)} — ${escapeHtml(p.confidence.reason)}</div>
    <div class="section-title" style="margin:10px 0 6px;">Observed pattern</div>
    <ul style="list-style:none;padding:0;margin-bottom:10px;">${bulletsHtml}</ul>
    <div class="actions">
      <form method="POST" action="/review/patterns/${encodeURIComponent(p.id)}/approve"><button class="btn" type="submit">Approve as Playbook</button></form>
      <form method="POST" action="/review/patterns/${encodeURIComponent(p.id)}/keep-observing"><button class="btn" style="background:var(--white);color:var(--ink-soft);border:1.5px solid var(--border);" type="submit">Keep Observing</button></form>
      <form class="reject-form" method="POST" action="/review/patterns/${encodeURIComponent(p.id)}/ignore">
        <input type="text" name="reason" placeholder="Reason (required)" required>
        <button class="btn btn-reject" type="submit">Ignore</button>
      </form>
    </div>
  </div>`;
}

function renderDraftEntry(e: KnowledgeEntry): string {
  const preview = e.body.length > 400 ? `${e.body.slice(0, 400)}…` : e.body;
  return `
  <div class="entry">
    <div class="entry-title">${escapeHtml(e.title)}</div>
    <div class="entry-meta">${escapeHtml(e.category)} · confidence ${e.confidence} · source: ${escapeHtml(e.source.type)} · contributed by ${escapeHtml(e.contributedBy)}</div>
    <div class="entry-body">${escapeHtml(preview)}</div>
    <div class="actions">
      <form method="POST" action="/review/knowledge/${encodeURIComponent(e.id)}/approve"><button class="btn" type="submit">Approve → verified</button></form>
      <form class="reject-form" method="POST" action="/review/knowledge/${encodeURIComponent(e.id)}/reject">
        <input type="text" name="reason" placeholder="Reason (required)" required>
        <button class="btn btn-reject" type="submit">Reject</button>
      </form>
    </div>
  </div>`;
}

function renderReview(): string {
  const suggestions = listPendingSuggestions();
  const allEntries = loadAllKnowledgeEntries();
  const writableDrafts = allEntries.filter((e) => e.status === 'draft' && isWritableEntry(e));
  const readOnlyDraftCount = allEntries.filter((e) => e.status === 'draft' && !isWritableEntry(e)).length;
  const patterns = listCandidatePatterns();

  return pageShell(
    'Review Knowledge',
    `
    <a class="back" href="/">← Home</a>
    <h1>📚 Review Knowledge</h1>
    <div class="subtitle">Nothing becomes Intelligence without a decision here.</div>

    <div class="section-title">Emerging Playbooks (${patterns.length})</div>
    ${patterns.length ? patterns.map(renderPlaybookCard).join('') : '<p class="empty">No repeating pattern has emerged yet.</p>'}

    <div class="section-title">Pending Knowledge Suggestions (${suggestions.length})</div>
    ${suggestions.length ? suggestions.map(renderSuggestion).join('') : '<p class="empty">Nothing waiting for review.</p>'}

    <div class="section-title">Draft Knowledge Entries (${writableDrafts.length})</div>
    ${writableDrafts.length ? writableDrafts.map(renderDraftEntry).join('') : '<p class="empty">Nothing waiting for review.</p>'}
    ${readOnlyDraftCount > 0 ? `<p class="hint">${readOnlyDraftCount} additional draft${readOnlyDraftCount === 1 ? '' : 's'} from brain/lao/ shown for reference only in \`npm run knowledge:review\` — not editable here (see knowledge/README.md).</p>` : ''}
    `
  );
}

// ---------------------------------------------------------------------------
// Observation Sources
// ---------------------------------------------------------------------------

const OUTCOME_LABEL: Record<RoutingOutcome['decision'], string> = {
  executive: '🎯 In today\'s briefing',
  department: '📨 Routed, not shown to you',
  ignore: '— Not meaningful',
};

async function renderObservations(): Promise<string> {
  const asOf = new Date();
  const { observations, unavailable } = await gatherAllObservations();

  // Connection status first and plainly — every registered source gets a
  // clear connected/not-connected line regardless of whether it produced
  // any observations this run. "The goal is confidence, not analytics."
  const configuredSources = new Set(observations.map((o) => o.source));
  const notConfigured = new Set(unavailable.filter((u) => u.reason === 'not configured').map((u) => u.source));
  const allSourceNames = new Set([...configuredSources, ...unavailable.map((u) => u.source)]);
  const statusHtml = [...allSourceNames]
    .map((name) => {
      if (notConfigured.has(name)) {
        return `<div class="entry"><div class="entry-title">${escapeHtml(name)} — <span style="color:var(--red);">Not connected</span></div><div class="entry-meta">Run <code>npm run tiktok:connect</code> in Terminal, once, to connect it.</div></div>`;
      }
      const failure = unavailable.find((u) => u.source === name);
      if (failure) {
        return `<div class="entry"><div class="entry-title">${escapeHtml(name)} — <span style="color:var(--gold);">Connected, but not reporting right now</span></div><div class="entry-meta">${escapeHtml(failure.reason)}</div></div>`;
      }
      return `<div class="entry"><div class="entry-title">${escapeHtml(name)} — <span style="color:var(--green);">Connected</span></div><div class="entry-meta">Reporting as of this page load.</div></div>`;
    })
    .join('');

  // Every observation shown with what it actually became — not just the
  // raw fact, but whether Observation Intelligence sent it to the CEO
  // Workspace, routed it elsewhere, or decided it wasn't meaningful. This
  // is the same classification collectObservations() applies for real; shown
  // here for transparency, not recomputed differently.
  const observationsHtml = observations.length
    ? observations
        .map((o) => {
          const outcome = classifyObservation(o);
          return `
    <div class="entry">
      <div class="entry-title">${escapeHtml(o.source)} <span class="badge">${escapeHtml(o.kind)}</span> <span class="badge">${escapeHtml(OUTCOME_LABEL[outcome.decision])}</span></div>
      <div class="entry-body">${escapeHtml(o.whatHappened)}</div>
      <div class="entry-meta">${escapeHtml(o.whyItMatters)}</div>
      <div class="evidence">${o.evidence.map((e) => escapeHtml(e)).join(' · ')}</div>
    </div>`;
        })
        .join('')
    : '<p class="empty">Nothing observed this run.</p>';

  return pageShell(
    'Observation Sources',
    `
    <a class="back" href="/">← Home</a>
    <h1>📡 Observation Sources</h1>
    <div class="subtitle">What Marketing OS can currently observe about the real world — as of ${escapeHtml(asOf.toLocaleString())}, since this page always checks live.</div>

    <div class="section-title">Connection status</div>
    ${statusHtml || '<p class="empty">No Observation Sources are registered.</p>'}

    <div class="section-title">What was observed this run, and what happened to it</div>
    ${observationsHtml}
    <p class="hint">"Routed, not shown to you" and "Not meaningful" observations are working as intended, not a bug — see <code>departments/intelligence/OBSERVATION_INTELLIGENCE_DESIGN.md</code>.</p>
    `
  );
}

// ---------------------------------------------------------------------------
// Static dashboard/*.html passthrough — /dashboard/<file>.html only, a flat
// filename with no path separators, so this can't escape the dashboard/
// directory. Serves the exact files npm run daily-briefing already writes;
// nothing here regenerates or alters them.
// ---------------------------------------------------------------------------

function serveDashboardFile(res: ServerResponse, filename: string): void {
  if (!/^[a-zA-Z0-9_-]+\.html$/.test(filename)) {
    sendHtml(res, 404, pageShell('Not found', '<p>Not found.</p>'));
    return;
  }
  try {
    const content = readFileSync(join(REPO_ROOT, 'dashboard', filename), 'utf-8');
    sendHtml(res, 200, content);
  } catch {
    sendHtml(res, 404, pageShell('Not found', `<p>dashboard/${escapeHtml(filename)} doesn't exist yet — generate a briefing first, or run its generator.</p><a class="back" href="/">← Home</a>`));
  }
}

// ---------------------------------------------------------------------------
// Morning Brief (M2.9) — the primary founder-facing interface, replacing
// dashboard/morning.html as the default destination. Instant reads from
// the cached MorningBrief (daily-briefing/latest.json), with a background
// regeneration when stale — see morningCache (lib/cached-page.ts) above.
// ---------------------------------------------------------------------------

async function handleMorning(res: ServerResponse): Promise<void> {
  const cached = readLatestMorningBrief();
  if (!cached) {
    // Cold start: nothing generated yet — block once, this request only.
    const brief = await morningCache.ensureFresh();
    sendHtml(res, 200, renderMorningPage(brief, { regenerating: morningCache.status(brief).regenerating, executeEnabled: true }));
    return;
  }
  morningCache.refreshInBackgroundIfStale(cached);
  // Pass `cached` straight through — status() would otherwise re-read
  // daily-briefing/latest.json a second time in this same request purely
  // to report a `regenerating` flag it already has in memory.
  // executeEnabled: this server is the one surface where POST
  // /campaign/execute actually exists — the static copies (dashboard/
  // morning.html, the Supabase-published phone page) stay read-only.
  sendHtml(res, 200, renderMorningPage(cached, { regenerating: morningCache.status(cached).regenerating, executeEnabled: true }));
}

function handleMorningStatus(res: ServerResponse): void {
  sendJson(res, 200, morningCache.status());
}

// ---------------------------------------------------------------------------
// Morning Brief generation as a JSON job (M2.11) — what the phone calls.
//
// Deliberately asynchronous. Generation takes tens of seconds to minutes
// (several LLM calls), which is longer than a mobile browser will reliably
// hold a request open, and the founder may lock their phone mid-run. So the
// POST starts the work and returns immediately; the client polls for state
// and refreshes when it lands. The run itself is NOT tied to the request —
// backgrounding the browser doesn't cancel it.
//
// This calls generateDailyBriefing(), the exact same function `npm run
// daily-briefing` calls — same generation, same local artifacts, same
// Supabase publish. Nothing about the pipeline's behavior changes; this only
// adds a second way to trigger it.
// ---------------------------------------------------------------------------

interface GenerationJob {
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** Populated on failure so the phone can show what actually went wrong instead of a generic error. */
  error?: string;
  /** generatedAt of the brief this run produced — lets the client confirm it's looking at new output. */
  generatedAt?: string;
}

/**
 * In-memory view of the current run. This is now a CACHE over the run ledger
 * (services/runs/, autonomy roadmap step 1), not the source of truth: the
 * durable record lives in Supabase's pipeline_runs and survives this process.
 *
 * Kept because it's the zero-latency answer for the common case (the founder
 * polling the run they just started, in this process), and because the ledger
 * is allowed to be unavailable — see ledger.ts's degradation rule. When both
 * exist the ledger wins; when the ledger is down this still works exactly as
 * it did before.
 */
let morningJob: GenerationJob | null = null;
/** The ledger row for the in-flight run, so completion updates the durable record too. */
let morningRunId: string | null = null;

/**
 * Reads run state, preferring the durable ledger over the in-memory cache.
 * This is what makes "a run started on another device" and "the workspace
 * restarted mid-run" visible to the phone instead of looking like no run
 * ever happened.
 */
async function morningJobPayload(): Promise<GenerationJob & { cachedGeneratedAt: string | null; durable: boolean }> {
  const cachedGeneratedAt = readLatestMorningBrief()?.generatedAt ?? null;

  const ledgerRun = await findLatestRun('morning-brief');
  if (ledgerRun) {
    return {
      // 'interrupted' is reported to the client as a failure with an honest
      // explanation — from the phone's perspective the run is over and did
      // not produce a brief, which is what it needs to act on.
      status: ledgerRun.status === 'complete' ? 'complete' : ledgerRun.status === 'running' ? 'running' : 'failed',
      startedAt: ledgerRun.startedAt,
      finishedAt: ledgerRun.finishedAt,
      error: ledgerRun.error,
      generatedAt: typeof ledgerRun.output.generatedAt === 'string' ? ledgerRun.output.generatedAt : undefined,
      cachedGeneratedAt,
      durable: true,
    };
  }

  return {
    ...(morningJob ?? { status: 'complete' as const, startedAt: '', finishedAt: '' }),
    cachedGeneratedAt,
    durable: false,
  };
}

async function handleMorningGenerate(res: ServerResponse): Promise<void> {
  // Check the ledger too, not just this process — a run started from another
  // device (or before a restart) should not be duplicated.
  const inFlight = morningJob?.status === 'running' || (await findRunningRun('morning-brief')) !== null;
  if (inFlight) {
    // Idempotent: a double-tap joins the run in progress rather than
    // starting a second one and paying twice.
    sendJson(res, 202, await morningJobPayload());
    return;
  }

  const startedAt = new Date().toISOString();
  morningJob = { status: 'running', startedAt };
  // No idempotencyKey: a founder pressing Generate deliberately may want a
  // second brief today. Scheduled runs (step 6) will pass a cycle key.
  const run = await startRun({ department: 'morning-brief', trigger: 'founder' });
  morningRunId = run?.id ?? null;

  sendJson(res, 202, await morningJobPayload());

  void generateDailyBriefing()
    .then(async () => {
      const generatedAt = readLatestMorningBrief()?.generatedAt;
      morningJob = { status: 'complete', startedAt, finishedAt: new Date().toISOString(), generatedAt };
      await completeRun(morningRunId, { output: generatedAt ? { generatedAt } : {} });
      console.log('[founder-server] Morning Brief generation finished (triggered via API).');
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      morningJob = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: message };
      await failRun(morningRunId, err);
      console.error('[founder-server] Morning Brief generation failed (triggered via API):', err);
    })
    .finally(() => {
      morningRunId = null;
    });
}

// ---------------------------------------------------------------------------
// Campaign execution — the real orchestration behind the Execute Campaign
// button (see services/campaign/generate.ts). POST /campaign/execute
// creates the Campaign and kicks the run off in the background (same
// pattern as the morning cache's background regeneration), then redirects
// to the live progress page, which polls /api/campaign/:id/status.
// ---------------------------------------------------------------------------

// Campaigns whose run is alive in THIS process. A campaign found on disk
// as 'running' but absent here was orphaned by a restart — reported (and
// persisted) as 'interrupted' rather than left spinning forever.
const activeCampaigns = new Map<string, Campaign>();

function resolveCampaign(id: string): Campaign | null {
  const live = activeCampaigns.get(id);
  if (live) return live;
  const stored = readCampaign(id);
  if (stored && stored.status === 'running') {
    stored.status = 'interrupted';
    writeCampaign(stored);
  }
  return stored;
}

/** Latest campaign for the tab pages, with the same orphan-detection as resolveCampaign(). */
function resolveLatestCampaign(): Campaign | null {
  const latest = readLatestCampaign();
  if (!latest) return null;
  return resolveCampaign(latest.id);
}

/**
 * Rebuilds the full scoring signal for a submitted opportunity. The
 * execute form only carries title/detail/source; the evidence list and
 * pattern confidence live on the latest MorningBrief, so a title match
 * there recovers them — deterministic lookup, nothing smuggled through
 * hidden fields.
 */
function toScorable(title: string, detail: string, source: string): ScorableOpportunity {
  const brief = readLatestMorningBrief();
  const match = brief?.opportunities.find((o) => o.title === title);
  if (match) {
    return { title, detail, evidence: match.evidence, kind: match.kind, confidenceLevel: match.confidenceLevel };
  }
  return { title, detail, evidence: [], kind: source === 'opportunity' ? 'outperforming-content' : source };
}

/**
 * Kicks a created campaign off in the background — the founder watches progress
 * on its page. executeCampaign persists every step and records failures on the
 * campaign itself; the catch is a last line of defense so an unexpected error
 * still lands on disk.
 *
 * Also opens a ledger run (step 1), so a campaign generated overnight appears
 * in run history with its outcome and cost alongside every other department's
 * work — which is what the Morning Brief will eventually report over (§7).
 */
function startCampaignRun(campaign: Campaign): void {
  activeCampaigns.set(campaign.id, campaign);
  void (async () => {
    const run = await startRun({ department: 'campaign', trigger: 'founder', progress: { campaignId: campaign.id, title: campaign.title } });
    try {
      const finished = await executeCampaign(campaign);
      const output = { campaignId: finished.id, title: finished.title, status: finished.status, qaApproved: finished.qaReport?.approved ?? null };
      // A campaign that stops at a failed department is a failed run, even
      // though executeCampaign() returns normally — the ledger records what
      // actually happened, not whether the function threw.
      if (finished.status === 'complete') await completeRun(run?.id ?? null, { output });
      else await failRun(run?.id ?? null, finished.steps.find((s) => s.status === 'failed')?.detail ?? `Campaign ended as "${finished.status}"`, { output });
    } catch (err) {
      console.error(`[Campaign ${campaign.id}] Unexpected orchestration error:`, err);
      campaign.status = 'failed';
      writeCampaign(campaign);
      await failRun(run?.id ?? null, err, { output: { campaignId: campaign.id } });
    } finally {
      activeCampaigns.delete(campaign.id);
    }
  })();
}

async function handleCampaignExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  const title = (body.get('title') ?? '').trim();
  if (!title) {
    redirect(res, '/morning');
    return;
  }
  const detail = (body.get('detail') ?? '').trim();
  const source = (body.get('source') ?? 'manual').trim() || 'manual';

  // Score BEFORE any LLM spend (M3 §1) — deterministic, and stored on the
  // campaign so the founder sees why. A founder-triggered single execute
  // always proceeds regardless of priority: the score informs, the founder
  // already decided.
  const score = await scoreOpportunity(toScorable(title, detail, source));
  const campaign = createCampaign({ title, detail, source }, score);
  startCampaignRun(campaign);
  redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
}

/**
 * The daily funnel (M3 §2): score EVERY opportunity on the latest Morning
 * Brief, keep the configured top N (low priority never selected), generate
 * those campaigns sequentially in the background. Founder-triggered — one
 * button, predictable spend.
 */
async function handleGenerateTopCampaigns(res: ServerResponse): Promise<void> {
  const brief = readLatestMorningBrief();
  const candidates: ScorableOpportunity[] = (brief?.opportunities ?? []).map((o) => ({
    title: o.title,
    detail: o.detail,
    evidence: o.evidence,
    kind: o.kind,
    confidenceLevel: o.confidenceLevel,
  }));
  if (brief?.recommendedAction) {
    candidates.push({ title: brief.recommendedAction, detail: brief.recommendedActionReasoning ?? '', evidence: [], kind: 'recommended-action' });
  }
  if (candidates.length === 0) {
    redirect(res, '/campaigns');
    return;
  }

  const selected = selectTopOpportunities(await scoreOpportunities(candidates));
  const campaigns = selected.map(({ opportunity, score }) =>
    createCampaign({ title: opportunity.title, detail: opportunity.detail, source: opportunity.kind }, score)
  );

  // Sequential in the background — campaigns don't compete for the local
  // LLM budget/process all at once; within each campaign the generation
  // departments still run in parallel.
  void (async () => {
    for (const campaign of campaigns) {
      activeCampaigns.set(campaign.id, campaign);
      try {
        await executeCampaign(campaign);
      } catch (err) {
        console.error(`[Campaign ${campaign.id}] Unexpected orchestration error:`, err);
        campaign.status = 'failed';
        writeCampaign(campaign);
      } finally {
        activeCampaigns.delete(campaign.id);
      }
    }
  })();

  redirect(res, '/campaigns');
}

// ---------------------------------------------------------------------------
// Founder feedback (M4) — the campaign no longer ends at "complete". A
// structured review, founder edits (AI original always kept), and the
// deterministic lessons those produce are what the Learning Layer derives
// future behavior from. All parsing/validation here; the Learning Layer
// stays a pure function over the stored records.
// ---------------------------------------------------------------------------

const VALID_OUTCOMES: CampaignOutcome[] = ['approved', 'approved-with-edits', 'needs-regeneration', 'rejected'];

/** Only 1-5 counts — anything else is dropped rather than coerced into a rating the founder never gave. */
function parseRating(raw: string | null): Rating | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? (n as Rating) : undefined;
}

/** Checkbox values validated against the known chip list — never trusted verbatim from the form. */
function parseReasons(body: URLSearchParams): FeedbackReason[] {
  const allowed = new Set<string>(FEEDBACK_REASONS);
  return body.getAll('reason').filter((r): r is FeedbackReason => allowed.has(r));
}

async function handleCampaignReview(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const campaign = resolveCampaign(id);
  if (!campaign) {
    sendHtml(res, 404, pageShell('Not found', '<p>No such campaign.</p><a class="back" href="/campaigns">← Campaigns</a>'));
    return;
  }
  const body = await readRequestBody(req);
  const outcome = body.get('outcome') as CampaignOutcome | null;
  const overallRating = parseRating(body.get('overall'));
  if (!outcome || !VALID_OUTCOMES.includes(outcome) || !overallRating) {
    // The form marks both required; a submission without them is malformed,
    // not a review to record half of.
    redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
    return;
  }

  const departmentRatings: Partial<Record<RateableDepartment, Rating>> = {};
  for (const d of RATEABLE_DEPARTMENTS) {
    const rating = parseRating(body.get(`rating-${d}`));
    if (rating) departmentRatings[d] = rating;
  }

  const review: CampaignReview = {
    outcome,
    overallRating,
    departmentRatings,
    reasons: parseReasons(body),
    note: (body.get('note') ?? '').trim() || undefined,
    reviewedAt: new Date().toISOString(),
  };
  campaign.review = review;
  // Lessons are regenerated from the full record (review + every edit), so
  // they stay consistent no matter what order feedback arrived in.
  campaign.lessons = generateLessons(campaign);
  writeCampaign(campaign);
  // Refresh the human-readable Learning Layer snapshot. The campaigns
  // remain the source of truth — this is a window, not a cache.
  writeLearningSnapshot();

  redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
}

/**
 * Resolves an /edit/:language/:field request against the campaign (M5 —
 * assets are language-keyed). Returns null unless the language is one this
 * business operates in, the field is genuinely editable, and generated text
 * actually exists at that address.
 */
function resolveEditTarget(id: string, language: string, field: string): { campaign: Campaign; language: Language; field: keyof WrittenAssets; original: string } | null {
  const campaign = resolveCampaign(id);
  if (!campaign) return null;
  const typedField = field as keyof WrittenAssets;
  if (!WRITTEN_ASSET_FIELDS.includes(typedField)) return null;
  if (!readConfiguredLanguages().includes(language as Language)) return null;
  const typedLanguage = language as Language;
  const original = campaign.content?.[typedLanguage]?.[typedField];
  if (!original) return null;
  return { campaign, language: typedLanguage, field: typedField, original };
}

function handleCampaignEditForm(res: ServerResponse, id: string, language: string, field: string): void {
  const target = resolveEditTarget(id, language, field);
  if (!target) {
    sendHtml(res, 404, pageShell('Not found', '<p>Nothing to edit there.</p><a class="back" href="/campaigns">← Campaigns</a>'));
    return;
  }
  sendHtml(res, 200, renderCampaignEditPage(target.campaign, target.language, target.field, target.original));
}

async function handleCampaignEditSave(req: IncomingMessage, res: ServerResponse, id: string, language: string, field: string): Promise<void> {
  const target = resolveEditTarget(id, language, field);
  if (!target) {
    sendHtml(res, 404, pageShell('Not found', '<p>Nothing to edit there.</p><a class="back" href="/campaigns">← Campaigns</a>'));
    return;
  }
  const { campaign, original } = target;
  const body = await readRequestBody(req);
  const edited = body.get('edited') ?? '';
  if (!edited.trim() || edited === original) {
    redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
    return;
  }

  // The AI original is preserved on the edit record itself (M4 §3) — the
  // campaign's live content becomes the founder's version, but what
  // Marketing OS wrote is never discarded.
  campaign.edits = [
    ...(campaign.edits ?? []),
    {
      field: target.field,
      language: target.language,
      original,
      edited,
      deltaChars: edited.length - original.length,
      reasons: parseReasons(body),
      editedAt: new Date().toISOString(),
    },
  ];
  campaign.content = {
    ...campaign.content,
    [target.language]: { ...campaign.content?.[target.language], [target.field]: edited },
  };
  campaign.lessons = generateLessons(campaign);
  writeCampaign(campaign);
  writeLearningSnapshot();

  redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
}

async function handleCampaignRegenerate(res: ServerResponse, id: string, stepId: string): Promise<void> {
  const campaign = resolveCampaign(id);
  if (!campaign || !REGENERABLE_STEPS.includes(stepId as CampaignStepId)) {
    sendHtml(res, 404, pageShell('Not found', '<p>No such campaign or step.</p><a class="back" href="/campaigns">← Campaigns</a>'));
    return;
  }
  activeCampaigns.set(campaign.id, campaign);
  regenerateCampaignStep(campaign, stepId as CampaignStepId)
    .catch((err) => {
      console.error(`[Campaign ${campaign.id}] Unexpected regeneration error:`, err);
      campaign.status = 'failed';
      writeCampaign(campaign);
    })
    .finally(() => {
      activeCampaigns.delete(campaign.id);
    });
  redirect(res, `/campaign/${encodeURIComponent(campaign.id)}`);
}

function handleCampaignStatus(res: ServerResponse, id: string): void {
  const campaign = resolveCampaign(id);
  if (!campaign) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  sendJson(res, 200, { status: campaign.status, steps: campaign.steps.map(({ id: stepId, status, detail }) => ({ id: stepId, status, detail })) });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  // CORS first, and reject a disallowed browser origin before anything else
  // looks at the request.
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: 'Origin not allowed' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Liveness probe — the only unauthenticated route, deliberately: hosting
  // platforms need it to tell whether the process is up, and it reveals
  // nothing beyond that.
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true, authRequired: authRequired() });
    return;
  }

  // Identity for EVERY other route, before any handler runs. In local mode
  // this is the same fixed session it always was; when auth is required it
  // verifies the request's Supabase token and throws UnauthorizedError.
  // Enforced here rather than per-route on purpose: most routes below mutate
  // state, and a route added later must be protected by default, not by
  // remembering to add a check.
  let founderName: string;
  try {
    founderName = (await getFounderSession(req)).founderName;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Flat 401 — never says which check failed, so this can't be used to
      // probe whether an account exists.
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    throw err;
  }

  try {
    if (req.method === 'GET' && pathname === '/') {
      sendHtml(res, 200, renderHome(founderName));
    } else if (req.method === 'GET' && pathname === '/morning') {
      await handleMorning(res);
    } else if (req.method === 'GET' && pathname === '/api/morning/status') {
      handleMorningStatus(res);
    } else if (req.method === 'POST' && pathname === '/api/morning/generate') {
      await handleMorningGenerate(res);
    } else if (req.method === 'GET' && pathname === '/api/morning/generate/status') {
      sendJson(res, 200, await morningJobPayload());
    } else if (req.method === 'POST' && pathname === '/campaign/execute') {
      await handleCampaignExecute(req, res);
    } else if (req.method === 'POST' && pathname === '/campaign/execute-top') {
      await handleGenerateTopCampaigns(res);
    } else if (req.method === 'POST' && /^\/campaign\/[^/]+\/regenerate\/[^/]+$/.test(pathname)) {
      const [, , id, , stepId] = pathname.split('/');
      await handleCampaignRegenerate(res, decodeURIComponent(id), stepId);
    } else if (req.method === 'POST' && /^\/campaign\/[^/]+\/review$/.test(pathname)) {
      await handleCampaignReview(req, res, decodeURIComponent(pathname.split('/')[2]));
    } else if (req.method === 'GET' && /^\/campaign\/[^/]+\/edit\/[^/]+\/[^/]+$/.test(pathname)) {
      const [, , id, , language, field] = pathname.split('/');
      handleCampaignEditForm(res, decodeURIComponent(id), language, field);
    } else if (req.method === 'POST' && /^\/campaign\/[^/]+\/edit\/[^/]+\/[^/]+$/.test(pathname)) {
      const [, , id, , language, field] = pathname.split('/');
      await handleCampaignEditSave(req, res, decodeURIComponent(id), language, field);
    } else if (req.method === 'GET' && pathname === '/runs') {
      // listRecentRuns() before isLedgerAvailable() — the availability flag is
      // only meaningful after a read has been attempted in this process.
      const runs = await listRecentRuns();
      sendHtml(res, 200, renderRunsPage(runs, { ledgerAvailable: isLedgerAvailable() }));
    } else if (req.method === 'GET' && pathname === '/learning') {
      sendHtml(res, 200, renderLearningPage(deriveFounderLearning(listCampaigns())));
    } else if (req.method === 'GET' && pathname === '/campaigns') {
      // Through resolveCampaign so a live in-process run shows its current
      // state and a run orphaned by a restart reads honestly as
      // 'interrupted' instead of "Generating…" forever.
      sendHtml(res, 200, renderCampaignsPage(listCampaigns().map((c) => resolveCampaign(c.id) ?? c)));
    } else if (req.method === 'GET' && pathname.startsWith('/campaign/')) {
      const rest = pathname.slice('/campaign/'.length);
      if (rest.includes('/')) {
        sendHtml(res, 404, pageShell('Not found', '<p>Not found.</p><a class="back" href="/">← Home</a>'));
      } else {
        const campaign = resolveCampaign(decodeURIComponent(rest));
        if (!campaign) {
          sendHtml(res, 404, pageShell('Not found', '<p>No such campaign.</p><a class="back" href="/campaigns">← Campaigns</a>'));
        } else {
          sendHtml(res, 200, renderCampaignPage(campaign));
        }
      }
    } else if (req.method === 'GET' && pathname.startsWith('/api/campaign/') && pathname.endsWith('/status')) {
      handleCampaignStatus(res, decodeURIComponent(pathname.slice('/api/campaign/'.length, -'/status'.length)));
    } else if (req.method === 'GET' && pathname === '/research') {
      sendHtml(res, 200, renderResearchPage(resolveLatestCampaign()));
    } else if (req.method === 'GET' && pathname === '/content') {
      sendHtml(res, 200, renderContentPage(resolveLatestCampaign()));
    } else if (req.method === 'GET' && pathname === '/video') {
      sendHtml(res, 200, renderVideoPage(resolveLatestCampaign()));
    } else if (req.method === 'GET' && pathname === '/publish') {
      sendHtml(res, 200, renderPublishPage(resolveLatestCampaign()));
    } else if (req.method === 'GET' && pathname.startsWith('/dashboard/')) {
      serveDashboardFile(res, pathname.slice('/dashboard/'.length));
    } else if (req.method === 'GET' && pathname === '/teach') {
      sendHtml(res, 200, renderTeach(url.searchParams.get('status') ?? undefined, url.searchParams.get('id') ?? undefined));
    } else if (req.method === 'POST' && pathname === '/teach') {
      const body = await readRequestBody(req);
      const instead = (body.get('instead') ?? '').trim();
      const why = (body.get('why') ?? '').trim();
      if (!instead) {
        redirect(res, '/teach?status=skipped');
        return;
      }
      const { action: recommendedAction, date } = readTodaysRecommendation();
      if (!recommendedAction) {
        redirect(res, '/teach');
        return;
      }
      const suggestion = proposeSuggestion(buildFounderTeachingSuggestionInput(recommendedAction, date, instead, why));
      redirect(res, `/teach?status=saved&id=${encodeURIComponent(suggestion.id)}`);
    } else if (req.method === 'GET' && pathname === '/review') {
      sendHtml(res, 200, renderReview());
    } else if (req.method === 'POST' && pathname.startsWith('/review/suggestions/')) {
      const rest = pathname.slice('/review/suggestions/'.length);
      const [id, action] = rest.split('/');
      if (action === 'approve') {
        approveSuggestion({ id, reviewedBy: founderName });
      } else if (action === 'reject') {
        const body = await readRequestBody(req);
        rejectSuggestion({ id, reviewedBy: founderName, reason: (body.get('reason') ?? '').trim() || 'No reason given' });
      }
      redirect(res, '/review');
    } else if (req.method === 'POST' && pathname.startsWith('/review/knowledge/')) {
      const rest = pathname.slice('/review/knowledge/'.length);
      const [id, action] = rest.split('/');
      if (action === 'approve') {
        reviewKnowledgeEntry({ id, toStatus: 'verified', reviewedBy: founderName });
      } else if (action === 'reject') {
        const body = await readRequestBody(req);
        reviewKnowledgeEntry({ id, toStatus: 'deprecated', reviewedBy: founderName, reviewNotes: (body.get('reason') ?? '').trim() || 'No reason given' });
      }
      redirect(res, '/review');
    } else if (req.method === 'POST' && pathname.startsWith('/review/patterns/')) {
      const rest = pathname.slice('/review/patterns/'.length);
      const [id, action] = rest.split('/');
      if (action === 'approve') {
        approvePattern({ id, reviewedBy: founderName });
      } else if (action === 'ignore') {
        const body = await readRequestBody(req);
        ignorePattern({ id, reviewedBy: founderName, reason: (body.get('reason') ?? '').trim() || 'No reason given' });
      } else if (action === 'keep-observing') {
        keepObservingPattern({ id, reviewedBy: founderName });
      }
      redirect(res, '/review');
    } else if (req.method === 'GET' && pathname === '/observations') {
      sendHtml(res, 200, await renderObservations());
    } else if (req.method === 'POST' && pathname === '/api/generate-briefing') {
      await generateDailyBriefing();
      redirect(res, '/morning');
    } else {
      sendHtml(res, 404, pageShell('Not found', '<p>Not found.</p><a class="back" href="/">← Home</a>'));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    sendHtml(res, 500, pageShell('Error', `<a class="back" href="/">← Home</a><h1>Something went wrong</h1><p>${escapeHtml(message)}</p>`));
  }
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendHtml(res, 500, '<p>Internal error.</p>');
  });
});

// Already enforced at import time by lib/exposure-guard.ts; called again here
// so the invariant is visible at the point it actually matters, and so a
// future refactor that drops the import can't silently remove the check.
assertSafeExposure();

// Any run still flagged 'running' belonged to a process that no longer
// exists, so it was orphaned by a restart — not failed by an agent. Recording
// that distinction is the whole point of having a durable ledger (step 1);
// without it, a redeploy mid-generation would look like a department fault
// forever. Fire-and-forget: it must never delay or prevent startup.
void reconcileOrphanedRuns();

server.listen(PORT, HOST, () => {
  if (isLoopback(HOST)) {
    console.log(`Founder Workspace running at http://${HOST}:${PORT} — local only, no auth (see this file's header comment for why).`);
  } else {
    const origins = allowedOrigins();
    console.log(`Founder Workspace running on ${HOST}:${PORT} — authenticated mode, every route requires the founder's Supabase token.`);
    console.log(
      origins.length
        ? `Browser origins allowed to call the API: ${origins.join(', ')}`
        : 'No MARKETING_OS_ALLOWED_ORIGINS set — browser calls from another origin (e.g. pintag.io) will be refused. Set it to enable the phone UI.'
    );
  }
});
