// Auth seam — originally a stub for the local-only Founder Workspace (M2.9),
// now the real thing (M2.11): founder-server.ts can be deployed and reached
// from the founder's phone, which means every route needs identity.
//
// Two modes, chosen by environment, never guessed:
//
//   LOCAL (default — no MARKETING_OS_REQUIRE_AUTH set): unchanged from
//   before. The server binds loopback only and every request is treated as
//   the founder, because "running this on my own machine" is the same trust
//   boundary as running a CLI command there. Zero behavior change for
//   `npm run founder-ui`.
//
//   AUTHENTICATED (MARKETING_OS_REQUIRE_AUTH=true): every request must
//   carry a valid Supabase Auth access token belonging to the configured
//   founder. This is the mode a deployed instance runs in, and
//   founder-server.ts refuses to bind a non-loopback address without it —
//   see that file's assertSafeExposure().
//
// The token is the SAME session marketing-os.html already establishes when
// the founder signs in on their phone (supabase.auth.signInWithPassword →
// session.access_token). One identity, one login, no second password to
// manage: the page just forwards the token it already holds.
//
// Verification is delegated to Supabase itself (GET /auth/v1/user with the
// token) rather than verifying a JWT signature locally. That's deliberate:
// it needs no JWT secret in this process, and it respects revocation — a
// signed-out or expired session stops working immediately, which local
// signature checking wouldn't catch until the token's own expiry.

import type { IncomingMessage } from 'node:http';
import { readFounderName } from './config.js';

export interface FounderSession {
  founderName: string;
  authenticated: true;
  /** The verified email, when a real token was checked. Absent in local mode. */
  email?: string;
}

/** Thrown for any request that fails authentication. The server maps this to a flat 401 without leaking which check failed. */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** True when this process must authenticate every request. Anything other than an explicit "true" means local mode. */
export function authRequired(): boolean {
  return process.env.MARKETING_OS_REQUIRE_AUTH === 'true';
}

/**
 * The config an authenticated deployment needs. Returns null when any piece
 * is missing, so callers can fail closed with a clear message rather than
 * starting a server that cannot actually verify anyone.
 */
export function authConfig(): { supabaseUrl: string; anonKey: string; founderEmail: string } | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  // The anon key is all that's needed to call /auth/v1/user with a user's
  // own token — deliberately NOT the service-role key, which bypasses RLS
  // and must never be used for request-scoped identity checks.
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const founderEmail = process.env.MARKETING_OS_FOUNDER_EMAIL;
  if (!supabaseUrl || !anonKey || !founderEmail) return null;
  return { supabaseUrl, anonKey, founderEmail };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Verified-token cache, so a polling client doesn't call Supabase on every request. Short TTL: long enough to stop hammering, short enough that a revoked session stops working promptly. */
const VERIFY_CACHE_TTL_MS = 60_000;
const verifiedTokens = new Map<string, { email: string; verifiedAt: number }>();

/**
 * Verifies a Supabase access token and confirms it belongs to the
 * configured founder. Every failure path — no token, rejected token,
 * expired session, a valid user who isn't the founder, Supabase
 * unreachable — throws UnauthorizedError. It never falls back to "allow":
 * an auth check that cannot run must deny.
 */
async function verifyFounderToken(req: IncomingMessage): Promise<{ email: string }> {
  const config = authConfig();
  if (!config) throw new UnauthorizedError('Auth is required but not configured');

  const token = bearerToken(req);
  if (!token) throw new UnauthorizedError('Missing bearer token');

  const cached = verifiedTokens.get(token);
  if (cached && Date.now() - cached.verifiedAt < VERIFY_CACHE_TTL_MS) {
    return { email: cached.email };
  }

  let email: string | undefined;
  try {
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey },
    });
    if (!response.ok) throw new UnauthorizedError('Token rejected by Supabase');
    const user = (await response.json()) as { email?: string };
    email = user.email;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    // Network or parse failure — deny rather than assume.
    throw new UnauthorizedError('Could not verify token');
  }

  if (!email || email.toLowerCase() !== config.founderEmail.toLowerCase()) {
    // A valid Supabase user who isn't the founder is still unauthorized:
    // this project's auth instance may hold other users, and none of them
    // should reach the Founder Workspace.
    throw new UnauthorizedError('Not the founder account');
  }

  verifiedTokens.set(token, { email, verifiedAt: Date.now() });
  // Bounded: this only ever holds the founder's own recent tokens, but a
  // long-running process shouldn't accumulate them indefinitely.
  if (verifiedTokens.size > 50) {
    for (const [key, value] of verifiedTokens) {
      if (Date.now() - value.verifiedAt >= VERIFY_CACHE_TTL_MS) verifiedTokens.delete(key);
    }
  }
  return { email };
}

/**
 * The one place every route reads founder identity from. In local mode this
 * returns the same fixed session it always did; in authenticated mode it
 * verifies the request's token first and throws UnauthorizedError if
 * anything is wrong.
 */
export async function getFounderSession(req: IncomingMessage): Promise<FounderSession> {
  if (!authRequired()) {
    return { founderName: readFounderName(), authenticated: true };
  }
  const { email } = await verifyFounderToken(req);
  return { founderName: readFounderName(), authenticated: true, email };
}
