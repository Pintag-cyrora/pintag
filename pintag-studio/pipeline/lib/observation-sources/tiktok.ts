// TikTok Observation Source — the first real implementation of the
// Observation Source framework (pipeline/lib/observations.ts). Read-only:
// account stats + recent-video performance via TikTok's official Display
// API (Login Kit). No posting, no scheduling — see SETUP.md's TikTok
// section and the M2.2 design discussion for why (Content Posting API is a
// separate product, deliberately untouched here).
//
// Endpoint shapes and OAuth details below are based on TikTok's published
// developer docs as researched for the M2.2 proposal, not hand-verified
// against a live account (no TikTok Developer app exists yet in this
// environment). Re-check field names/response envelopes against
// developers.tiktok.com when the app is actually created — see SETUP.md.
//
// Credentials: TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET (app-level, static,
// env vars — same pattern as every other API credential in this repo).
// Access/refresh tokens are NOT env vars — a 24-hour access-token lifetime
// makes that the wrong shape (see supabase/migrations/0004_observation_sources.sql
// and observation_source_tokens). npm run tiktok:connect performs the
// one-time authorization handshake that populates that table; this file
// refreshes the access token in place on every run that needs it.

import { supabase } from '../supabase.js';
import { readObservationIntelligenceThresholds } from '../config.js';
import type { Observation, ObservationSource, ObservationSourceResult } from '../observations.js';

export const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const TIKTOK_VIDEO_LIST_URL = 'https://open.tiktokapis.com/v2/video/list/';

// Scopes requested: account stats + this account's own recent videos. Both
// read-only; no posting scope is requested since publishing is explicitly
// out of scope this milestone.
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.stats', 'video.list'];

/**
 * The one canonical redirect URI for Marketing OS's TikTok connection —
 * chosen, not configurable, so there's nothing for a founder to invent or
 * get wrong (M2.5 follow-up: this used to be a blank env var with no
 * documented value, which made setup genuinely impossible without reading
 * source code).
 *
 * Verified against TikTok's published Login Kit requirements: "Desktop"
 * app types (the right type for a local CLI tool like this — not "Web")
 * allow `http://` loopback (`localhost`/`127.0.0.1`) redirect URIs with a
 * port number; "Web" app types require a real https:// domain, which this
 * tool deliberately avoids needing. Nothing needs to actually listen on
 * this port — tiktok-connect.ts never binds it, it's just the value
 * registered with TikTok and echoed back in the browser's address bar for
 * the founder to copy from, same as before.
 */
export const CANONICAL_TIKTOK_REDIRECT_URI = 'http://127.0.0.1:4322/callback';

const ORG_ID = 'pintag';
const SOURCE_NAME = 'tiktok';

// How many of the account's most recent videos to fetch per run. Small and
// fixed — this is a daily narrative input, not an analytics export.
const RECENT_VIDEO_COUNT = 10;
// Of those, how many "most notable" (biggest deviation from the recent
// average, either direction) become their own Observation — same "cap and
// protect the reader's time" discipline as the CEO Workspace's Needs Your
// Attention section.
const NOTABLE_VIDEO_LIMIT = 3;

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}

async function loadStoredToken(): Promise<StoredToken | null> {
  const { data, error } = await supabase
    .from('observation_source_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('org_id', ORG_ID)
    .eq('source', SOURCE_NAME)
    .maybeSingle();
  if (error || !data) return null;
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at };
}

/** Shared by tiktok-connect.ts (after the initial authorization-code exchange) and refreshAccessToken() below (after a refresh) — one write path for this table. */
export async function storeToken(accessToken: string, refreshToken: string | null, expiresInSeconds: number): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  await supabase.from('observation_source_tokens').upsert(
    { org_id: ORG_ID, source: SOURCE_NAME, access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, updated_at: new Date().toISOString() },
    { onConflict: 'org_id,source' }
  );
}

/** The initial authorization-code -> token exchange, called once by tiktok-connect.ts. Exported here so both the one-time setup CLI and this file's own refresh logic share one client/secret-reading path. */
/** Shows enough of a credential to visually confirm it's the right one, without printing it in full to a terminal/log. */
function maskCredential(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

export async function exchangeCodeForToken(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set.');

  const requestBody = {
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  // Debug logging (M2.5 follow-up — real PKCE failure reported). Every
  // field actually sent, with only the two real secrets masked — code and
  // code_verifier are shown in full since they're exactly what's under
  // investigation and are single-use/short-lived regardless.
  console.log('--- Token request (POST ' + TIKTOK_TOKEN_URL + ') ---');
  console.log(`  client_key:    ${maskCredential(requestBody.client_key)}`);
  console.log(`  client_secret: ${maskCredential(requestBody.client_secret)}`);
  console.log(`  code:          ${requestBody.code}`);
  console.log(`  grant_type:    ${requestBody.grant_type}`);
  console.log(`  redirect_uri:  ${requestBody.redirect_uri}`);
  console.log(`  code_verifier: ${requestBody.code_verifier} (length ${requestBody.code_verifier.length})`);
  console.log('---------------------------------------------');

  const res = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(requestBody),
  });

  // Read as text first, always — so the complete raw body is on record
  // even if it isn't valid JSON or has fields the code below doesn't
  // already know to look for.
  const rawBody = await res.text();
  console.log(`--- Token response (HTTP ${res.status}) ---`);
  console.log(rawBody);
  console.log('--------------------------------------');

  let json: any;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error(`TikTok token exchange failed: HTTP ${res.status}, non-JSON response: ${rawBody}`);
  }
  if (!res.ok || json.error) throw new Error(`TikTok token exchange failed: ${json.error_description ?? json.error ?? res.statusText}`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

async function refreshAccessToken(refreshToken: string): Promise<StoredToken> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set.');

  const res = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`TikTok token refresh failed: ${json.error_description ?? json.error ?? res.statusText}`);

  await storeToken(json.access_token, json.refresh_token ?? refreshToken, json.expires_in);
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? refreshToken, expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString() };
}

/** Loads the stored token, refreshing first if it's expired or expiring within the next 5 minutes (safety margin for the API calls that follow). */
async function getValidAccessToken(): Promise<string> {
  const stored = await loadStoredToken();
  if (!stored) throw new Error("TikTok isn't connected yet — run `npm run tiktok:connect`.");

  const expiresInMs = new Date(stored.expiresAt).getTime() - Date.now();
  if (expiresInMs > 5 * 60 * 1000) return stored.accessToken;

  if (!stored.refreshToken) throw new Error('TikTok access token expired and no refresh token is on record — run `npm run tiktok:connect` again.');
  const refreshed = await refreshAccessToken(stored.refreshToken);
  return refreshed.accessToken;
}

interface TikTokUserInfo {
  follower_count: number;
  following_count: number;
  likes_count: number;
  video_count: number;
}

async function fetchUserInfo(accessToken: string): Promise<TikTokUserInfo> {
  const url = new URL(TIKTOK_USER_INFO_URL);
  url.searchParams.set('fields', 'follower_count,following_count,likes_count,video_count');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok || json.error?.code !== 'ok') throw new Error(`TikTok user/info failed: ${json.error?.message ?? res.statusText}`);
  return json.data.user;
}

interface TikTokVideo {
  id: string;
  title: string;
  create_time: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
}

async function fetchRecentVideos(accessToken: string): Promise<TikTokVideo[]> {
  const url = new URL(TIKTOK_VIDEO_LIST_URL);
  url.searchParams.set('fields', 'id,title,create_time,view_count,like_count,comment_count,share_count');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_count: RECENT_VIDEO_COUNT }),
  });
  const json = await res.json();
  if (!res.ok || json.error?.code !== 'ok') throw new Error(`TikTok video/list failed: ${json.error?.message ?? res.statusText}`);
  return json.data.videos ?? [];
}

/**
 * Turns this run's raw account + video data into Observations, computing
 * "why it matters" purely from facts available within this same call — no
 * persisted history (see observations.ts's header note). Account-level
 * growth ("+18 followers since yesterday") would need a stored baseline to
 * claim honestly; without one, account_snapshot reports today's standing as
 * context rather than inventing a trend. Video performance can honestly
 * compare each video against the average of the others fetched in the same
 * call, which needs no persistence at all.
 */
export function buildObservations(user: TikTokUserInfo, videos: TikTokVideo[], observedAt: string): Observation[] {
  const observations: Observation[] = [];

  observations.push({
    id: `tiktok-account-snapshot-${observedAt.slice(0, 10)}`,
    source: 'tiktok',
    kind: 'account_snapshot',
    observedAt,
    whatHappened: `Your TikTok has ${user.follower_count.toLocaleString()} followers and ${user.video_count} videos published.`,
    whyItMatters: "Useful context for interpreting the video performance below — Marketing OS doesn't yet track day-over-day change for this metric, so this is today's standing, not a trend.",
    evidence: [`${user.follower_count.toLocaleString()} followers`, `${user.likes_count.toLocaleString()} total likes`, `${user.video_count} videos total`],
    data: { ...user },
  });

  if (videos.length > 1) {
    const withAverage = videos.map((v) => {
      const others = videos.filter((o) => o.id !== v.id);
      const avgViews = others.reduce((sum, o) => sum + o.view_count, 0) / others.length;
      return { video: v, avgViews, ratio: avgViews > 0 ? v.view_count / avgViews : 1 };
    });

    const mostNotable = [...withAverage].sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1)).slice(0, NOTABLE_VIDEO_LIMIT);

    // Read once here, not per-video — and from the same function
    // observation-intelligence.ts reads, so this prose and that routing
    // decision can never disagree about what counts as "significant."
    const { outperformRatio, underperformRatio } = readObservationIntelligenceThresholds();

    for (const { video, avgViews, ratio } of mostNotable) {
      const whyItMatters =
        ratio >= outperformRatio
          ? 'This significantly outperformed your recent average — worth understanding what worked.'
          : ratio <= underperformRatio
            ? "This underperformed your recent average — may be worth reviewing what didn't land."
            : 'This performed in line with your recent average.';

      observations.push({
        id: `tiktok-video-${video.id}`,
        source: 'tiktok',
        kind: 'video_performance',
        observedAt,
        occurredAt: new Date(video.create_time * 1000).toISOString(),
        whatHappened: `Your video "${video.title || video.id}" reached ${video.view_count.toLocaleString()} views.`,
        whyItMatters,
        evidence: [
          `${video.view_count.toLocaleString()} views (recent average: ${Math.round(avgViews).toLocaleString()})`,
          `${video.like_count.toLocaleString()} likes`,
          `${video.comment_count.toLocaleString()} comments`,
          `${video.share_count.toLocaleString()} shares`,
        ],
        // ratio/avgViews are real numbers, not re-derivable from evidence's
        // prose — this is what lets observation-intelligence.ts classify on
        // real data instead of parsing generated sentences.
        data: { ...video, ratio, avgViews },
      });
    }
  }

  return observations;
}

async function observe(): Promise<ObservationSourceResult> {
  try {
    const accessToken = await getValidAccessToken();
    const [user, videos] = await Promise.all([fetchUserInfo(accessToken), fetchRecentVideos(accessToken)]);
    return { available: true, observations: buildObservations(user, videos, new Date().toISOString()) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { available: false, observations: [], error: message };
  }
}

export const tiktokObservationSource: ObservationSource = {
  name: 'tiktok',
  isConfigured: () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
  observe,
};
