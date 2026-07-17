// Period-bucketing helpers — merge N days of intelligence_daily_metrics
// output into one combined period snapshot, for Weekly/Monthly reports.
// Plain JS for the same dual-runtime (Deno + node unit tests) reason as
// insight-engine.js.
//
// Disclosed approximation: `sessions_total` is summed across days, which
// can double-count a session that returns on more than one day within the
// period (a real distinct-session-across-the-whole-period count would
// need its own SQL query, not a sum of daily distinct-session counts).
// Acceptable for a v1 weekly/monthly "roughly how much traffic" figure;
// flagged here rather than silently presented as exact.

function sumObjects(objs) {
  const out = {};
  objs.forEach((obj) => {
    Object.entries(obj || {}).forEach(([k, v]) => {
      out[k] = (out[k] || 0) + (typeof v === 'number' ? v : 0);
    });
  });
  return out;
}

function mergePropertyLists(dailyLists, valueKey) {
  // dailyLists: array of arrays of {property_id, title, [valueKey]}
  const byProperty = new Map();
  dailyLists.forEach((list) => {
    (list || []).forEach((row) => {
      const cur = byProperty.get(row.property_id) || { property_id: row.property_id, title: row.title, [valueKey]: 0 };
      cur[valueKey] += row[valueKey] || 0;
      byProperty.set(row.property_id, cur);
    });
  });
  return Array.from(byProperty.values()).sort((a, b) => b[valueKey] - a[valueKey]);
}

function mergeCtrLists(dailyLists) {
  const byProperty = new Map();
  dailyLists.forEach((list) => {
    (list || []).forEach((row) => {
      const cur = byProperty.get(row.property_id) || { property_id: row.property_id, title: row.title, impressions: 0, clicks: 0 };
      cur.impressions += row.impressions || 0;
      cur.clicks += row.clicks || 0;
      byProperty.set(row.property_id, cur);
    });
  });
  return Array.from(byProperty.values())
    .filter((r) => r.impressions >= 5)
    .map((r) => ({ ...r, ctr: r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.ctr - a.ctr);
}

export function sumMetrics(dailySnapshots) {
  const all = dailySnapshots.map((s) => s.metrics);
  const impressions = all.reduce((a, m) => a + (m.listing_impressions || 0), 0);
  const clicks = all.reduce((a, m) => a + (m.listing_clicks || 0), 0);
  const views = all.reduce((a, m) => a + (m.listing_views || 0), 0);
  const sessionsTotal = all.reduce((a, m) => a + (m.sessions_total || 0), 0);

  return {
    search: {
      total: all.reduce((a, m) => a + (m.search.total || 0), 0),
      zero_result: all.reduce((a, m) => a + (m.search.zero_result || 0), 0),
      by_district: sumObjects(all.map((m) => m.search.by_district)),
      by_property_type: sumObjects(all.map((m) => m.search.by_property_type)),
      by_transaction_type: sumObjects(all.map((m) => m.search.by_transaction_type)),
    },
    listing_impressions: impressions,
    listing_clicks: clicks,
    listing_views: views,
    listing_ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 1000 : 0,
    views_by_district: sumObjects(all.map((m) => m.views_by_district)),
    views_by_property_type: sumObjects(all.map((m) => m.views_by_property_type)),
    whatsapp_clicks: all.reduce((a, m) => a + (m.whatsapp_clicks || 0), 0),
    call_clicks: all.reduce((a, m) => a + (m.call_clicks || 0), 0),
    leads_created: all.reduce((a, m) => a + (m.leads_created || 0), 0),
    leads_closed: all.reduce((a, m) => a + (m.leads_closed || 0), 0),
    leads_lost: all.reduce((a, m) => a + (m.leads_lost || 0), 0),
    sessions_total: sessionsTotal, // see disclosed approximation note above
    avg_listings_viewed_per_session: sessionsTotal > 0 ? Math.round((views / sessionsTotal) * 100) / 100 : 0,
    gallery_events: all.reduce((a, m) => a + (m.gallery_events || 0), 0),
    share_events: all.reduce((a, m) => a + (m.share_events || 0), 0),
    favorite_events: all.reduce((a, m) => a + (m.favorite_events || 0), 0),
    map_events: all.reduce((a, m) => a + (m.map_events || 0), 0),
    filter_usage: sumObjects(all.map((m) => m.filter_usage)),
    ui_element_counts: sumObjects(all.map((m) => m.ui_element_counts)),
    top_listings_by_views: mergePropertyLists(all.map((m) => m.top_listings_by_views), 'views').slice(0, 10),
    top_listings_by_ctr: mergeCtrLists(all.map((m) => m.top_listings_by_ctr)).slice(0, 10),
    impressions_no_leads: mergePropertyLists(all.map((m) => m.impressions_no_leads), 'impressions').slice(0, 10),
  };
}

// Buckets a flat array of {day, metrics} (oldest first) into consecutive
// N-day windows, most recent window last. Used to turn ~9 weeks of daily
// rows into ~9 weekly snapshots for Weekly reports, or ~13 months of daily
// rows into ~13 monthly snapshots for Monthly reports — the caller decides
// the grouping key (see groupByWeek/groupByMonth below); this just merges.
export function bucketSnapshots(dailySnapshots, groupKeyFn) {
  const groups = new Map();
  dailySnapshots.forEach((s) => {
    const key = groupKeyFn(s.day);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  return Array.from(groups.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, snaps]) => ({
      periodKey: key,
      periodStart: snaps[0].day,
      periodEnd: snaps[snaps.length - 1].day,
      metrics: sumMetrics(snaps),
    }));
}

// ISO week key, e.g. '2026-W29' — Monday-start weeks.
export function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}
