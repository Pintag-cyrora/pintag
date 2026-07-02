import { createClient } from '@supabase/supabase-js';

// Server-side client for headless pipeline runs (GitHub Actions / `claude -p`
// invocations). Uses the service role key and therefore bypasses RLS by
// design — see the RLS comment block in
// supabase/migrations/0001_init_control_plane.sql. Never ship this key to
// the Dashboard; the Dashboard authenticates as the founder's own user via
// Supabase Auth instead.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. See pintag-studio/SETUP.md for how to provision the project and set these as GitHub Actions secrets.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
