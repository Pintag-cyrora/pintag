// Report Validator — the layer between Gemini's narrative output and what
// actually gets persisted. Two independent checks, both purely mechanical
// (no AI, no judgment calls):
//
//  1. Direction contradiction: does the narrative's own wording agree with
//     the direction the deterministic data actually shows? ("Returned to
//     baseline" next to a KPI reading "up 1504%" is exactly the impossible
//     combination the product spec calls out.)
//  2. Number grounding: does every percentage the narrative states actually
//     appear somewhere in the data it was given? A number that doesn't
//     trace back to evidence/trend/metrics is an invented number, which
//     the whole pipeline exists to prevent.
//
// Neither check understands English prose in any deep sense — both are
// keyword/regex-based on purpose. That's a deliberate, disclosed
// limitation (see validateReportContent's own comment): a cheap, reliable
// mechanical check that catches the specific failure modes named in the
// spec beats an expensive, unreliable "ask another AI to check the AI"
// step. False negatives (a subtler contradiction slipping through) are
// possible; false positives are guarded against by only flagging strong,
// unambiguous keyword clashes (see UP_WORDS/DOWN_WORDS/STABLE_WORDS).
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

const UP_WORDS = ['increase', 'increasing', 'increased', 'up ', 'spike', 'spiked', 'surge', 'surged', 'jump', 'jumped', 'grew', 'growth', 'rose', 'rising', 'higher', 'climb', 'climbed', 'soar', 'soared'];
const DOWN_WORDS = ['decrease', 'decreasing', 'decreased', 'down ', 'decline', 'declined', 'declining', 'drop', 'dropped', 'fell', 'falling', 'plunge', 'plunged', 'fewer', 'lower', 'slump', 'slumped'];
const STABLE_WORDS = ['stable', 'stability', 'baseline', 'back to normal', 'returned to normal', 'no change', 'unchanged', 'flat', 'steady', 'consistent with', 'normal range', 'within normal', 'nothing notable', 'no significant'];

function countKeywords(text, words) {
  const lower = text.toLowerCase();
  return words.reduce((n, w) => n + (lower.split(w).length - 1), 0);
}

// Extracts the Executive Summary + Biggest Story sections only — a report
// legitimately says "stable" about one metric in "Product Insights" while
// its Biggest Story is a real spike elsewhere; only the headline sections
// need to agree with the single most significant thing that happened.
function headlineSections(bodyMarkdown, executiveSummary) {
  const parts = [executiveSummary || ''];
  const bm = bodyMarkdown || '';
  const bigStoryMatch = bm.match(/##\s*Biggest Story\s*\n([\s\S]*?)(?=\n##|\n#|$)/i);
  if (bigStoryMatch) parts.push(bigStoryMatch[1]);
  else {
    // Weekly/Monthly have no "Biggest Story" heading -- fall back to the
    // first section after the Executive Summary, which plays the same role.
    const firstSection = bm.match(/^#\s*Executive Summary\s*\n([\s\S]*?)(?=\n##|$)/im);
    if (firstSection) parts.push(firstSection[1]);
  }
  return parts.join('\n');
}

// The single most significant thing that actually happened, per the
// deterministic Insight Engine output already ranked by priorityScore —
// composed.new_insights/continuing_insights are already sorted/selected
// upstream (report-composer.js), so the first new-or-continuing insight
// (if any) IS the biggest story. Returns null when there's genuinely
// nothing (a quiet period never reaches this validator at all — see
// index.ts — but a non-quiet period with only resolved insights has no
// "current" direction to check against).
function biggestStoryDirection(composed) {
  const candidate = composed.new_insights[0] || composed.continuing_insights[0];
  if (!candidate || !candidate.evidence || typeof candidate.evidence.z !== 'number') return null;
  return { direction: candidate.evidence.direction, absZ: Math.abs(candidate.evidence.z), title: candidate.title };
}

// Check 1: direction contradiction. If the biggest story is a real,
// strongly-significant move (|z| large enough that "stable/baseline"
// language would be simply false) but the headline sections use
// stability language WITHOUT also using direction language, that's the
// exact "Returned to baseline" vs "up 1504%" impossible combination.
function checkDirectionContradiction(bodyMarkdown, executiveSummary, composed) {
  const story = biggestStoryDirection(composed);
  if (!story) return null;
  // Only check when the anomaly is unambiguous (|z| >= 2.5, i.e. at least
  // "high" severity per severityFromZ) -- a borderline |z|~1.5 finding
  // legitimately might get hedged, cautious language, which isn't a
  // contradiction.
  if (story.absZ < 2.5) return null;

  const text = headlineSections(bodyMarkdown, executiveSummary);
  const stableCount = countKeywords(text, STABLE_WORDS);
  if (stableCount === 0) return null; // no stability language at all -- nothing to contradict

  const directionWords = story.direction === 'up' ? UP_WORDS : DOWN_WORDS;
  const directionCount = countKeywords(text, directionWords);
  if (directionCount > 0) return null; // mentions both -- e.g. "up sharply before stabilizing" is a legitimate narrative, not a contradiction

  return `Headline/Biggest-Story language says "${STABLE_WORDS.find((w) => text.toLowerCase().includes(w))}" but the deterministic data shows a significant ${story.direction === 'up' ? 'increase' : 'decrease'} (${story.title}, |z|=${story.absZ.toFixed(1)}) with no corresponding direction language in the same section.`;
}

// Collect every number that legitimately appears somewhere in what Gemini
// was given -- rounded to the nearest integer, since that's the precision
// a narrative would plausibly restate a number at. Sourced from: every
// insight's evidence (today/mean/z-derived percentage), the trend
// calculator's change_vs_* percentages, and raw scalar metric values
// themselves (a narrative citing "45 searches" is citing a real count, not
// a percentage, but should still be groundable).
function collectKnownNumbers(composed, trends, rawMetricsSummary) {
  const known = new Set();
  const add = (n) => { if (typeof n === 'number' && !Number.isNaN(n)) known.add(Math.round(n)); };

  [...composed.new_insights, ...composed.continuing_insights, ...composed.resolved_insights].forEach((i) => {
    const e = i.evidence || {};
    add(e.today); add(e.mean); add(e.stddev);
    if (typeof e.today === 'number' && typeof e.mean === 'number' && e.mean !== 0) {
      add(Math.round(((e.today - e.mean) / e.mean) * 100));
    }
  });

  Object.values(trends || {}).forEach((t) => {
    add(t.today); add(t.yesterday); add(t.avg_7d); add(t.avg_30d);
    add(t.change_vs_yesterday); add(t.change_vs_7d); add(t.change_vs_30d);
  });

  // Flat scalar values from the raw metrics summary -- a narrative citing
  // a plain count (not a percentage) should still be able to ground it. A
  // value strictly between -1 and 1 is very likely a stored ratio (e.g.
  // listing_ctr: 0.084) that a narrative would naturally restate as a
  // percentage ("8%"), so both the raw fraction and its ×100 form are
  // grounded -- otherwise every legitimate CTR/rate citation would
  // false-positive as "invented."
  (function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    Object.values(obj).forEach((v) => {
      if (typeof v === 'number') {
        add(v);
        if (v > -1 && v < 1) add(v * 100);
      } else if (v && typeof v === 'object') walk(v);
    });
  })(rawMetricsSummary);

  return known;
}

// Check 2: number grounding. Extracts every percentage token from the
// headline sections and confirms each is within rounding tolerance (±1,
// since Gemini may round differently than this module does) of some
// number it was actually given. A percentage that grounds to nothing is
// flagged as a likely invented statistic.
function checkNumberGrounding(bodyMarkdown, executiveSummary, composed, trends, rawMetricsSummary) {
  const text = headlineSections(bodyMarkdown, executiveSummary);
  const matches = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s?%/g)].map((m) => Math.round(parseFloat(m[1])));
  if (!matches.length) return null;

  const known = collectKnownNumbers(composed, trends, rawMetricsSummary);
  const ungrounded = matches.filter((n) => {
    for (let d = -1; d <= 1; d++) if (known.has(n + d)) return false;
    return true;
  });
  if (!ungrounded.length) return null;

  return `Narrative states percentage(s) ${[...new Set(ungrounded)].join('%, ')}% that do not correspond to any figure in the evidence, trend analysis, or raw metrics provided.`;
}

// validateReportContent — runs both checks, returns a plain issues list
// (empty = passed). Called on Gemini's parsed output only; the
// deterministic quiet-day/fallback paths never reach this (they're
// correct by construction, nothing to validate).
export function validateReportContent(gemini, composed, trends, rawMetricsSummary) {
  const issues = [];
  const bm = gemini && gemini.body_markdown;
  const es = gemini && gemini.executive_summary;

  const dirIssue = checkDirectionContradiction(bm, es, composed);
  if (dirIssue) issues.push(dirIssue);

  const numIssue = checkNumberGrounding(bm, es, composed, trends, rawMetricsSummary);
  if (numIssue) issues.push(numIssue);

  return { ok: issues.length === 0, issues };
}

// The deterministic fallback used when Gemini's narrative fails validation
// twice (once on the original prompt, once on a corrective retry) — never
// publish a report the pipeline itself knows contains a contradiction or
// an invented number. Presents the same verified insight/trend data as a
// plain list instead of prose, clearly labeled so staff know why.
export function buildValidationFallbackReport(reportType, period, composed) {
  const labelByType = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  const label = labelByType[reportType] || reportType;
  const periodLabel = period.start === period.end ? period.start : `${period.start} to ${period.end}`;
  const lines = [];
  const section = (title, arr) => {
    if (!arr.length) return;
    lines.push(`## ${title}`);
    arr.forEach((i) => lines.push(`- ${i.title}${i.summary ? ` — ${i.summary}` : ''}`));
  };
  section('New', composed.new_insights);
  section('Continuing', composed.continuing_insights);
  section('Resolved', composed.resolved_insights);

  const summary = `AI narrative validation failed for ${periodLabel} — showing verified data only, without AI-written prose.`;
  return {
    title: `${label} report: verified data only (${periodLabel})`,
    executive_summary: summary,
    body_markdown: `# Executive Summary\n${summary}\n\n${lines.join('\n')}`,
    mentioned_districts: [],
    mentioned_property_types: [],
  };
}
