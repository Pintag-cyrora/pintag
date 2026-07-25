// Web renderers for Campaign pages — the live execution progress page and
// the Research / Content / Video / Publish tabs. Display only, same
// contract as render.ts: every value shown is read directly off Campaign,
// never computed, classified, or decided here. All business logic lives in
// services/campaign/generate.ts at generation time.

import { escapeHtml, pageShell } from './shell.js';
import type { Campaign, CampaignStepState } from '../../services/campaign/types.js';

const STEP_ICON: Record<CampaignStepState['status'], string> = {
  pending: '○',
  running: '◌',
  complete: '✓',
  failed: '✕',
};

const CAMPAIGN_STYLE = `<style>
.campaign-header{margin-bottom:20px;}
.campaign-header h1{font-size:22px;font-weight:600;margin-bottom:4px;}
.campaign-meta{font-size:13px;color:var(--ink-muted);}
.step-row{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);align-items:flex-start;}
.step-row:last-child{border-bottom:none;}
.step-icon{font-size:18px;line-height:1.3;width:24px;flex-shrink:0;text-align:center;}
.step-complete .step-icon{color:var(--green);}
.step-failed .step-icon{color:var(--red);}
.step-running .step-icon{color:var(--teal);animation:pulse 1.2s ease-in-out infinite;}
.step-pending{opacity:0.45;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.35;}}
.step-label{font-weight:600;font-size:15px;}
.step-detail{font-size:13px;color:var(--ink-muted);margin-top:1px;}
.status-banner{border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:15px;font-weight:600;}
.status-complete{background:rgba(30,107,69,0.1);border:1px solid rgba(30,107,69,0.3);color:var(--green);}
.status-failed{background:rgba(192,57,43,0.08);border:1px solid rgba(192,57,43,0.3);color:var(--red);}
.status-running{background:var(--teal-dim);border:1px solid var(--teal-border);color:var(--teal);}
.status-interrupted{background:rgba(184,134,11,0.1);border:1px solid rgba(184,134,11,0.3);color:var(--gold);}
.asset-block{margin-bottom:18px;}
.asset-label{font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:6px;}
.asset-body{font-size:15px;color:var(--ink);white-space:pre-wrap;background:var(--warm-deep);border-radius:10px;padding:14px 16px;}
.asset-list{list-style:none;padding:0;}
.asset-list li{padding:8px 0;border-bottom:1px solid var(--border);font-size:15px;}
.asset-list li:last-child{border-bottom:none;}
.qa-approved{color:var(--green);font-weight:600;}
.qa-issues{color:var(--red);font-weight:600;}
.tab-links{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;}
.tab-links a{display:inline-block;background:var(--teal);color:#fff;font-size:14px;font-weight:600;border-radius:8px;padding:10px 16px;text-decoration:none;}
</style>`;

function statusBanner(campaign: Campaign): string {
  switch (campaign.status) {
    case 'complete':
      return `<div class="status-banner status-complete">Campaign Complete — every department has finished.</div>`;
    case 'failed':
      return `<div class="status-banner status-failed">Campaign stopped — a department step failed. Everything generated before the failure is saved below.</div>`;
    case 'interrupted':
      return `<div class="status-banner status-interrupted">This campaign was interrupted (the workspace restarted mid-run). Re-run it from the Morning Brief to start fresh.</div>`;
    default:
      return `<div class="status-banner status-running">Generating Campaign… departments are working in order. This page updates itself.</div>`;
  }
}

/** The live execution page behind the Execute Campaign button. */
export function renderCampaignProgressPage(campaign: Campaign): string {
  const doneLinks =
    campaign.status === 'complete'
      ? `<div class="card"><div class="card-title">📦 Generated assets</div>
          <p>Everything is saved inside this campaign and ready to review.</p>
          <div class="tab-links">
            <a href="/research">Research</a><a href="/content">Content</a><a href="/video">Video</a><a href="/publish">Publish</a>
          </div>
        </div>`
      : '';

  // Same scoped client-side JS exception as /morning's staleness poll (see
  // render.ts) — inert if opened with no server behind it. Patches step
  // rows in place so the founder watches departments finish one by one;
  // stops polling once the campaign reaches a terminal state, and reloads
  // once on completion so the assets card appears.
  const pollScript =
    campaign.status === 'running'
      ? `<script>
(function () {
  function poll() {
    fetch('/api/campaign/${encodeURIComponent(campaign.id)}/status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.status) return;
        if (data.status !== 'running') { location.reload(); return; }
        (data.steps || []).forEach(function (step) {
          var row = document.getElementById('step-' + step.id);
          if (!row) return;
          row.className = 'step-row step-' + step.status;
          var icons = { pending: '○', running: '◌', complete: '✓', failed: '✕' };
          row.querySelector('.step-icon').textContent = icons[step.status] || '○';
          row.querySelector('.step-detail').textContent = step.detail || (step.status === 'running' ? 'Working…' : step.status === 'pending' ? 'Waiting' : '');
        });
      })
      .catch(function () { /* silent — static file or server briefly away */ });
  }
  setInterval(poll, 2500);
})();
</script>`
      : '';

  // Step rows carry ids so the poll script can patch them in place.
  const stepsHtml = campaign.steps
    .map(
      (s) => `
  <div class="step-row step-${s.status}" id="step-${escapeHtml(s.id)}">
    <div class="step-icon">${STEP_ICON[s.status]}</div>
    <div><div class="step-label">${escapeHtml(s.label)}</div><div class="step-detail">${escapeHtml(s.detail || (s.status === 'running' ? 'Working…' : s.status === 'pending' ? 'Waiting' : ''))}</div></div>
  </div>`
    )
    .join('');

  const bodyHtml = `
  <a class="back" href="/morning" style="display:inline-block;font-size:13px;color:var(--teal);text-decoration:none;font-weight:600;margin-bottom:16px;">← Morning Brief</a>
  <div class="campaign-header">
    <h1>${escapeHtml(campaign.title)}</h1>
    <div class="campaign-meta">Campaign · created ${escapeHtml(new Date(campaign.createdAt).toLocaleString())}</div>
  </div>
  ${statusBanner(campaign)}
  <div class="card"><div class="card-title">🏢 Departments</div>${stepsHtml}</div>
  ${doneLinks}
  `;

  return pageShell({ title: 'Campaign', bodyHtml, extraHeadHtml: CAMPAIGN_STYLE + pollScript });
}

// ---------------------------------------------------------------------------
// Tab pages — each renders the latest campaign's sections, with honest
// empty states when nothing exists yet.
// ---------------------------------------------------------------------------

function emptyTab(title: string, activeHref: string, icon: string): string {
  return pageShell({
    title,
    activeHref,
    bodyHtml: `<h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">${icon} ${escapeHtml(title)}</h1>
      <p class="empty">No campaign has been generated yet. Execute a campaign from the Morning Brief's Recommended Action, and its ${escapeHtml(title.toLowerCase())} will appear here.</p>`,
    extraHeadHtml: CAMPAIGN_STYLE,
  });
}

function campaignContextHeader(campaign: Campaign, icon: string, title: string): string {
  return `
  <h1 style="font-size:22px;font-weight:600;margin-bottom:4px;">${icon} ${escapeHtml(title)}</h1>
  <div class="campaign-meta" style="margin-bottom:20px;">From campaign: <a href="/campaign/${encodeURIComponent(campaign.id)}">${escapeHtml(campaign.title)}</a></div>`;
}

function block(label: string, body: string): string {
  return `<div class="asset-block"><div class="asset-label">${escapeHtml(label)}</div><div class="asset-body">${escapeHtml(body)}</div></div>`;
}

function listBlock(label: string, items: string[]): string {
  if (items.length === 0) return '';
  return `<div class="asset-block"><div class="asset-label">${escapeHtml(label)}</div><ul class="asset-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
}

export function renderResearchPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Research', '/research', '🔍');
  const bodyHtml = `
  ${campaignContextHeader(campaign, '🔍', 'Research')}
  ${campaign.objective ? block('Objective', campaign.objective.objective) : '<p class="empty">The CMO step has not defined an objective yet.</p>'}
  ${campaign.strategy ? block('Target Audience', campaign.strategy.audience) : ''}
  ${campaign.research ? block('Research Brief', campaign.research.researchBrief) : '<p class="empty">Research has not completed yet.</p>'}
  ${campaign.research ? listBlock('Supporting Evidence', campaign.research.facts.map((f) => `${f.claim} — ${f.source}`)) : ''}
  ${campaign.research && campaign.research.knowledgeGaps.length > 0 ? listBlock('Knowledge Gaps (not covered by any verified source)', campaign.research.knowledgeGaps) : ''}
  `;
  return pageShell({ title: 'Research', bodyHtml, activeHref: '/research', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderContentPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Content', '/content', '✍️');
  const c = campaign.content;
  const bodyHtml = `
  ${campaignContextHeader(campaign, '✍️', 'Content')}
  ${campaign.strategy ? block('Core Message', campaign.strategy.messaging) + block('Call to Action', campaign.strategy.cta) : ''}
  ${
    c
      ? block('Facebook', c.facebookPost) + block('Instagram', c.instagramCaption) + block('LinkedIn', c.linkedinPost) + block('Blog Article', c.blogArticleMarkdown)
      : '<p class="empty">The Writer has not generated content yet.</p>'
  }
  ${campaign.design ? listBlock('Carousel Copy', campaign.design.carouselSlides) + listBlock('Image Prompts', campaign.design.imagePrompts) + block('Thumbnail Concept', campaign.design.thumbnailPrompt) : ''}
  `;
  return pageShell({ title: 'Content', bodyHtml, activeHref: '/content', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderVideoPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Video', '/video', '🎬');
  const v = campaign.video;
  const bodyHtml = `
  ${campaignContextHeader(campaign, '🎬', 'Video')}
  ${
    v
      ? block('TikTok Script', v.tiktokScript) +
        block('Reel Script', v.reelScript) +
        listBlock('Hooks', v.hooks) +
        block('Voice-over', v.voiceover) +
        listBlock('B-roll Ideas', v.brollIdeas) +
        listBlock('Captions', v.captions)
      : '<p class="empty">The Video Producer has not generated scripts yet.</p>'
  }
  `;
  return pageShell({ title: 'Video', bodyHtml, activeHref: '/video', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderPublishPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Publish', '/publish', '📤');
  const qa = campaign.qaReport;
  const qaHtml = qa
    ? `
    <div class="card"><div class="card-title">🛡️ Brand Guardian Review</div>
      <p class="${qa.approved ? 'qa-approved' : 'qa-issues'}" style="margin-bottom:12px;">${qa.approved ? '✓ Approved' : `⚠ ${qa.issues.length} issue${qa.issues.length === 1 ? '' : 's'} for your attention`}</p>
      ${block('Summary', qa.summary)}
      ${block('Fact Checking', qa.factCheck)}
      ${block('Brand Voice', qa.brandVoice)}
      ${block('Grammar', qa.grammar)}
      ${block('Lao Terminology', qa.laoTerminology)}
      ${block('Duplicate Detection', qa.duplication)}
      ${listBlock('Issues', qa.issues)}
    </div>`
    : '<p class="empty">Brand Guardian has not reviewed this campaign yet.</p>';

  const bodyHtml = `
  ${campaignContextHeader(campaign, '📤', 'Publish')}
  <div class="status-banner ${campaign.status === 'complete' ? 'status-complete' : 'status-running'}">
    ${campaign.status === 'complete' ? 'Ready for Review — publishing is a separate, founder-approved step and is not part of campaign generation.' : 'This campaign is still generating — nothing to publish yet.'}
  </div>
  ${qaHtml}
  `;
  return pageShell({ title: 'Publish', bodyHtml, activeHref: '/publish', extraHeadHtml: CAMPAIGN_STYLE });
}
