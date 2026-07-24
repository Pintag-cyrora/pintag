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
// Local-only by design: binds to 127.0.0.1, no auth. This runs on the
// founder's own machine for the founder's own daily use — the same trust
// boundary as running a CLI command locally, not a hosted multi-user
// surface (unlike dashboard/index.html, which needs Supabase Auth because
// it's meant to be bookmarked/hosted). Plain HTML forms + redirects, no
// client-side JavaScript at all — except GET /morning, which is a
// deliberate, scoped exception: its page includes a small inline poll
// script (see renderers/web/render.ts) so a founder reading a cached brief
// can be told a newer one finished generating in the background, without
// auto-reloading out from under them. Every other route stays JS-free.
//
// Run: npm run founder-ui  (defaults to http://127.0.0.1:4321; set PORT to
// change it, e.g. PORT=3000 npm run founder-ui)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readMorningBriefConfig } from './lib/config.js';
import { generateDailyBriefing, readFounderName, SUGGESTION_KIND_LABELS } from './daily-briefing.js';
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

const PORT = Number(process.env.PORT ?? 4321);

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

function renderHome(): string {
  const pendingSuggestions = listPendingSuggestions().length;
  const pendingDrafts = loadAllKnowledgeEntries().filter((e) => e.status === 'draft' && isWritableEntry(e)).length;
  const pendingPatterns = listCandidatePatterns().length;
  const pendingTotal = pendingSuggestions + pendingDrafts + pendingPatterns;

  return pageShell(
    'Founder Workspace',
    `
    <h1>Good morning, ${escapeHtml(readFounderName())}</h1>
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
  // is the same classification gatherObservations() applies for real; shown
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
    sendHtml(res, 200, renderMorningPage(brief));
    return;
  }
  morningCache.refreshInBackgroundIfStale(cached);
  sendHtml(res, 200, renderMorningPage(cached, { regenerating: morningCache.status().regenerating }));
}

function handleMorningStatus(res: ServerResponse): void {
  sendJson(res, 200, morningCache.status());
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  const founderName = readFounderName();

  try {
    if (req.method === 'GET' && pathname === '/') {
      sendHtml(res, 200, renderHome());
    } else if (req.method === 'GET' && pathname === '/morning') {
      await handleMorning(res);
    } else if (req.method === 'GET' && pathname === '/api/morning/status') {
      handleMorningStatus(res);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Founder Workspace running at http://127.0.0.1:${PORT} — local only, no auth (see this file's header comment for why).`);
});
