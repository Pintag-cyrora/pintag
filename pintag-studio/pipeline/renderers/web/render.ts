// Mobile-first, card-based web renderer for the Morning Brief — replaces
// daily-briefing.ts's old renderMorningScreen(). Display only: every value
// shown here is read directly off MorningBrief, never computed, classified,
// or decided. Reused at two call sites: GET /morning (founder-server.ts)
// and dashboard/morning.html regeneration (daily-briefing.ts), so the
// legacy static file gets this design for free.

import { escapeHtml, pageShell } from './shell.js';
import type { MorningBrief, DepartmentUpdate, RiskItem, OpportunityItem } from '../../services/morning/types.js';

const HEALTH_DOT: Record<DepartmentUpdate['status'], string> = { healthy: '🟢', degraded: '🟡', down: '🔴', idle: '⚪' };
const COMPANY_HEALTH_DOT: Record<MorningBrief['companyHealth']['overallStatus'], string> = { healthy: '🟢', attention: '🟡', down: '🔴', unavailable: '⚪' };
const RISK_ICON: Record<RiskItem['kind'], string> = { 'department-health': '🏥', 'underperforming-content': '📉', 'source-error': '🔌' };
const OPPORTUNITY_ICON: Record<OpportunityItem['kind'], string> = { 'outperforming-content': '📈', 'emerging-playbook': '🧭' };

function section(title: string, icon: string, innerHtml: string): string {
  return `<div class="card"><div class="card-title">${icon} ${escapeHtml(title)}</div>${innerHtml}</div>`;
}

function renderTodaysPriorities(brief: MorningBrief): string {
  if (brief.todaysPriorities.length === 0) return '<p class="empty">Nothing needs your attention right now.</p>';
  const items = brief.todaysPriorities
    .map(
      (item) =>
        `<li class="list-row"><div class="list-title">${escapeHtml(item.title)} <span class="tag">${escapeHtml(item.badge)}</span></div><div class="list-detail">${escapeHtml(item.detail)} <a href="${escapeHtml(item.link)}">Review →</a></div></li>`
    )
    .join('');
  return `<ul>${items}</ul>`;
}

function renderMarketIntelligence(brief: MorningBrief): string {
  const knowledgeItems = brief.recentlyVerifiedKnowledge
    .map((e) => `<li class="list-row"><div class="list-title">${escapeHtml(e.title)}</div><div class="list-detail">${escapeHtml(e.category)} · confidence ${e.confidence}</div></li>`)
    .join('');
  const activityItems = brief.recentActivity
    .map(
      (item) =>
        `<li class="list-row"><div class="list-title">${escapeHtml(item.observation.whatHappened)}</div><div class="list-detail">${escapeHtml(item.stat)}</div><div class="list-framing">${escapeHtml(item.framing)}</div></li>`
    )
    .join('');
  if (!knowledgeItems && !activityItems) return '<p class="empty">Nothing new to report right now.</p>';
  return `<ul>${knowledgeItems}${activityItems}</ul>`;
}

function renderCompanyHealth(brief: MorningBrief): string {
  const h = brief.companyHealth;
  if (!h.available) return `<p class="empty">${escapeHtml(h.headline)}</p>`;
  return `<div class="health-headline">${COMPANY_HEALTH_DOT[h.overallStatus]} ${escapeHtml(h.headline)}</div>`;
}

function renderDepartmentUpdates(brief: MorningBrief): string {
  if (brief.departmentUpdates.length === 0) return '<p class="empty">Department status unavailable.</p>';
  const items = brief.departmentUpdates
    .map(
      (d) =>
        `<li class="list-row"><div class="list-title">${HEALTH_DOT[d.status]} ${escapeHtml(d.label)}</div><div class="list-detail">${escapeHtml(d.message ?? '')}${d.lastRunLabel ? ` · last ran ${escapeHtml(d.lastRunLabel)}` : ''}</div></li>`
    )
    .join('');
  return `<ul>${items}</ul>`;
}

function renderRisks(brief: MorningBrief): string {
  if (brief.risks.length === 0) return '<p class="empty">No risks flagged right now.</p>';
  const items = brief.risks
    .map((r) => `<li class="list-row"><div class="list-title">${RISK_ICON[r.kind]} ${escapeHtml(r.title)}</div><div class="list-detail">${escapeHtml(r.detail)}</div></li>`)
    .join('');
  return `<ul>${items}</ul>`;
}

function renderOpportunities(brief: MorningBrief): string {
  if (brief.opportunities.length === 0) return '<p class="empty">Nothing stands out as an opportunity right now.</p>';
  const items = brief.opportunities
    .map((o) => {
      const evidenceHtml = o.evidence.length ? `<ul class="evidence-list">${o.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : '';
      const linkHtml = o.link ? `<div class="list-action"><a href="${escapeHtml(o.link)}" target="_blank" rel="noopener">Open →</a></div>` : '';
      const playbookActionsHtml =
        o.kind === 'emerging-playbook' && o.patternId
          ? `<div class="playbook-actions">
              <form method="POST" action="/review/patterns/${encodeURIComponent(o.patternId)}/approve"><button class="btn-sm" type="submit">Approve as Playbook →</button></form>
              <form method="POST" action="/review/patterns/${encodeURIComponent(o.patternId)}/keep-observing"><button class="btn-sm btn-sm-secondary" type="submit">Keep Observing →</button></form>
            </div>`
          : '';
      return `<li class="list-row"><div class="list-title">${OPPORTUNITY_ICON[o.kind]} ${escapeHtml(o.title)}</div><div class="list-detail">${escapeHtml(o.detail)}</div>${evidenceHtml}${linkHtml}${playbookActionsHtml}</li>`;
    })
    .join('');
  return `<ul>${items}</ul>`;
}

export interface RenderMorningPageOptions {
  regenerating?: boolean;
}

export function renderMorningPage(brief: MorningBrief, opts: RenderMorningPageOptions = {}): string {
  const winHtml = brief.win ? `<div class="win-banner"><span class="win-label">Yesterday's Win</span>${escapeHtml(brief.win)}</div>` : '';

  const recommendedActionHtml = brief.recommendedAction
    ? section(
        'Recommended Action',
        '🎯',
        `<div class="rec-action-label">If you only do one thing today</div>
         <button class="btn-primary" onclick="alert('One-click execution isn\\'t built yet — this is the recommended action Marketing OS would run for you.'); return false;">${escapeHtml(brief.recommendedAction)}</button>
         ${brief.recommendedActionReasoning ? `<div class="rec-action-reasoning">${escapeHtml(brief.recommendedActionReasoning)}</div>` : ''}`
      )
    : '';

  const bodyHtml = `
  <div class="greeting">
    <div class="workspace-label">CEO Workspace</div>
    <h1>☀️ Good Morning, ${escapeHtml(brief.founderName)}</h1>
    <div class="date-label">${escapeHtml(brief.dateLabel)}</div>
    <div class="company-chip">${escapeHtml(brief.activeCompany)}</div>
  </div>

  <div id="staleness-banner" class="staleness-banner" style="display:none;" data-generated-at="${escapeHtml(brief.generatedAt)}">
    New Morning Brief Available — <button id="staleness-refresh" class="link-btn">Refresh</button> <button id="staleness-dismiss" class="link-btn">Dismiss</button>
  </div>

  ${winHtml}

  ${section('Executive Summary', '🧠', `<p>${escapeHtml(brief.narrative)}</p>`)}

  ${section('Market Intelligence', '📬', renderMarketIntelligence(brief))}

  ${section('Company Health', '🏢', renderCompanyHealth(brief))}

  ${section('Department Updates', '🧑‍💼', renderDepartmentUpdates(brief))}

  ${recommendedActionHtml}

  ${section("Today's Priorities", '📋', renderTodaysPriorities(brief))}

  ${section('Risks', '⚠️', renderRisks(brief))}

  ${section('Opportunities', '💡', renderOpportunities(brief))}

  <div class="footnote">Generated ${escapeHtml(brief.generatedLabel)}${opts.regenerating ? ' — a newer version is generating in the background.' : ''}</div>
  `;

  // The one deliberate exception to this codebase's "no client-side
  // JavaScript at all" convention (see founder-server.ts's header comment)
  // — scoped to this page only, and fully inert (try/catch, no-op on
  // failure) if this file is ever opened as a static file with no server
  // behind it. It never auto-reloads; refreshing is entirely the founder's
  // choice, on tap, per the hybrid-cache design.
  const pollScript = `<script>
(function () {
  var banner = document.getElementById('staleness-banner');
  if (!banner) return;
  var initialGeneratedAt = banner.getAttribute('data-generated-at');
  document.getElementById('staleness-dismiss')?.addEventListener('click', function () { banner.style.display = 'none'; });
  document.getElementById('staleness-refresh')?.addEventListener('click', function () { location.reload(); });
  function poll() {
    fetch('/api/morning/status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.generatedAt && data.generatedAt !== initialGeneratedAt) {
          banner.style.display = 'block';
        }
      })
      .catch(function () { /* silent — e.g. opened as a static file with no server behind it */ });
  }
  setInterval(poll, 25000);
})();
</script>`;

  const extraStyle = `<style>
.greeting{margin-bottom:20px;}
.workspace-label{font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--teal);margin-bottom:8px;}
.greeting h1{font-size:26px;font-weight:600;margin-bottom:4px;}
.date-label{font-size:14px;color:var(--ink-muted);margin-bottom:10px;}
.company-chip{display:inline-block;background:var(--teal-dim);border:1px solid var(--teal-border);color:var(--ink);font-size:13px;font-weight:600;padding:6px 14px;border-radius:20px;}
.staleness-banner{background:var(--gold);color:#fff;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:14px;font-weight:600;}
.link-btn{background:none;border:none;color:#fff;text-decoration:underline;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer;padding:0 4px;}
.win-banner{background:var(--teal-dim);border:1px solid var(--teal-border);border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:15px;}
.win-label{font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--teal);display:block;margin-bottom:4px;}
.list-row{padding:12px 0;border-bottom:1px solid var(--border);}
.list-row:last-child{border-bottom:none;}
.list-title{font-weight:600;font-size:15px;color:var(--ink);}
.list-detail{font-size:14px;color:var(--ink-muted);margin-top:2px;}
.list-framing{font-size:14px;color:var(--ink-soft);margin-top:2px;}
.list-action{margin-top:6px;font-size:14px;}
.tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-muted);background:var(--warm-deep);border-radius:10px;padding:2px 8px;margin-left:8px;}
.evidence-list{list-style:none;padding-left:0;margin-top:6px;}
.evidence-list li{font-size:13px;color:var(--ink-muted);padding:1px 0;}
.health-headline{font-size:16px;font-weight:600;}
.rec-action-label{font-size:13px;color:var(--ink-muted);margin-bottom:12px;}
.btn-primary{display:inline-block;background:var(--teal);color:#fff;font-size:16px;font-weight:600;border:none;border-radius:8px;padding:14px 24px;cursor:pointer;font-family:inherit;width:100%;}
.rec-action-reasoning{margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:14px;color:var(--ink-soft);}
.playbook-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
.btn-sm{background:var(--teal);color:#fff;font-size:13px;font-weight:600;border:none;border-radius:6px;padding:9px 14px;cursor:pointer;font-family:inherit;}
.btn-sm-secondary{background:var(--white);color:var(--ink-soft);border:1.5px solid var(--border);}
.footnote{font-size:12px;color:var(--ink-muted);margin-top:24px;text-align:center;}
</style>`;

  return pageShell({ title: 'Morning Brief', bodyHtml, activeHref: '/morning', extraHeadHtml: extraStyle + pollScript });
}
