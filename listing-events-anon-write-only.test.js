// Static companion to tests/security/regression/listing_events_anon_regression.sql (supabase/migrations/20261104010000_listing_events_no_anon_select.sql).
// The database now refuses anonymous reads of listing_events (and INSERT ... RETURNING). This suite proves the browser code only ever WRITES events with
// `Prefer: return=minimal`, that no public page reads the table, and that the only reader is the administrator tool. Run with: node --test listing-events-anon-write-only.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MIGRATION = read('supabase/migrations/20261104010000_listing_events_no_anon_select.sql');
const rootFiles = fs.readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f) && !/\.test\.js$/.test(f));
const PUBLIC = rootFiles.filter((f) => !['admin.html', 'analytics-inspector.html', 'analytics.html', 'analytics.js', 'analytics-core.js', 'intelligence.html', 'intelligence.js', 'gallery-recovery.html', 'agent-setup.html', 'watermark-migrate.html', 'dashboard.html', 'edit-listing.html', 'add-property.html', 'marketing-os.html', 'og-preview-gen.html', 'og-preview-listings-gen.html',
  // administrator-only modules (loaded by admin.html, which signs in with the administrator token)
  'listing-provenance.js', 'import-provenance.js', 'admin-auth.js', 'availability-issues.js', 'map-location-field.js', 'reset-password.html'].includes(f));

test('the migration drops both anonymous SELECT policies and revokes anon SELECT, and leaves the INSERT policy alone', () => {
  assert.match(MIGRATION, /DROP POLICY IF EXISTS "anon dedup read listing_events" ON listing_events/);
  assert.match(MIGRATION, /DROP POLICY IF EXISTS "Allow anon dedup self-check" ON listing_events/);
  assert.match(MIGRATION, /REVOKE SELECT ON TABLE listing_events FROM anon/);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /anon insert listing_events|GRANT|CREATE POLICY/);
});

test('the dedup guards the INSERT policy relies on are SECURITY DEFINER in the migrations (so the anonymous SELECT policy was never needed)', () => {
  const dedup = read('supabase/migrations/20260811000000_restore_analytics_insert_protections.sql');
  assert.match(dedup, /check_listing_event_dedup\([^)]*\)\s*RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER/);
  const ceiling = read('supabase/migrations/20260817010000_authz_identity_and_abuse_bounds.sql');
  assert.match(ceiling, /check_event_target_ceiling\([\s\S]{0,200}?SECURITY DEFINER/);
});

test('every postEvent() the public pages define sends Prefer: return=minimal (an insert never asks for the row back)', () => {
  const defs = [];
  for (const f of PUBLIC) { const t = read(f); const i = t.indexOf('function postEvent('); if (i >= 0) defs.push([f, t.slice(i, i + 700)]); }
  assert.ok(defs.length >= 4, 'index, listing, listings and agent define postEvent');
  for (const [f, body] of defs) assert.match(body, /'Prefer':\s*'return=minimal'/, f);
});

test('no public file asks the API for a representation of an inserted row', () => {
  for (const f of PUBLIC) assert.doesNotMatch(read(f), /return=representation/, f);
});

test('no public page or shared module reads listing_events: the table is only ever written (POST) from the browser', () => {
  for (const f of PUBLIC) {
    const t = read(f);
    for (const m of t.matchAll(/listing_events[^\n]{0,160}/g)) {
      const line = m[0];
      assert.doesNotMatch(line, /rest\/v1\/listing_events\?|\.from\(['"]listing_events['"]\)\s*\.select|sbGet\(['"]listing_events/, `${f}: ${line}`);
    }
    assert.doesNotMatch(t, /\.from\(['"]listing_events['"]\)\s*\.select/, f);
  }
});

test('the only reader of listing_events is the administrator tool, which authenticates with the administrator token', () => {
  const readers = rootFiles.filter((f) => /rest\/v1\/listing_events|sbGet\('listing_events/.test(read(f)) || /sbGet\('listing_events\?/.test(read(f)));
  assert.deepEqual(readers, ['analytics-inspector.html']);
  const t = read('analytics-inspector.html');
  assert.match(t, /PintagAdminAuth/);          // behind the shared admin login
  assert.match(t, /Authorization': 'Bearer ' \+ token|Bearer ' \+ token/);   // sends the session token, not the public key alone
});
