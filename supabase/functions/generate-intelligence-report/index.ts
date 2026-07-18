// generate-intelligence-report — orchestrates the three-layer Intelligence
// pipeline: Metrics Engine (SQL) -> Insight Engine (deterministic TS) ->
// Report Composer (TS) -> Gemini (narration only) -> persisted report.
//
// This file is a thin orchestrator. Each layer's actual logic lives in its
// own module: insight-engine.js (detection + lifecycle), report-composer.js
// (what a report discusses + the prompt), gemini-client.js (the one place
// that talks to Gemini). See INTELLIGENCE_ARCHITECTURE.md for the
// invariants this split exists to protect.
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

import { runInsightEngine, DEFAULT_DETECTORS } from './insight-engine.js';
import { dataQualityDetector } from './data-quality-detector.js';
import { duplicateListingDetector } from './duplicate-listing-detector.js';
import { sumMetrics } from './metrics-utils.js';
import {
  composeReportInput, buildPrompt, isQuietPeriod, buildQuietDayReport,
  buildReportInsightLinks, CANONICAL_DISTRICTS, CANONICAL_PROPERTY_TYPES,
} from './report-composer.js';
import { callGemini } from './gemini-client.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TRAILING_WINDOW_DAYS = 30;
// A stale lock (the previous run crashed without releasing it) is
// reclaimable after this long — long enough to cover a real run plus
// retries, short enough that a genuine crash doesn't wedge tomorrow's run.
const SWEEP_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

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

  async patchWhere(table: string, filterQuery: string, patch: Record<string, unknown>, returning = false): Promise<any[]> {
    const r = await fetch(`${this.url}/rest/v1/${table}?${filterQuery}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: returning ? 'return=representation' : 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH ${table} failed: ${r.status} ${await r.text()}`);
    return returning ? r.json() : [];
  }

  async patch(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    await this.patchWhere(table, `id=eq.${id}`, patch, false);
  }

  async delete(table: string, id: string): Promise<void> {
    const r = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    if (!r.ok) throw new Error(`DELETE ${table} failed: ${r.status} ${await r.text()}`);
  }
}

// ── Idempotency ──────────────────────────────────────────────────────────
// A duplicate cron fire (or any accidental double invocation) for a period
// that's already been generated should be a cheap, safe no-op — not a
// second Gemini charge and not a second row. See
// INTELLIGENCE_ARCHITECTURE.md's Database Invariants: the partial unique
// index on intelligence_reports is the actual guarantee; this check is
// what makes the common case return fast and cleanly rather than relying
// on that index to reject it after doing all the work.
async function findExistingReport(db: Db, reportType: ReportType, period: { start: string; end: string }): Promise<any | null> {
  const rows = await db.select(
    'intelligence_reports',
    `report_type=eq.${reportType}&period_start=eq.${period.start}&period_end=eq.${period.end}&status=eq.generated&limit=1`
  );
  return rows[0] || null;
}

// ── Sweep lock ───────────────────────────────────────────────────────────
// Prevents two concurrent daily Insight Engine sweeps from both reading
// "no open insight for key X" before either commits and both inserting —
// which would produce two open insights tracking the same real-world
// condition, breaking the "one insight = one tracked condition" invariant.
//
// A single-row claim table via an atomic PATCH, not a Postgres session-
// level advisory lock: Supabase's REST API is served over a pooled
// connection where consecutive HTTP calls are not guaranteed to land on
// the same underlying database session, so a lock acquired in one request
// and released in another could silently be released by (or held forever
// by) the wrong connection. A row-level UPDATE's WHERE clause is
// re-evaluated under Postgres's own row locking, which is race-safe
// regardless of connection pooling, and needs no matching "same session"
// requirement to release correctly.
async function acquireSweepLock(db: Db): Promise<boolean> {
  const staleBefore = new Date(Date.now() - SWEEP_LOCK_STALE_AFTER_MS).toISOString();
  const rows = await db.patchWhere(
    'intelligence_sweep_lock',
    `id=eq.daily_sweep&or=(locked_at.is.null,locked_at.lt.${encodeURIComponent(staleBefore)})`,
    { locked_at: new Date().toISOString() },
    true
  );
  return rows.length > 0;
}
async function releaseSweepLock(db: Db): Promise<void> {
  await db.patchWhere('intelligence_sweep_lock', 'id=eq.daily_sweep', { locked_at: null }, false);
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

// Fetches the columns data-quality-detector.js's and duplicate-listing-
// detector.js's rule checks need, scoped to actively-shown listings (a
// draft/sold/inactive listing's data quality is not staff's morning
// priority the way a live listing's is). Only the columns each rule
// actually reads — same lean-select convention as fetchCurrentSupply()
// above.
async function fetchDataQualityProperties(db: Db): Promise<any[]> {
  return db.select(
    'properties',
    'select=id,title_en,images,description_en,property_highlight_en,neighborhood_insight_en,' +
    'price_display,district_en,village_en,property_type,created_at,view_count&status=in.(active,available)'
  );
}

// Every property id that has at least one row in `leads` (any status) —
// used only by dataQualityDetector's no_leads rule. A plain Set, built
// once per sweep rather than a per-property query.
async function fetchPropertyIdsWithLeads(db: Db): Promise<Set<string>> {
  const rows = await db.select('leads', 'select=property_id');
  return new Set((rows || []).map((r: any) => r.property_id).filter(Boolean));
}

// ── Insight Engine step (daily only) ────────────────────────────────────
async function runDailyInsightSweep(db: Db, today: DailySnapshot, trailing: DailySnapshot[], periodEnd: string) {
  const openInsights = await db.select(
    'intelligence_insights',
    'select=*&resolved_at=is.null'
  );
  const [properties, propertyIdsWithLeads] = await Promise.all([
    fetchDataQualityProperties(db),
    fetchPropertyIdsWithLeads(db),
  ]);
  const { toInsert, toUpdate, toResolve } = runInsightEngine(
    today, trailing, openInsights, periodEnd,
    [...DEFAULT_DETECTORS, dataQualityDetector, duplicateListingDetector],
    { properties, propertyIdsWithLeads }
  );

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
  let sweepLockHeld = false;

  try {
    const body = await req.json().catch(() => ({}));
    reportType = (['daily', 'weekly', 'monthly'].includes(body.report_type) ? body.report_type : 'daily') as ReportType;
    period = resolvePeriod(reportType, body.period_end);
    const force = body.force === true;

    // Idempotency: a duplicate invocation for an already-generated period
    // either returns the existing report (no force) or replaces it
    // (force — the UI's Regenerate button, and the manual preview
    // workflow's "Generate Again" after Delete). Deleting-then-inserting
    // rather than updating in place keeps this consistent with a plain
    // Delete followed by a fresh Generate, and avoids colliding with the
    // partial unique index on (report_type, period_start, period_end).
    const existing = await findExistingReport(db, reportType, period);
    if (existing) {
      if (!force) {
        return new Response(JSON.stringify(existing), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await db.delete('intelligence_reports', existing.id);
    }

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

      const gotLock = await acquireSweepLock(db);
      if (!gotLock) {
        throw new Error('Another daily Insight Engine sweep is already in progress — skipping this invocation to avoid duplicate insight detection.');
      }
      sweepLockHeld = true;
      try {
        dailySweep = await runDailyInsightSweep(db, today, trailingDays, period.end);
      } finally {
        await releaseSweepLock(db);
        sweepLockHeld = false;
      }

      rawMetricsSummary = today.metrics;
      supply = await fetchCurrentSupply(db);
    } else {
      rawMetricsSummary = sumMetrics(periodDays);
      if (reportType === 'monthly') supply = await fetchCurrentSupply(db);
    }

    const composed = await composeReportInput(db, reportType, period, dailySweep);

    // Quiet period: nothing new/continuing/resolved to discuss. Skip
    // Gemini entirely rather than asking it to write 300-600 words about
    // nothing — saves cost and removes the padding/hallucination risk a
    // near-empty prompt invites. Weekly/Monthly still always narrate,
    // since a wider window summarizing "nothing changed" is itself a
    // legitimate, useful thing to say in an executive-style report.
    let gemini: any;
    let modelUsed: string;
    if (reportType === 'daily' && isQuietPeriod(composed)) {
      gemini = buildQuietDayReport(reportType, period);
      modelUsed = 'deterministic';
    } else {
      const apiKey = Deno.env.get('GEMINI_API_KEY');
      if (!apiKey) throw new Error('GEMINI_API_KEY is not configured. Add it in Supabase Dashboard → Edge Functions → Manage secrets.');
      const prompt = buildPrompt(reportType, composed, rawMetricsSummary, supply);
      gemini = await callGemini(apiKey, prompt);
      modelUsed = 'gemini-2.5-flash';
    }

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
      model_used: modelUsed,
    }]);

    // report_insights links: deduplicated and role-assigned by the Report
    // Composer (buildReportInsightLinks). Wrapped in its own try/catch —
    // the report itself already committed successfully above; a links-
    // table hiccup must never retroactively mislabel a good report as
    // 'failed'. Degrades gracefully: the report still renders, just
    // without NEW/CONTINUING/RESOLVED chips for this one run.
    const links = buildReportInsightLinks(composed).map((l) => ({ report_id: report.id, ...l }));
    if (links.length) {
      try {
        await db.insert('report_insights', links, false);
      } catch (linkErr) {
        console.error('report_insights insert failed (report already saved):', linkErr);
      }
    }

    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (sweepLockHeld) {
      await releaseSweepLock(db).catch(() => {});
    }
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
