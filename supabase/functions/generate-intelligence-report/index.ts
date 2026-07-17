// generate-intelligence-report — orchestrates the three-layer Intelligence
// pipeline: Metrics Engine (SQL) -> Insight Engine (deterministic TS) ->
// Report Composer (TS) -> Gemini (narration only) -> persisted report.
//
// See the plan doc, "The Intelligence Layer" section, for the full design
// and the rationale for each decision below. In short: Gemini never decides
// what's important — insight-engine.js already did that, deterministically,
// before Gemini ever sees a prompt. Gemini's only job is to explain and
// connect the insights it's handed.
//
// Auth: either a staff JWT (mirrors requireAdmin() in generate-listing-content,
// reused verbatim per the plan's explicit note that modernizing it to
// is_pintag_staff() is an unrelated cleanup) OR the raw service-role key,
// so pg_cron's net.http_post (which has no user session to attach) can
// trigger this unattended every morning.
//
// Writes always use the service-role key, bypassing RLS by design — staff
// only ever gets read access to intelligence_reports/intelligence_insights/
// report_insights via the API, matching every other analytics table.

import { runInsightEngine, priorityScore } from './insight-engine.js';
import { sumMetrics, bucketSnapshots, isoWeekKey, monthKey } from './metrics-utils.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CANONICAL_DISTRICTS = [
  'Chanthabouly', 'Sikhottabong', 'Xaythany', 'Sisattanak',
  'Hadxaifong', 'Saysettha', 'Naxaithong',
];
const CANONICAL_PROPERTY_TYPES = [
  'house', 'townhouse', 'villa', 'apartment', 'condo', 'commercial', 'land',
];

const TRAILING_WINDOW_DAYS = 30;
const MAX_DISCUSSED_INSIGHTS = 8;

// ── Auth ─────────────────────────────────────────────────────────────────
async function requireStaffOrService(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) return 'Server misconfigured';

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return 'Missing auth token';
  const token = auth.slice(7);

  // pg_cron's net.http_post has no user session — it authenticates with the
  // service-role key directly (stored in Supabase Vault, see the plan's
  // scheduling section). Recognize that up front rather than sending it
  // through the /auth/v1/user lookup, which is for real user JWTs only.
  if (token === serviceRoleKey) return null;

  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey },
  });
  if (!r.ok) return 'Invalid token';
  const user = await r.json();
  if (user?.email !== 'admin@pintag.io') return 'Admin only';
  return null;
}

// ── Date helpers ─────────────────────────────────────────────────────────
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return toISODate(d);
}
function yesterdayUTC(): string {
  return addDays(toISODate(new Date()), -1);
}

type ReportType = 'daily' | 'weekly' | 'monthly';

function resolvePeriod(reportType: ReportType, periodEndOverride?: string): { start: string; end: string } {
  if (reportType === 'daily') {
    const end = periodEndOverride || yesterdayUTC();
    return { start: end, end };
  }
  if (reportType === 'weekly') {
    const end = periodEndOverride || yesterdayUTC();
    return { start: addDays(end, -6), end };
  }
  // monthly: normalize to the calendar month containing the reference date
  // (defaults to yesterday, so a run on the 1st reports the month that just
  // ended), full first-to-last-day range.
  const ref = periodEndOverride || yesterdayUTC();
  const refDate = new Date(ref + 'T00:00:00Z');
  const start = toISODate(new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1)));
  const end = toISODate(new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() + 1, 0)));
  return { start, end };
}

// ── Supabase REST helpers (service-role key, bypasses RLS) ─────────────────
class Db {
  constructor(private url: string, private key: string) {}

  private headers(extra?: Record<string, string>) {
    return {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...(extra || {}),
    };
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<any> {
    const r = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`RPC ${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async select(table: string, query: string): Promise<any[]> {
    const r = await fetch(`${this.url}/rest/v1/${table}?${query}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`SELECT ${table} failed: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async insert(table: string, rows: unknown[], returning = true): Promise<any[]> {
    const r = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.headers({ Prefer: returning ? 'return=representation' : 'return=minimal' }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`INSERT ${table} failed: ${r.status} ${await r.text()}`);
    return returning ? r.json() : [];
  }

  async patch(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const r = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH ${table} failed: ${r.status} ${await r.text()}`);
  }
}

// ── Metrics Engine access ───────────────────────────────────────────────
interface DailySnapshot { day: string; metrics: any; }

async function fetchDailyMetrics(db: Db, start: string, end: string): Promise<DailySnapshot[]> {
  const rows = await db.rpc('intelligence_daily_metrics', { p_start: start, p_end: end });
  return rows.map((r: any) => ({ day: r.day, metrics: r.metrics }));
}

async function fetchCurrentSupply(db: Db): Promise<{ byDistrict: Record<string, number>; byType: Record<string, number> }> {
  const rows = await db.select('properties', 'select=district_en,property_type&status=in.(active,available)');
  const byDistrict: Record<string, number> = {};
  const byType: Record<string, number> = {};
  rows.forEach((p: any) => {
    if (p.district_en) byDistrict[p.district_en] = (byDistrict[p.district_en] || 0) + 1;
    if (p.property_type) byType[p.property_type] = (byType[p.property_type] || 0) + 1;
  });
  return { byDistrict, byType };
}

// ── Insight Engine step (daily only) ────────────────────────────────────
async function runDailyInsightSweep(db: Db, today: DailySnapshot, trailing: DailySnapshot[], periodEnd: string) {
  const openInsights = await db.select(
    'intelligence_insights',
    'select=*&resolved_at=is.null'
  );
  const { toInsert, toUpdate, toResolve } = runInsightEngine(today, trailing, openInsights, periodEnd);

  const inserted = toInsert.length ? await db.insert('intelligence_insights', toInsert) : [];
  for (const u of toUpdate) {
    const { id, ...patch } = u;
    await db.patch('intelligence_insights', id, patch);
  }
  for (const id of toResolve) {
    await db.patch('intelligence_insights', id, { resolved_at: new Date().toISOString(), trend: 'resolved' });
  }

  return { inserted, updatedIds: toUpdate.map((u: any) => u.id), resolvedIds: toResolve };
}

// ── Report Composer ──────────────────────────────────────────────────────
// Selects which insights this report discusses and assembles Gemini's
// structured input. Gemini never sees raw database rows — only this.
async function composeReportInput(db: Db, reportType: ReportType, period: { start: string; end: string }, dailySweep?: { inserted: any[]; updatedIds: string[]; resolvedIds: string[] }) {
  let newInsights: any[] = [];
  let continuingInsights: any[] = [];
  let resolvedInsights: any[] = [];

  if (reportType === 'daily' && dailySweep) {
    newInsights = dailySweep.inserted;
    if (dailySweep.updatedIds.length) {
      continuingInsights = await db.select('intelligence_insights', `select=*&id=in.(${dailySweep.updatedIds.join(',')})`);
    }
    if (dailySweep.resolvedIds.length) {
      resolvedInsights = await db.select('intelligence_insights', `select=*&id=in.(${dailySweep.resolvedIds.join(',')})`);
    }
  } else {
    // Weekly/Monthly are pure readers of insight state — no detection here.
    // "New" = opened within this period; "resolved" = resolved within this
    // period; "continuing" = still open, opened before this period, active
    // during it (last_seen falls inside the window).
    newInsights = await db.select(
      'intelligence_insights',
      `select=*&first_seen=gte.${period.start}&first_seen=lte.${period.end}`
    );
    resolvedInsights = await db.select(
      'intelligence_insights',
      `select=*&resolved_at=gte.${period.start}T00:00:00&resolved_at=lte.${period.end}T23:59:59`
    );
    const stillOpen = await db.select(
      'intelligence_insights',
      `select=*&resolved_at=is.null&last_seen=gte.${period.start}`
    );
    const newIds = new Set(newInsights.map((i) => i.id));
    continuingInsights = stillOpen.filter((i: any) => !newIds.has(i.id));
  }

  // Rank by read-time priority; always keep every new/resolved insight
  // regardless of rank (continuity matters more than rank for those), cap
  // the total so reports don't bloat as open insights accumulate.
  const withPriority = (arr: any[]) => arr.map((i) => ({ ...i, _priority: priorityScore(i) }));
  const rankedContinuing = withPriority(continuingInsights).sort((a, b) => b._priority - a._priority);

  const mustKeep = [...newInsights, ...resolvedInsights];
  const remainingSlots = Math.max(0, MAX_DISCUSSED_INSIGHTS - mustKeep.length);
  const discussedContinuing = rankedContinuing.slice(0, remainingSlots);

  return {
    period,
    new_insights: newInsights.map(stripInternal),
    continuing_insights: discussedContinuing.map(stripInternal),
    resolved_insights: resolvedInsights.map(stripInternal),
  };
}

function stripInternal(i: any) {
  const { _priority, ...rest } = i;
  return rest;
}

// ── Gemini prompt construction ──────────────────────────────────────────
function insightSummaryLine(i: any): string {
  const dims = [i.dimension_district, i.dimension_property_type].filter(Boolean).join('/');
  return `- [${i.type}] ${i.title}${dims ? ` (${dims})` : ''} — severity: ${i.severity}, confidence: ${Math.round((i.confidence || 0) * 100)}%, trend: ${i.trend}${i.recommendation ? `, suggested action: ${i.recommendation}` : ''}`;
}

function buildPrompt(reportType: ReportType, composed: any, rawMetricsSummary: any, supply: { byDistrict: Record<string, number>; byType: Record<string, number> } | null) {
  const newBlock = composed.new_insights.length
    ? composed.new_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const continuingBlock = composed.continuing_insights.length
    ? composed.continuing_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const resolvedBlock = composed.resolved_insights.length
    ? composed.resolved_insights.map(insightSummaryLine).join('\n')
    : '(none)';

  const supplyBlock = supply
    ? `\nCURRENT ACTIVE SUPPLY (live snapshot, not historical):\nBy district: ${JSON.stringify(supply.byDistrict)}\nBy property type: ${JSON.stringify(supply.byType)}\n`
    : '';

  const commonRules = `You are writing for Pintag, a real estate marketplace in Vientiane, Laos. You are given a set of insights that deterministic code has ALREADY detected, ranked, and classified as new/continuing/resolved — these are the only findings that exist. Your job is strictly to explain, connect, and narrate them clearly.

Do NOT:
- Discover anomalies yourself
- Decide what's significant
- Invent any statistic, percentage, or number not present in the data below
- State a number without it appearing in the evidence provided

You MAY:
- Explain WHY something might be happening, in plain business terms
- Connect related insights into one narrative (e.g. a demand spike + a supply shortage in the same district becomes one recruiting recommendation)
- Reference the raw metrics summary below for period totals

NEW INSIGHTS (🟢):\n${newBlock}\n
CONTINUING INSIGHTS (🔴):\n${continuingBlock}\n
RESOLVED INSIGHTS (✅):\n${resolvedBlock}
${supplyBlock}
RAW METRICS SUMMARY (period totals, safe to cite verbatim):
${JSON.stringify(rawMetricsSummary)}

Canonical districts: ${CANONICAL_DISTRICTS.join(', ')}. Canonical property types: ${CANONICAL_PROPERTY_TYPES.join(', ')}.`;

  const structureByType: Record<ReportType, string> = {
    daily: `Write a DAILY INTELLIGENCE REPORT, 300-600 words, readable in under two minutes. Natural prose, not a list of statistics. Structure with these markdown headings, in order:
# Executive Summary
## Biggest Story
## Marketplace
## Buyer Behaviour
## Property Performance
## Product Insights
## Opportunities
## AI Recommendations
Skip a section entirely (omit the heading) if there is truly nothing worth saying in it today — do not pad.`,
    weekly: `Write a WEEKLY INTELLIGENCE REPORT. Compare this week to the previous week; highlight TRENDS, not just totals. Structure with these markdown headings:
# Executive Summary
## What Changed This Week
## Continuing Trends
## Resolved This Week
## Recommendations`,
    monthly: `Write a MONTHLY INTELLIGENCE REPORT. Professional executive market summary — should read like a CBRE, JLL or Savills market report, suitable for management or investors, not like raw analytics. Structure with these markdown headings:
# Executive Summary
## Market Overview
## Demand & Supply
## Notable Trends This Month
## Outlook & Recommendations`,
  };

  return `${commonRules}\n\n${structureByType[reportType]}\n\nReturn ONLY valid JSON, no additional text, in this exact format:
{
  "title": "a short descriptive title for this report, max 100 characters",
  "executive_summary": "2-3 sentences, the absolute headline takeaway",
  "body_markdown": "the full report body using the headings above",
  "mentioned_districts": ["array of canonical district names actually discussed"],
  "mentioned_property_types": ["array of canonical property type keys actually discussed"]
}`;
}

async function callGemini(apiKey: string, prompt: string): Promise<any> {
  const RETRY_DELAYS = [2000, 5000, 10000];
  let response!: Response;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (response.ok) break;
    if ((response.status === 429 || response.status === 503) && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    const errText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const geminiData = await response.json();
  const text = geminiData.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
  if (!text) throw new Error('No text content in Gemini response');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from Gemini response');
  return JSON.parse(jsonMatch[0]);
}

// ── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authErr = await requireStaffOrService(req);
  if (authErr) {
    return new Response(JSON.stringify({ error: authErr }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = new Db(supabaseUrl, serviceRoleKey);

  let reportType: ReportType = 'daily';
  let period = { start: '', end: '' };

  try {
    const body = await req.json().catch(() => ({}));
    reportType = (['daily', 'weekly', 'monthly'].includes(body.report_type) ? body.report_type : 'daily') as ReportType;
    period = resolvePeriod(reportType, body.period_end);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured. Add it in Supabase Dashboard → Edge Functions → Manage secrets.');

    // Fetch trailing window + the report's own period in one call: for
    // daily, trailingStart is 30 days before period.start; for weekly/
    // monthly the whole period is fetched day-by-day and bucketed in code
    // (metrics-utils.js), one query shape serving all three granularities.
    const trailingStart = addDays(period.start, -TRAILING_WINDOW_DAYS);
    const allDays = await fetchDailyMetrics(db, trailingStart, period.end);

    const periodDays = allDays.filter((d) => d.day >= period.start && d.day <= period.end);
    const trailingDays = allDays.filter((d) => d.day < period.start);

    let dailySweep: { inserted: any[]; updatedIds: string[]; resolvedIds: string[] } | undefined;
    let rawMetricsSummary: any;
    let supply: { byDistrict: Record<string, number>; byType: Record<string, number> } | null = null;

    if (reportType === 'daily') {
      const today = periodDays[periodDays.length - 1] || { day: period.end, metrics: {} };
      dailySweep = await runDailyInsightSweep(db, today, trailingDays, period.end);
      rawMetricsSummary = today.metrics;
      supply = await fetchCurrentSupply(db);
    } else {
      rawMetricsSummary = sumMetrics(periodDays);
      if (reportType === 'monthly') supply = await fetchCurrentSupply(db);
    }

    const composed = await composeReportInput(db, reportType, period, dailySweep);
    const prompt = buildPrompt(reportType, composed, rawMetricsSummary, supply);
    const gemini = await callGemini(apiKey, prompt);

    const mentionedDistricts = Array.isArray(gemini.mentioned_districts)
      ? gemini.mentioned_districts.filter((d: string) => CANONICAL_DISTRICTS.includes(d))
      : [];
    const mentionedPropertyTypes = Array.isArray(gemini.mentioned_property_types)
      ? gemini.mentioned_property_types.filter((t: string) => CANONICAL_PROPERTY_TYPES.includes(t))
      : [];

    const [report] = await db.insert('intelligence_reports', [{
      report_type: reportType,
      period_start: period.start,
      period_end: period.end,
      status: 'generated',
      title: gemini.title || null,
      executive_summary: gemini.executive_summary || null,
      body_markdown: gemini.body_markdown || null,
      metrics_snapshot: rawMetricsSummary,
      mentioned_districts: mentionedDistricts,
      mentioned_property_types: mentionedPropertyTypes,
      model_used: 'gemini-2.5-flash',
    }]);

    // report_insights links — biggest_story is whichever new/continuing
    // insight ranks highest by read-time priority; everything else
    // discussed gets 'mentioned'. Simple, defensible default; Gemini's own
    // prose is free to weave a richer narrative, but the *link table* only
    // needs "was this insight part of the report," not a precise per-role
    // taxonomy Gemini would have to output correctly every time.
    const candidates = [...composed.new_insights, ...composed.continuing_insights];
    if (candidates.length) {
      const withPriority = candidates.map((i: any) => ({ ...i, _priority: priorityScore(i) }));
      withPriority.sort((a, b) => b._priority - a._priority);
      const biggestStoryId = withPriority[0]?.id;
      const links = [
        ...withPriority.map((i: any) => ({
          report_id: report.id, insight_id: i.id,
          role: i.id === biggestStoryId ? 'biggest_story' : 'mentioned',
        })),
        ...composed.resolved_insights.map((i: any) => ({ report_id: report.id, insight_id: i.id, role: 'mentioned' })),
      ];
      if (links.length) await db.insert('report_insights', links, false);
    }

    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    try {
      await db.insert('intelligence_reports', [{
        report_type: reportType,
        period_start: period.start || toISODate(new Date()),
        period_end: period.end || toISODate(new Date()),
        status: 'failed',
        error_message: message,
      }], false);
    } catch (_) {
      // If even the failure-record insert fails, fall through to the error response below.
    }
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
