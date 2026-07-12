// One-time TikTok authorization handshake (M2.2) — the manual setup step
// that gets a real access_token/refresh_token pair into
// observation_source_tokens so pipeline/lib/observation-sources/tiktok.ts
// can start reporting real observations. Same "human does this once,
// interactively, via a CLI" pattern as knowledge-review.ts / teach.ts.
//
// Run: npm run tiktok:connect
//
// Requires TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI
// already set (see SETUP.md's TikTok section) — the redirect URI must
// exactly match what's registered in the TikTok Developer app. It does not
// need to be a live, listening server: TikTok redirects the founder's
// browser there with the authorization code in the query string, and the
// founder pastes that URL back here even if the page itself 404s.

import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { TIKTOK_AUTH_URL, TIKTOK_SCOPES, exchangeCodeForToken, storeToken } from './lib/observation-sources/tiktok.js';

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
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !clientSecret || !redirectUri) {
    console.log('Missing TikTok credentials — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI first.');
    console.log('See SETUP.md\'s TikTok section for how to create the Developer app and register a redirect URI.');
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

  console.log('Open this URL, log in as the Pintag TikTok account, and approve the requested permissions:');
  console.log('');
  console.log(authUrl.toString());
  console.log('');
  console.log("TikTok will redirect your browser to your registered redirect URI — that page may 404, that's expected.");
  console.log('Paste the full URL you land on (or just the `code` value from it) below.');
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
    console.log('Nothing saved — double check the redirect URI matches exactly what\'s registered in the TikTok Developer app, and that the code hasn\'t already been used (codes are single-use).');
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
