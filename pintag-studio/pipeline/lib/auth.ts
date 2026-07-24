// Auth seam (M2.9 follow-up) — founder-server.ts is explicitly local-only,
// no-auth by design (see that file's header comment): this exists so
// routes that will eventually need real identity (starting with
// GET /morning) read it through one function instead of assuming, without
// hardcoding any actual auth provider yet. dashboard/index.html already has
// a real, if currently unwired, Supabase Auth pattern
// (auth.onAuthStateChange / signInWithPassword / signOut, backed by real
// RLS policies) — swapping that in later means changing this file only,
// not any route handler that calls getFounderSession().

import type { IncomingMessage } from 'node:http';
import { readFounderName } from './config.js';

export interface FounderSession {
  founderName: string;
  authenticated: true;
}

/** Always returns a fixed local-founder session today — this tool runs on the founder's own machine, the same trust boundary as running a CLI command locally. Takes `req` (unused today) so the signature doesn't need to change when real session lookup (a cookie, a header) is wired in later. */
export function getFounderSession(_req: IncomingMessage): FounderSession {
  return { founderName: readFounderName(), authenticated: true };
}
