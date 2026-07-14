// One-time TikTok authorization handshake (M2.2) — the manual setup step
// that gets a real access_token/refresh_token pair into
// observation_source_tokens so pipeline/lib/observation-sources/tiktok.ts
// can start reporting real observations. Same "human does this once,
// interactively, via a CLI" pattern as knowledge-review.ts / teach.ts.
//
// Run: npm run tiktok:connect
//
// Requires TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET already set (see
// SETUP.md's TikTok section). The redirect URI is NOT something you choose
// — it's CANONICAL_TIKTOK_REDIRECT_URI (see lib/observation-sources/
// tiktok.ts), the one fixed value this whole tool is built around. It does
// not need to be a live, listening server: TikTok redirects the founder's
// browser there with the authorization code in the query string, and the
// founder pastes that URL back here even if the page itself 404s.

import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { TIKTOK_AUTH_URL, TIKTOK_SCOPES, CANONICAL_TIKTOK_REDIRECT_URI, exchangeCodeForToken, storeToken } from './lib/observation-sources/tiktok.js';

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? '' : value.trim();
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function extractCode(pasted: string): string | undefined {
  const trimmed = pasted.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code') ?? undefined;
  } catch {
    // Not a URL — treat the whole thing as the raw code.
    return trimmed;
  }
}

async function main(): Promise<void> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    console.log("I can't connect TikTok yet — TIKTOK_CLIENT_KEY and/or TIKTOK_CLIENT_SECRET aren't set.");
    console.log('');
    console.log('Add them to .env.local (see FIRST_TIME_SETUP.md, or SETUP.md\'s TikTok section for how to get them from developers.tiktok.com).');
    console.log('While testing (before App Review), these must be your Sandbox app\'s own Client Key/Secret —');
    console.log('revealed via the eye icon on the Sandbox app\'s page — not your production app\'s credentials.');
    console.log('TikTok treats these as two separate credential pairs; using the wrong one is rejected as an');
    console.log('invalid client_key even though the OAuth URL itself is otherwise correctly formed.');
    rl.close();
    return;
  }

  // The redirect URI is a fixed constant, not something the founder
  // chooses — but .env.local can still override it (matching every other
  // credential in this tool), so this is a safety net for a stale or
  // hand-edited value, not the primary path. If it's simply unset,
  // .env.example already pre-fills the canonical value, so this only
  // fires for someone who removed or changed that line.
  const redirectUri = process.env.TIKTOK_REDIRECT_URI ?? CANONICAL_TIKTOK_REDIRECT_URI;
  if (redirectUri !== CANONICAL_TIKTOK_REDIRECT_URI) {
    console.log("I can't connect TikTok — TIKTOK_REDIRECT_URI in your .env.local doesn't match the value Marketing OS expects.");
    console.log('');
    console.log(`  Your .env.local has:  ${redirectUri}`);
    console.log(`  It needs to be:       ${CANONICAL_TIKTOK_REDIRECT_URI}`);
    console.log('');
    console.log('Fix TIKTOK_REDIRECT_URI in .env.local to match exactly, then run this again.');
    rl.close();
    return;
  }

  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  const authUrl = new URL(TIKTOK_AUTH_URL);
  authUrl.searchParams.set('client_key', clientKey);
  authUrl.searchParams.set('scope', TIKTOK_SCOPES.join(','));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('Before you continue: your TikTok Developer app must have this exact redirect URI registered');
  console.log('under the Login Kit product (app/platform type "Desktop") — NOT under "URL Properties," which is');
  console.log('a different, unrelated feature (Content Posting API domain verification) this tool doesn\'t need:');
  console.log('');
  console.log(`  ${CANONICAL_TIKTOK_REDIRECT_URI}`);
  console.log('');
  console.log('Also confirm TIKTOK_CLIENT_KEY/SECRET above are your Sandbox app\'s credentials (eye icon on the');
  console.log('Sandbox app\'s page), not a production app\'s — TikTok will reject the client_key otherwise, before');
  console.log('App Review is complete.');
  console.log('');
  console.log('Open this URL, log in as the Pintag TikTok account, and approve the requested permissions:');
  console.log('');
  console.log(authUrl.toString());
  console.log('');
  console.log("TikTok will redirect your browser to that address — the page will 404, and that's expected (nothing is running there).");
  console.log('Copy the full address from your browser\'s address bar and paste it below.');
  console.log('');

  const pasted = await ask('Redirect URL or code: ');
  const code = extractCode(pasted);
  if (!code) {
    console.log('No code found — nothing saved.');
    rl.close();
    return;
  }

  try {
    const token = await exchangeCodeForToken(code, redirectUri, verifier);
    await storeToken(token.accessToken, token.refreshToken, token.expiresIn);
    console.log('');
    console.log('Connected. TikTok observations will now appear in the next `npm run daily-briefing` run.');
    console.log('The access token refreshes automatically — you shouldn\'t need to run this again unless the refresh token expires (TikTok\'s refresh tokens last about a year).');
  } catch (err) {
    console.log('');
    console.log(`Token exchange failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    console.log(`Nothing saved — double check ${CANONICAL_TIKTOK_REDIRECT_URI} is registered exactly as shown in your TikTok Developer app, that TIKTOK_CLIENT_KEY/SECRET in .env.local are your Sandbox app's own credentials (not a production app's — TikTok rejects a mismatched pair), and that the code hasn't already been used (codes are single-use, and expire quickly — if it's been more than a minute, just run this again for a fresh one).`);
  }
  rl.close();
}

// Guards against running main() if this module is ever imported rather than
// executed directly — same pattern daily-briefing.ts uses.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    rl.close();
    process.exit(1);
  });
}
