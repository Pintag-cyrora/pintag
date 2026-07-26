// Fail-closed exposure check, deliberately in its own module with NO
// dependencies beyond auth.ts.
//
// Why it isn't just a function called from founder-server.ts's body: ES
// modules evaluate every import before any of the importing module's own
// code runs, and pipeline/lib/supabase.ts throws at import time when its
// credentials are missing. So a check written in the server's body would run
// AFTER that throw — meaning a misconfigured public deployment could die on
// a confusing Supabase error instead of the clear "you are about to expose
// this server" message, and the ordering would silently depend on which
// import happened to come first.
//
// Importing this module for its side effect, as founder-server.ts's very
// first import, makes the check the first thing that happens in the process.
// ESM evaluates dependencies in declaration order, so nothing else — no
// Supabase client construction, no config read — can precede it.

import { authRequired, authConfig } from './auth.js';

/** Loopback addresses — the trust boundary that makes running without auth acceptable. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export const SERVER_HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Returns the reasons an exposed bind would be unsafe, or an empty array
 * when it's fine (including when the bind is loopback, where auth is not
 * required). Exported separately from the exit-on-failure behavior so it's
 * testable without spawning a process.
 */
export function exposureProblems(host: string = SERVER_HOST): string[] {
  if (isLoopback(host)) return [];
  const problems: string[] = [];
  if (!authRequired()) problems.push('MARKETING_OS_REQUIRE_AUTH is not "true"');
  if (!authConfig()) problems.push('SUPABASE_URL, SUPABASE_ANON_KEY, and MARKETING_OS_FOUNDER_EMAIL must all be set');
  return problems;
}

/**
 * Refuses to continue if this process is about to expose the Founder
 * Workspace beyond localhost without working authentication. Almost every
 * route can mutate state (approving knowledge, saving campaign reviews,
 * regenerating departments) or spend LLM budget, so an exposed instance
 * without auth is a serious hole, not a minor misconfiguration.
 *
 * Exits rather than throwing so the operator sees a readable message instead
 * of a stack trace.
 */
export function assertSafeExposure(host: string = SERVER_HOST): void {
  const problems = exposureProblems(host);
  if (problems.length === 0) return;

  console.error(
    [
      `REFUSING TO START: HOST=${host} would expose this server beyond localhost, but authentication is not configured.`,
      ...problems.map((p) => `  - ${p}`),
      '',
      'Every route here can mutate state (approving knowledge, saving reviews, regenerating',
      'departments) or spend LLM budget, so an exposed instance without auth is not safe.',
      'Either set the variables above, or leave HOST unset to bind 127.0.0.1 for local use.',
      'See SETUP.md §10.',
    ].join('\n')
  );
  process.exit(1);
}

// Runs on import — see the header comment for why this is a side effect
// rather than a call from the server's body.
assertSafeExposure();
