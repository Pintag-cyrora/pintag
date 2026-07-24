import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Server-side client for headless pipeline runs (GitHub Actions / `claude -p`
// invocations). Uses the service role key and therefore bypasses RLS by
// design — see the RLS comment block in
// supabase/migrations/0001_init_control_plane.sql. Never ship this key to
// the Dashboard; the Dashboard authenticates as the founder's own user via
// Supabase Auth instead.

// Loads pintag-studio/.env.local if one exists (see .env.example — this
// convention already existed before "Start Marketing OS.command", just
// unused by any code until now) — the one thing that lets the double-click
// launcher start with zero Terminal typing: a shell you type `export` into
// by hand has nothing to hand off to a double-clicked script, but a file
// does. Node's built-in loadEnvFile() never overrides a variable that's
// already set (confirmed before relying on it), so this is a no-op
// everywhere a real environment already provides these — GitHub Actions,
// or a shell that already exported them — same credentials, same behavior,
// just also readable from a local file when nothing else set them.
//
// Anchored to this file's own location (same pattern as config.ts's
// REPO_ROOT), not process.cwd() — a bare relative path here resolves
// against whatever directory the command happened to be run from, which
// silently fails (caught below) the moment that isn't pintag-studio/
// itself, e.g. `tsx pipeline/daily-briefing.ts` invoked from the repo
// root. Computed independently here rather than importing REPO_ROOT from
// config.ts, which already imports this file for loadRuntimeConfig() —
// that would be a real circular import, not just a type-only one.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL_PATH = join(__dirname, '..', '..', '.env.local');

try {
  process.loadEnvFile(ENV_LOCAL_PATH);
} catch {
  // No .env.local file — expected in CI and anywhere else the environment
  // is already configured directly.
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. For local use: copy pintag-studio/.env.example to pintag-studio/.env.local and fill in real values (this file is auto-loaded, see loadEnvFile() above) — see SETUP.md §1. There is no CI for this pipeline; these only need to exist in your local environment.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
