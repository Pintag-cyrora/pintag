// Web renderers for Campaign pages — the campaigns dashboard, the unified
// progress/detail page, and the Research / Content / Video / Publish tabs.
// Display only, same contract as render.ts: every value shown is read
// directly off Campaign, never computed, classified, or decided here. All
// business logic lives in services/campaign/ at generation time.
//
// The /campaign/:id page is one renderer with two faces: while the
// campaign is running it's a live progress checklist (polling, departments
// finishing one by one); the moment it reaches a terminal state the poll
// reloads once and the same URL renders the full Campaign Detail — score,
// brief, research, content, video, QA, regenerate actions — so the founder
// lands on the review screen with zero extra clicks (M3 §10).

import { escapeHtml, pageShell } from './shell.js';
import { FEEDBACK_REASONS, RATEABLE_DEPARTMENTS, type Campaign, type CampaignStepState, type OpportunityScore, type RateableDepartment, type CampaignOutcome } from '../../services/campaign/types.js';
import type { FounderLearning } from '../../services/learning/learn.js';

const STEP_ICON: Record<CampaignStepState['status'], string> = {
  pending: '○',
  running: '◌',
  complete: '✓',
  failed: '✕',
  skipped: '—',
};

const PRIORITY_CLASS: Record<OpportunityScore['priority'], string> = { high: 'prio-high', medium: 'prio-medium', low: 'prio-low' };

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
.step-skipped{opacity:0.5;}
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
.score-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;}
.score-stat{flex:1 1 100px;background:var(--warm-deep);border-radius:10px;padding:12px 14px;text-align:center;}
.score-stat-value{font-size:22px;font-weight:700;}
.score-stat-label{font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);margin-top:2px;}
.prio-high{color:var(--green);}
.prio-medium{color:var(--gold);}
.prio-low{color:var(--ink-muted);}
.score-reasons{list-style:none;padding:0;}
.score-reasons li{font-size:13px;color:var(--ink-soft);padding:3px 0;}
.regen-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
.btn-sm{background:var(--teal);color:#fff;font-size:13px;font-weight:600;border:none;border-radius:6px;padding:9px 14px;cursor:pointer;font-family:inherit;}
.btn-sm-secondary{background:var(--white);color:var(--ink-soft);border:1.5px solid var(--border);}
.camp-card{display:block;text-decoration:none;color:inherit;}
.camp-card:hover .card{border-color:var(--teal-border);}
.camp-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.chip{display:inline-block;font-size:12px;font-weight:700;background:var(--warm-deep);border-radius:10px;padding:3px 10px;color:var(--ink-soft);}
.camp-steps{font-size:13px;color:var(--ink-muted);margin-top:8px;letter-spacing:0.05em;}
.rate-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);}
.rate-row:last-of-type{border-bottom:none;}
.rate-name{font-size:15px;font-weight:600;}
.stars{display:flex;flex-direction:row-reverse;gap:2px;}
.stars input{position:absolute;opacity:0;width:0;height:0;}
.stars label{font-size:24px;line-height:1;color:var(--warm-deep);cursor:pointer;-webkit-text-stroke:1px var(--ink-muted);}
.stars input:checked ~ label{color:var(--gold);-webkit-text-stroke:1px var(--gold);}
.stars label:hover,.stars label:hover ~ label{color:var(--gold);-webkit-text-stroke:1px var(--gold);}
.chip-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;}
.chip-check input{position:absolute;opacity:0;width:0;height:0;}
.chip-check span{display:inline-block;font-size:13px;font-weight:600;background:var(--white);border:1.5px solid var(--border);color:var(--ink-soft);border-radius:16px;padding:7px 14px;cursor:pointer;}
.chip-check input:checked + span{background:var(--teal-dim);border-color:var(--teal);color:var(--teal);}
.outcome-grid{display:flex;flex-direction:column;gap:8px;margin-bottom:6px;}
.outcome-check input{position:absolute;opacity:0;width:0;height:0;}
.outcome-check span{display:block;font-size:15px;font-weight:600;background:var(--white);border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;}
.outcome-check input:checked + span{background:var(--teal-dim);border-color:var(--teal);color:var(--teal);}
.stars-static{color:var(--gold);font-size:17px;letter-spacing:1px;}
.learning-note{font-size:14px;color:var(--ink-soft);padding:6px 0;border-bottom:1px solid var(--border);}
.learning-note:last-child{border-bottom:none;}
.edit-link{font-size:12px;font-weight:600;color:var(--teal);text-decoration:none;margin-left:8px;}
.edit-area{width:100%;font-family:inherit;font-size:15px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--white);color:var(--ink);min-height:220px;resize:vertical;margin-bottom:12px;}
</style>`;

function statusBanner(campaign: Campaign): string {
  switch (campaign.status) {
    case 'complete':
      return `<div class="status-banner status-complete">Campaign Complete — Ready for Review.</div>`;
    case 'failed':
      return `<div class="status-banner status-failed">Campaign stopped — a department step failed. Everything generated before the failure is saved below.</div>`;
    case 'interrupted':
      return `<div class="status-banner status-interrupted">This campaign was interrupted (the workspace restarted mid-run). Re-run it from the Morning Brief to start fresh.</div>`;
    default:
      return `<div class="status-banner status-running">Generating Campaign… departments are working. This page updates itself and opens the full review when they finish.</div>`;
  }
}

function stepDetailText(s: CampaignStepState): string {
  return s.detail || (s.status === 'running' ? 'Working…' : s.status === 'pending' ? 'Waiting' : '');
}

function stepsChecklist(campaign: Campaign): string {
  return campaign.steps
    .map(
      (s) => `
  <div class="step-row step-${s.status}" id="step-${escapeHtml(s.id)}">
    <div class="step-icon">${STEP_ICON[s.status]}</div>
    <div><div class="step-label">${escapeHtml(s.label)}</div><div class="step-detail">${escapeHtml(stepDetailText(s))}</div></div>
  </div>`
    )
    .join('');
}

function scoreCard(campaign: Campaign): string {
  const score = campaign.score;
  if (!score) return '';
  return `<div class="card"><div class="card-title">📊 Opportunity Score</div>
    <div class="score-row">
      <div class="score-stat"><div class="score-stat-value">${score.total}/100</div><div class="score-stat-label">Score</div></div>
      <div class="score-stat"><div class="score-stat-value">${score.confidencePercent}%</div><div class="score-stat-label">Confidence</div></div>
      <div class="score-stat"><div class="score-stat-value ${PRIORITY_CLASS[score.priority]}">${escapeHtml(score.priority)}</div><div class="score-stat-label">Priority</div></div>
    </div>
    <div class="asset-label">Reason</div>
    <ul class="score-reasons">${score.reasons.map((r) => `<li>· ${escapeHtml(r)}</li>`).join('')}</ul>
  </div>`;
}

function block(label: string, body: string): string {
  return `<div class="asset-block"><div class="asset-label">${escapeHtml(label)}</div><div class="asset-body">${escapeHtml(body)}</div></div>`;
}

function listBlock(label: string, items: string[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `<div class="asset-block"><div class="asset-label">${escapeHtml(label)}</div><ul class="asset-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
}

function optBlock(label: string, body: string | undefined): string {
  return body ? block(label, body) : '';
}

function briefCard(campaign: Campaign): string {
  const b = campaign.brief;
  if (!b) return '';
  return `<div class="card"><div class="card-title">🧭 Campaign Brief</div>
    ${block('Objective', b.objective)}
    ${block('Business Goal', b.businessGoal)}
    ${block('Audience', b.audience)}
    ${block('Core Message', b.messaging)}
    ${block('Call to Action', b.cta)}
    ${block('Primary Format', b.primaryFormat)}
    ${listBlock('Secondary Formats', b.secondaryFormats)}
    ${listBlock('Success Metrics', b.successMetrics)}
  </div>`;
}

function researchCard(campaign: Campaign): string {
  const r = campaign.research;
  if (!r) return '';
  const provenance = r.reusedFromCache ? `<p class="campaign-meta" style="margin-bottom:12px;">♻️ Reused recent research (${escapeHtml(r.reusedFromCache)}) — no new tokens spent.</p>` : '';
  return `<div class="card"><div class="card-title">🔍 Research</div>
    ${provenance}
    ${block('Research Brief', r.researchBrief)}
    ${listBlock('Supporting Evidence', r.facts.map((f) => `${f.claim} — ${f.source}`))}
    ${r.knowledgeGaps.length > 0 ? listBlock('Knowledge Gaps (not covered by any verified source)', r.knowledgeGaps) : ''}
  </div>`;
}

/** An editable written asset — the label carries an Edit link to /campaign/:id/edit/:field, where the founder's version is saved alongside the AI original (M4 §3). */
function editableBlock(campaign: Campaign, label: string, field: keyof NonNullable<Campaign['content']>, body: string | undefined, editable: boolean): string {
  if (!body) return '';
  const link = editable ? `<a class="edit-link" href="/campaign/${encodeURIComponent(campaign.id)}/edit/${field}">Edit →</a>` : '';
  return `<div class="asset-block"><div class="asset-label">${escapeHtml(label)}${link}</div><div class="asset-body">${escapeHtml(body)}</div></div>`;
}

function contentCard(campaign: Campaign, editable = false): string {
  const c = campaign.content;
  const d = campaign.design;
  if (!c && !d) return '';
  return `<div class="card"><div class="card-title">✍️ Content</div>
    ${editableBlock(campaign, 'Facebook', 'facebookPost', c?.facebookPost, editable)}
    ${editableBlock(campaign, 'Instagram', 'instagramCaption', c?.instagramCaption, editable)}
    ${editableBlock(campaign, 'LinkedIn', 'linkedinPost', c?.linkedinPost, editable)}
    ${editableBlock(campaign, 'Blog Article', 'blogArticleMarkdown', c?.blogArticleMarkdown, editable)}
    ${listBlock('Carousel Copy', d?.carouselSlides)}
    ${listBlock('Graphic Concepts', d?.graphicConcepts)}
    ${listBlock('Image Prompts', d?.imagePrompts)}
    ${optBlock('Thumbnail Concept', d?.thumbnailPrompt)}
  </div>`;
}

/** The edit screen for one written asset — prefilled with the current text; saving keeps the original as the AI version and asks for one-click reasons. */
export function renderCampaignEditPage(campaign: Campaign, field: keyof NonNullable<Campaign['content']>, current: string): string {
  const bodyHtml = `
  <a class="back" href="/campaign/${encodeURIComponent(campaign.id)}" style="display:inline-block;font-size:13px;color:var(--teal);text-decoration:none;font-weight:600;margin-bottom:16px;">← Back to campaign</a>
  <h1 style="font-size:22px;font-weight:600;margin-bottom:4px;">✏️ Edit ${escapeHtml(field)}</h1>
  <div class="campaign-meta" style="margin-bottom:20px;">${escapeHtml(campaign.title)} — Marketing OS keeps its original version alongside yours, so the difference becomes something it can learn from.</div>
  <div class="card">
    <form method="POST" action="/campaign/${encodeURIComponent(campaign.id)}/edit/${field}">
      <textarea class="edit-area" name="edited" required>${escapeHtml(current)}</textarea>
      <div class="asset-label">Why did you change it? (optional, tap any)</div>
      <div class="chip-grid">
        ${FEEDBACK_REASONS.map((r) => `<label class="chip-check"><input type="checkbox" name="reason" value="${escapeHtml(r)}"><span>${escapeHtml(r)}</span></label>`).join('')}
      </div>
      <button class="btn-sm" type="submit" style="font-size:15px;padding:12px 20px;margin-top:12px;">Save My Version</button>
    </form>
  </div>`;
  return pageShell({ title: 'Edit', bodyHtml, extraHeadHtml: CAMPAIGN_STYLE });
}

function videoCard(campaign: Campaign): string {
  const v = campaign.video;
  if (!v) return '';
  return `<div class="card"><div class="card-title">🎬 Video</div>
    ${optBlock('TikTok Script', v.tiktokScript)}
    ${optBlock('Reel Script', v.reelScript)}
    ${listBlock('Hooks', v.hooks)}
    ${block('Voice-over', v.voiceover)}
    ${listBlock('B-roll Ideas', v.brollIdeas)}
    ${listBlock('Captions', v.captions)}
  </div>`;
}

function qaCard(campaign: Campaign, withRegenerate: boolean): string {
  const qa = campaign.qaReport;
  if (!qa) return '';
  // Regenerate exactly one department, then a fresh Guardian review —
  // never the whole pipeline (M3 §8). Buttons only for departments that
  // actually generated something.
  const regenTargets: Array<{ step: string; label: string }> = [
    { step: 'writing', label: 'Regenerate Writing' },
    { step: 'design', label: 'Regenerate Design' },
    { step: 'video', label: 'Regenerate Video' },
  ].filter(({ step }) => campaign.steps.some((s) => s.id === step && s.status === 'complete'));
  const regenHtml =
    withRegenerate && regenTargets.length
      ? `<div class="asset-label" style="margin-top:16px;">Fix one department without rerunning the pipeline</div>
        <div class="regen-actions">${regenTargets
          .map(
            ({ step, label }) =>
              `<form method="POST" action="/campaign/${encodeURIComponent(campaign.id)}/regenerate/${step}"><button class="btn-sm ${qa.approved ? 'btn-sm-secondary' : ''}" type="submit">${escapeHtml(label)}</button></form>`
          )
          .join('')}</div>`
      : '';
  return `<div class="card"><div class="card-title">🛡️ Brand Guardian Review</div>
    <p class="${qa.approved ? 'qa-approved' : 'qa-issues'}" style="margin-bottom:12px;">${qa.approved ? '✓ Approved' : `⚠ ${qa.issues.length} issue${qa.issues.length === 1 ? '' : 's'} for your attention`}</p>
    ${block('Summary', qa.summary)}
    ${block('Fact Checking', qa.factCheck)}
    ${block('Brand Voice', qa.brandVoice)}
    ${block('Grammar', qa.grammar)}
    ${block('Lao Terminology', qa.laoTerminology)}
    ${block('Duplicate Detection', qa.duplication)}
    ${listBlock('Issues', qa.issues)}
    ${regenHtml}
  </div>`;
}

const DEPARTMENT_LABEL: Record<RateableDepartment, string> = {
  research: 'Research',
  strategy: 'Strategy',
  writing: 'Writing',
  design: 'Design',
  video: 'Video',
  brandVoice: 'Brand Voice',
};

const OUTCOME_LABEL: Record<CampaignOutcome, string> = {
  approved: 'Approved',
  'approved-with-edits': 'Approved With Edits',
  'needs-regeneration': 'Needs Regeneration',
  rejected: 'Rejected',
};

function starsStatic(rating: number): string {
  return `<span class="stars-static">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

/** A 1-5 star radio group. Reverse-ordered in the DOM (5 first) so pure-CSS `:checked ~ label` highlights every star below the chosen one — no JavaScript. */
function starInput(name: string, required: boolean): string {
  return `<div class="stars">${[5, 4, 3, 2, 1]
    .map(
      (n) =>
        `<input type="radio" id="${name}-${n}" name="${name}" value="${n}"${required && n === 5 ? ' required' : ''}><label for="${name}-${n}" title="${n} of 5">★</label>`
    )
    .join('')}</div>`;
}

/**
 * The structured Founder Review form (M4 §1/§2/§4/§6) — outcome, overall
 * and per-department stars, and one-click reason chips. Only departments
 * that actually produced something are rateable, so a skipped video is
 * never scored as a failure. Plain HTML form + POST, no client-side JS,
 * same discipline as every other founder-server form.
 */
function reviewFormCard(campaign: Campaign): string {
  const produced: RateableDepartment[] = RATEABLE_DEPARTMENTS.filter((d) => {
    if (d === 'brandVoice') return Boolean(campaign.qaReport);
    if (d === 'strategy') return Boolean(campaign.brief);
    if (d === 'research') return Boolean(campaign.research);
    return campaign.steps.some((s) => s.id === d && s.status === 'complete');
  });

  return `<div class="card"><div class="card-title">📝 Founder Review</div>
    <p style="font-size:14px;color:var(--ink-soft);margin-bottom:16px;">Your review is what Marketing OS actually learns from — it shapes future campaigns, and every adjustment it makes will cite the feedback behind it.</p>
    <form method="POST" action="/campaign/${encodeURIComponent(campaign.id)}/review">
      <div class="asset-label">Outcome</div>
      <div class="outcome-grid">
        ${(Object.keys(OUTCOME_LABEL) as CampaignOutcome[])
          .map(
            (o, i) =>
              `<label class="outcome-check"><input type="radio" name="outcome" value="${o}"${i === 0 ? ' required' : ''}><span>${escapeHtml(OUTCOME_LABEL[o])}</span></label>`
          )
          .join('')}
      </div>

      <div class="asset-label" style="margin-top:18px;">Ratings</div>
      <div class="rate-row"><div class="rate-name">Overall</div>${starInput('overall', true)}</div>
      ${produced.map((d) => `<div class="rate-row"><div class="rate-name">${escapeHtml(DEPARTMENT_LABEL[d])}</div>${starInput(`rating-${d}`, false)}</div>`).join('')}

      <div class="asset-label" style="margin-top:18px;">Anything off? (tap any that apply — no explanation needed)</div>
      <div class="chip-grid">
        ${FEEDBACK_REASONS.map((r) => `<label class="chip-check"><input type="checkbox" name="reason" value="${escapeHtml(r)}"><span>${escapeHtml(r)}</span></label>`).join('')}
      </div>

      <div class="asset-label" style="margin-top:18px;">Note (optional)</div>
      <textarea name="note" rows="3" style="width:100%;font-family:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--white);color:var(--ink);margin-bottom:12px;" placeholder="Only if you want to add something the chips don't cover."></textarea>

      <button class="btn-sm" type="submit" style="font-size:15px;padding:12px 20px;">Save Review</button>
    </form>
  </div>`;
}

/** The saved review, read back — permanent record (M4 §1). */
function savedReviewCard(campaign: Campaign): string {
  const r = campaign.review!;
  const deptRows = (Object.entries(r.departmentRatings) as Array<[RateableDepartment, number]>)
    .map(([d, rating]) => `<div class="rate-row"><div class="rate-name">${escapeHtml(DEPARTMENT_LABEL[d])}</div>${starsStatic(rating)}</div>`)
    .join('');
  return `<div class="card"><div class="card-title">📝 Founder Review</div>
    <div class="rate-row"><div class="rate-name">Outcome</div><div style="font-weight:600;">${escapeHtml(OUTCOME_LABEL[r.outcome])}</div></div>
    <div class="rate-row"><div class="rate-name">Overall</div>${starsStatic(r.overallRating)}</div>
    ${deptRows}
    ${r.reasons.length ? `<div class="asset-label" style="margin-top:14px;">Flagged</div><div class="chip-grid">${r.reasons.map((x) => `<span class="chip">${escapeHtml(x)}</span>`).join('')}</div>` : ''}
    ${r.note ? block('Note', r.note) : ''}
    <p class="campaign-meta" style="margin-top:12px;">Reviewed ${escapeHtml(new Date(r.reviewedAt).toLocaleString())}</p>
  </div>`;
}

/** Lessons Learned (M4 §7) — deterministic records of what the founder's review and edits actually did. */
function lessonsCard(campaign: Campaign): string {
  if (!campaign.lessons?.length) return '';
  return `<div class="card"><div class="card-title">🎓 Lessons Learned</div>
    <ul class="asset-list">${campaign.lessons.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <p class="campaign-meta" style="margin-top:10px;">Recorded from your review and edits — these feed future campaigns.</p>
  </div>`;
}

/** Learning applied to THIS campaign (M4 §11) — never a hidden adjustment. */
function learningAppliedCard(campaign: Campaign): string {
  if (!campaign.learningNotes?.length) return '';
  return `<div class="card"><div class="card-title">🧠 What Marketing OS Applied From Your Feedback</div>
    ${campaign.learningNotes.map((n) => `<div class="learning-note">${escapeHtml(n)}</div>`).join('')}
    <p class="campaign-meta" style="margin-top:10px;">These adjustments came from your own past reviews and edits — shown so behavior never changes silently.</p>
  </div>`;
}

/** Founder edits (M4 §3) — the AI original is kept alongside the founder's version, never discarded. */
function editsCard(campaign: Campaign): string {
  if (!campaign.edits?.length) return '';
  return `<div class="card"><div class="card-title">✏️ Your Edits</div>
    ${campaign.edits
      .map((e) => {
        const pct = e.original.length > 0 ? Math.round((e.deltaChars / e.original.length) * 100) : 0;
        return `<div class="asset-block">
          <div class="asset-label">${escapeHtml(e.field)} · ${pct >= 0 ? '+' : ''}${pct}% (${e.original.length} → ${e.edited.length} chars) · ${escapeHtml(new Date(e.editedAt).toLocaleString())}</div>
          ${e.reasons.length ? `<div class="chip-grid">${e.reasons.map((r) => `<span class="chip">${escapeHtml(r)}</span>`).join('')}</div>` : ''}
          <div class="asset-label" style="margin-top:8px;">Your version</div><div class="asset-body">${escapeHtml(e.edited)}</div>
          <div class="asset-label" style="margin-top:8px;">Marketing OS original (kept)</div><div class="asset-body" style="opacity:0.7;">${escapeHtml(e.original)}</div>
        </div>`;
      })
      .join('')}
  </div>`;
}

/** The unified /campaign/:id page — live progress while running, full Campaign Detail once terminal. */
export function renderCampaignPage(campaign: Campaign): string {
  const running = campaign.status === 'running';

  // Same scoped client-side JS exception as /morning's staleness poll (see
  // render.ts) — inert if opened with no server behind it. Patches step
  // rows in place while running; on ANY terminal status it reloads once,
  // which lands the founder on the full detail view automatically.
  const pollScript = running
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
          var icons = { pending: '○', running: '◌', complete: '✓', failed: '✕', skipped: '—' };
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

  // While running: the checklist is the page. Once terminal: the checklist
  // collapses into a compact record and the generated sections take over.
  const detailHtml = running
    ? ''
    : `
  ${scoreCard(campaign)}
  ${learningAppliedCard(campaign)}
  ${briefCard(campaign)}
  ${researchCard(campaign)}
  ${contentCard(campaign, campaign.status === 'complete')}
  ${videoCard(campaign)}
  ${qaCard(campaign, campaign.status === 'complete')}
  ${editsCard(campaign)}
  ${campaign.review ? savedReviewCard(campaign) : campaign.status === 'complete' ? reviewFormCard(campaign) : ''}
  ${lessonsCard(campaign)}
  ${
    campaign.status === 'complete'
      ? `<div class="card"><div class="card-title">🗂 Also available on the tabs</div><div class="tab-links"><a href="/research">Research</a><a href="/content">Content</a><a href="/video">Video</a><a href="/publish">Publish</a></div></div>`
      : ''
  }`;

  const bodyHtml = `
  <a class="back" href="/campaigns" style="display:inline-block;font-size:13px;color:var(--teal);text-decoration:none;font-weight:600;margin-bottom:16px;">← Campaigns</a>
  <div class="campaign-header">
    <h1>${escapeHtml(campaign.title)}</h1>
    <div class="campaign-meta">Campaign · created ${escapeHtml(new Date(campaign.createdAt).toLocaleString())}</div>
  </div>
  ${statusBanner(campaign)}
  <div class="card"><div class="card-title">🏢 Departments</div>${stepsChecklist(campaign)}</div>
  ${detailHtml}
  `;

  return pageShell({ title: 'Campaign', bodyHtml, extraHeadHtml: CAMPAIGN_STYLE + pollScript });
}

/** The Campaigns dashboard (M3 §9) — the Campaign is the primary object of Marketing OS; this is where every generated campaign lives, newest first. */
export function renderCampaignsPage(campaigns: Campaign[]): string {
  const STATUS_LABEL: Record<Campaign['status'], string> = {
    running: 'Generating…',
    complete: 'Ready for Review',
    failed: 'Needs attention',
    interrupted: 'Interrupted',
  };

  const cards = campaigns
    .map((c) => {
      const stepsLine = c.steps.map((s) => `${STEP_ICON[s.status]} ${escapeHtml(s.label.split(' ')[0])}`).join(' · ');
      const chips = [
        `<span class="chip">${escapeHtml(STATUS_LABEL[c.status])}</span>`,
        c.score ? `<span class="chip">Score ${c.score.total}/100</span>` : '',
        c.score ? `<span class="chip">Confidence ${c.score.confidencePercent}%</span>` : '',
        c.score ? `<span class="chip ${PRIORITY_CLASS[c.score.priority]}">${escapeHtml(c.score.priority)} priority</span>` : '',
      ]
        .filter(Boolean)
        .join('');
      return `
    <a class="camp-card" href="/campaign/${encodeURIComponent(c.id)}">
      <div class="card">
        <div class="step-label">${escapeHtml(c.title)}</div>
        <div class="campaign-meta">${escapeHtml(new Date(c.createdAt).toLocaleString())}</div>
        <div class="camp-chips">${chips}</div>
        <div class="camp-steps">${stepsLine}</div>
      </div>
    </a>`;
    })
    .join('');

  const bodyHtml = `
  <h1 style="font-size:22px;font-weight:600;margin-bottom:4px;">📦 Campaigns</h1>
  <div class="campaign-meta" style="margin-bottom:20px;">Every campaign Marketing OS has generated, newest first.</div>
  ${campaigns.length ? cards : '<p class="empty">No campaigns yet. Execute one from the Morning Brief\'s Recommended Action, or run the scored top-opportunities batch.</p>'}
  `;

  return pageShell({ title: 'Campaigns', bodyHtml, activeHref: '/campaigns', extraHeadHtml: CAMPAIGN_STYLE });
}

/**
 * The Learning Layer, fully visible (M4 §5/§10/§11). Everything Marketing
 * OS currently believes about the founder, each line with the observations
 * behind it — derived from real reviews and edits, never configured by hand
 * and never inferred from work that was never reviewed.
 */
export function renderLearningPage(learning: FounderLearning): string {
  const prefRows = (items: typeof learning.preferences) =>
    items.map((p) => `<div class="learning-note"><strong>${escapeHtml(p.statement)}</strong><br><span style="color:var(--ink-muted);font-size:13px;">${escapeHtml(p.evidence)}</span></div>`).join('');

  const deptRows = learning.departmentFeedback
    .map((d) => `<div class="rate-row"><div class="rate-name">${escapeHtml(DEPARTMENT_LABEL[d.department])}</div><div>${starsStatic(Math.round(d.averageRating))} <span class="campaign-meta">${d.averageRating}/5 over ${d.ratingCount} review${d.ratingCount === 1 ? '' : 's'}</span></div></div>`)
    .join('');

  const trackRows = learning.trackRecordByKind
    .map(
      (t) =>
        `<div class="rate-row"><div class="rate-name">${escapeHtml(t.kind)}</div><div class="campaign-meta">${t.approvedCount} of ${t.reviewedCount} approved (${Math.round(t.approvalRate * 100)}%)</div></div>`
    )
    .join('');

  const lessonRows = learning.allLessons
    .slice(0, 40)
    .map((l) => `<li>${escapeHtml(l.lesson)} <a href="/campaign/${encodeURIComponent(l.campaignId)}" style="font-size:12px;">${escapeHtml(l.campaignTitle)}</a></li>`)
    .join('');

  const nothingYet = learning.reviewedCampaignCount === 0 && learning.allLessons.length === 0;

  const bodyHtml = `
  <h1 style="font-size:22px;font-weight:600;margin-bottom:4px;">🧠 What Marketing OS Has Learned</h1>
  <div class="campaign-meta" style="margin-bottom:20px;">Derived from your own reviews and edits — ${learning.reviewedCampaignCount} reviewed campaign${learning.reviewedCampaignCount === 1 ? '' : 's'}. Nothing here is configured by hand, and nothing is guessed: every line shows the observations behind it.</div>

  ${
    nothingYet
      ? `<p class="empty">Nothing learned yet. Review a completed campaign and Marketing OS will start building this picture — it needs at least two consistent observations before it treats anything as a preference.</p>`
      : ''
  }

  ${learning.preferences.length ? `<div class="card"><div class="card-title">🎯 Preferences</div>${prefRows(learning.preferences)}</div>` : ''}
  ${learning.avoid.length ? `<div class="card"><div class="card-title">🚫 Avoid</div>${prefRows(learning.avoid)}</div>` : ''}
  ${deptRows ? `<div class="card"><div class="card-title">🏢 Department Feedback</div>${deptRows}</div>` : ''}
  ${trackRows ? `<div class="card"><div class="card-title">📈 Approval Track Record By Opportunity Kind</div>${trackRows}<p class="campaign-meta" style="margin-top:10px;">Feeds the Founder Track Record dimension in opportunity scoring — only once a kind has at least 3 reviewed campaigns.</p></div>` : ''}
  ${lessonRows ? `<div class="card"><div class="card-title">🎓 Campaign Lessons</div><ul class="asset-list">${lessonRows}</ul></div>` : ''}

  <div class="card"><div class="card-title">ℹ️ What isn't here yet</div>
    <p style="font-size:14px;color:var(--ink-soft);">Published-campaign performance (reach, shares, saves, watch time, leads) will appear here once publishing exists and real metrics can be recorded. Marketing OS deliberately learns nothing from unmeasured work — no estimated engagement, no invented performance.</p>
  </div>
  `;
  return pageShell({ title: 'Learning', bodyHtml, activeHref: '/learning', extraHeadHtml: CAMPAIGN_STYLE });
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

export function renderResearchPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Research', '/research', '🔍');
  const bodyHtml = `
  ${campaignContextHeader(campaign, '🔍', 'Research')}
  ${campaign.brief ? block('Objective', campaign.brief.objective) + block('Target Audience', campaign.brief.audience) : '<p class="empty">The Campaign Brief has not been created yet.</p>'}
  ${campaign.research ? '' : '<p class="empty">Research has not completed yet.</p>'}
  ${researchCard(campaign)}
  `;
  return pageShell({ title: 'Research', bodyHtml, activeHref: '/research', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderContentPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Content', '/content', '✍️');
  const bodyHtml = `
  ${campaignContextHeader(campaign, '✍️', 'Content')}
  ${campaign.brief ? block('Core Message', campaign.brief.messaging) + block('Call to Action', campaign.brief.cta) : ''}
  ${campaign.content || campaign.design ? contentCard(campaign) : '<p class="empty">The Writer has not generated content yet.</p>'}
  `;
  return pageShell({ title: 'Content', bodyHtml, activeHref: '/content', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderVideoPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Video', '/video', '🎬');
  const skippedVideo = campaign.steps.some((s) => s.id === 'video' && s.status === 'skipped');
  const bodyHtml = `
  ${campaignContextHeader(campaign, '🎬', 'Video')}
  ${campaign.video ? videoCard(campaign) : skippedVideo ? '<p class="empty">Strategy did not request video formats for this campaign.</p>' : '<p class="empty">The Video Producer has not generated scripts yet.</p>'}
  `;
  return pageShell({ title: 'Video', bodyHtml, activeHref: '/video', extraHeadHtml: CAMPAIGN_STYLE });
}

export function renderPublishPage(campaign: Campaign | null): string {
  if (!campaign) return emptyTab('Publish', '/publish', '📤');
  const bodyHtml = `
  ${campaignContextHeader(campaign, '📤', 'Publish')}
  <div class="status-banner ${campaign.status === 'complete' ? 'status-complete' : 'status-running'}">
    ${campaign.status === 'complete' ? 'Ready for Review — publishing is a separate, founder-approved step and is not part of campaign generation.' : 'This campaign is still generating — nothing to publish yet.'}
  </div>
  ${campaign.qaReport ? qaCard(campaign, campaign.status === 'complete') : '<p class="empty">Brand Guardian has not reviewed this campaign yet.</p>'}
  `;
  return pageShell({ title: 'Publish', bodyHtml, activeHref: '/publish', extraHeadHtml: CAMPAIGN_STYLE });
}
