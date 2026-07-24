// Pure formatting/classification helpers shared by generate.ts and
// kpis.ts. These belong in the service layer, not a renderer — per the
// "Services -> Canonical Structured Data -> Renderers" principle,
// classification and relative-time labels are business-logic-adjacent
// decisions ("is this too early to judge", "how should this be phrased")
// that must be made once, at generation time, and stored as plain strings
// on MorningBrief. Renderers only ever read the result.

/** "3 hours" / "2.0 days" / "less than an hour" — bare relative-time span, no "ago" suffix (callers append it where the phrasing needs it, e.g. "3 hours ago" vs. "in 3 hours"). */
export function formatRelativeSpan(iso: string, now: number): string {
  const ageHours = (now - new Date(iso).getTime()) / 3_600_000;
  if (ageHours < 1) return 'less than an hour';
  return ageHours < 24 ? `${Math.round(ageHours)} hour${Math.round(ageHours) === 1 ? '' : 's'}` : `${(ageHours / 24).toFixed(1)} days`;
}

/** "3 hours ago" / "2.0 days ago" — used for department last-run/last-success timestamps. */
export function formatRelativeTime(iso: string, now: number): string {
  return `${formatRelativeSpan(iso, now)} ago`;
}

/** "N views in N hours/days" when the source gives us a view count (TikTok does); a generic age-only fallback otherwise, so a future non-video source degrades honestly instead of assuming "views" is universal vocabulary. */
export function formatRecentActivityStat(data: Record<string, unknown>, ageSpan: string): string {
  const viewCount = typeof data.view_count === 'number' ? data.view_count : undefined;
  return viewCount !== undefined ? `${viewCount.toLocaleString()} views in ${ageSpan}` : `Observed ${ageSpan} ago`;
}

/**
 * Hedged, descriptive framing for a single recent observation, never a
 * confident claim the way Pattern Detection's routing is. Reads the same
 * ratio Observation Intelligence itself reads (data.ratio, when present) so
 * the two views can't contradict each other's numbers, only differ in what
 * they're answering.
 */
export function classifyRecentActivity(data: Record<string, unknown>, ageHours: number, minAgeHours: number, outperformRatio: number, underperformRatio: number): string {
  if (ageHours < minAgeHours) return 'Too early to judge — Marketing OS will continue monitoring.';
  const ratio = typeof data.ratio === 'number' ? data.ratio : undefined;
  if (ratio === undefined) return 'Still gathering data on this.';
  if (ratio >= outperformRatio) return 'Early performance is well above your recent baseline — showing early promise.';
  if (ratio <= underperformRatio) return 'Early performance is below your recent baseline so far — too early to draw a conclusion.';
  return 'Early performance is in line with your recent baseline so far.';
}
